import { thread, label, threadLabel, folderSyncState, folderMessage } from '../db/schema';
import {
  eq,
  and,
  count,
  inArray,
  notInArray,
  like,
  sql,
  desc,
  lt,
  or,
  ilike,
  isNotNull,
} from 'drizzle-orm';
import type { Sender } from '../types';
import { createDb } from '../db';
import { env } from '../env';

/**
 * Per-connection thread/label index on Postgres (Phase 3 of
 * MIGRATION-PLAN.md §2). Replaces the per-shard DO-SQLite store
 * (routes/agent/db) — every function scopes by connectionId; the 8 GiB
 * shard model is gone.
 *
 * Row shape parity: the SQLite schema had `id` == `threadId` duplicated;
 * Postgres keys on (connectionId, threadId) and exposes `id` as an alias so
 * ZeroDriver-era callers keep working. `latestReceivedOn` is a real
 * timestamp in Postgres; the API keeps ISO strings (including pageToken
 * cursors) for compatibility.
 */

const db = () => createDb(env.HYPERDRIVE.connectionString).db;

export type IndexThread = {
  id: string;
  threadId: string;
  providerId: string | null;
  latestSender: Sender | null;
  latestReceivedOn: string | null;
  latestSubject: string | null;
};

export type IndexLabel = { id: string; name: string; color: string | null };

const toIndexThread = (row: {
  threadId: string;
  providerId: string | null;
  latestSender: unknown;
  latestReceivedOn: Date | null;
  latestSubject: string | null;
}): IndexThread => ({
  id: row.threadId,
  threadId: row.threadId,
  providerId: row.providerId,
  latestSender: (row.latestSender as Sender | null) ?? null,
  latestReceivedOn: row.latestReceivedOn ? row.latestReceivedOn.toISOString() : null,
  latestSubject: row.latestSubject,
});

const threadSelect = {
  threadId: thread.threadId,
  providerId: thread.providerId,
  latestSender: thread.latestSender,
  latestReceivedOn: thread.latestReceivedOn,
  latestSubject: thread.latestSubject,
} as const;

const parseCursor = (pageToken: string): Date | null => {
  const d = new Date(pageToken);
  return isNaN(d.getTime()) ? null : d;
};

/** Upsert missing label rows (id used as name/color defaults, as before). */
const ensureLabels = async (connectionId: string, labelIds: string[]): Promise<void> => {
  if (!labelIds.length) return;
  await db()
    .insert(label)
    .values(labelIds.map((id) => ({ connectionId, id, name: id, color: '#000000' })))
    .onConflictDoNothing();
};

/** Upsert a thread and (optionally) attach labels. */
export const upsertThread = async (
  connectionId: string,
  data: {
    threadId: string;
    providerId: string;
    latestSender: unknown;
    latestReceivedOn: string;
    latestSubject: string | null;
  },
  labelIds?: string[],
): Promise<void> => {
  const values = {
    connectionId,
    threadId: data.threadId,
    providerId: data.providerId,
    latestSender: data.latestSender,
    latestReceivedOn: new Date(data.latestReceivedOn),
    latestSubject: data.latestSubject,
    updatedAt: new Date(),
  };
  await db()
    .insert(thread)
    .values(values)
    .onConflictDoUpdate({
      target: [thread.connectionId, thread.threadId],
      set: {
        providerId: values.providerId,
        latestSender: values.latestSender,
        latestReceivedOn: values.latestReceivedOn,
        latestSubject: values.latestSubject,
        updatedAt: values.updatedAt,
      },
    });

  // Tag-derived labels (UNREAD/STARRED/$keywords) are wholly derived from
  // the fresh message flags, so stale ones must be REMOVED — add-only label
  // writes could never clear UNREAD after a \Seen flip (defect exposed by
  // the Phase 6.2 incremental-equivalence oracle; it silently affected the
  // full-refetch path too). Folder labels (each folder's own sync
  // contributes its own) and app-managed labels (TRASH/SNOOZED) stay
  // add-only here.
  const kept = labelIds ?? [];
  await db()
    .delete(threadLabel)
    .where(
      and(
        eq(threadLabel.connectionId, connectionId),
        eq(threadLabel.threadId, data.threadId),
        or(inArray(threadLabel.labelId, ['UNREAD', 'STARRED']), like(threadLabel.labelId, '$%')),
        kept.length ? notInArray(threadLabel.labelId, kept) : sql`true`,
      ),
    );

  if (labelIds?.length) {
    await ensureLabels(connectionId, labelIds);
    // ON CONFLICT DO NOTHING is the concurrency hardening the DO-SQLite
    // version lacked (it relied on DO serialization; see MIGRATION-PLAN §1).
    await db()
      .insert(threadLabel)
      .values(labelIds.map((labelId) => ({ connectionId, threadId: data.threadId, labelId })))
      .onConflictDoNothing();
  }
};

export const getIndexedThread = async (
  connectionId: string,
  threadId: string,
): Promise<IndexThread | null> => {
  const [row] = await db()
    .select(threadSelect)
    .from(thread)
    .where(and(eq(thread.connectionId, connectionId), eq(thread.threadId, threadId)));
  return row ? toIndexThread(row) : null;
};

export const deleteIndexedThread = async (
  connectionId: string,
  threadId: string,
): Promise<void> => {
  await db()
    .delete(thread)
    .where(and(eq(thread.connectionId, connectionId), eq(thread.threadId, threadId)));
};

/** Wipe a connection's entire index (forceReSync). */
export const clearIndex = async (connectionId: string): Promise<void> => {
  await db().delete(threadLabel).where(eq(threadLabel.connectionId, connectionId));
  await db().delete(thread).where(eq(thread.connectionId, connectionId));
  await db().delete(label).where(eq(label.connectionId, connectionId));
};

export const countIndexedThreads = async (connectionId: string): Promise<number> => {
  const [row] = await db()
    .select({ count: count() })
    .from(thread)
    .where(eq(thread.connectionId, connectionId));
  return row?.count ?? 0;
};

export const countThreadsByLabels = async (
  connectionId: string,
  labelIds: string[],
): Promise<{ labelId: string; count: number }[]> => {
  if (!labelIds.length) return [];
  return await db()
    .select({ labelId: threadLabel.labelId, count: count() })
    .from(threadLabel)
    .where(and(eq(threadLabel.connectionId, connectionId), inArray(threadLabel.labelId, labelIds)))
    .groupBy(threadLabel.labelId);
};

export const getThreadLabels = async (
  connectionId: string,
  threadId: string,
): Promise<IndexLabel[]> => {
  return await db()
    .select({ id: label.id, name: label.name, color: label.color })
    .from(label)
    .innerJoin(
      threadLabel,
      and(
        eq(threadLabel.connectionId, label.connectionId),
        eq(threadLabel.labelId, label.id),
      ),
    )
    .where(and(eq(label.connectionId, connectionId), eq(threadLabel.threadId, threadId)));
};

export const modifyThreadLabels = async (
  connectionId: string,
  threadId: string,
  addLabelIds: string[],
  removeLabelIds: string[],
): Promise<{ addedLabels: string[]; removedLabels: string[] }> => {
  if (removeLabelIds.length) {
    await db()
      .delete(threadLabel)
      .where(
        and(
          eq(threadLabel.connectionId, connectionId),
          eq(threadLabel.threadId, threadId),
          inArray(threadLabel.labelId, removeLabelIds),
        ),
      );
  }
  if (addLabelIds.length) {
    await ensureLabels(connectionId, addLabelIds);
    await db()
      .insert(threadLabel)
      .values(addLabelIds.map((labelId) => ({ connectionId, threadId, labelId })))
      .onConflictDoNothing();
  }
  return { addedLabels: addLabelIds, removedLabels: removeLabelIds };
};

export const deleteSpamThreads = async (
  connectionId: string,
): Promise<{ deletedCount: number }> => {
  const spam = await db()
    .select({ threadId: threadLabel.threadId })
    .from(threadLabel)
    .where(and(eq(threadLabel.connectionId, connectionId), eq(threadLabel.labelId, 'SPAM')));
  if (!spam.length) return { deletedCount: 0 };
  const ids = spam.map((r) => r.threadId);
  await db()
    .delete(thread)
    .where(and(eq(thread.connectionId, connectionId), inArray(thread.threadId, ids)));
  await db()
    .delete(threadLabel)
    .where(and(eq(threadLabel.connectionId, connectionId), inArray(threadLabel.threadId, ids)));
  return { deletedCount: ids.length };
};

export const getAllSubjects = async (connectionId: string): Promise<string[]> => {
  const rows = await db()
    .select({ latestSubject: thread.latestSubject })
    .from(thread)
    .where(eq(thread.connectionId, connectionId));
  return rows.map((r) => r.latestSubject).filter((s): s is string => s !== null);
};

export const getRecentSenders = async (
  connectionId: string,
  limit = 100,
): Promise<{ latestSender: Sender | null; latestReceivedOn: string | null }[]> => {
  const rows = await db()
    .select({ latestSender: thread.latestSender, latestReceivedOn: thread.latestReceivedOn })
    .from(thread)
    .where(and(eq(thread.connectionId, connectionId), isNotNull(thread.latestSender)))
    .orderBy(desc(thread.latestReceivedOn))
    .limit(limit);
  return rows.map((r) => ({
    latestSender: (r.latestSender as Sender | null) ?? null,
    latestReceivedOn: r.latestReceivedOn ? r.latestReceivedOn.toISOString() : null,
  }));
};

/**
 * Approximate on-disk size of a connection's index rows (Phase 3.4: the
 * Do_State `storageSize` replacement for the old per-shard SQLite
 * databaseSize — which also only covered the index, since bodies lived in
 * R2/blobs).
 */
export const getIndexSizeBytes = async (connectionId: string): Promise<number> => {
  const result = await db().execute(sql`
    SELECT (
      COALESCE((SELECT SUM(pg_column_size(t.*)) FROM ${thread} t
                WHERE t.connection_id = ${connectionId}), 0)
      + COALESCE((SELECT SUM(pg_column_size(tl.*)) FROM ${threadLabel} tl
                  WHERE tl.connection_id = ${connectionId}), 0)
      + COALESCE((SELECT SUM(pg_column_size(l.*)) FROM ${label} l
                  WHERE l.connection_id = ${connectionId}), 0)
    )::bigint AS bytes
  `);
  const row = (result as unknown as { bytes: string | number }[])[0];
  return Number(row?.bytes ?? 0);
};

/**
 * Unified thread query: label filtering (any/all), text search, keyset
 * pagination on latestReceivedOn. Collapses the six special cases of the
 * DO-SQLite queryThreads into one indexed query.
 */
export const findThreads = async (
  connectionId: string,
  params: {
    labelIds?: string[];
    searchText?: string;
    pageToken?: string;
    maxResults: number;
    requireAllLabels?: boolean;
  },
): Promise<{ threads: IndexThread[]; nextPageToken: string | null }> => {
  const { labelIds = [], searchText, pageToken, maxResults, requireAllLabels = false } = params;

  const conditions = [eq(thread.connectionId, connectionId)];

  if (labelIds.length) {
    if (requireAllLabels) {
      conditions.push(
        sql`(SELECT count(*) FROM ${threadLabel}
             WHERE ${threadLabel.connectionId} = ${connectionId}
               AND ${threadLabel.threadId} = ${thread.threadId}
               AND ${threadLabel.labelId} IN ${labelIds}) = ${labelIds.length}`,
      );
    } else {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM ${threadLabel}
             WHERE ${threadLabel.connectionId} = ${connectionId}
               AND ${threadLabel.threadId} = ${thread.threadId}
               AND ${threadLabel.labelId} IN ${labelIds})`,
      );
    }
  }

  if (searchText) {
    const pattern = `%${searchText}%`;
    const senderMatch = sql`${thread.latestSender}::text ILIKE ${pattern}`;
    const subjectMatch = ilike(thread.latestSubject, pattern);
    conditions.push(or(subjectMatch, senderMatch)!);
  }

  if (pageToken) {
    const cursor = parseCursor(pageToken);
    if (cursor) conditions.push(lt(thread.latestReceivedOn, cursor));
  }

  const rows = await db()
    .select(threadSelect)
    .from(thread)
    .where(and(...conditions))
    .orderBy(desc(thread.latestReceivedOn))
    .limit(maxResults + 1);

  const hasNextPage = rows.length > maxResults;
  const page = hasNextPage ? rows.slice(0, maxResults) : rows;
  const last = page[page.length - 1];
  const nextPageToken =
    hasNextPage && last?.latestReceivedOn ? last.latestReceivedOn.toISOString() : null;

  return { threads: page.map(toIndexThread), nextPageToken };
};

// ---------------------------------------------------------------------------
// Folder sync checkpoints (Phase 4 §3): the sync-folder job persists its
// provider pageToken after every page so a BullMQ retry resumes the page
// loop instead of restarting it. pageToken = null means "no sync in
// progress" (the last run completed).
// ---------------------------------------------------------------------------

export type FolderSyncRow = typeof folderSyncState.$inferSelect;

/** Full per-folder sync-state row (Phase 6.1 guard + 6.2 ladder). */
export const getFolderSyncRow = async (
  connectionId: string,
  folder: string,
): Promise<FolderSyncRow | undefined> => {
  return await db().query.folderSyncState.findFirst({
    where: and(
      eq(folderSyncState.connectionId, connectionId),
      eq(folderSyncState.folder, folder),
    ),
  });
};

export const upsertFolderSyncState = async (
  connectionId: string,
  folder: string,
  values: Partial<
    Pick<
      FolderSyncRow,
      | 'uidValidity'
      | 'uidNext'
      | 'highestModseq'
      | 'pageToken'
      | 'lastSyncedAt'
      | 'resyncCount'
      | 'syncMode'
    >
  >,
): Promise<void> => {
  const now = new Date();
  await db()
    .insert(folderSyncState)
    .values({ connectionId, folder, ...values, updatedAt: now })
    .onConflictDoUpdate({
      target: [folderSyncState.connectionId, folderSyncState.folder],
      set: { ...values, updatedAt: now },
    });
};

/** Thread ids carrying a folder label — the purge set for a UIDVALIDITY change. */
export const listThreadIdsByLabel = async (
  connectionId: string,
  labelId: string,
): Promise<string[]> => {
  const rows = await db()
    .select({ threadId: threadLabel.threadId })
    .from(threadLabel)
    .where(and(eq(threadLabel.connectionId, connectionId), eq(threadLabel.labelId, labelId)));
  return rows.map((r) => r.threadId);
};

// ---------------------------------------------------------------------------
// Folder UID -> thread ledger (Phase 6.2). Bounded by the sync window; the
// incremental path cannot attribute a DELETED message to its thread any
// other way (the message can no longer be fetched).
// ---------------------------------------------------------------------------

export type LedgerEntry = { uid: number; threadId: string; flags: string };

export const getFolderLedger = async (
  connectionId: string,
  folder: string,
): Promise<LedgerEntry[]> => {
  const rows = await db()
    .select({ uid: folderMessage.uid, threadId: folderMessage.threadId, flags: folderMessage.flags })
    .from(folderMessage)
    .where(and(eq(folderMessage.connectionId, connectionId), eq(folderMessage.folder, folder)));
  return rows;
};

/** Wholesale ledger replacement after a full sync's snapshot. */
export const replaceFolderLedger = async (
  connectionId: string,
  folder: string,
  entries: LedgerEntry[],
): Promise<void> => {
  await db()
    .delete(folderMessage)
    .where(and(eq(folderMessage.connectionId, connectionId), eq(folderMessage.folder, folder)));
  if (entries.length) {
    await db()
      .insert(folderMessage)
      .values(entries.map((e) => ({ connectionId, folder, ...e })));
  }
};

/** Incremental ledger update: drop vanished UIDs, upsert changed/new ones. */
export const applyFolderLedgerDelta = async (
  connectionId: string,
  folder: string,
  changes: { vanishedUids: number[]; messages: LedgerEntry[] },
): Promise<void> => {
  if (changes.vanishedUids.length) {
    await db()
      .delete(folderMessage)
      .where(
        and(
          eq(folderMessage.connectionId, connectionId),
          eq(folderMessage.folder, folder),
          inArray(folderMessage.uid, changes.vanishedUids),
        ),
      );
  }
  for (const entry of changes.messages) {
    await db()
      .insert(folderMessage)
      .values({ connectionId, folder, ...entry })
      .onConflictDoUpdate({
        target: [folderMessage.connectionId, folderMessage.folder, folderMessage.uid],
        set: { threadId: entry.threadId, flags: entry.flags, updatedAt: new Date() },
      });
  }
};

export const clearFolderLedger = async (connectionId: string, folder?: string): Promise<void> => {
  await db()
    .delete(folderMessage)
    .where(
      folder
        ? and(eq(folderMessage.connectionId, connectionId), eq(folderMessage.folder, folder))
        : eq(folderMessage.connectionId, connectionId),
    );
};

/** Full sync-state reset (forceReSync): cursors AND ledger go together. */
export const clearFolderSyncData = async (connectionId: string): Promise<void> => {
  await db().delete(folderSyncState).where(eq(folderSyncState.connectionId, connectionId));
  await clearFolderLedger(connectionId);
};

export const getFolderSyncPageToken = async (
  connectionId: string,
  folder: string,
): Promise<string | null> => {
  const rows = await db()
    .select({ pageToken: folderSyncState.pageToken })
    .from(folderSyncState)
    .where(and(eq(folderSyncState.connectionId, connectionId), eq(folderSyncState.folder, folder)))
    .limit(1);
  return rows[0]?.pageToken ?? null;
};

export const setFolderSyncPageToken = async (
  connectionId: string,
  folder: string,
  pageToken: string | null,
): Promise<void> => {
  const now = new Date();
  await db()
    .insert(folderSyncState)
    .values({
      connectionId,
      folder,
      pageToken,
      lastSyncedAt: pageToken === null ? now : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [folderSyncState.connectionId, folderSyncState.folder],
      set: {
        pageToken,
        updatedAt: now,
        ...(pageToken === null ? { lastSyncedAt: now } : {}),
      },
    });
};
