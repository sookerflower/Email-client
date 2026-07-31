import type { IGetThreadResponse, IGetThreadsResponse } from './driver/types';
import { OutgoingMessageType } from '../routes/agent/types';
import { getContext } from 'hono/context-storage';
import { connection } from '../db/schema';
import { defaultPageSize } from './utils';
import type { HonoContext } from '../ctx';
import { createDriver } from './driver';
import { eq } from 'drizzle-orm';
import { UserDb } from './user-db';
import { createDb } from '../db';
import { env } from '../env';

export const getZeroDB = async (userId: string) => {
  // Phase 1 (MIGRATION-PLAN.md): the ZeroDB Durable Object was a thin RPC
  // facade over Postgres. UserDb is the same method surface as a plain class,
  // used on both Node and workerd — no DO hop on either runtime.
  return new UserDb(userId);
};

/**
 * Phase 3 (MIGRATION-PLAN.md §2): the per-(connection, shard) ZeroDriver DOs,
 * the ShardRegistry, dormroom addressing, the 8 GiB shard-selection loop, and
 * the Effect aggregators/racers are all deleted — Postgres has no size cap,
 * so one MailEngine per connection replaces N shards. The `{ stub }` wrapper
 * shape is kept so the ~40 existing call sites stay unchanged.
 */
export const getZeroAgent = async (connectionId: string, _executionCtx?: unknown) => {
  const { getMailEngine } = await import('./mail-engine');
  const engine = await getMailEngine(connectionId);
  return { stub: engine };
};

export const getThread = async (
  connectionId: string,
  threadId: string,
): Promise<{ result: IGetThreadResponse }> => {
  const { getMailEngine } = await import('./mail-engine');
  const engine = await getMailEngine(connectionId);
  const result = await engine.getThreadFromDB(threadId, true);
  return { result };
};

/**
 * Apply label changes to threads, WRITE-THROUGH to IMAP.
 *
 * Replaces the old `modifyThreadLabelsInDB`, which was deliberately DELETED
 * rather than aliased: it wrote to Postgres only, so every user action --
 * star, read/unread, archive, bin, spam, labels -- produced index state the
 * IMAP server had never heard of. That state reverted on any forced resync
 * and was destroyed outright by a DB wipe. Leaving an alias behind would let
 * a call site quietly keep using it.
 *
 * Takes an ARRAY of thread ids on purpose: the driver batches a single IMAP
 * round trip per operation, so callers should hand it the whole set rather
 * than mapping one call per thread.
 *
 * Throws on IMAP failure. That is the point -- the client's optimistic update
 * needs a real error to roll back from.
 */
export const applyThreadLabels = async (
  connectionId: string,
  threadIds: string[],
  addLabels: string[],
  removeLabels: string[],
) => {
  const { getMailEngine } = await import('./mail-engine');
  const engine = await getMailEngine(connectionId);
  const result = await engine.applyLabels(threadIds, addLabels, removeLabels);
  await sendDoState(connectionId);
  return result;
};

export const forceReSync = async (connectionId: string) => {
  const { getMailEngine } = await import('./mail-engine');
  const engine = await getMailEngine(connectionId);
  return engine.forceReSync();
};

export const reSyncThread = async (connectionId: string, threadId: string) => {
  try {
    const { getMailEngine } = await import('./mail-engine');
    const engine = await getMailEngine(connectionId);
    await engine.syncThread({ threadId });
  } catch (error) {
    console.error(`[MailEngine] Failed to re-sync thread ${threadId}`, error);
  }
};

export const getThreadsFromDB = async (
  connectionId: string,
  params: {
    labelIds?: string[];
    folder?: string;
    q?: string;
    maxResults?: number;
    pageToken?: string;
  },
): Promise<IGetThreadsResponse> => {
  void sendDoState(connectionId);
  const { getMailEngine } = await import('./mail-engine');
  const engine = await getMailEngine(connectionId);
  return await engine.getThreadsFromDB({
    ...params,
    maxResults: params.maxResults ?? defaultPageSize,
  });
};

export const getDatabaseSize = async (connectionId: string): Promise<number> => {
  const { getMailEngine } = await import('./mail-engine');
  const engine = await getMailEngine(connectionId);
  return engine.getDatabaseSize();
};

export const deleteAllSpam = async (connectionId: string) => {
  const { getMailEngine } = await import('./mail-engine');
  const engine = await getMailEngine(connectionId);
  return await engine.deleteAllSpam();
};

type CountResult = { label: string; count: number };

const getCounts = async (connectionId: string): Promise<CountResult[]> => {
  const { getMailEngine } = await import('./mail-engine');
  const engine = await getMailEngine(connectionId);
  return await engine.count();
};

/**
 * Push storage/count state to connected clients via the Phase 5 beacon
 * layer (Redis pub/sub -> SSE). Payload-carrying: the data rides in the
 * message itself, so there is no publish-after-commit concern here.
 */
export const sendDoState = async (connectionId: string) => {
  try {
    const [counts, storageSize] = await Promise.all([
      getCounts(connectionId),
      getDatabaseSize(connectionId),
    ]);
    // Wire shape unchanged from the DO era — the client destructures
    // { isSyncing, syncingFolders, storageSize, counts, shards }. Only the
    // numbers' provenance changed (Postgres); shards is 0 forever.
    const { getMailEngine } = await import('./mail-engine');
    const engine = await getMailEngine(connectionId);
    engine.broadcast({
      type: OutgoingMessageType.Do_State,
      isSyncing: false,
      syncingFolders: ['inbox'],
      storageSize,
      counts,
      shards: 0,
    });
  } catch (error) {
    console.error(`[sendDoState] Failed to send do state for connection ${connectionId}:`, error);
  }
};

export const getActiveConnection = async () => {
  const c = getContext<HonoContext>();
  const { sessionUser, auth } = c.var;
  if (!sessionUser) throw new Error('Session Not Found');

  const db = await getZeroDB(sessionUser.id);
  const userData = await db.findUser();

  if (userData?.defaultConnectionId) {
    const activeConnection = await db.findUserConnection(userData.defaultConnectionId);
    if (activeConnection) return activeConnection;
  }

  const firstConnection = await db.findFirstConnection();
  if (!firstConnection) {
    try {
      if (auth) {
        await auth.api.revokeSession({ headers: c.req.raw.headers });
        await auth.api.signOut({ headers: c.req.raw.headers });
      }
    } catch (err) {
      console.warn(`[getActiveConnection] Session cleanup failed for user ${sessionUser.id}:`, err);
    }
    console.error(`No connections found for user ${sessionUser.id}`);
    throw new Error('No connections found for user');
  }

  return firstConnection;
};

export const connectionToDriver = (activeConnection: typeof connection.$inferSelect) => {
  // IMAP/SMTP provider authenticates with host/port + username/password rather
  // than OAuth tokens; the plaintext password is never decrypted here (that
  // happens in the Node sidecar) — only the ciphertext is passed through.
  if (activeConnection.providerId === 'imap') {
    if (
      !activeConnection.imapHost ||
      activeConnection.imapPort == null ||
      !activeConnection.smtpHost ||
      activeConnection.smtpPort == null ||
      !activeConnection.username ||
      !activeConnection.passwordEncrypted
    ) {
      throw new Error(`Invalid imap connection ${JSON.stringify(activeConnection?.id)}`);
    }
    return createDriver('imap', {
      auth: {
        userId: activeConnection.userId,
        accessToken: '',
        refreshToken: '',
        email: activeConnection.email,
        connectionId: activeConnection.id,
        imap: {
          imapHost: activeConnection.imapHost,
          imapPort: activeConnection.imapPort,
          imapSecure: activeConnection.imapSecure ?? true,
          smtpHost: activeConnection.smtpHost,
          smtpPort: activeConnection.smtpPort,
          smtpSecure: activeConnection.smtpSecure ?? activeConnection.smtpPort === 465,
          username: activeConnection.username,
          passwordEncrypted: activeConnection.passwordEncrypted,
          allowInsecureTls: activeConnection.imapAllowInsecureTls ?? false,
        },
      },
    });
  }

  if (!activeConnection.accessToken || !activeConnection.refreshToken) {
    throw new Error(`Invalid connection ${JSON.stringify(activeConnection?.id)}`);
  }

  return createDriver(activeConnection.providerId, {
    auth: {
      userId: activeConnection.userId,
      accessToken: activeConnection.accessToken,
      refreshToken: activeConnection.refreshToken,
      email: activeConnection.email,
    },
  });
};

export const verifyToken = async (token: string) => {
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to verify token: ${await response.text()}`);
  }

  const data = (await response.json()) as any;
  return !!data;
};

export const resetConnection = async (connectionId: string) => {
  const { db, conn } = createDb(env.DATABASE_URL);
  await db
    .update(connection)
    .set({
      accessToken: null,
      refreshToken: null,
    })
    .where(eq(connection.id, connectionId));
  await conn.end();
};
