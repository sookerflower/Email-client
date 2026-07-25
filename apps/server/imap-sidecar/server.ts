/**
 * LEGACY WRAPPER (Phase 3.2 of MIGRATION-PLAN.md).
 *
 * The sidecar's implementation moved to src/worker/core.ts, shared with the
 * new mail-worker entrypoint (src/worker/index.ts). This wrapper preserves
 * the old `pnpm imap:sidecar` command with the old single-process behavior
 * (watchers always on, no leader lease) during the 3.2 transition; it is
 * retired at the 3.2.4 cutover in favor of `node dist-node/worker.mjs`.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMailWorker } from '../src/worker/core';

if (!process.env.IMAP_SIDECAR_SECRET) {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
  } catch {
    // no .env — rely on the process environment
  }
}

startMailWorker({
  port: Number(process.env.IMAP_SIDECAR_PORT ?? 8791),
  host: process.env.IMAP_SIDECAR_HOST ?? '127.0.0.1',
  secret: process.env.IMAP_SIDECAR_SECRET ?? '',
  encryptionKey: process.env.IMAP_ENCRYPTION_KEY ?? '',
  databaseUrl: process.env.DATABASE_URL ?? '',
  notifyUrl: process.env.IMAP_NOTIFY_URL ?? 'http://127.0.0.1:8787/api/public/imap-notify',
  pollSeconds: Number(process.env.IMAP_POLL_SECONDS ?? 600),
  watchersEnabled: () => true,
  legacyLabelStorePath: join(dirname(fileURLToPath(import.meta.url)), '.label-store.json'),
});
