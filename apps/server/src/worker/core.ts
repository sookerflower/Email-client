/**
 * Mail worker core (Phase 3.2 of MIGRATION-PLAN.md): the IMAP/SMTP transport
 * engine extracted from imap-sidecar/server.ts so the legacy sidecar wrapper
 * and the new worker entrypoint share one implementation.
 *
 * Owns ALL IMAP sockets in the deployment: the driver cache serving /rpc and
 * (when enabled) the per-connection IDLE watchers. The api process holds no
 * sockets — its MailEngine talks to /rpc via ImapSmtpProxyMailManager, which
 * keeps the per-account connection count bounded (the fail2ban lesson).
 *
 * `watchersEnabled` is consulted dynamically on every driver use and by a
 * periodic reconciler — in the worker it is wired to the Redis leader lease
 * (3.2.3), so losing leadership stops watchers and gaining it starts them.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { ImapFlow } from 'imapflow';

import { createPgLabelStore, migrateJsonLabelStore } from '../lib/imap-label-store';
import { ImapSmtpMailManager, type LabelStore } from '../lib/driver/imap';
import { createSocketCensus } from './socket-census';
import { decryptPassword } from '../lib/driver/imap-crypto';
import type { ManagerConfig } from '../lib/driver/types';
import { connection as connectionSchema } from '../db/schema';
import { createDb } from '../db';
import { eq } from 'drizzle-orm';

export interface MailWorkerOptions {
  port: number;
  host: string;
  secret: string;
  encryptionKey: string;
  databaseUrl: string;
  notifyUrl: string;
  pollSeconds: number;
  /** Consulted dynamically; false = serve /rpc but hold no IDLE watchers. */
  watchersEnabled: () => boolean;
  /**
   * Phase 4: when set, new-mail events enqueue a sync-folder job directly
   * (the worker process hosts the processors) instead of POSTing the api's
   * /api/public/imap-notify. The HTTP path remains as the fallback for the
   * legacy sidecar wrapper, which has no queue runtime.
   */
  enqueueSync?: (connectionId: string, folder: string) => Promise<void>;
  /**
   * Phase 4 §4: outbox delivery timers. The api process cannot import
   * BullMQ (workerd bundle), so its send_email_queue shim POSTs
   * /enqueue-send and /cancel-send here. Absent on the legacy sidecar
   * (routes answer 501).
   */
  enqueueSend?: (messageId: string, connectionId: string, sendAt: number) => Promise<void>;
  cancelSend?: (messageId: string) => Promise<void>;
  /** Optional legacy .label-store.json to import once at boot. */
  legacyLabelStorePath?: string;
}

const IDLE_MS = 5 * 60 * 1000; // dispose a driver after 5 min idle
const NOTIFY_DEBOUNCE_MS = 2000;
const RECONNECT_DELAY_MS = 60 * 1000;
const WATCHER_RECONCILE_MS = 5000;

interface CacheEntry {
  driver: ImapSmtpMailManager;
  timer: NodeJS.Timeout;
}

interface Watcher {
  connectionId: string;
  credDigest: string;
  client: ImapFlow | null;
  stopped: boolean;
  notifyTimer?: NodeJS.Timeout;
  pollTimer?: NodeJS.Timeout;
  imap: NonNullable<ManagerConfig['auth']['imap']>;
  password: string;
}

export interface MailWorker {
  server: Server;
  watcherCount(): number;
  idlingCount(): number;
  stopAllWatchers(reason: string): void;
  /** Start watchers for every IMAP connection in Postgres (new leader). */
  bootstrapWatchers(): Promise<number>;
  close(): Promise<void>;
}

export function startMailWorker(opts: MailWorkerOptions): MailWorker {
  if (!opts.secret) throw new Error('secret is required');
  if (!opts.encryptionKey) throw new Error('encryptionKey is required');
  if (!opts.databaseUrl) throw new Error('databaseUrl is required');

  const labelStore: LabelStore = createPgLabelStore(opts.databaseUrl);
  if (opts.legacyLabelStorePath) {
    void migrateJsonLabelStore(opts.legacyLabelStorePath, labelStore);
  }

  // --- Driver cache: reuse IMAP connections per mailbox ----------------------
  const cache = new Map<string, CacheEntry>();

  // Socket census (Phase 6.3): every mail-server socket the worker holds,
  // per account, with a running max-concurrent-IMAP the E2E suites assert on.
  const census = createSocketCensus();
  const accountKey = (imap: NonNullable<ManagerConfig['auth']['imap']>) =>
    `${imap.username}@${imap.imapHost}`;

  // Key includes a digest of the DECRYPTED password so a real password
  // change (or a retry after a typo) never reuses a driver built with stale
  // credentials — while re-encryption of the SAME password (every
  // Custom-IMAP login re-encrypts with a fresh IV) maps to the same key.
  // Digesting the ciphertext here caused login churn: each login orphaned
  // the cached driver (an open IMAP socket, up to 5 min) and restarted the
  // IDLE watcher for nothing (Phase 6.3).
  const accountPrefix = (imap: NonNullable<ManagerConfig['auth']['imap']>) =>
    `${imap.username}@${imap.imapHost}:${imap.imapPort}#`;
  const cacheKey = (imap: NonNullable<ManagerConfig['auth']['imap']>, password: string) =>
    `${accountPrefix(imap)}${createHash('sha256').update(password).digest('base64url').slice(0, 16)}`;

  // In-flight disposals by cache key: a rebuild for the same account must
  // await the old socket's teardown before connecting (never two concurrent
  // driver connections for one account — the 3.2 invariant, now enforced on
  // the idle-timer eviction path too, not just the reconnect retry).
  const disposing = new Map<string, Promise<void>>();

  const evict = (key: string): Promise<void> => {
    const entry = cache.get(key);
    if (!entry) return disposing.get(key) ?? Promise.resolve();
    cache.delete(key);
    clearTimeout(entry.timer);
    const teardown = entry.driver
      .dispose()
      .catch(() => undefined)
      .then(() => {
        if (disposing.get(key) === teardown) disposing.delete(key);
      });
    disposing.set(key, teardown);
    return teardown;
  };

  // Per-ACCOUNT operation serialization (Phase 6.2, widened in 6.3). Every
  // /rpc call is one complete driver method, but different callers (worker
  // jobs, api tRPC, E2E polling) share ONE cached IMAP connection — and a
  // concurrent op that opens a different mailbox between another op's
  // commands makes multi-fetch sequences read the WRONG mailbox (observed
  // live: a folder delta's uid scan returned another folder's uids,
  // producing false "vanished" messages and wrongful thread removals).
  // Serializing whole methods makes each sequence atomic w.r.t. selection.
  // 6.3 keys the chain on the ACCOUNT (not the credential-digested cache
  // key) and runs driverFor INSIDE it, so cache rebuilds and same-account
  // evictions also serialize against in-flight ops — a credential change
  // can never tear a socket out from under a running method and let old
  // and new drivers hold two connections at once.
  const opChains = new Map<string, Promise<unknown>>();
  const withDriverLock = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = opChains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    opChains.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  };

  /**
   * Errors that mean "the cached IMAP connection is dead", not "the request
   * is wrong": imapflow surfaces post-drop command failures as bare
   * `Command failed` / NoConnection, plus the usual socket error family.
   * Auth and argument errors deliberately do NOT match — retrying those on
   * a fresh connection would double the load for a deterministic failure.
   */
  const isConnectionError = (error: Error & { code?: string }): boolean =>
    /command failed|noconnection|connection not available|unexpected close|connection closed|socket|econnreset|epipe|etimedout|not usable|greeting never received/i.test(
      `${error.code ?? ''} ${error.message ?? ''}`,
    );

  async function driverFor(
    auth: ManagerConfig['auth'],
  ): Promise<{ driver: ImapSmtpMailManager; key: string }> {
    const imap = auth.imap;
    if (!imap) throw new Error('auth.imap missing');

    const password =
      imap.password ??
      (imap.passwordEncrypted
        ? await decryptPassword(imap.passwordEncrypted, opts.encryptionKey)
        : undefined);
    if (!password) throw new Error('No password (plaintext or passwordEncrypted) provided');

    // Any driver use for a known connection also (re-)registers its new-mail
    // watcher — continuous sync stays self-healing across restarts. Gated on
    // watchersEnabled so a non-leader worker serves /rpc without IDLE sockets.
    if (auth.connectionId && opts.watchersEnabled()) ensureWatcher(auth, password);

    const key = cacheKey(imap, password);
    const existing = cache.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => void evict(key), IDLE_MS);
      return { driver: existing.driver, key };
    }

    // A REAL credential change strands the old entry under its old digest
    // with an open IMAP socket — evict any same-account siblings, and await
    // every pending same-account teardown, before connecting a replacement
    // (the ≤2-IMAP-sockets-per-account ceiling has no allowance for a
    // "briefly both" window).
    const prefix = accountPrefix(imap);
    const teardowns: Promise<void>[] = [];
    for (const staleKey of Array.from(cache.keys())) {
      if (staleKey.startsWith(prefix) && staleKey !== key) teardowns.push(evict(staleKey));
    }
    for (const [pendingKey, pending] of disposing) {
      if (pendingKey.startsWith(prefix)) teardowns.push(pending);
    }
    if (teardowns.length) await Promise.all(teardowns);

    const driver = new ImapSmtpMailManager(
      { auth: { ...auth, imap: { ...imap, password } } },
      {
        labelStore,
        census: { open: (kind) => census.open(accountKey(imap), kind === 'imap' ? 'driver' : 'smtp') },
      },
    );
    const timer = setTimeout(() => void evict(key), IDLE_MS);
    cache.set(key, { driver, timer });
    return { driver, key };
  }

  // --- New-mail watchers (IMAP IDLE + poll fallback) -------------------------
  const watchers = new Map<string, Watcher>();

  async function notify(connectionId: string): Promise<void> {
    if (opts.enqueueSync) {
      try {
        await opts.enqueueSync(connectionId, 'inbox');
        console.log(`[mail-worker] notify ${connectionId}: sync-folder job enqueued`);
      } catch (error) {
        console.warn(
          `[mail-worker] notify ${connectionId} enqueue failed:`,
          (error as Error).message,
        );
      }
      return;
    }
    try {
      const res = await fetch(opts.notifyUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-imap-sidecar-secret': opts.secret,
        },
        body: JSON.stringify({ connectionId, folder: 'inbox' }),
      });
      console.log(`[mail-worker] notify ${connectionId}: HTTP ${res.status}`);
    } catch (error) {
      console.warn(`[mail-worker] notify ${connectionId} failed:`, (error as Error).message);
    }
  }

  /** Debounced: IMAP servers often emit several events per delivered message. */
  function scheduleNotify(watcher: Watcher): void {
    if (watcher.notifyTimer) clearTimeout(watcher.notifyTimer);
    watcher.notifyTimer = setTimeout(() => void notify(watcher.connectionId), NOTIFY_DEBOUNCE_MS);
  }

  async function runWatcher(watcher: Watcher, predecessorDown: Promise<void>): Promise<void> {
    const { imap, password } = watcher;
    // Never overlap the replaced watcher's socket: wait for its logout (or
    // a bounded grace) before the first connection attempt.
    await Promise.race([predecessorDown, new Promise((r) => setTimeout(r, 5000))]);
    while (!watcher.stopped) {
      const release = census.open(accountKey(imap), 'watcher');
      try {
        const client = new ImapFlow({
          host: imap.imapHost,
          port: imap.imapPort,
          secure: imap.imapSecure,
          auth: { user: imap.username, pass: password },
          logger: false,
          tls: imap.allowInsecureTls ? { rejectUnauthorized: false } : undefined,
        });
        client.on('close', release);
        watcher.client = client;
        client.on('exists', () => scheduleNotify(watcher));
        client.on('expunge', () => scheduleNotify(watcher));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (client as any).on('flags', () => scheduleNotify(watcher));
        client.on('error', (error: Error) => {
          console.warn(`[mail-worker] watcher ${watcher.connectionId} error:`, error.message);
        });

        await client.connect();
        await client.mailboxOpen('INBOX');
        console.log(`[mail-worker] IDLE watching ${watcher.connectionId} (INBOX)`);
        // Catch up on anything that arrived while the watcher was down.
        void notify(watcher.connectionId);
        // Blocks while idling; resolves/rejects when the connection ends.
        await client.idle();
      } catch (error) {
        console.warn(
          `[mail-worker] watcher ${watcher.connectionId} disconnected:`,
          (error as Error).message,
        );
      }
      release();
      watcher.client = null;
      if (watcher.stopped) break;
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
    }
  }

  /** Returns when the watcher's socket is down (logout done or no socket). */
  function stopWatcher(watcher: Watcher): Promise<void> {
    watcher.stopped = true;
    if (watcher.notifyTimer) clearTimeout(watcher.notifyTimer);
    if (watcher.pollTimer) clearInterval(watcher.pollTimer);
    watchers.delete(watcher.connectionId);
    const client = watcher.client;
    watcher.client = null;
    return client ? client.logout().catch(() => undefined) : Promise.resolve();
  }

  function ensureWatcher(auth: ManagerConfig['auth'], password: string): void {
    const imap = auth.imap;
    const connectionId = auth.connectionId;
    if (!imap || !connectionId) return;

    // Digest of the PLAINTEXT credential (6.3): re-encryption of the same
    // password on every Custom-IMAP login used to churn this digest and
    // needlessly restart the IDLE watcher on each login.
    const credDigest = cacheKey(imap, password);
    const existing = watchers.get(connectionId);
    if (existing && existing.credDigest === credDigest) return; // already watching
    // Credentials/host actually changed — restart, awaiting the old socket.
    const predecessorDown = existing ? stopWatcher(existing) : Promise.resolve();

    const watcher: Watcher = {
      connectionId,
      credDigest,
      client: null,
      stopped: false,
      imap,
      password,
    };
    watchers.set(connectionId, watcher);

    if (opts.pollSeconds > 0) {
      // Safety net for missed IDLE events; the sync path is idempotent.
      watcher.pollTimer = setInterval(() => void notify(connectionId), opts.pollSeconds * 1000);
    }

    void runWatcher(watcher, predecessorDown);
  }

  function stopAllWatchers(reason: string): void {
    if (!watchers.size) return;
    console.log(`[mail-worker] stopping ${watchers.size} watcher(s): ${reason}`);
    for (const watcher of Array.from(watchers.values())) void stopWatcher(watcher);
  }

  /**
   * Autonomous watcher bootstrap: on gaining leadership, start an IDLE
   * watcher for every IMAP connection in Postgres — failover must not wait
   * for api traffic to re-establish continuous sync. Idempotent via
   * ensureWatcher's credDigest check.
   */
  async function bootstrapWatchers(): Promise<number> {
    if (!opts.watchersEnabled()) return 0;
    const { db } = createDb(opts.databaseUrl);
    const rows = await db.query.connection.findMany({
      where: eq(connectionSchema.providerId, 'imap'),
    });
    let started = 0;
    for (const row of rows) {
      if (!opts.watchersEnabled()) break; // leadership lost mid-bootstrap
      if (
        !row.imapHost ||
        row.imapPort == null ||
        !row.username ||
        !row.passwordEncrypted ||
        !row.smtpHost ||
        row.smtpPort == null
      ) {
        continue;
      }
      try {
        const password = await decryptPassword(row.passwordEncrypted, opts.encryptionKey);
        ensureWatcher(
          {
            userId: row.userId,
            accessToken: '',
            refreshToken: '',
            email: row.email,
            connectionId: row.id,
            imap: {
              imapHost: row.imapHost,
              imapPort: row.imapPort,
              imapSecure: row.imapSecure ?? true,
              smtpHost: row.smtpHost,
              smtpPort: row.smtpPort,
              smtpSecure: row.smtpSecure ?? row.smtpPort === 465,
              username: row.username,
              passwordEncrypted: row.passwordEncrypted,
              allowInsecureTls: row.imapAllowInsecureTls ?? false,
            },
          },
          password,
        );
        started++;
      } catch (error) {
        console.warn(
          `[mail-worker] bootstrap watcher failed for ${row.id}:`,
          (error as Error).message,
        );
      }
    }
    console.log(`[mail-worker] bootstrapped ${started}/${rows.length} watcher(s)`);
    return started;
  }

  // Reconciler: if leadership is lost between RPCs, tear watchers down
  // promptly rather than waiting for the next driver use — this preserves the
  // one-IDLE-connection-per-account invariant during failover.
  const reconcileTimer = setInterval(() => {
    if (!opts.watchersEnabled() && watchers.size) stopAllWatchers('watchers disabled (lease lost)');
  }, WATCHER_RECONCILE_MS);

  // --- HTTP handler ----------------------------------------------------------
  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${opts.host}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, {
        ok: true,
        cached: cache.size,
        watchersEnabled: opts.watchersEnabled(),
        watchers: [...watchers.values()].map((w) => ({
          connectionId: w.connectionId,
          idling: w.client !== null,
        })),
      });
    }

    // Socket census (6.3): secret-guarded (accounts are usernames@hosts).
    // The E2E suites assert the per-account max-concurrent-IMAP ceiling here.
    if (req.method === 'GET' && url.pathname === '/census') {
      if (req.headers['x-imap-sidecar-secret'] !== opts.secret) {
        return send(res, 401, { error: 'Unauthorized' });
      }
      return send(res, 200, census.snapshot());
    }

    const isQueueRoute =
      url.pathname === '/enqueue-send' || url.pathname === '/cancel-send';
    if (req.method !== 'POST' || (url.pathname !== '/rpc' && !isQueueRoute)) {
      return send(res, 404, { error: 'Not found' });
    }

    if (req.headers['x-imap-sidecar-secret'] !== opts.secret) {
      return send(res, 401, { error: 'Unauthorized' });
    }

    if (isQueueRoute) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let body: any;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { error: 'Invalid JSON body' });
      }
      try {
        if (url.pathname === '/enqueue-send') {
          if (!opts.enqueueSend) return send(res, 501, { error: 'send queue not available' });
          const { messageId, connectionId, sendAt } = body ?? {};
          if (typeof messageId !== 'string' || typeof connectionId !== 'string' || typeof sendAt !== 'number') {
            return send(res, 400, { error: 'messageId, connectionId, sendAt required' });
          }
          await opts.enqueueSend(messageId, connectionId, sendAt);
          return send(res, 200, { ok: true });
        }
        if (!opts.cancelSend) return send(res, 501, { error: 'send queue not available' });
        if (typeof body?.messageId !== 'string') {
          return send(res, 400, { error: 'messageId required' });
        }
        await opts.cancelSend(body.messageId);
        return send(res, 200, { ok: true });
      } catch (error) {
        const e = error as Error;
        console.error(`[mail-worker] ${url.pathname} failed:`, e.message);
        return send(res, 500, { error: e.message });
      }
    }

    let method: string;
    let args: unknown[];
    let auth: ManagerConfig['auth'];
    try {
      const parsed = JSON.parse(await readBody(req)) as {
        method: string;
        args: unknown[];
        auth: ManagerConfig['auth'];
      };
      method = parsed.method;
      args = parsed.args ?? [];
      auth = parsed.auth;
    } catch {
      return send(res, 400, { error: 'Invalid JSON body' });
    }

    // The account lock wraps driverFor too (not just the method), so cache
    // rebuilds/evictions serialize against in-flight ops for the account.
    const lockKey = auth.imap ? accountPrefix(auth.imap) : method;
    let usedKey: string | null = null;
    const runMethod = () =>
      withDriverLock(lockKey, async () => {
        const { driver, key } = await driverFor(auth);
        usedKey = key;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fn = (driver as any)[method];
        if (typeof fn !== 'function') {
          throw Object.assign(new Error(`Unknown method: ${method}`), { code: 'EUNKNOWN_METHOD' });
        }
        return await fn.apply(driver, args);
      });

    try {
      const result = await runMethod();
      return send(res, 200, { result: result ?? null });
    } catch (error) {
      let e = error as Error & { code?: string };
      if (e.code === 'EUNKNOWN_METHOD') {
        return send(res, 400, { error: e.message });
      }
      // One-shot reconnect retry (Phase 4.3, bug #1 closure): a dead cached
      // connection reports `usable` until a command actually fails, so the
      // failure IS the detection. Evict (awaiting the old socket's
      // teardown), rebuild the driver, retry the op exactly once.
      if (auth.imap && usedKey && isConnectionError(e)) {
        console.warn(
          `[mail-worker] ${method} failed on cached connection (${e.message}) — evicting driver, one-shot reconnect retry`,
        );
        await evict(usedKey);
        // Brief settle: post-drop the server side may need a moment (e.g.
        // it just restarted); an instant retry can hit the same wall.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
          const result = await runMethod();
          console.log(`[mail-worker] ${method} recovered after reconnect`);
          return send(res, 200, { result: result ?? null });
        } catch (retryError) {
          e = retryError as Error & { code?: string };
        }
      }
      console.error(`[mail-worker] ${method} failed:`, e.message);
      return send(res, 500, { error: e.message, code: e.code });
    }
  });

  server.listen(opts.port, opts.host, () => {
    console.log(`[mail-worker] listening on http://${opts.host}:${opts.port}`);
  });

  return {
    server,
    watcherCount: () => watchers.size,
    idlingCount: () => [...watchers.values()].filter((w) => w.client !== null).length,
    stopAllWatchers,
    bootstrapWatchers,
    close: async () => {
      clearInterval(reconcileTimer);
      stopAllWatchers('worker shutting down');
      for (const key of Array.from(cache.keys())) void evict(key);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
