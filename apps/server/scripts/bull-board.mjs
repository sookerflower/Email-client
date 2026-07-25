/**
 * Bull Board — queue inspection UI (Phase 4.1 of MIGRATION-PLAN.md).
 *
 * Deliberately a standalone, UNBUNDLED dev/ops tool: Bull Board serves
 * static UI assets from node_modules, which does not survive the esbuild
 * bundle, and it has no business in the workerd build. Run on demand:
 *
 *   node scripts/bull-board.mjs        # from apps/server
 *   -> http://127.0.0.1:8793/admin/queues
 *
 * Env: QUEUE_REDIS_URL (default redis://127.0.0.1:6379),
 *      BULL_BOARD_PORT (default 8793)
 */
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Queue } from 'bullmq';
import express from 'express';
import IORedis from 'ioredis';

const QUEUE_NAMES = ['mail-sync', 'mail-send', 'mail-sweep'];
const redisUrl = process.env.QUEUE_REDIS_URL ?? 'redis://127.0.0.1:6379';
const port = Number(process.env.BULL_BOARD_PORT ?? 8793);

const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const queues = QUEUE_NAMES.map((name) => new Queue(name, { connection }));

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');
createBullBoard({ queues: queues.map((q) => new BullMQAdapter(q)), serverAdapter });

const app = express();
app.use('/admin/queues', serverAdapter.getRouter());
app.listen(port, '127.0.0.1', () => {
  console.log(`[bull-board] http://127.0.0.1:${port}/admin/queues (redis: ${redisUrl})`);
});
