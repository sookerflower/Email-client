import { imapLabelRegistry } from '../db/schema';
import type { LabelStore } from './driver/imap';
import { createDb } from '../db';
import { eq } from 'drizzle-orm';

/**
 * Postgres-backed LabelStore (Phase 3.2.1 of MIGRATION-PLAN.md): replaces
 * the sidecar's .label-store.json file, whose in-process write-chain could
 * not survive more than one worker process.
 *
 * Deliberately does NOT import src/env.ts (which pulls `cloudflare:workers`):
 * the sidecar/worker runs under plain Node and passes its own DATABASE_URL.
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

/**
 * One-time import of an existing .label-store.json into Postgres. Existing
 * Postgres entries win (the file is stale the moment the pg store goes
 * live); the file is renamed *.migrated afterwards so this never re-runs.
 */
export const migrateJsonLabelStore = async (
  jsonPath: string,
  store: LabelStore,
): Promise<void> => {
  const { readFile, rename } = await import('node:fs/promises');
  let raw: string;
  try {
    raw = await readFile(jsonPath, 'utf-8');
  } catch {
    return; // no file — nothing to migrate
  }
  try {
    const map = JSON.parse(raw) as Record<string, string>;
    for (const [key, value] of Object.entries(map)) {
      const existing = await store.get(key);
      if (existing === null) await store.put(key, value);
    }
    await rename(jsonPath, `${jsonPath}.migrated`);
    console.log(
      `[imap-label-store] migrated ${Object.keys(map).length} entries from ${jsonPath}`,
    );
  } catch (error) {
    console.error(`[imap-label-store] failed to migrate ${jsonPath}:`, error);
  }
};
