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
  enqueueSendEmail,
  enqueueSyncFolder,
  getQueue,
  hasLiveSendJob,
  isSyncDirty,
  startQueueWorker,
  type SendEmailJobData,
  type SyncFolderJobData,
} from '../lib/queue';
import { toAttachmentFiles, type SerializedAttachment } from '../lib/attachments';
import { connection as connectionSchema } from '../db/schema';
import { outboxStore, snoozeStore } from '../lib/stores';
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

/**
 * send-email processor (§4): the outbox row is the source of truth, the job
 * is just the timer. Port of the CF queue consumer (old main.ts Entry.queue
 * send-email branch) minus its swallow-everything catch: transport errors
 * RETHROW so BullMQ retries; the final-failure hook below marks the row
 * 'failed' — nothing is ever silently dropped.
 */
async function processSendJob(job: Job): Promise<unknown> {
  if (job.name !== 'send-email') {
    throw new Error(`Unknown ${QUEUE_NAMES.send} job: ${job.name}`);
  }
  const { messageId, connectionId } = job.data as SendEmailJobData;

  const row = await outboxStore.getById(messageId);
  if (!row) throw new Error(`No outbox row for scheduled email ${messageId}`);
  // Fire-time status re-check: the row decides, not the job's existence
  // (undo-send may have failed to remove the job — that's fine).
  if (row.status === 'cancelled') return { skipped: 'cancelled' };
  if (row.status === 'sent') return { skipped: 'already sent' };
  if (row.status === 'failed') return { skipped: 'failed (manual re-send required)' };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = row.payload as any;
  if (Array.isArray(payload.attachments)) {
    payload.attachments = payload.attachments.map((att: SerializedAttachment) =>
      'arrayBuffer' in att && typeof (att as { arrayBuffer?: unknown }).arrayBuffer === 'function'
        ? att
        : toAttachmentFiles([att])[0],
    );
  }

  const engine = await MailEngine.init(connectionId);
  if (payload.draftId) {
    const { draftId, ...rest } = payload;
    await engine.sendDraft(draftId, rest);
  } else {
    await engine.create(payload);
  }

  const marked = await outboxStore.markSent(messageId);
  if (!marked) {
    // A cancel raced in after the transport send left — too late to unsend,
    // but never resend. Loud, for the human to reconcile.
    console.warn(`[jobs] send ${messageId}: sent, but row was cancelled mid-send (not resending)`);
  }
  // Sent-folder visibility for this send is handled at the /rpc choke point
  // (core.ts): engine.create/sendDraft above route their IMAP work through
  // /rpc, where a successful create|sendDraft enqueues sync-folder:sent.
  // One hook covers BOTH send paths (this job and the api's direct send).
  return { sent: true };
}

/** Enqueue a sent-folder sync for every IMAP connection (bug #2 fix). */
async function scheduleSentFolderSyncs(): Promise<{ scheduled: number }> {
  const { db } = createDb(env.DATABASE_URL);
  const rows = await db.query.connection.findMany({
    where: eq(connectionSchema.providerId, 'imap'),
    columns: { id: true },
  });
  for (const row of rows) {
    await enqueueSyncFolder(row.id, 'sent');
  }
  return { scheduled: rows.length };
}

/**
 * Reconciliation sweep (§4): any unsent outbox row past its send_at with no
 * live timer job gets re-enqueued (covers rows created while the worker was
 * down and Redis data loss — the Postgres row is what survives).
 */
async function reconcileOutbox(): Promise<{ examined: number; requeued: number }> {
  const due = await outboxStore.listOverdueUnsent(new Date());
  let requeued = 0;
  for (const row of due) {
    if (await hasLiveSendJob(row.id)) continue;
    await enqueueSendEmail(row.id, row.connectionId, row.sendAt);
    await outboxStore.markQueued(row.id);
    requeued += 1;
    console.log(`[jobs] outbox-reconcile: re-enqueued overdue send ${row.id}`);
  }
  return { examined: due.length, requeued };
}

/**
 * Unsnooze sweep (§3): wakes due snoozes back into the inbox. The old cron
 * dispatch was commented out (main.ts) — snooze set wake times that nothing
 * ever honored; this makes snooze actually work.
 */
async function unsnoozeSweep(): Promise<{ connections: number; threads: number }> {
  const due = await snoozeStore.listDue(new Date());
  const byConnection = new Map<string, string[]>();
  for (const { connectionId, threadId } of due) {
    const list = byConnection.get(connectionId) ?? [];
    list.push(threadId);
    byConnection.set(connectionId, list);
  }
  for (const [connectionId, threadIds] of byConnection) {
    try {
      const engine = await MailEngine.init(connectionId);
      await engine.unsnoozeThreadsHandler({ connectionId, threadIds });
      console.log(`[jobs] unsnooze-sweep: woke ${threadIds.length} thread(s) on ${connectionId}`);
    } catch (error) {
      // Per-connection isolation; the failed batch stays due and the next
      // sweep retries it.
      console.error(
        `[jobs] unsnooze-sweep failed for ${connectionId}:`,
        (error as Error).message,
      );
    }
  }
  return { connections: byConnection.size, threads: due.length };
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
    case 'outbox-reconcile':
      return await reconcileOutbox();
    case 'unsnooze-sweep':
      return await unsnoozeSweep();
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

  // Sends are strictly sequential per process: parallel SMTP submissions
  // multiplex the same cached driver, and volume is tiny.
  const sendWorker = startQueueWorker(QUEUE_NAMES.send, processSendJob, { concurrency: 1 });

  // Exhausted retries -> the row is marked 'failed' + a beacon hook (logged
  // no-op until Phase 5 SSE). This is the anti-silent-drop guarantee.
  sendWorker.on('failed', (job, error) => {
    if (!job || job.name !== 'send-email') return;
    const attempts = typeof job.opts.attempts === 'number' ? job.opts.attempts : 1;
    if (job.attemptsMade < attempts) return; // retries remain
    const { messageId, connectionId } = job.data as SendEmailJobData;
    void outboxStore
      .markFailed(messageId, error.message)
      .then(() =>
        console.warn(
          `[jobs] beacon (pending Phase 5): send-failed ${messageId} on ${connectionId} — ${error.message}`,
        ),
      )
      .catch((markError) =>
        console.error(`[jobs] failed to mark outbox ${messageId} failed:`, markError),
      );
  });

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
  await sweepQueue.upsertJobScheduler(
    'outbox-reconcile',
    { every: 10 * 60 * 1000 },
    { name: 'outbox-reconcile' },
  );
  await sweepQueue.upsertJobScheduler(
    'unsnooze-sweep',
    { every: 10 * 60 * 1000 },
    { name: 'unsnooze-sweep' },
  );

  // Startup reconciliation: don't wait for the first repeatable tick to
  // recover sends that came due while the worker was down.
  void reconcileOutbox().catch((error) =>
    console.error('[jobs] startup outbox reconcile failed:', (error as Error).message),
  );

  console.log(
    '[jobs] queue workers started (sweep, sync, send); schedulers: heartbeat, sync-sent-folders, outbox-reconcile, unsnooze-sweep',
  );

  return {
    workers: [sweepWorker, syncWorker, sendWorker],
    close: async () => {
      await sweepWorker.close();
      await syncWorker.close();
      await sendWorker.close();
      await closeQueues();
    },
  };
}
