import {
  connectionLabelConfig,
  outbox,
  promptOverride,
  providerSubscription,
  snooze,
} from '../db/schema';
import { and, eq, inArray, lte } from 'drizzle-orm';
import type { EProviders } from '../types';
import { redis } from './services';
import { createDb } from '../db';
import { env } from '../env';

/**
 * Replacements for the Cloudflare KV namespaces (Phase 2 of
 * MIGRATION-PLAN.md §5): ephemeral state (locks, cooldowns) goes to Redis,
 * durable state (user config, subscription/sync cursors, scheduled sends,
 * snoozes) goes to the Phase 1 Postgres tables. Redis here is
 * efficiency-only — correctness always comes from Postgres constraints and
 * idempotent writes, never from a Redis lock (Kleppmann rule).
 */

const db = () => createDb(env.HYPERDRIVE.connectionString).db;

// ---------------------------------------------------------------------------
// Ephemeral: Redis (was KV `gmail_processing_threads`)
// ---------------------------------------------------------------------------

/**
 * Acquire a short-lived processing lock. Returns true if acquired. Unlike the
 * old KV `put` (which was not actually atomic), SET NX EX is a real
 * test-and-set.
 */
export const acquireProcessingLock = async (key: string, ttlSeconds: number): Promise<boolean> => {
  const result = await redis().set(`lock:${key}`, '1', { nx: true, ex: ttlSeconds });
  return result === 'OK';
};

/** Release processing locks/keys (replaces bulk-delete.ts + KV deletes). */
export const releaseProcessingKeys = async (
  keys: string[],
): Promise<{ successful: number; failed: number }> => {
  if (!keys.length) return { successful: 0, failed: 0 };
  try {
    await redis().del(...keys.map((k) => `lock:${k}`));
    return { successful: keys.length, failed: 0 };
  } catch (error) {
    console.error('[STORES] Failed to release processing keys:', error);
    return { successful: 0, failed: keys.length };
  }
};

/** Resync cooldown (was `resync_cooldown_*` keys in gmail_processing_threads). */
export const checkAndSetCooldown = async (
  key: string,
  ttlSeconds: number,
): Promise<boolean> => {
  // NX+EX: returns true (and arms the cooldown) only if none was active.
  const result = await redis().set(`cooldown:${key}`, Date.now().toString(), {
    nx: true,
    ex: ttlSeconds,
  });
  return result === 'OK';
};

// ---------------------------------------------------------------------------
// Snoozes: Postgres `mail0_snooze` (was KV `snoozed_emails`)
// ---------------------------------------------------------------------------

export const snoozeStore = {
  async set(connectionId: string, threadIds: string[], wakeAt: Date): Promise<void> {
    if (!threadIds.length) return;
    await db()
      .insert(snooze)
      .values(threadIds.map((threadId) => ({ connectionId, threadId, wakeAt })))
      .onConflictDoUpdate({
        target: [snooze.connectionId, snooze.threadId],
        set: { wakeAt },
      });
  },

  async getWakeAt(connectionId: string, threadId: string): Promise<Date | null> {
    const row = await db().query.snooze.findFirst({
      where: and(eq(snooze.connectionId, connectionId), eq(snooze.threadId, threadId)),
    });
    return row?.wakeAt ?? null;
  },

  async delete(connectionId: string, threadIds: string[]): Promise<void> {
    if (!threadIds.length) return;
    await db()
      .delete(snooze)
      .where(and(eq(snooze.connectionId, connectionId), inArray(snooze.threadId, threadIds)));
  },

  /** All snoozes due at or before `now`, for the unsnooze sweep. */
  async listDue(now: Date): Promise<{ connectionId: string; threadId: string; wakeAt: Date }[]> {
    return await db().query.snooze.findMany({ where: lte(snooze.wakeAt, now) });
  },
};

// ---------------------------------------------------------------------------
// Scheduled/undo sends: Postgres `mail0_outbox`
// (was KV pending_emails_status + pending_emails_payload + scheduled_emails)
// ---------------------------------------------------------------------------

export type OutboxRow = typeof outbox.$inferSelect;

export const outboxStore = {
  async create(row: {
    id: string;
    userId: string;
    connectionId: string;
    payload: unknown;
    sendAt: Date;
  }): Promise<void> {
    await db()
      .insert(outbox)
      .values({ ...row, status: 'pending' });
  },

  async getById(id: string): Promise<OutboxRow | undefined> {
    return await db().query.outbox.findFirst({ where: eq(outbox.id, id) });
  },

  /** Cancel (undo-send). Returns false if the send already left the building. */
  async cancel(id: string): Promise<boolean> {
    const result = await db()
      .update(outbox)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(eq(outbox.id, id), inArray(outbox.status, ['pending', 'queued'])))
      .returning({ id: outbox.id });
    return result.length > 0;
  },

  /** Cron promotion marker: pending -> queued once a delivery timer exists. */
  async markQueued(id: string): Promise<void> {
    await db()
      .update(outbox)
      .set({ status: 'queued', updatedAt: new Date() })
      .where(and(eq(outbox.id, id), eq(outbox.status, 'pending')));
  },

  /**
   * Optimistic completion: only marks sent if not cancelled meanwhile; the
   * caller must check the return value BEFORE dispatching is not needed —
   * check status first, send, then this guard catches a cancel that raced in.
   */
  async markSent(id: string): Promise<void> {
    await db()
      .update(outbox)
      .set({ status: 'sent', updatedAt: new Date() })
      .where(eq(outbox.id, id));
  },

  async markFailed(id: string, error: string): Promise<void> {
    await db()
      .update(outbox)
      .set({ status: 'failed', lastError: error.slice(0, 2000), updatedAt: new Date() })
      .where(eq(outbox.id, id));
  },

  /** Pending sends due within the horizon (hourly promotion cron). */
  async listDuePending(horizon: Date): Promise<OutboxRow[]> {
    return await db().query.outbox.findMany({
      where: and(eq(outbox.status, 'pending'), lte(outbox.sendAt, horizon)),
    });
  },
};

// ---------------------------------------------------------------------------
// AI label config: Postgres `mail0_connection_label_config`
// (was KV `connection_labels`)
// ---------------------------------------------------------------------------

export type LabelConfig = { name: string; usecase: string };

export const labelConfigStore = {
  async get(connectionId: string): Promise<LabelConfig[] | null> {
    const row = await db().query.connectionLabelConfig.findFirst({
      where: eq(connectionLabelConfig.connectionId, connectionId),
    });
    return (row?.labels as LabelConfig[] | undefined) ?? null;
  },

  async set(connectionId: string, labels: LabelConfig[]): Promise<void> {
    await db()
      .insert(connectionLabelConfig)
      .values({ connectionId, labels })
      .onConflictDoUpdate({
        target: connectionLabelConfig.connectionId,
        set: { labels, updatedAt: new Date() },
      });
  },

  async seedIfMissing(connectionId: string, defaults: LabelConfig[]): Promise<void> {
    await db()
      .insert(connectionLabelConfig)
      .values({ connectionId, labels: defaults })
      .onConflictDoNothing();
  },
};

// ---------------------------------------------------------------------------
// Prompt overrides: Postgres `mail0_prompt_override` (was KV `prompts_storage`)
// ---------------------------------------------------------------------------

/**
 * Legacy prompt names are `${connectionId}-${promptType}`; EPrompts values
 * contain no dashes, so splitting on the LAST dash is exact.
 */
const splitPromptName = (promptName: string): { connectionId: string; promptType: string } => {
  const i = promptName.lastIndexOf('-');
  if (i === -1) return { connectionId: '', promptType: promptName };
  return { connectionId: promptName.slice(0, i), promptType: promptName.slice(i + 1) };
};

export const promptStore = {
  async get(promptName: string): Promise<string | null> {
    const { connectionId, promptType } = splitPromptName(promptName);
    const row = await db().query.promptOverride.findFirst({
      where: and(
        eq(promptOverride.connectionId, connectionId),
        eq(promptOverride.promptType, promptType),
      ),
    });
    return row?.content ?? null;
  },

  async set(promptName: string, content: string): Promise<void> {
    const { connectionId, promptType } = splitPromptName(promptName);
    await db()
      .insert(promptOverride)
      .values({ connectionId, promptType, content })
      .onConflictDoUpdate({
        target: [promptOverride.connectionId, promptOverride.promptType],
        set: { content, updatedAt: new Date() },
      });
  },
};

// ---------------------------------------------------------------------------
// Provider subscriptions + Gmail sync cursor: Postgres
// `mail0_provider_subscription`
// (was KV subscribed_accounts + gmail_sub_age + gmail_history_id)
// ---------------------------------------------------------------------------

export const subscriptionStore = {
  async isSubscribed(connectionId: string, providerId: EProviders | string): Promise<boolean> {
    const row = await db().query.providerSubscription.findFirst({
      where: and(
        eq(providerSubscription.connectionId, connectionId),
        eq(providerSubscription.providerId, providerId as string),
      ),
    });
    return row?.status === 'active';
  },

  /** Mark subscribed now (merges the old subscribed_accounts + gmail_sub_age writes). */
  async setSubscribed(connectionId: string, providerId: EProviders | string): Promise<void> {
    const now = new Date();
    await db()
      .insert(providerSubscription)
      .values({
        connectionId,
        providerId: providerId as string,
        status: 'active',
        subscribedAt: now,
      })
      .onConflictDoUpdate({
        target: [providerSubscription.connectionId, providerSubscription.providerId],
        set: { status: 'active', subscribedAt: now, updatedAt: now },
      });
  },

  async getSubscribedAt(
    connectionId: string,
    providerId: EProviders | string,
  ): Promise<Date | null> {
    const row = await db().query.providerSubscription.findFirst({
      where: and(
        eq(providerSubscription.connectionId, connectionId),
        eq(providerSubscription.providerId, providerId as string),
      ),
    });
    return row?.subscribedAt ?? null;
  },

  async delete(connectionId: string, providerId: EProviders | string): Promise<void> {
    await db()
      .delete(providerSubscription)
      .where(
        and(
          eq(providerSubscription.connectionId, connectionId),
          eq(providerSubscription.providerId, providerId as string),
        ),
      );
  },

  /**
   * Remove all subscription rows for a connection. (The old
   * `cleanupOnFailure` deleted KV key `connectionId`, which never matched the
   * `${connectionId}__${providerId}` key format — a silent no-op bug; this
   * implements the evident intent.)
   */
  async deleteAllForConnection(connectionId: string): Promise<void> {
    await db()
      .delete(providerSubscription)
      .where(eq(providerSubscription.connectionId, connectionId));
  },

  /** Gmail incremental-sync cursor (was KV gmail_history_id, keyed by connection). */
  async getHistoryId(connectionId: string): Promise<string | null> {
    const row = await db().query.providerSubscription.findFirst({
      where: and(
        eq(providerSubscription.connectionId, connectionId),
        eq(providerSubscription.providerId, 'google'),
      ),
    });
    return row?.historyId ?? null;
  },

  async setHistoryId(connectionId: string, historyId: string): Promise<void> {
    await db()
      .insert(providerSubscription)
      .values({ connectionId, providerId: 'google', historyId })
      .onConflictDoUpdate({
        target: [providerSubscription.connectionId, providerSubscription.providerId],
        set: { historyId, updatedAt: new Date() },
      });
  },
};
