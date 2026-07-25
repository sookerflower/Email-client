/**
 * Mail worker entrypoint (Phase 3.2 of MIGRATION-PLAN.md).
 *
 * Hosts the deployment's ONLY IMAP sockets: the /rpc driver cache (the api
 * process's MailEngine proxies every IMAP op here — sole entry point, no
 * second pool) and, when this instance holds the Redis leader lease, the
 * per-connection IDLE watchers. Followers serve /rpc but hold no watchers,
 * so an account never has two concurrent IDLE connections (3.2.3).
 *
 * Env (process env wins; falls back to repo-root .env):
 *   WORKER_PORT / IMAP_SIDECAR_PORT   listen port (default 8791)
 *   IMAP_SIDECAR_HOST                 bind address (default 127.0.0.1)
 *   IMAP_SIDECAR_SECRET               shared secret for /rpc
 *   IMAP_ENCRYPTION_KEY               password decryption key
 *   DATABASE_URL                      Postgres (label registry)
 *   IMAP_NOTIFY_URL                   app new-mail callback
 *   IMAP_POLL_SECONDS                 poll fallback (default 600)
 *   WORKER_WATCHERS                   'lease' (default) | 'always' | 'never'
 *   REDIS_URL / REDIS_TOKEN           lease store (WORKER_WATCHERS=lease)
 *   WORKER_ID                         lease holder label (default pid)
 *   QUEUE_REDIS_URL                   BullMQ Redis TCP url (default redis://127.0.0.1:6379)
 *
 * Run: node dist-node/worker.mjs   (built by src/node/build.mjs)
 */
import { join } from 'node:path';

import { startMailWorker } from './core';
import { startLeaderLease } from './leader-lease';
import { startJobRuntime, type JobRuntime } from './jobs';
import { cancelSendEmail, enqueueSendEmail, enqueueSyncFolder } from '../lib/queue';

// The worker runs bundled (dist-node/worker.mjs) with cwd = apps/server, so
// paths resolve from cwd, not import.meta.url.
if (!process.env.IMAP_SIDECAR_SECRET) {
  try {
    process.loadEnvFile(join(process.cwd(), '..', '..', '.env'));
  } catch {
    // no .env — rely on the process environment
  }
}

const PORT = Number(process.env.WORKER_PORT ?? process.env.IMAP_SIDECAR_PORT ?? 8791);
const HOST = process.env.IMAP_SIDECAR_HOST ?? '127.0.0.1';
const WATCHER_MODE = process.env.WORKER_WATCHERS ?? 'lease';
const WORKER_ID = process.env.WORKER_ID ?? `worker-${process.pid}`;

let isLeader = WATCHER_MODE === 'always';

const worker = startMailWorker({
  port: PORT,
  host: HOST,
  secret: process.env.IMAP_SIDECAR_SECRET ?? '',
  encryptionKey: process.env.IMAP_ENCRYPTION_KEY ?? '',
  databaseUrl: process.env.DATABASE_URL ?? '',
  notifyUrl:
    process.env.IMAP_NOTIFY_URL ?? 'http://127.0.0.1:8787/api/public/imap-notify',
  pollSeconds: Number(process.env.IMAP_POLL_SECONDS ?? 600),
  watchersEnabled: () => isLeader,
  enqueueSync: enqueueSyncFolder,
  enqueueSend: (messageId, connectionId, sendAt) =>
    enqueueSendEmail(messageId, connectionId, new Date(sendAt)),
  cancelSend: cancelSendEmail,
  // Legacy sidecar JSON store, imported once if still present.
  legacyLabelStorePath: join(process.cwd(), 'imap-sidecar', '.label-store.json'),
});

let jobs: JobRuntime | null = null;
startJobRuntime()
  .then((runtime) => {
    jobs = runtime;
  })
  .catch((error) => {
    console.error('[worker] BullMQ job runtime failed to start:', (error as Error).message);
  });

let lease: Awaited<ReturnType<typeof startLeaderLease>> | null = null;

if (WATCHER_MODE === 'lease') {
  lease = startLeaderLease({
    redisUrl: process.env.REDIS_URL ?? '',
    redisToken: process.env.REDIS_TOKEN ?? '',
    holderId: WORKER_ID,
    onAcquired: () => {
      console.log(`[worker:${WORKER_ID}] leader lease ACQUIRED — watchers enabled`);
      isLeader = true;
      void worker.bootstrapWatchers();
    },
    onLost: () => {
      console.warn(`[worker:${WORKER_ID}] leader lease LOST — stopping watchers`);
      isLeader = false;
      worker.stopAllWatchers('leader lease lost');
    },
  });
} else {
  console.log(`[worker:${WORKER_ID}] watcher mode '${WATCHER_MODE}' (no lease)`);
  if (WATCHER_MODE === 'always') void worker.bootstrapWatchers();
}

const shutdown = async (signal: string) => {
  console.log(`[worker:${WORKER_ID}] ${signal} — shutting down`);
  await lease?.release().catch(() => undefined);
  await jobs?.close().catch(() => undefined);
  await worker.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
