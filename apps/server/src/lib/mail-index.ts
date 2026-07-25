import { thread, label, threadLabel } from '../db/schema';
import { eq, and, count, inArray, sql, desc, lt, or, ilike, isNotNull } from 'drizzle-orm';
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
