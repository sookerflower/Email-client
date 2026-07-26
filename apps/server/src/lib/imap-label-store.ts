import { imapLabelRegistry } from '../db/schema';
import type { LabelStore } from './driver/imap';
import { createDb } from '../db';
import { eq } from 'drizzle-orm';

/**
 * Postgres-backed LabelStore (Phase 3.2.1 of MIGRATION-PLAN.md): replaces
 * the legacy sidecar's .label-store.json file, whose in-process write-chain
 * could not survive more than one worker process. The worker passes its own
 * DATABASE_URL rather than importing src/env.ts.
 */
export const createPgLabelStore = (databaseUrl: string): LabelStore => {
  const db = () => createDb(databaseUrl).db;
  return {
    async get(key) {
      const row = await db().query.imapLabelRegistry.findFirst({
        where: eq(imapLabelRegistry.key, key),
      });
      return row?.value ?? null;
    },
    async put(key, value) {
      await db()
        .insert(imapLabelRegistry)
        .values({ key, value })
        .onConflictDoUpdate({
          target: imapLabelRegistry.key,
          set: { value, updatedAt: new Date() },
        });
    },
  };
};
