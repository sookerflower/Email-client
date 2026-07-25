/**
 * BullMQ job processing in the mail worker (Phase 4 of MIGRATION-PLAN.md).
 *
 * The worker process hosts all queue processors, next to the IMAP driver
 * cache the jobs use — the api process only ever enqueues. MailEngine
 * instantiated here still routes every IMAP op through /rpc (loopback),
 * so the single-driver-cache-per-account invariant holds no matter which
 * process runs the sync.
 *
 * 4.1: infra (`ping` + repeatable `heartbeat`).
 * 4.2: `sync-folder` processor (paged, checkpointed, errors rethrown so
 *      the attempts/backoff policy is real) + the `sync-sent-folders`
 *      repeatable that schedules periodic sent-folder syncs (fixes known
 *      bug #2 — the old path only ever pulled inbox).
 */
import { eq } from 'drizzle-orm';
import type { Job, Worker } from 'bullmq';

import {
  QUEUE_NAMES,
  claimSyncDirty,
  closeQueues,
  enqueueSyncFolder,
  getQueue,
  isSyncDirty,
  startQueueWorker,
  type SyncFolderJobData,
} from '../lib/queue';
import { connection as connectionSchema } from '../db/schema';
import { MailEngine } from '../lib/mail-engine';
import { createDb } from '../db';
import { env } from '../env';

export interface JobRuntime {
  workers: Worker[];
  close(): Promise<void>;
}

const SENT_SYNC_EVERY_MS = 10 * 60 * 1000;

/**
 * Per-account serialization: two sync jobs for the SAME connection (e.g.
 * inbox + sent) multiplex one cached IMAP connection, and interleaved
 * mailboxOpen/FETCH from concurrent jobs is exactly old bug #1's failure
 * class ("list fails under connection concurrency"). All sync jobs run in
 * this one worker process, so an in-process promise chain per connectionId
 * is a sufficient lock. Different accounts still run in parallel.
 */
const accountChains = new Map<string, Promise<unknown>>();

function withAccountLock<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = accountChains.get(connectionId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  accountChains.set(
    connectionId,
    next.catch(() => undefined),
  );
  return next;
}

async function processSyncJob(job: Job): Promise<unknown> {
  if (job.name !== 'sync-folder') {
    throw new Error(`Unknown ${QUEUE_NAMES.sync} job: ${job.name}`);
  }
  const { connectionId, folder } = job.data as SyncFolderJobData;
  return await withAccountLock(connectionId, async () => {
    // Claim the pending-notify marker: anything that arrives after this
    // point may postdate our listing and re-sets it, and the completion
    // hook below re-enqueues.
    await claimSyncDirty(connectionId, folder);
    const engine = await MailEngine.init(connectionId);
    // Errors propagate: BullMQ retries with backoff, and the page checkpoint
    // in folder_sync_state makes the retry (attemptsMade > 0) resume, not
    // restart. A fresh job never resumes a stale checkpoint.
    return await engine.syncFolderJob(folder, { resume: job.attemptsMade > 0 });
  });
}

/** Enqueue a sent-folder sync for every IMAP connection (bug #2 fix). */
async function scheduleSentFolderSyncs(): Promise<{ scheduled: number }> {
  const { db } = createDb(env.HYPERDRIVE.connectionString);
  const rows = await db.query.connection.findMany({
    where: eq(connectionSchema.providerId, 'imap'),
    columns: { id: true },
  });
  for (const row of rows) {
    await enqueueSyncFolder(row.id, 'sent');
  }
  return { scheduled: rows.length };
}

async function processSweepJob(job: Job): Promise<unknown> {
  switch (job.name) {
    case 'ping':
      return { pong: true, echo: job.data ?? null };
    case 'heartbeat':
      console.log(`[jobs] heartbeat (queues alive, job ${job.id})`);
      return { at: Date.now() };
    case 'sync-sent-folders':
      return await scheduleSentFolderSyncs();
    default:
      // Rethrow-on-error discipline (§3): unknown work is a loud failure,
      // never a silent skip.
      throw new Error(`Unknown ${QUEUE_NAMES.sweep} job: ${job.name}`);
  }
}

export async function startJobRuntime(): Promise<JobRuntime> {
  const sweepWorker = startQueueWorker(QUEUE_NAMES.sweep, processSweepJob, { concurrency: 1 });
  // Cross-account job concurrency. Per-ACCOUNT discipline is what fail2ban
  // cares about, and that is enforced elsewhere: all of one account's ops
  // multiplex over the worker's single cached IMAP connection, and
  // per-thread concurrency inside a job is bounded at 3 in
  // MailEngine.syncFolderJob (do not raise). Cross-account slots must be
  // plentiful enough that one slow mailbox can't starve the rest (a
  // 2-slot pool let two slow real-server jobs starve a GreenMail inbox
  // sync past the E2E window).
  const syncWorker = startQueueWorker(QUEUE_NAMES.sync, processSyncJob, { concurrency: 8 });

  // Trailing edge of the dedup: a notify that landed mid-sync set the dirty
  // flag; the dedup key is released on completion, so re-enqueue here picks
  // the signal up. Must run on 'completed' — inside the processor the dedup
  // key is still held and the add would be dropped.
  syncWorker.on('completed', (job) => {
    if (job.name !== 'sync-folder') return;
    const { connectionId, folder } = job.data as SyncFolderJobData;
    void isSyncDirty(connectionId, folder)
      .then((dirty) => (dirty ? enqueueSyncFolder(connectionId, folder) : undefined))
      .catch((error) =>
        console.warn('[jobs] dirty-flag re-enqueue failed:', (error as Error).message),
      );
  });

  // Repeatable schedulers. The heartbeat is deliberately trivial — it
  // exists so a dead scheduler is visible in logs/Bull Board long before a
  // real sweep silently rots.
  const sweepQueue = getQueue(QUEUE_NAMES.sweep);
  await sweepQueue.upsertJobScheduler(
    'heartbeat',
    { every: 15 * 60 * 1000 },
    { name: 'heartbeat' },
  );
  await sweepQueue.upsertJobScheduler(
    'sync-sent-folders',
    { every: SENT_SYNC_EVERY_MS },
    { name: 'sync-sent-folders' },
  );

  console.log('[jobs] queue workers started (sweep, sync); schedulers: heartbeat, sync-sent-folders');

  return {
    workers: [sweepWorker, syncWorker],
    close: async () => {
      await sweepWorker.close();
      await syncWorker.close();
      await closeQueues();
    },
  };
}
