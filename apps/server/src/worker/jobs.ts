/**
 * BullMQ job processing in the mail worker (Phase 4 of MIGRATION-PLAN.md).
 *
 * The worker process hosts all queue processors, next to the IMAP driver
 * cache the jobs will use — the api process only ever enqueues.
 *
 * Sub-step 4.1: infrastructure only. Handlers: `ping` (round-trip proof)
 * and the repeatable `heartbeat` (proves schedulers fire). The real
 * sync-folder / send-email processors land in 4.2/4.4.
 */
import type { Job, Worker } from 'bullmq';

import { QUEUE_NAMES, closeQueues, getQueue, startQueueWorker } from '../lib/queue';

export interface JobRuntime {
  workers: Worker[];
  close(): Promise<void>;
}

async function processSweepJob(job: Job): Promise<unknown> {
  switch (job.name) {
    case 'ping':
      return { pong: true, echo: job.data ?? null };
    case 'heartbeat':
      console.log(`[jobs] heartbeat (queues alive, job ${job.id})`);
      return { at: Date.now() };
    default:
      // Rethrow-on-error discipline (§3): unknown work is a loud failure,
      // never a silent skip.
      throw new Error(`Unknown ${QUEUE_NAMES.sweep} job: ${job.name}`);
  }
}

export async function startJobRuntime(): Promise<JobRuntime> {
  const sweepWorker = startQueueWorker(QUEUE_NAMES.sweep, processSweepJob, { concurrency: 1 });

  // Repeatable scheduler infra. The heartbeat is deliberately trivial —
  // it exists so a dead scheduler is visible in logs/Bull Board long
  // before a real sweep (unsnooze, outbox reconciliation) silently rots.
  await getQueue(QUEUE_NAMES.sweep).upsertJobScheduler(
    'heartbeat',
    { every: 15 * 60 * 1000 },
    { name: 'heartbeat' },
  );

  console.log('[jobs] queue workers started (sweep); heartbeat scheduler registered');

  return {
    workers: [sweepWorker],
    close: async () => {
      await sweepWorker.close();
      await closeQueues();
    },
  };
}
