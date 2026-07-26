/**
 * Node.js entrypoint for the zero-server Hono app (Path B migration).
 *
 * Run from apps/server: `pnpm dev` (esbuild bundle -> dist-node/server.mjs).
 * Auth (Google OAuth + Custom IMAP/SMTP), tRPC, chat, and the SSE realtime
 * relay all serve from here; IMAP sockets live exclusively in the worker
 * process (dist-node/worker.mjs).
 */
import { serve } from '@hono/node-server';
import { app } from '../main';
import { env } from '../env';
import { registerRealtimeRoutes } from './realtime';

// Phase 5 §8b: SSE beacon relay, registered here so ioredis and the
// subscriber stay out of the workerd bundle.
registerRealtimeRoutes(app);

/** workerd ExecutionContext equivalent: fire-and-forget with error logging. */
const executionCtx = {
  waitUntil(promise: Promise<unknown>) {
    void Promise.resolve(promise).catch((error) => {
      console.error('[waitUntil] background task failed:', error);
    });
  },
  passThroughOnException() {},
  props: {},
};

const port = Number(process.env.PORT || 8787);

serve(
  {
    // Merge @hono/node-server's per-request env ({ incoming, outgoing })
    // into ours: getConnInfo (rate-limit IPs) reads c.env.incoming.socket,
    // app code reads the ZeroEnv vars — both live on c.env.
    fetch: (request, nodeEnv) =>
      app.fetch(request, Object.assign({}, env, nodeEnv) as never, executionCtx as never),
    port,
    hostname: process.env.HOST || '127.0.0.1',
  },
  (info) => {
    console.log(`[node] zero-server listening on http://127.0.0.1:${info.port}`);
    console.log('[node] runtime: Node', process.versions.node, '| DO-backed mail features: not ported yet');
  },
);
