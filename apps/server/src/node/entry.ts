/**
 * Node.js entrypoint for the zero-server Hono app (Path B migration, Phase 0).
 *
 * Run from apps/server:
 *   node --import tsx --import ./src/node/cf-hook.mjs src/node/entry.ts
 * (or `pnpm dev:node`).
 *
 * Serves the same `app` that workerd serves. Cloudflare bindings resolve to
 * the shim in cf-shim.mjs: auth (Google OAuth + Custom IMAP/SMTP), tRPC, and
 * anything Postgres/sidecar-backed works; mail-engine features that still
 * live in Durable Objects fail loudly with NotPortedError until their
 * migration phase lands.
 */
import { serve } from '@hono/node-server';
import { app } from '../main';
import { env } from '../env';

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
    fetch: (request) => app.fetch(request, env as never, executionCtx as never),
    port,
    hostname: process.env.HOST || '127.0.0.1',
  },
  (info) => {
    console.log(`[node] zero-server listening on http://127.0.0.1:${info.port}`);
    console.log('[node] runtime: Node', process.versions.node, '| DO-backed mail features: not ported yet');
  },
);
