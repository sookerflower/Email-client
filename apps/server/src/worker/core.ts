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
import { ImapFlow } from 'imapflow';

import { createPgLabelStore, migrateJsonLabelStore } from '../lib/imap-label-store';
import { ImapSmtpMailManager, type LabelStore } from '../lib/driver/imap';
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

  // Key includes a digest of the credential so a password change (or a retry
  // after a typo) never reuses a driver built with stale credentials.
  const cacheKey = (imap: NonNullable<ManagerConfig['auth']['imap']>) => {
    const cred = imap.passwordEncrypted ?? imap.password ?? '';
    let digest = 0;
    for (let i = 0; i < cred.length; i++) digest = (digest * 31 + cred.charCodeAt(i)) | 0;
    return `${imap.username}@${imap.imapHost}:${imap.imapPort}#${digest}`;
  };

  const evict = (key: string) => {
    const entry = cache.get(key);
    if (!entry) return;
    cache.delete(key);
    clearTimeout(entry.timer);
    void entry.driver.dispose().catch(() => undefined);
  };

  async function driverFor(auth: ManagerConfig['auth']): Promise<ImapSmtpMailManager> {
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

    const key = cacheKey(imap);
    const existing = cache.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => evict(key), IDLE_MS);
      return existing.driver;
    }

    const driver = new ImapSmtpMailManager(
      { auth: { ...auth, imap: { ...imap, password } } },
      { labelStore },
    );
    const timer = setTimeout(() => evict(key), IDLE_MS);
    cache.set(key, { driver, timer });
    return driver;
  }

  // --- New-mail watchers (IMAP IDLE + poll fallback) -------------------------
  const watchers = new Map<string, Watcher>();

  async function notify(connectionId: string): Promise<void> {
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

  async function runWatcher(watcher: Watcher): Promise<void> {
    const { imap, password } = watcher;
    while (!watcher.stopped) {
      try {
        const client = new ImapFlow({
          host: imap.imapHost,
          port: imap.imapPort,
          secure: imap.imapSecure,
          auth: { user: imap.username, pass: password },
          logger: false,
          tls: imap.allowInsecureTls ? { rejectUnauthorized: false } : undefined,
        });
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
      watcher.client = null;
      if (watcher.stopped) break;
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
    }
  }

  function stopWatcher(watcher: Watcher): void {
    watcher.stopped = true;
    if (watcher.notifyTimer) clearTimeout(watcher.notifyTimer);
    if (watcher.pollTimer) clearInterval(watcher.pollTimer);
    void watcher.client?.logout().catch(() => undefined);
    watchers.delete(watcher.connectionId);
  }

  function ensureWatcher(auth: ManagerConfig['auth'], password: string): void {
    const imap = auth.imap;
    const connectionId = auth.connectionId;
    if (!imap || !connectionId) return;

    const credDigest = cacheKey(imap);
    const existing = watchers.get(connectionId);
    if (existing && existing.credDigest === credDigest) return; // already watching
    if (existing) stopWatcher(existing); // credentials/host changed — restart

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

    void runWatcher(watcher);
  }

  function stopAllWatchers(reason: string): void {
    if (!watchers.size) return;
    console.log(`[mail-worker] stopping ${watchers.size} watcher(s): ${reason}`);
    for (const watcher of Array.from(watchers.values())) stopWatcher(watcher);
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

    if (req.method !== 'POST' || url.pathname !== '/rpc') {
      return send(res, 404, { error: 'Not found' });
    }

    if (req.headers['x-imap-sidecar-secret'] !== opts.secret) {
      return send(res, 401, { error: 'Unauthorized' });
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

    try {
      const driver = await driverFor(auth);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fn = (driver as any)[method];
      if (typeof fn !== 'function') {
        return send(res, 400, { error: `Unknown method: ${method}` });
      }
      const result = await fn.apply(driver, args);
      return send(res, 200, { result: result ?? null });
    } catch (error) {
      const e = error as Error & { code?: string };
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
      for (const key of Array.from(cache.keys())) evict(key);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
