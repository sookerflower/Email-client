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
 *   mail-sync   sync-folder jobs (§3) — deduplicated notify-driven syncs
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

export interface SyncFolderJobData {
  connectionId: string;
  folder: string;
}

/**
 * Enqueue a folder sync (§3), deduplicated per `{connectionId}:{folder}`.
 *
 * Extended dedup mode (id, no ttl): duplicates are dropped for as long as
 * a job with this id is queued or running, and the key clears when it
 * completes/fails. A ttl-window debounce is not enough — a folder sync on
 * the real server runs minutes, and every IDLE notify past the window
 * would enqueue another identical full sync (backlog that starves other
 * folders of the same account behind the per-account lock). Not a custom
 * jobId either: a deterministic jobId collides with the RETAINED
 * completed/failed job of a previous run and silently drops future syncs.
 * The watcher's own 2 s notify debounce handles event bursts.
 */
export async function enqueueSyncFolder(connectionId: string, folder: string): Promise<void> {
  const queue = getQueue(QUEUE_NAMES.sync);
  // Dirty flag first, then add: extended dedup silently drops adds while a
  // job is queued/running, but a notify landing MID-SYNC may postdate the
  // running job's listing — the flag lets the processor's completion hook
  // re-enqueue once, so no new-mail signal is ever lost to dedup.
  await flagRedis().set(syncDirtyKey(connectionId, folder), '1', 'EX', 3600);
  const data: SyncFolderJobData = { connectionId, folder };
  await queue.add('sync-folder', data, {
    deduplication: { id: `sync-folder:${connectionId}:${folder}` },
  });
}

export interface SendEmailJobData {
  messageId: string;
  connectionId: string;
}

/**
 * Enqueue the delivery timer for an outbox row (§4). The Postgres row is
 * the source of truth; this job is just the timer. Deterministic jobId
 * `send-{messageId}` is safe here (unlike sync-folder): a messageId is a
 * fresh UUID enqueued at most once, and the id doubles as the handle for
 * undo-send removal and reconciliation idempotency. (Custom jobIds cannot
 * contain `:` — hence the dash.) BullMQ delayed jobs take any duration —
 * the old 12-hour KV/cron split is gone.
 */
export async function enqueueSendEmail(
  messageId: string,
  connectionId: string,
  sendAt: Date,
): Promise<void> {
  const data: SendEmailJobData = { messageId, connectionId };
  await getQueue(QUEUE_NAMES.send).add('send-email', data, {
    jobId: `send-${messageId}`,
    delay: Math.max(0, sendAt.getTime() - Date.now()),
  });
}

/**
 * Undo-send: drop the delayed job. Best-effort — an already-active job
 * cannot be removed, which is fine because the handler re-checks the
 * outbox row status at fire time (the row is the source of truth).
 */
export async function cancelSendEmail(messageId: string): Promise<void> {
  const job = await getQueue(QUEUE_NAMES.send).getJob(`send-${messageId}`);
  if (job) await job.remove().catch(() => undefined);
}

/** True if a live (delayed/waiting/active) timer job exists for the row. */
export async function hasLiveSendJob(messageId: string): Promise<boolean> {
  const job = await getQueue(QUEUE_NAMES.send).getJob(`send-${messageId}`);
  if (!job) return false;
  const state = await job.getState();
  return state === 'delayed' || state === 'waiting' || state === 'active' || state === 'prioritized';
}

const syncDirtyKey = (connectionId: string, folder: string) =>
  `sync-dirty:${connectionId}:${folder}`;

// Plain ioredis connection for the dirty flags (Queue#client is typed to a
// minimal command surface that lacks set-with-EX/exists).
let flagConnection: IORedis | null = null;
const flagRedis = (): IORedis => {
  flagConnection ??= createQueueConnection();
  return flagConnection;
};

/** Consume the pending-notify marker; called by the processor as it starts listing. */
export async function claimSyncDirty(connectionId: string, folder: string): Promise<void> {
  await flagRedis().del(syncDirtyKey(connectionId, folder));
}

/** True if a notify arrived after the current sync claimed the folder. */
export async function isSyncDirty(connectionId: string, folder: string): Promise<boolean> {
  return (await flagRedis().exists(syncDirtyKey(connectionId, folder))) === 1;
}

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
  if (flagConnection) {
    flagConnection.disconnect();
    flagConnection = null;
  }
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
