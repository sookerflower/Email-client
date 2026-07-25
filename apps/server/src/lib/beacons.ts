/**
 * Mail invalidation beacons (Phase 5 §8b): durable state lives in Postgres,
 * this is only the ephemeral "something changed" ping. Lost pings cost
 * latency, never correctness — the client heals via refetch-on-ping plus
 * the reconnect blanket invalidation.
 *
 * Publishing goes through the Upstash REST client (lib/services), so this
 * module is safe in BOTH runtimes — api (workerd bundle included) and the
 * Node worker. The subscribe side is Node-only (src/node/realtime.ts,
 * ioredis on the Redis TCP port) and never enters the workerd graph.
 *
 * PUBLISH-AFTER-COMMIT RULE: call publishBeacon (or MailEngine.broadcast,
 * its only wrapper) only after the Postgres write it announces has been
 * awaited, and never inside a transaction callback. A beacon that fires
 * before its row is visible makes the client refetch stale and never
 * refetch again.
 */
import type { OutgoingMessageType } from '../routes/agent/types';
import { redis } from './services';

export type BeaconMessage = { type: OutgoingMessageType; [key: string]: unknown };

export const beaconChannel = (connectionId: string) => `beacon:${connectionId}`;

export async function publishBeacon(connectionId: string, message: BeaconMessage): Promise<void> {
  try {
    await redis().publish(beaconChannel(connectionId), JSON.stringify(message));
  } catch (error) {
    // Losing a ping degrades latency only; never let it fail a mail flow.
    console.warn(
      `[beacons] publish failed for ${connectionId} (${message.type}):`,
      (error as Error).message,
    );
  }
}
