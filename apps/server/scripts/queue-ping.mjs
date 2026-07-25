/**
 * Phase 4.1 round-trip check: enqueue a `ping` job on mail-sweep and wait
 * for the worker process (dist-node/worker.mjs, which hosts the BullMQ
 * processors) to complete it. Exits 0 on pong, 1 on timeout/failure.
 *
 *   node scripts/queue-ping.mjs        # from apps/server; worker must be up
 */
import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';

const redisUrl = process.env.QUEUE_REDIS_URL ?? 'redis://127.0.0.1:6379';
const connection = () => new IORedis(redisUrl, { maxRetriesPerRequest: null });

const queue = new Queue('mail-sweep', { connection: connection() });
const events = new QueueEvents('mail-sweep', { connection: connection() });
await events.waitUntilReady();

const nonce = `ping-${process.pid}-${Date.now()}`;
const job = await queue.add('ping', { nonce });
console.log(`[queue-ping] enqueued ping job ${job.id} (nonce ${nonce})`);

try {
  const result = await job.waitUntilFinished(events, 15_000);
  if (result?.pong !== true || result?.echo?.nonce !== nonce) {
    throw new Error(`unexpected result: ${JSON.stringify(result)}`);
  }
  console.log('[queue-ping] PONG — worker processed the job:', JSON.stringify(result));
  process.exitCode = 0;
} catch (error) {
  console.error('[queue-ping] FAILED:', error.message);
  process.exitCode = 1;
} finally {
  await events.close();
  await queue.close();
}
