/**
 * BullMQ queue infrastructure (Phase 4 of MIGRATION-PLAN.md, §3/§4).
 *
 * Node-only: BullMQ speaks the Redis TCP protocol (Valkey on
 * QUEUE_REDIS_URL), unlike lib/stores.ts which goes through the Upstash
 * HTTP proxy. Never import this module from code that ends up in the
 * workerd bundle (src/main.ts and below) — it is used by the worker
 * process (src/worker/) and by scripts only, so `wrangler deploy
 * --dry-run` keeps building.
 *
 * Queues:
 *   mail-sync   sync-folder jobs (§3) — deterministic jobId + debounce
 *   mail-send   outbox-backed delayed send-email jobs (§4)
 *   mail-sweep  repeatable schedulers (unsnooze sweep, outbox
 *               reconciliation, heartbeat)
 */
import { Queue, Worker, type Processor, type JobsOptions, type WorkerOptions } from 'bullmq';
import IORedis from 'ioredis';

export const QUEUE_NAMES = {
  sync: 'mail-sync',
  send: 'mail-send',
  sweep: 'mail-sweep',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export function queueRedisUrl(): string {
  return process.env.QUEUE_REDIS_URL ?? 'redis://127.0.0.1:6379';
}

/** BullMQ requires maxRetriesPerRequest: null on its blocking connections. */
export function createQueueConnection(): IORedis {
  return new IORedis(queueRedisUrl(), {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

/**
 * §3: real retries — attempts 3, exponential backoff from 30 s. Processors
 * must RETHROW errors (the old CF queue consumers caught-and-swallowed,
 * defeating retries). Failed jobs are retained for Bull Board inspection.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

const queues = new Map<QueueName, Queue>();

/** Lazy per-process Queue singletons (safe to call from api or worker). */
export function getQueue(name: QueueName): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection: createQueueConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    queue.on('error', (error) => {
      console.error(`[queue:${name}] error:`, (error as Error).message);
    });
    queues.set(name, queue);
  }
  return queue;
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((queue) => queue.close().catch(() => undefined)));
  queues.clear();
}

/**
 * Start a BullMQ worker for one queue. Thin wrapper so every processor gets
 * the same connection settings and failure logging; error propagation is the
 * processor's job (rethrow!).
 */
export function startQueueWorker(
  name: QueueName,
  processor: Processor,
  options?: Partial<WorkerOptions>,
): Worker {
  const worker = new Worker(name, processor, {
    connection: createQueueConnection(),
    ...options,
  });
  worker.on('failed', (job, error) => {
    console.warn(
      `[queue:${name}] job ${job?.name}:${job?.id} attempt ${job?.attemptsMade} failed:`,
      error.message,
    );
  });
  worker.on('error', (error) => {
    console.error(`[queue:${name}] worker error:`, error.message);
  });
  return worker;
}
