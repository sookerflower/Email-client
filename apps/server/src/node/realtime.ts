/**
 * SSE realtime layer (Phase 5 §8b) — Node-only.
 *
 * GET /realtime/:connectionId relays Redis pub/sub beacons (published via
 * lib/beacons.ts from either process) to the browser as Server-Sent
 * Events. Registered from src/node/entry.ts on the imported Hono app, so
 * neither this module nor ioredis ever enters the workerd bundle (same
 * hygiene rule as BullMQ). The path is /realtime, NOT /api/realtime: the
 * /api sub-app carries a tRPC catch-all middleware that would intercept
 * unknown /api/* paths before a late-registered handler.
 *
 * Auth (the §8b ownership fix): better-auth session from the request
 * headers PLUS a Postgres check that the session user owns the connection
 * — 401 without a valid session, 403 for someone else's connectionId.
 * (The old workerd WS layer only checked that a Cookie header existed.)
 */
import IORedis from 'ioredis';

import type { Hono } from 'hono';
import type { HonoContext } from '../ctx';
import { beaconChannel } from '../lib/beacons';
import { createAuth } from '../lib/auth';
import { createDb } from '../db';
import { env } from '../env';

const HEARTBEAT_MS = 25_000; // proxies kill idle SSE; JMAP-ish keepalive

// ---------------------------------------------------------------------------
// Shared Redis subscriber: one TCP connection in subscriber mode for the
// whole process, with per-channel listener sets. Subscribes on first
// listener, unsubscribes on last — N tabs on one mailbox share a channel.
// ---------------------------------------------------------------------------

type Listener = (payload: string) => void;

let subscriber: IORedis | null = null;
const listeners = new Map<string, Set<Listener>>();

function getSubscriber(): IORedis {
  if (!subscriber) {
    subscriber = new IORedis(process.env.QUEUE_REDIS_URL ?? 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: null,
    });
    subscriber.on('message', (channel: string, payload: string) => {
      const set = listeners.get(channel);
      if (!set) return;
      for (const listener of set) listener(payload);
    });
    subscriber.on('error', (error: Error) => {
      console.error('[realtime] subscriber error:', error.message);
    });
    // On reconnect ioredis re-subscribes automatically; clients that missed
    // beacons in the gap heal via their own reconnect-invalidation rule.
  }
  return subscriber;
}

async function addListener(channel: string, listener: Listener): Promise<void> {
  let set = listeners.get(channel);
  if (!set) {
    set = new Set();
    listeners.set(channel, set);
    await getSubscriber().subscribe(channel);
  }
  set.add(listener);
}

function removeListener(channel: string, listener: Listener): void {
  const set = listeners.get(channel);
  if (!set) return;
  set.delete(listener);
  if (set.size === 0) {
    listeners.delete(channel);
    void subscriber?.unsubscribe(channel).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export function registerRealtimeRoutes(app: Hono<HonoContext>): void {
  app.get('/realtime/:connectionId', async (c) => {
    const connectionId = c.req.param('connectionId');

    const auth = createAuth();
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const { db } = createDb(env.HYPERDRIVE.connectionString);
    const row = await db.query.connection.findFirst({
      where: (fields, { eq }) => eq(fields.id, connectionId),
      columns: { id: true, userId: true },
    });
    // Same status for missing and not-owned: don't leak which ids exist.
    if (!row || row.userId !== session.user.id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const channel = beaconChannel(connectionId);
    const encoder = new TextEncoder();
    let heartbeat: NodeJS.Timeout | undefined;
    let listener: Listener | undefined;
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (text: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            // Controller already closed under us; cancel() does cleanup.
          }
        };

        listener = (payload) => write(`data: ${payload}\n\n`);
        await addListener(channel, listener);

        // Named open event: lets clients (and the E2E script) distinguish
        // "stream established" from the first beacon.
        write(`event: open\ndata: {"connectionId":"${connectionId}"}\n\n`);
        heartbeat = setInterval(() => write(':hb\n\n'), HEARTBEAT_MS);
      },
      cancel() {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (listener) removeListener(channel, listener);
      },
    });

    // Belt and braces: ReadableStream.cancel fires on client disconnect via
    // @hono/node-server, but tie cleanup to the request abort signal too.
    c.req.raw.signal.addEventListener('abort', () => {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (listener) removeListener(channel, listener);
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  });
}

/** Test/ops introspection: channels with at least one live SSE client. */
export function activeChannelCount(): number {
  return listeners.size;
}
