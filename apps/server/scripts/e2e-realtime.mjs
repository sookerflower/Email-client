#!/usr/bin/env node
/**
 * Realtime (Phase 5) end-to-end verification — SSE beacons layer (5.1).
 *
 * Legs, in order (non-zero exit on the first failure):
 *   1. preflight     — app server + worker health endpoints answer
 *   2. probe         — TCP reachability of the IMAP server
 *   3. login         — user A signs in, session cookie + connectionId
 *   4. sse-auth      — no cookie -> 401; another user's cookie against A's
 *                      connectionId -> 403 (GreenMail only — minting user B
 *                      is free there); A's cookie + foreign/random
 *                      connectionId -> 403; A + own connection -> 200
 *                      text/event-stream with an `open` event
 *   5. beacon        — tRPC mail.markAsRead -> zero_mail_get_thread beacon
 *                      for that exact threadId (api-process publish path)
 *   6. order-probe   — CONCURRENT mutate -> beacon -> immediate refetch
 *                      cycles on distinct threads; on each beacon the fact
 *                      must already be visible (publish-after-commit
 *                      backstop under write contention — the guarantee
 *                      itself is the audited call-site discipline)
 *   7. worker-fanin  — raw SMTP -> IDLE watcher -> worker sync job ->
 *                      beacon published from the WORKER process, relayed
 *                      by the api's SSE stream (cross-process fan-in)
 *   8. heartbeat     — `:hb` frame within 35 s on an idle stream
 *   9. reconnect     — drop the stream, reopen, beacons flow again
 *
 * Usage:
 *   node scripts/e2e-realtime.mjs           # GreenMail (default)
 *   node scripts/e2e-realtime.mjs --real    # real server (ban-probes first;
 *                                             skips the two-user 403 leg)
 */
import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import nodemailer from 'nodemailer';
import { Agent, setGlobalDispatcher } from 'undici';

// Same client-timeout fix as e2e-mail.mjs: undici headersTimeout 300 s
// default vs multi-minute non-streaming tRPC responses (forceSync --real).
setGlobalDispatcher(new Agent({ headersTimeout: 900_000, bodyTimeout: 900_000 }));

const REAL = process.argv.includes('--real');
const APP = process.env.E2E_APP_URL || 'http://127.0.0.1:8787';
const SIDECAR = process.env.E2E_SIDECAR_URL || 'http://127.0.0.1:8791';
const ORIGIN = 'http://localhost:3000';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const devVars = Object.fromEntries(
  readFileSync(join(serverDir, '.dev.vars'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')];
    }),
);

const mode = REAL
  ? {
      name: 'real',
      email: devVars.TEST_IMAP_USER,
      password: devVars.TEST_IMAP_PASSWORD,
      probeHost: devVars.IMAP_DEFAULT_IMAP_HOST,
      probePort: Number(devVars.IMAP_DEFAULT_IMAP_PORT || 993),
      loginBody: (email, password) => ({ email, password }),
      smtp: {
        host: devVars.IMAP_DEFAULT_SMTP_HOST,
        port: Number(devVars.IMAP_DEFAULT_SMTP_PORT || 587),
        secure: Number(devVars.IMAP_DEFAULT_SMTP_PORT || 587) === 465,
        auth: { user: devVars.TEST_IMAP_USER, pass: devVars.TEST_IMAP_PASSWORD },
        tls: { rejectUnauthorized: false },
      },
      beaconWindowMs: 240_000, // worker sync jobs run minutes under full refetch
    }
  : {
      name: 'greenmail',
      email: 'student@classroom.test',
      password: 'secret123',
      probeHost: '127.0.0.1',
      probePort: 3143,
      loginBody: (email, password) => ({
        email,
        password,
        imapHost: '127.0.0.1',
        imapPort: 3143,
        smtpHost: '127.0.0.1',
        smtpPort: 3025,
      }),
      smtp: { host: '127.0.0.1', port: 3025, secure: false },
      beaconWindowMs: 90_000,
    };

if (!mode.email || !mode.password) {
  console.error('[e2e-rt] missing credentials for mode', mode.name);
  process.exit(2);
}

const runId = Math.random().toString(36).slice(2, 10);
let failed = false;

const leg = async (name, fn) => {
  if (failed) return;
  const started = Date.now();
  try {
    const detail = await fn();
    console.log(`[e2e-rt] PASS ${name}${detail ? ` — ${detail}` : ''} (${Date.now() - started}ms)`);
  } catch (error) {
    failed = true;
    console.error(`[e2e-rt] FAIL ${name} — ${error.message}`);
  }
};

const tcpProbe = (host, port) =>
  new Promise((resolve, reject) => {
    const sock = createConnection({ host, port, timeout: 8000 });
    sock.on('connect', () => (sock.destroy(), resolve()));
    sock.on('error', (e) => reject(new Error(`${host}:${port} unreachable (${e.message})`)));
    sock.on('timeout', () => (sock.destroy(), reject(new Error(`${host}:${port} timed out`))));
  });

const login = async (email, password) => {
  const res = await fetch(`${APP}/api/auth/sign-in/imap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify(mode.loginBody(email, password)),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.status) throw new Error(`login ${email} failed: ${JSON.stringify(body).slice(0, 150)}`);
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('no session cookie returned');
  return cookie;
};

const trpcAs = (cookie) => async (path, { query, mutationBody } = {}) => {
  const url = `${APP}/api/trpc/${path}?batch=1${
    query ? `&input=${encodeURIComponent(JSON.stringify({ 0: { json: query } }))}` : ''
  }`;
  const init = { method: 'GET', headers: { Origin: ORIGIN, Cookie: cookie } };
  if (mutationBody !== undefined) {
    init.method = 'POST';
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify({ 0: { json: mutationBody } });
  }
  const res = await fetch(url, init);
  const parsed = JSON.parse(await res.text());
  const item = parsed[0];
  if (item?.error) throw new Error(`${path}: ${item.error.json?.message ?? 'tRPC error'}`);
  return item?.result?.data?.json;
};

/**
 * Minimal SSE client over fetch (native EventSource can't send cookies).
 * Emits every event {event, data} to subscribers; exposes close().
 */
async function openSse(connectionId, cookie) {
  const controller = new AbortController();
  const res = await fetch(`${APP}/realtime/${connectionId}`, {
    headers: { Cookie: cookie, Origin: ORIGIN, Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (res.status !== 200) {
    controller.abort();
    const body = await res.text().catch(() => '');
    const err = new Error(`SSE HTTP ${res.status}: ${body.slice(0, 120)}`);
    err.status = res.status;
    throw err;
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    controller.abort();
    throw new Error(`SSE wrong content-type: ${contentType}`);
  }

  const subscribers = new Set();
  const events = [];
  const emit = (evt) => {
    events.push(evt);
    for (const sub of subscribers) sub(evt);
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (frame.startsWith(':')) {
            emit({ event: 'comment', data: frame.slice(1).trim() });
            continue;
          }
          let event = 'message';
          const dataLines = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length) emit({ event, data: dataLines.join('\n') });
        }
      }
    } catch {
      // aborted/closed — fine
    }
  })();

  return {
    events,
    status: res.status,
    /**
     * Resolve when a matching event arrives. NEW events only by default —
     * every wait is registered BEFORE its triggering mutation, so nothing
     * can be missed, and stale look-alike events (e.g. Mail_Get for the
     * same threadId from an earlier sync) can't satisfy a leg spuriously.
     * `includeHistory` exists solely for the `open` handshake, which is
     * emitted during stream start before the caller can register.
     */
    waitFor(predicate, timeoutMs, label, { includeHistory = false } = {}) {
      const found = includeHistory ? events.find(predicate) : undefined;
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          subscribers.delete(sub);
          reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`));
        }, timeoutMs);
        const sub = (evt) => {
          if (!predicate(evt)) return;
          clearTimeout(timer);
          subscribers.delete(sub);
          resolve(evt);
        };
        subscribers.add(sub);
      });
    },
    close: () => controller.abort(),
  };
}

const isBeacon = (type, match = {}) => (evt) => {
  if (evt.event !== 'message') return false;
  try {
    const parsed = JSON.parse(evt.data);
    if (parsed.type !== type) return false;
    return Object.entries(match).every(([k, v]) => parsed[k] === v);
  } catch {
    return false;
  }
};

// --------------------------------------------------------------------------

let cookieA = '';
let trpcA;
let connectionId = '';
let mainStream = null;

await leg('preflight', async () => {
  const app = await fetch(`${APP}/health`).catch(() => null);
  if (!app?.ok) throw new Error(`app server not answering at ${APP}`);
  const side = await fetch(`${SIDECAR}/health`).catch(() => null);
  if (!side?.ok) throw new Error(`worker not answering at ${SIDECAR}`);
  return 'app + worker up';
});

await leg('probe', async () => {
  await tcpProbe(mode.probeHost, mode.probePort);
  return `${mode.probeHost}:${mode.probePort} reachable`;
});

await leg('login', async () => {
  cookieA = await login(mode.email, mode.password);
  trpcA = trpcAs(cookieA);
  const result = await trpcA('connections.list', { query: null });
  const all = result?.connections ?? [];
  connectionId = (all.find((c) => c.email === mode.email) ?? all[0])?.id;
  if (!connectionId) throw new Error('no connection for user A');
  return `${mode.email} (connection ${connectionId.slice(0, 8)}…)`;
});

await leg('sse-auth', async () => {
  const noCookie = await fetch(`${APP}/realtime/${connectionId}`, {
    headers: { Origin: ORIGIN },
  });
  if (noCookie.status !== 401) throw new Error(`no-cookie: expected 401, got ${noCookie.status}`);
  await noCookie.body?.cancel?.();

  if (!REAL) {
    const cookieB = await login('intruder@classroom.test', 'whatever123');
    let intruderStatus;
    try {
      const s = await openSse(connectionId, cookieB);
      intruderStatus = 200;
      s.close();
    } catch (error) {
      intruderStatus = error.status;
    }
    if (intruderStatus !== 403)
      throw new Error(`other user's cookie: expected 403, got ${intruderStatus}`);
  }

  let foreignStatus;
  try {
    const s = await openSse(crypto.randomUUID(), cookieA);
    foreignStatus = 200;
    s.close();
  } catch (error) {
    foreignStatus = error.status;
  }
  if (foreignStatus !== 403)
    throw new Error(`foreign connectionId: expected 403, got ${foreignStatus}`);

  mainStream = await openSse(connectionId, cookieA);
  await mainStream.waitFor((e) => e.event === 'open', 5000, 'open event', {
    includeHistory: true,
  });
  return `401 no-cookie${REAL ? '' : ', 403 other-user'}, 403 foreign-id, 200+open for owner`;
});

let threadIds = [];

await leg('beacon', async () => {
  const list = () => trpcA('mail.listThreads', { query: { folder: 'inbox', maxResults: 10 } });
  threadIds = ((await list())?.threads ?? []).map((t) => t.id);
  if (threadIds.length < 4) {
    // Seed a freshly-wiped mailbox (drop-recover in e2e-mail restarts
    // GreenMail) so the concurrent probe has threads to contend on.
    const transporter = nodemailer.createTransport(mode.smtp);
    for (let i = 0; i < 4; i++) {
      await transporter.sendMail({
        from: mode.email,
        to: mode.email,
        subject: `e2e-rt seed ${runId} ${i}`,
        html: `<p>seed</p>`,
      });
    }
    transporter.close();
    await trpcA('mail.forceSync', { mutationBody: null });
    threadIds = ((await list())?.threads ?? []).map((t) => t.id);
  }
  if (!threadIds.length) throw new Error('inbox has no threads to mutate');
  const target = threadIds[0];

  const wait = mainStream.waitFor(
    isBeacon('zero_mail_get_thread', { threadId: target }),
    15_000,
    `Mail_Get beacon for ${target}`,
  );
  await trpcA('mail.markAsRead', { mutationBody: { ids: [target] } });
  await wait;
  return `markAsRead -> zero_mail_get_thread(${target.slice(0, 12)}…) received`;
});

await leg('order-probe', async () => {
  // CONCURRENT cycles under write contention: a publish-before-commit only
  // loses the race when writes overlap. Backstop, not the guarantee.
  const targets = threadIds.slice(0, Math.min(4, threadIds.length));
  if (targets.length < 2) throw new Error('need >=2 inbox threads for a concurrent probe');

  await Promise.all(
    targets.map(async (threadId) => {
      const wait = mainStream.waitFor(
        isBeacon('zero_mail_get_thread', { threadId }),
        20_000,
        `beacon for ${threadId}`,
      );
      await trpcA('mail.markAsUnread', { mutationBody: { ids: [threadId] } });
      await wait;
      // The beacon promised this fact is committed — refetch NOW.
      const thread = await trpcA('mail.get', { query: { id: threadId } });
      const labelIds = (thread?.labels ?? []).map((l) => l.id);
      if (!labelIds.includes('UNREAD')) {
        throw new Error(
          `stale read after beacon: ${threadId} lacks UNREAD (labels: ${labelIds.join(',')})`,
        );
      }
    }),
  );
  // Cleanup — put them back to read.
  await trpcA('mail.markAsRead', { mutationBody: { ids: targets } });
  return `${targets.length} overlapping mutate->beacon->refetch cycles, all committed-before-publish`;
});

await leg('worker-fanin', async () => {
  const subject = `e2e-rt fanin ${runId}`;
  const wait = mainStream.waitFor(
    isBeacon('zero_mail_list_threads', { folder: 'inbox' }),
    mode.beaconWindowMs,
    'worker-published Mail_List(inbox) beacon',
  );
  const transporter = nodemailer.createTransport(mode.smtp);
  await transporter.sendMail({
    from: mode.email,
    to: mode.email,
    subject,
    html: `<p>e2e-rt fanin ${runId}</p>`,
  });
  transporter.close();
  await wait;
  return 'SMTP -> IDLE watcher -> worker sync job -> beacon relayed across processes';
});

await leg('heartbeat', async () => {
  await mainStream.waitFor((e) => e.event === 'comment' && e.data === 'hb', 35_000, 'heartbeat');
  return 'heartbeat within 35s';
});

await leg('reconnect', async () => {
  mainStream.close();
  const second = await openSse(connectionId, cookieA);
  await second.waitFor((e) => e.event === 'open', 5000, 'open event on 2nd stream', {
    includeHistory: true,
  });
  const target = threadIds[0];
  const wait = second.waitFor(
    isBeacon('zero_mail_get_thread', { threadId: target }),
    15_000,
    'beacon on reconnected stream',
  );
  await trpcA('mail.markAsRead', { mutationBody: { ids: [target] } });
  await wait;
  second.close();
  return 'stream dropped, reopened, beacons flow again';
});

console.log(`\n[e2e-rt] mode=${mode.name} — ${failed ? 'FAILED' : 'ALL LEGS GREEN'}`);
process.exit(failed ? 1 : 0);
