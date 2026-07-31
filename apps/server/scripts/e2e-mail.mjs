#!/usr/bin/env node
/**
 * End-to-end mail verification (Phase 3+ of MIGRATION-PLAN.md).
 *
 * Legs, in order (non-zero exit on the first failure):
 *   1. preflight   — app server + sidecar/worker health endpoints answer
 *   2. probe       — TCP reachability of the IMAP server (fail2ban check)
 *   3. login       — POST /api/auth/sign-in/imap, session cookie captured
 *   4. send        — tRPC mail.send (unique subject)
 *   5. forceSync   — tRPC mail.forceSync
 *   6. list        — tRPC mail.listThreads(inbox) returns >= 1 thread
 *   7. get         — our sent thread found; body marker present; labels
 *                    include INBOX (folder-label regression guard)
 *   8. sent-sync   — enqueue sync-folder:{connectionId}:sent (BullMQ) and
 *                    poll the app's Sent view until our sent message shows
 *                    with the SENT label (known bug #2 regression guard)
 *   9. idle-push   — raw SMTP delivery (bypassing the app), then poll list
 *                    WITHOUT any manual sync until the message arrives:
 *                    watcher -> sync-folder job -> auto-sync
 *  10. drop-recover (greenmail only) — docker-restart GreenMail to kill the
 *                    worker's cached IMAP connection mid-session, then
 *                    require the next driver-backed op to succeed with NO
 *                    manual retry (known bug #1 regression guard: the /rpc
 *                    one-shot reconnect). On --real the same path is
 *                    covered by the natural post-APPEND drops; recovery
 *                    shows up as "recovered after reconnect" in the worker
 *                    log.
 *
 * Usage:
 *   node scripts/e2e-mail.mjs               # GreenMail (default)
 *   node scripts/e2e-mail.mjs --real        # real server from .dev.vars
 *   node scripts/e2e-mail.mjs --skip-idle   # omit leg 8 (mid-transition)
 *
 * Preconditions (script checks and names the missing piece):
 *   docker: zerodotemail-db + greenmail-test; app server on :8787;
 *   sidecar/worker on :8791.
 */
import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import nodemailer from 'nodemailer';
import { Agent, setGlobalDispatcher } from 'undici';
import dns from 'node:dns';

dns.setDefaultResultOrder('ipv4first');

// undici's default headersTimeout is 300 s; a non-streaming tRPC response
// (forceSync on the real server: 2–4+ min, growing with mailbox size) sends
// headers only when the handler resolves — the intermittent "fetch failed"
// was the client timing out, not the server failing.
setGlobalDispatcher(new Agent({ headersTimeout: 900_000, bodyTimeout: 900_000 }));

const REAL = process.argv.includes('--real');
const SKIP_IDLE = process.argv.includes('--skip-idle');
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
        tls: { rejectUnauthorized: false }, // self-signed cert on m.re.cx
      },
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
    };

if (!mode.email || !mode.password) {
  console.error('[e2e] missing credentials for mode', mode.name);
  process.exit(2);
}

let cookie = '';
const runId = Math.random().toString(36).slice(2, 10);

/**
 * Date header for an ordering fixture, N hours in the PAST.
 *
 * These used to be dated 2030-01-01. Nothing needed a future date -- the
 * ordering legs care about relative age vs APPEND order (which controls UID),
 * not absolute time. But a future date permanently pins the message to the
 * top of every newest-first list, so any fixture that escaped cleanup sat
 * above real mail forever and pushed genuinely new messages out of the
 * windows other legs scan. That is exactly how idle-push failed for four
 * consecutive --real runs. Past dates make a stranded fixture harmless.
 */
const hoursAgoHeader = (h) => new Date(Date.now() - h * 3_600_000).toUTCString();

/**
 * Subject prefixes for every fixture this suite appends. Used by the
 * preflight guard; keep in sync when adding a leg that appends mail.
 */
const FIXTURE_PREFIXES = [
  'sort newer',
  'sort older',
  'slice newer',
  'slice older',
  'derived no-id',
  'e2e idle',
  'e2e send',
  'e2e scheduled',
];

const legs = [];
let failed = false;

/**
 * `always: true` runs the leg even after an earlier failure.
 *
 * Cleanup MUST be `always`. It used to be skipped by the `failed`
 * short-circuit, which created a self-reinforcing loop on --real: a failed
 * leg skipped cleanup, so that run's fixtures survived; those fixtures were
 * dated 2030-01-01 at the time, so the survivors permanently pinned the top
 * of the inbox; subjectInInbox scans only a window of the newest threads, so
 * the NEXT run's idle-push could not see its own message and failed,
 * skipping cleanup again. Ten zombie fixtures from four runs had accumulated
 * before this was found. Fixtures are past-dated now (hoursAgoHeader), which
 * removes the pinning, and the preflight guard catches survivors -- but
 * `always` is what stops the loop starting.
 */
const leg = async (name, fn, { always = false } = {}) => {
  if (failed && !always) return;
  const started = Date.now();
  try {
    const detail = await fn();
    legs.push([name, 'PASS', detail ?? '']);
    console.log(`[e2e] PASS ${name}${detail ? ` — ${detail}` : ''} (${Date.now() - started}ms)`);
  } catch (error) {
    failed = true;
    legs.push([name, 'FAIL', error.message]);
    console.error(`[e2e] FAIL ${name} — ${error.message}`);
  }
};

const tcpProbe = (host, port) =>
  new Promise((resolve, reject) => {
    const sock = createConnection({ host, port, timeout: 8000 });
    sock.on('connect', () => (sock.destroy(), resolve()));
    sock.on('error', (e) => reject(new Error(`${host}:${port} unreachable (${e.message})`)));
    sock.on('timeout', () => (sock.destroy(), reject(new Error(`${host}:${port} timed out`))));
  });

const trpc = async (path, { query, mutationBody } = {}) => {
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
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path}: non-JSON response (HTTP ${res.status}): ${text.slice(0, 120)}`);
  }
  const item = parsed[0];
  if (item?.error) throw new Error(`${path}: ${item.error.json?.message ?? 'tRPC error'}`);
  return item?.result?.data?.json;
};

const listInbox = () => trpc('mail.listThreads', { query: { folder: 'inbox', maxResults: 50 } });

/**
 * True if a thread whose latest subject matches is within the first `depth`
 * inbox threads.
 *
 * WHY A WINDOW AND NOT A SEARCH: this asserts what the user actually sees --
 * the message appearing near the top of the inbox VIEW, unaided, ordered
 * newest-first. Switching to `q:` would route through the driver's IMAP
 * SEARCH instead of the indexed inbox listing, i.e. it would test a different
 * subsystem and would still pass if the inbox view were broken.
 *
 * WHY 8: with correct newest-first ordering a just-arrived message lands at
 * position 0-2; 8 is headroom for concurrent arrivals, not a tuning knob.
 *
 * WHAT POISONS IT: anything that outranks fresh mail in the newest-first
 * order. Future-dated fixtures did exactly that -- eight of them sat above
 * real mail permanently and pushed new arrivals past the window, which is how
 * idle-push failed for four consecutive --real runs while push worked fine.
 * Fixtures are past-dated now and preflight-clean-mailbox aborts on
 * survivors; if this window ever starts failing again, check for high-ranking
 * junk in the inbox BEFORE suspecting sync or push.
 */
const subjectInInbox = async (subject, depth = 8) => {
  for (const t of (await listInbox()).threads.slice(0, depth)) {
    const thread = await trpc('mail.get', { query: { id: t.id } });
    if (thread?.latest?.subject === subject) return true;
  }
  return false;
};

const sendRawSmtp = async (subject) => {
  const transporter = nodemailer.createTransport(mode.smtp);
  await transporter.sendMail({
    from: mode.email,
    to: mode.email,
    subject,
    html: `<p>e2e raw smtp ${runId}</p>`,
  });
  transporter.close();
};

// --------------------------------------------------------------------------

await leg('preflight', async () => {
  const app = await fetch(`${APP}/health`).catch(() => null);
  if (!app?.ok) throw new Error(`app server not answering at ${APP} — start dist-node/server.mjs`);
  const side = await fetch(`${SIDECAR}/health`).catch(() => null);
  if (!side?.ok) throw new Error(`sidecar/worker not answering at ${SIDECAR}`);
  return `app + sidecar up`;
});

await leg('probe', async () => {
  await tcpProbe(mode.probeHost, mode.probePort);
  return `${mode.probeHost}:${mode.probePort} reachable`;
});

await leg('login', async () => {
  const res = await fetch(`${APP}/api/auth/sign-in/imap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify(mode.loginBody(mode.email, mode.password)),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.status) throw new Error(`login failed: ${JSON.stringify(body).slice(0, 150)}`);
  cookie = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .join('; ');
  if (!cookie) throw new Error('no session cookie returned');
  return body.user.email;
});

// Preflight: refuse to run on a mailbox still holding fixtures from a previous
// run. Leftovers are not cosmetic -- they used to compound silently (see the
// leg() note) and it took four failed --real runs to notice. Aborting loudly
// on the FIRST occurrence turns that into an obvious problem with an obvious
// remedy. Cheap enough to always run; only meaningful against a real mailbox
// where state persists between runs.
await leg('preflight-clean-mailbox', async () => {
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow(
    REAL
      ? {
          host: devVars.IMAP_DEFAULT_IMAP_HOST,
          port: Number(devVars.IMAP_DEFAULT_IMAP_PORT || 993),
          secure: true,
          auth: { user: devVars.TEST_IMAP_USER, pass: devVars.TEST_IMAP_PASSWORD },
          tls: { rejectUnauthorized: false },
          logger: false,
        }
      : {
          host: '127.0.0.1',
          port: 3143,
          secure: false,
          auth: { user: mode.email, pass: mode.password },
          logger: false,
        },
  );
  client.on('error', () => {});
  await client.connect();
  const found = [];
  const lock = await client.getMailboxLock('INBOX');
  try {
    for (const prefix of FIXTURE_PREFIXES) {
      const uids = (await client.search({ header: { subject: prefix } }, { uid: true })) || [];
      for (const u of uids) found.push({ uid: u, prefix });
    }
  } finally {
    lock.release();
  }
  await client.logout();

  if (found.length > 0) {
    const uids = found.map((f) => f.uid);
    throw new Error(
      `${found.length} fixture message(s) from a previous run are still in INBOX ` +
        `(uids ${uids.join(',')}). They distort every ordering and window assertion ` +
        `in this suite. Remove them before re-running, e.g.:\n` +
        `    node -e "…imapflow… messageDelete('${uids.join(',')}', {uid:true})"\n` +
        `  or delete by subject prefix: ${[...new Set(found.map((f) => f.prefix))].join(', ')}`,
    );
  }
  return 'no fixtures left over from previous runs';
});

const sentSubject = `e2e send ${runId}`;

await leg('send', async () => {
  const result = await trpc('mail.send', {
    mutationBody: {
      to: [{ email: mode.email, name: 'E2E' }],
      subject: sentSubject,
      message: `<p>e2e marker ${runId}</p>`,
      attachments: [],
      headers: {},
    },
  });
  if (!result?.success) throw new Error(`send returned ${JSON.stringify(result)}`);
});

await leg('forceSync', async () => {
  await trpc('mail.forceSync', { mutationBody: null });
});

let baselineCount = 0;

await leg('list', async () => {
  const result = await listInbox();
  baselineCount = result.threads.length;
  if (baselineCount < 1) throw new Error('inbox listed 0 threads after forceSync');
  return `${baselineCount} threads`;
});

await leg('get', async () => {
  // Poll: the self-addressed message's SMTP delivery can land AFTER a fast
  // forceSync completes (post-purge syncs are quick); the IDLE watcher then
  // auto-syncs it — single-shot scanning raced that and flaked.
  const deadline = Date.now() + (REAL ? 120_000 : 30_000);
  for (;;) {
    for (const t of (await listInbox()).threads.slice(0, 15)) {
      const thread = await trpc('mail.get', { query: { id: t.id } });
      if (thread?.latest?.subject === sentSubject) {
        const body = thread.messages.map((m) => m.decodedBody).join(' ');
        if (!body.includes(`e2e marker ${runId}`)) throw new Error('body marker missing');
        const labelIds = (thread.labels ?? []).map((l) => l.id);
        if (!labelIds.includes('INBOX'))
          throw new Error(`INBOX label missing (labels: ${labelIds.join(',') || 'none'})`);
        return `subject + body + INBOX label verified`;
      }
    }
    if (Date.now() > deadline)
      throw new Error(`sent thread "${sentSubject}" not found in first 15 threads`);
    await new Promise((r) => setTimeout(r, 3000));
  }
});

await leg('scheduled-send', async () => {
  // Outbox-backed delayed send (Phase 4 §4): schedule a self-addressed mail
  // ~8 s out, and undo-send a second one — the BullMQ delayed job is the
  // timer, the outbox row is the source of truth.
  const scheduledSubject = `e2e scheduled ${runId}`;
  const first = await trpc('mail.send', {
    mutationBody: {
      to: [{ email: mode.email, name: 'E2E' }],
      subject: scheduledSubject,
      message: `<p>e2e scheduled marker ${runId}</p>`,
      attachments: [],
      headers: {},
      scheduleAt: new Date(Date.now() + 8000).toISOString(),
    },
  });
  if (!first?.queued || !first?.messageId)
    throw new Error(`scheduled send not queued: ${JSON.stringify(first)}`);

  const second = await trpc('mail.send', {
    mutationBody: {
      to: [{ email: mode.email, name: 'E2E' }],
      subject: `e2e cancelled ${runId}`,
      message: `<p>should never send ${runId}</p>`,
      attachments: [],
      headers: {},
      scheduleAt: new Date(Date.now() + 120_000).toISOString(),
    },
  });
  if (!second?.queued || !second?.messageId)
    throw new Error(`second scheduled send not queued: ${JSON.stringify(second)}`);
  const undo = await trpc('mail.unsend', { mutationBody: { messageId: second.messageId } });
  if (!undo?.success) throw new Error(`unsend failed: ${JSON.stringify(undo)}`);

  if (REAL) {
    // Arrival assertion is GreenMail-only to keep the real run's wall-clock
    // sane; the timer->outbox->driver path is identical on both.
    return `queued ${first.messageId} + undo-send verified (arrival asserted on greenmail)`;
  }
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    if (await subjectInInbox(scheduledSubject)) {
      return `"${scheduledSubject}" delivered by delayed job + undo-send verified`;
    }
  }
  throw new Error(`"${scheduledSubject}" not delivered 90s after its 8s schedule`);
});

await leg('sent-sync', async () => {
  const result = await trpc('connections.list', { query: null });
  const all = result?.connections ?? [];
  const connectionId = (all.find((c) => c.email === mode.email) ?? all[0])?.id;
  if (!connectionId) throw new Error('connections.list returned no connection');

  // Enqueue exactly what the repeatable sent-folder scheduler enqueues.
  const { Queue } = await import('bullmq');
  const IORedis = (await import('ioredis')).default;
  const conn = new IORedis(process.env.QUEUE_REDIS_URL ?? 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null,
  });
  const queue = new Queue('mail-sync', { connection: conn });
  await queue.add('sync-folder', { connectionId, folder: 'sent' });
  await queue.close();

  // Real-server window, tightened after the 6.2 ladder: steady-state syncs
  // run 0.5–7 s (condstore); the worst case is a one-off full resync
  // (~60–70 s on a cleaned mailbox) right after the suite's forceSync
  // cleared the cursors. 120 s = ~2x that.
  const sentWindowMs = REAL ? 120_000 : 90_000;
  const deadline = Date.now() + sentWindowMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const sent = await trpc('mail.listThreads', { query: { folder: 'sent', maxResults: 20 } });
    for (const t of (sent?.threads ?? []).slice(0, 10)) {
      const thread = await trpc('mail.get', { query: { id: t.id } });
      if (thread?.latest?.subject === sentSubject) {
        const labelIds = (thread.labels ?? []).map((l) => l.id);
        if (!labelIds.includes('SENT'))
          throw new Error(`SENT label missing (labels: ${labelIds.join(',') || 'none'})`);
        return `"${sentSubject}" in Sent view with SENT label`;
      }
    }
  }
  throw new Error(
    `"${sentSubject}" not in Sent view after ${sentWindowMs / 1000}s — sent sync not working`,
  );
});

if (SKIP_IDLE) {
  console.log('[e2e] SKIP idle-push (--skip-idle)');
} else {
  await leg('idle-push', async () => {
    const idleSubject = `e2e idle ${runId}`;
    await sendRawSmtp(idleSubject);
    // Assert on the ARRIVAL OF THE MESSAGE ITSELF (newest-first ordering puts
    // it on page 1), not on a count — counts saturate at one page and go
    // stale on mailboxes with more threads than the page size.
    // Real-server window: 240 s. The 6.2 close measured 14 s and tightened
    // this to 120 s, but m.re.cx SMTP self-delivery alone ran 100–130 s
    // across 2026-07-26 (two border-line failures with the app machinery
    // provably clean: notifies fired, incremental syncs ran, the message
    // synced seconds after the deadline). The window tolerates the mail
    // server's out-of-band delivery latency; the assertion itself — arrival
    // with NO manual sync — is unchanged.
    const windowMs = REAL ? 240_000 : 90_000;
    const deadline = Date.now() + windowMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      if (await subjectInInbox(idleSubject)) {
        return `"${idleSubject}" auto-synced into inbox, no manual refresh`;
      }
    }
    throw new Error(
      `"${idleSubject}" not in inbox after ${windowMs / 1000}s — IDLE push not working`,
    );
  });
}

// --------------------------------------------------------------------------
// Phase 6.2 — incremental-sync ladder legs. The equivalence oracle is the
// merge gate: incremental must be indistinguishable from a from-scratch
// full resync, including the deletion case. If they diverge, the
// incremental path is wrong — the oracle is not adjusted to pass.
// --------------------------------------------------------------------------

const rawImap = async () => {
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow(
    REAL
      ? {
          host: devVars.IMAP_DEFAULT_IMAP_HOST,
          port: Number(devVars.IMAP_DEFAULT_IMAP_PORT || 993),
          secure: true,
          auth: { user: devVars.TEST_IMAP_USER, pass: devVars.TEST_IMAP_PASSWORD },
          tls: { rejectUnauthorized: false },
          logger: false,
        }
      : {
          host: '127.0.0.1',
          port: 3143,
          secure: false,
          auth: { user: mode.email, pass: mode.password },
          logger: false,
        },
  );
  await client.connect();
  await client.mailboxOpen('INBOX');
  return client;
};

const enqueueInboxSync = async (connectionId, folder = 'inbox') => {
  const { Queue } = await import('bullmq');
  const IORedis = (await import('ioredis')).default;
  const conn = new IORedis(process.env.QUEUE_REDIS_URL ?? 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null,
  });
  const queue = new Queue('mail-sync', { connection: conn });
  await queue.add('sync-folder', { connectionId, folder });
  await queue.close();
};

// --------------------------------------------------------------------------
// Phase 6.3 — socket-census helpers. The worker counts every mail-server
// socket it holds per account; these legs ASSERT the fail2ban invariant
// (never more than imapCeiling concurrent IMAP sockets per account) instead
// of eyeballing worker logs.
// --------------------------------------------------------------------------

const fetchCensus = async () => {
  const res = await fetch(`${SIDECAR}/census`, {
    headers: { 'x-imap-sidecar-secret': devVars.IMAP_SIDECAR_SECRET },
  });
  if (!res.ok) throw new Error(`/census HTTP ${res.status}`);
  return res.json();
};

const censusAccount = REAL
  ? `${devVars.TEST_IMAP_USER}@${devVars.IMAP_DEFAULT_IMAP_HOST}`
  : `${mode.email}@127.0.0.1`;

/**
 * Canonical app snapshot: sorted "subject|labels" lines for inbox threads.
 * Labels are filtered to SERVER-DERIVED state for this folder (INBOX
 * membership, flag-derived UNREAD/STARRED, $keyword labels). App-side
 * labels (SENT — owned by the sent folder's own sync; TRASH/SNOOZED —
 * applied index-side by app actions) are legitimately absent after a
 * from-scratch inbox resync; that's pre-existing product semantics, not an
 * incremental defect, and each has its own leg.
 */
const appSnapshot = async (filterRunId) => {
  const lines = [];
  for (const t of (await listInbox()).threads ?? []) {
    const thread = await trpc('mail.get', { query: { id: t.id } });
    const subject = thread?.latest?.subject ?? '';
    if (filterRunId && !subject.includes(runId)) continue;
    // The scheduled-send messages are timer-delayed BY DESIGN (delayed job
    // + outbox-reconcile sweep as delivery safety net), so their arrival
    // time is nondeterministic — one landing between snapshot A and
    // snapshot B diverges the oracle without any incremental defect
    // (observed live on --real). They are not controlled mutations; the
    // greenmail scheduled-send leg asserts their arrival explicitly.
    if (filterRunId && /^e2e (scheduled|cancelled) /.test(subject)) continue;
    const labels = (thread?.labels ?? [])
      .map((l) => l.id)
      .filter((id) => id === 'INBOX' || id === 'UNREAD' || id === 'STARRED' || id.startsWith('$'))
      .sort()
      .join(',');
    lines.push(`${subject}|${labels}`);
  }
  return lines.sort();
};

let equivalenceModeSeen = null;

await leg('incremental-equivalence', async () => {
  const result = await trpc('connections.list', { query: null });
  const all = result?.connections ?? [];
  const connectionId = (all.find((c) => c.email === mode.email) ?? all[0])?.id;
  if (!connectionId) throw new Error('no connection id');

  const postgres = (await import('postgres')).default;
  const sql = postgres(devVars.DATABASE_URL, { max: 1 });
  // last_synced_at is written UTC-naive by drizzle; extract epoch in SQL so
  // the comparison is timezone-proof.
  const syncRow = async () =>
    (
      await sql`SELECT uid_next, sync_mode,
                       extract(epoch from last_synced_at) * 1000 AS last_ms
                FROM mail0_folder_sync_state
                WHERE connection_id = ${connectionId} AND folder = 'inbox'`
    )[0];
  const waitForSyncAfter = async (t, windowMs) => {
    const deadline = Date.now() + windowMs;
    for (;;) {
      const row = await syncRow();
      if (row?.last_ms && Number(row.last_ms) > t) return row;
      if (Date.now() > deadline) throw new Error('sync did not complete in window');
      await new Promise((r) => setTimeout(r, 3000));
    }
  };

  try {
    // Cursor precondition: at least one completed JOB sync (cursors have
    // been populating since 6.1; never assume empty ones).
    let row = await syncRow();
    if (row?.uid_next == null) {
      const t = Date.now();
      await enqueueInboxSync(connectionId);
      row = await waitForSyncAfter(t, 240_000);
      if (row?.uid_next == null) throw new Error('cursor did not populate');
    }

    // Seed the mutation targets and let them sync in.
    const keepSubject = `eqv keep ${runId}`;
    const delSubject = `eqv del ${runId}`;
    await sendRawSmtp(keepSubject);
    await sendRawSmtp(delSubject);
    const seedDeadline = Date.now() + (REAL ? 240_000 : 90_000);
    while (!((await subjectInInbox(keepSubject, 25)) && (await subjectInInbox(delSubject, 25)))) {
      if (Date.now() > seedDeadline) throw new Error('seed messages never synced');
      await new Promise((r) => setTimeout(r, 3000));
    }
    // The seeds' own sync must have COMPLETED (cursor advanced past them)
    // so the next delta is exactly our three mutations.
    await new Promise((r) => setTimeout(r, 3000));

    // Out-of-band mutations: new delivery, flag flip, deletion.
    const newSubject = `eqv new ${runId}`;
    const client = await rawImap();
    const findUid = async (subject) => {
      const uids = (await client.search({ header: { subject } }, { uid: true })) || [];
      if (!uids.length) throw new Error(`raw search found no "${subject}"`);
      return uids[uids.length - 1];
    };
    const keepUid = await findUid(keepSubject);
    const delUid = await findUid(delSubject);
    await client.messageFlagsAdd(String(keepUid), ['\\Seen'], { uid: true });
    await client.messageDelete(String(delUid), { uid: true });
    await client.logout();
    await sendRawSmtp(newSubject);

    // Incremental sync over the mutations.
    const tMutation = Date.now();
    await enqueueInboxSync(connectionId);
    row = await waitForSyncAfter(tMutation, REAL ? 240_000 : 120_000);

    // Real SMTP delivery lags the API-side mutations by seconds — the new
    // arrival lands via IDLE notify -> further INCREMENTAL jobs (cursor is
    // live, so nothing here runs full). Poll until the app shows it; the
    // oracle still exercises exclusively the incremental machinery.
    const arrivalDeadline = Date.now() + (REAL ? 240_000 : 90_000);
    while (!(await subjectInInbox(newSubject, 30))) {
      if (Date.now() > arrivalDeadline)
        throw new Error('incremental sync missed the new delivery');
      await new Promise((r) => setTimeout(r, 3000));
    }
    row = await syncRow();
    equivalenceModeSeen = row?.sync_mode ?? null;

    // Snapshot A (incremental result). On --real, restrict to this run's
    // subjects so an unrelated real-mailbox arrival can't flake the diff.
    const snapshotA = await appSnapshot(REAL);
    if (snapshotA.some((l) => l.startsWith(`${delSubject}|`)))
      throw new Error('incremental sync failed to remove the deleted thread');
    const keepLine = snapshotA.find((l) => l.startsWith(`${keepSubject}|`));
    if (!keepLine) throw new Error('flag-flipped thread missing');
    if (keepLine.includes('UNREAD'))
      throw new Error('incremental sync missed the \\Seen flag flip');

    // From-scratch full resync, then snapshot B. The oracle.
    await trpc('mail.forceSync', { mutationBody: null });
    const snapshotB = await appSnapshot(REAL);

    const a = JSON.stringify(snapshotA);
    const b = JSON.stringify(snapshotB);
    if (a !== b) {
      throw new Error(
        `incremental != full-resync.\n  incremental: ${a}\n  full:        ${b}`,
      );
    }
    return `${snapshotA.length} thread lines identical incremental vs from-scratch (mode=${equivalenceModeSeen})`;
  } finally {
    await sql.end();
  }
});

await leg('ladder-mode', async () => {
  // A silent fall to the slow floor everywhere must not pass as done.
  const expected = REAL ? ['condstore', 'qresync'] : ['uid-diff'];
  if (!equivalenceModeSeen || !expected.includes(equivalenceModeSeen)) {
    throw new Error(
      `sync_mode "${equivalenceModeSeen}" — expected ${expected.join('/')} for ${mode.name}`,
    );
  }
  return `rung "${equivalenceModeSeen}" matches ${mode.name} capabilities`;
});

await leg('census-discipline', async () => {
  // Phase 6.3: the three serialization mechanisms — 3.2's leader-lease
  // single-watcher invariant, 4.2's per-account job serialization, and the
  // (6.2, widened in 6.3) per-account driver-method lock — must COMPOSE
  // under concurrent load: no seam where two driver connections open, and
  // no over-serialization stall. This is the concurrent shape that
  // reproduced the 6.2 SELECT-interleave bug (mixed-folder /rpc callers +
  // sync jobs + api traffic), now run with the census watching.
  const result = await trpc('connections.list', { query: null });
  const all = result?.connections ?? [];
  const connectionId = (all.find((c) => c.email === mode.email) ?? all[0])?.id;
  if (!connectionId) throw new Error('no connection id');

  const auth = {
    userId: 'e2e-census',
    accessToken: '',
    refreshToken: '',
    email: mode.email,
    imap: REAL
      ? {
          imapHost: devVars.IMAP_DEFAULT_IMAP_HOST,
          imapPort: Number(devVars.IMAP_DEFAULT_IMAP_PORT || 993),
          imapSecure: true,
          smtpHost: devVars.IMAP_DEFAULT_SMTP_HOST,
          smtpPort: Number(devVars.IMAP_DEFAULT_SMTP_PORT || 587),
          smtpSecure: false,
          username: devVars.TEST_IMAP_USER,
          password: devVars.TEST_IMAP_PASSWORD,
          allowInsecureTls: true,
        }
      : {
          imapHost: '127.0.0.1',
          imapPort: 3143,
          imapSecure: false,
          smtpHost: '127.0.0.1',
          smtpPort: 3025,
          smtpSecure: false,
          username: mode.email,
          password: mode.password,
        },
  };
  const rpc = async (method, args) => {
    const res = await fetch(`${SIDECAR}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-imap-sidecar-secret': devVars.IMAP_SIDECAR_SECRET,
      },
      body: JSON.stringify({ method, args, auth }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`${method}: ${body.error}`);
    return body.result;
  };

  const boundMs = REAL ? 120_000 : 60_000;
  const started = Date.now();
  // Mixed-folder /rpc + queued sync jobs + api tRPC, all at once. A stall
  // (over-serialization deadlock) fails the race; a seam (two concurrent
  // driver sockets) fails the ceiling check below.
  const ops = Promise.all([
    rpc('list', [{ folder: 'inbox', maxResults: 10 }]),
    rpc('list', [{ folder: 'sent', maxResults: 10 }]),
    rpc('getFolderState', ['inbox']),
    rpc('getFolderState', ['sent']),
    rpc('count', []),
    rpc('list', [{ folder: 'inbox', maxResults: 5 }]),
    enqueueInboxSync(connectionId, 'inbox'),
    enqueueInboxSync(connectionId, 'sent'),
    listInbox(),
    trpc('mail.listThreads', { query: { folder: 'sent', maxResults: 10 } }),
  ]);
  const results = await Promise.race([
    ops,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`concurrent ops stalled >${boundMs / 1000}s`)), boundMs),
    ),
  ]);
  const inboxListing = results[0];
  if (!Array.isArray(inboxListing?.threads))
    throw new Error('concurrent inbox list returned no thread array');

  const census = await fetchCensus();
  const acct = census.accounts?.[censusAccount];
  if (!acct) throw new Error(`census has no entry for ${censusAccount} — instrumentation not engaged`);
  if (acct.maxImap > census.imapCeiling)
    throw new Error(`ceiling breached under load: maxImap=${acct.maxImap} > ${census.imapCeiling}`);
  return `10 concurrent ops in ${Date.now() - started}ms, maxImap=${acct.maxImap}<=${census.imapCeiling}`;
});

await leg('census-login-churn', async () => {
  // Phase 6.3 known fix: every Custom-IMAP login re-encrypts the password
  // (fresh IV -> new ciphertext). The digests are now computed from the
  // DECRYPTED password, so repeated logins must NOT cycle the IDLE watcher
  // or the cached driver connection.
  const before = await fetchCensus();
  const acctBefore = before.accounts?.[censusAccount];
  if (!acctBefore) throw new Error(`census has no entry for ${censusAccount}`);

  for (let i = 1; i <= 2; i++) {
    const res = await fetch(`${APP}/api/auth/sign-in/imap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify(mode.loginBody(mode.email, mode.password)),
    });
    if (!res.ok) throw new Error(`re-login ${i} failed (HTTP ${res.status})`);
  }
  // An authenticated driver op now carries the NEW ciphertext plus the
  // connectionId — pre-fix this is exactly what restarted the watcher.
  await listInbox();
  // A watcher restart reconnects immediately (not after the 60s retry
  // delay), so this window is ample for the churn to show if it exists.
  await new Promise((r) => setTimeout(r, 8000));

  const after = await fetchCensus();
  const acctAfter = after.accounts?.[censusAccount];
  const watcherDelta = acctAfter.opens.watcher - acctBefore.opens.watcher;
  if (watcherDelta !== 0)
    throw new Error(`IDLE watcher cycled ${watcherDelta}x across re-logins — credDigest not stable`);
  const driverDelta = acctAfter.opens.driver - acctBefore.opens.driver;
  // Strict on GreenMail; on --real a natural post-APPEND drop could add a
  // legitimate reconnect, so the driver assert would flake there.
  if (!REAL && driverDelta !== 0)
    throw new Error(`driver connection cycled ${driverDelta}x across re-logins — cache key not stable`);
  if (acctAfter.open.driver > 1 || acctAfter.open.watcher > 1)
    throw new Error(
      `duplicate sockets after re-logins: driver=${acctAfter.open.driver} watcher=${acctAfter.open.watcher}`,
    );
  return `2 re-logins: watcher opens +${watcherDelta}, driver opens +${driverDelta}, open now driver=${acctAfter.open.driver} watcher=${acctAfter.open.watcher}`;
});

await leg('midsync-arrival', async () => {
  // Phase 6.5 regression guard — a TIMING bug needs a timed repro. A full
  // sync used to record its cursor from a snapshot taken AFTER the listing;
  // a message arriving in between was ledgered with the cursor advanced
  // past it and NEVER indexed — and no later incremental could see it
  // (uid-diff starts above its uid, condstore starts above its modseq, and
  // nothing reconciles ledger-vs-index). Silent mail-invisibility on the
  // from-empty first-run path. The fix records the PRE-LISTING folder
  // state as the cursor, so a mid-sync arrival stays above it and the next
  // incremental indexes it. This leg races a delivery into the middle of a
  // running forceSync and asserts visibility within ONE further sync cycle.
  const result = await trpc('connections.list', { query: null });
  const all = result?.connections ?? [];
  const connectionId = (all.find((c) => c.email === mode.email) ?? all[0])?.id;
  if (!connectionId) throw new Error('no connection id');

  // The repro must match the observed mechanism exactly: a JOB full sync
  // whose page-1 listing predates the arrival, with the arrival's notify
  // collapsing into the 4.2 dirty-flag (job already active) so the trailing
  // sync runs INCREMENTAL against the job's completion cursor. An api-side
  // forceSync race does NOT reproduce it — its cursor wipe makes the
  // notify-spawned job run full and rescue the message (observed: the
  // first version of this leg passed on pre-fix code).
  //
  // GreenMail syncs are fast — widen the job's window by seeding the inbox
  // so its full listing takes ~10s. The real mailbox is slow on its own.
  if (!REAL) {
    const transporter = nodemailer.createTransport(mode.smtp);
    for (let i = 0; i < 50; i++) {
      await transporter.sendMail({
        from: mode.email,
        to: mode.email,
        subject: `e2e midseed ${runId} ${i}`,
        html: `<p>seed</p>`,
      });
    }
    transporter.close();
  }

  // Force the next JOB sync onto the full path: drop the inbox cursor and
  // ledger for this connection (index left intact — the full sync re-upserts).
  const postgres = (await import('postgres')).default;
  const sql = postgres(devVars.DATABASE_URL, { max: 1 });
  try {
    await sql`DELETE FROM mail0_folder_sync_state WHERE connection_id = ${connectionId} AND folder = 'inbox'`;
    await sql`DELETE FROM mail0_folder_message WHERE connection_id = ${connectionId} AND folder = 'inbox'`;
  } finally {
    await sql.end();
  }

  // Start the job, let it list page 1 (newest-first, listed first), then
  // land the probe while the job is still mid-run.
  const probeSubject = `e2e midsync ${runId}`;
  await enqueueInboxSync(connectionId);
  await new Promise((r) => setTimeout(r, REAL ? 30_000 : 4000));
  await sendRawSmtp(probeSubject);

  // The probe's own notify hits the jobId dedup (job active) -> dirty-flag
  // trailing re-enqueue -> trailing sync runs incremental against the
  // job's recorded cursor. Pre-fix that cursor post-dated the probe
  // (snapshot taken after the listing) and the probe stayed invisible
  // FOREVER; post-fix the cursor is the pre-listing state, so the trailing
  // incremental indexes it. Window covers job completion + the trailing
  // cycle.
  const windowMs = REAL ? 360_000 : 90_000;
  const deadline = Date.now() + windowMs;
  let visible = false;
  while (Date.now() < deadline) {
    if (await subjectInInbox(probeSubject, 25)) {
      visible = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  // Self-clean the GreenMail seeds (best-effort): a run that aborts after
  // this leg must not leave 50 same-timestamp threads behind — they push
  // the inbox past the 50-thread snapshot page and same-timestamp ordering
  // ties flake the equivalence oracle on the NEXT run (observed live). On
  // --real there are no seeds; the cleanup leg removes the probe.
  if (!REAL) {
    const rpcAuth = {
      userId: 'e2e-midsync-clean',
      accessToken: '',
      refreshToken: '',
      email: mode.email,
      imap: {
        imapHost: '127.0.0.1',
        imapPort: 3143,
        imapSecure: false,
        smtpHost: '127.0.0.1',
        smtpPort: 3025,
        smtpSecure: false,
        username: mode.email,
        password: mode.password,
      },
    };
    const rpc = async (method, args) => {
      const res = await fetch(`${SIDECAR}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-imap-sidecar-secret': devVars.IMAP_SIDECAR_SECRET,
        },
        body: JSON.stringify({ method, args, auth: rpcAuth }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(`${method}: ${body.error}`);
      return body.result;
    };
    try {
      for (let page = 0; page < 3; page++) {
        const listing = await rpc('list', [{ folder: 'inbox', maxResults: 50 }]);
        const targets = (listing.threads ?? []).filter((t) =>
          (t.$raw?.subject ?? '').startsWith(`e2e midseed ${runId}`),
        );
        if (!targets.length) break;
        for (const t of targets) {
          await rpc('delete', [t.id]).catch(() => undefined);
        }
      }
      await enqueueInboxSync(connectionId);
    } catch {
      // best-effort — drop-recover's GreenMail restart wipes the rest
    }
  }

  if (!visible) {
    throw new Error(
      `mid-sync arrival "${probeSubject}" NOT visible ${windowMs / 1000}s after the full job sync — ledgered-but-unindexed regression`,
    );
  }
  return `mid-sync arrival "${probeSubject}" visible within one sync cycle of the job`;
});

if (REAL) {
  // Mailbox hygiene: hard-delete this run's messages from the REAL server
  // (thread delete purges every folder member via the worker /rpc driver).
  // Without this the mailbox grows a few messages per run, full-refetch
  // sync time grows with it, and the timing windows above start flaking
  // (observed at ~55 inbox threads). Best-effort — a failure here does not
  // fail the run. GreenMail needs none of this (drop-recover wipes it).
  await leg('cleanup', async () => {
    const auth = {
      userId: 'e2e-cleanup',
      accessToken: '',
      refreshToken: '',
      email: mode.email,
      imap: {
        imapHost: devVars.IMAP_DEFAULT_IMAP_HOST,
        imapPort: Number(devVars.IMAP_DEFAULT_IMAP_PORT || 993),
        imapSecure: true,
        smtpHost: devVars.IMAP_DEFAULT_SMTP_HOST,
        smtpPort: Number(devVars.IMAP_DEFAULT_SMTP_PORT || 587),
        smtpSecure: false,
        username: devVars.TEST_IMAP_USER,
        password: devVars.TEST_IMAP_PASSWORD,
        allowInsecureTls: true,
      },
    };
    const rpc = async (method, args) => {
      const res = await fetch(`${SIDECAR}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-imap-sidecar-secret': devVars.IMAP_SIDECAR_SECRET,
        },
        body: JSON.stringify({ method, args, auth }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(`${method}: ${body.error}`);
      return body.result;
    };
    let deleted = 0;
    try {
      for (const folder of ['inbox', 'sent']) {
        // 20 was too small once a run leaves more than a page of fixtures
        // behind: the tail survived cleanup and accumulated.
        const listing = await rpc('list', [{ folder, maxResults: 100 }]);
        for (const t of listing.threads ?? []) {
          if ((t.$raw?.subject ?? '').includes(runId)) {
            try {
              await rpc('delete', [t.id]);
              deleted++;
            } catch {
              // best-effort
            }
          }
        }
      }
    } catch (error) {
      // Best-effort means best-effort: a transient failure here (e.g. a DNS
      // blip) must not fail an otherwise-green run.
      return `cleanup skipped (best-effort): ${error.message}`;
    }
    return `${deleted} thread(s) of run ${runId} hard-deleted from the real server`;
  }, { always: true });
}

if (!REAL) {
  await leg('drop-recover', async () => {
    // Kill every IMAP connection out from under the worker's driver cache.
    const { execSync } = await import('node:child_process');
    execSync('docker restart greenmail-test', { stdio: 'ignore' });
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await tcpProbe('127.0.0.1', 3143);
        break;
      } catch {
        if (Date.now() > deadline) throw new Error('greenmail did not come back after restart');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    // TCP-accept precedes IMAP readiness on a restarting GreenMail; give
    // the greeting a moment so the leg tests OUR reconnect, not GreenMail
    // boot latency.
    await new Promise((r) => setTimeout(r, 3000));
    // The cached driver still looks `usable`; this op's failure is the
    // detection, and the /rpc reconnect retry must make it green with no
    // manual retry from here.
    await trpc('mail.forceSync', { mutationBody: null });
    return 'forceSync green over a freshly killed connection (auto-reconnect, no manual retry)';
  });
}

if (!REAL) {
  await leg('uidvalidity-guard', async () => {
    // Phase 6.1 (MIGRATION-PLAN §9.1): a UIDVALIDITY change means cached
    // UIDs may point at DIFFERENT messages. GreenMail's validity is
    // boot-derived and its store is in-memory, so docker restart IS a real
    // validity change plus a full mailbox swap — exactly the corruption
    // scenario the guard exists for.
    const postgres = (await import('postgres')).default;
    const { ImapFlow } = await import('imapflow');
    const sql = postgres(devVars.DATABASE_URL, { max: 1 });
    const pgRow = async (connectionId) =>
      (
        await sql`SELECT uid_validity, page_token, resync_count FROM mail0_folder_sync_state
                  WHERE connection_id = ${connectionId} AND folder = 'inbox'`
      )[0];
    const rawInboxState = async () => {
      const client = new ImapFlow({
        host: '127.0.0.1',
        port: 3143,
        secure: false,
        auth: { user: mode.email, pass: mode.password },
        logger: false,
      });
      await client.connect();
      const mailbox = await client.mailboxOpen('INBOX');
      const subjects = [];
      if (mailbox.exists > 0) {
        for await (const msg of client.fetch('1:*', { envelope: true })) {
          subjects.push(msg.envelope?.subject ?? '');
        }
      }
      const state = { uidValidity: Number(mailbox.uidValidity), subjects };
      await client.logout();
      return state;
    };

    try {
      const result = await trpc('connections.list', { query: null });
      const all = result?.connections ?? [];
      const connectionId = (all.find((c) => c.email === mode.email) ?? all[0])?.id;
      if (!connectionId) throw new Error('no connection id');

      // Phase A: seed, let the JOB sync record the current validity.
      // drop-recover just restarted GreenMail; its SMTP side can lag the
      // IMAP probe. Retry the seed send briefly instead of dying on a
      // boot-window socket close.
      const sendWithRetry = async (subject) => {
        for (let attempt = 1; ; attempt++) {
          try {
            await sendRawSmtp(subject);
            return;
          } catch (error) {
            if (attempt >= 5) throw error;
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
      };

      // Window covers the watcher reconnect (~60 s) still pending from the
      // drop-recover leg's own GreenMail restart just above.
      const subjectA = `uidv A ${runId}`;
      await sendWithRetry(subjectA);
      let deadline = Date.now() + 150_000;
      while (!(await subjectInInbox(subjectA, 20))) {
        if (Date.now() > deadline) throw new Error('phase-A message never synced');
        await new Promise((r) => setTimeout(r, 3000));
      }
      // Bounded poll, not a single read: while the inbox index is empty
      // (exactly the post-drop-recover state), every listThreads poll above
      // may fire an ASYNC forceReSync (30s cooldown) whose clear->record
      // window can transiently hide the row a job sync just wrote. The
      // assertion stands — validity must be recorded — it just tolerates an
      // in-flight concurrent resync.
      let before = await pgRow(connectionId);
      const validityDeadline = Date.now() + 60_000;
      while (before?.uid_validity == null) {
        if (Date.now() > validityDeadline)
          throw new Error('sync did not record uid_validity before the change');
        await new Promise((r) => setTimeout(r, 3000));
        before = await pgRow(connectionId);
      }

      // The change: restart (new validity, empty store) and reseed B.
      const { execSync } = await import('node:child_process');
      execSync('docker restart greenmail-test', { stdio: 'ignore' });
      deadline = Date.now() + 30_000;
      for (;;) {
        try {
          await tcpProbe('127.0.0.1', 3143);
          break;
        } catch {
          if (Date.now() > deadline) throw new Error('greenmail did not come back');
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      const subjectB = `uidv B ${runId}`;
      await sendWithRetry(subjectB);

      // Watcher reconnects (~60 s), notify fires, the guard must trip.
      deadline = Date.now() + 180_000;
      while (!(await subjectInInbox(subjectB, 20))) {
        if (Date.now() > deadline) throw new Error('phase-B message never synced after restart');
        await new Promise((r) => setTimeout(r, 3000));
      }

      const server = await rawInboxState();
      
      let after = await pgRow(connectionId);
      const afterDeadline = Date.now() + 60_000;
      while (after?.uid_validity == null) {
        if (Date.now() > afterDeadline) throw new Error('sync did not record uid_validity after the change');
        await new Promise((r) => setTimeout(r, 1000));
        after = await pgRow(connectionId);
      }

      if (Number(after?.uid_validity) === Number(before.uid_validity))
        throw new Error('stored uid_validity did not change');
      if (Number(after?.uid_validity) !== server.uidValidity)
        throw new Error(
          `stored validity ${after?.uid_validity} != server ${server.uidValidity}`,
        );
      if (after?.page_token != null) throw new Error('stale pageToken checkpoint survived');
      // NOTE: resync_count=1 is set by the tripped sync but a trailing
      // incremental sync (~150 ms under the 6.2 ladder) may legitimately
      // reset it to 0 before this read — the trip itself is asserted via
      // its durable effects (validity updated + purge below); the counter
      // is only asserted to be non-stuck at the end.

      // Purge assert: the pre-change thread must be GONE from the app.
      if (await subjectInInbox(subjectA, 20))
        throw new Error(`stale pre-change thread "${subjectA}" still served`);

      // Corruption non-event: every served page-1 thread's subject must
      // exist on the server — nothing is served from a stale cache.
      const serverSubjects = new Set(server.subjects);
      for (const t of (await listInbox()).threads.slice(0, 10)) {
        const thread = await trpc('mail.get', { query: { id: t.id } });
        const subject = thread?.latest?.subject;
        if (subject && !serverSubjects.has(subject))
          throw new Error(`served thread "${subject}" does not exist on the server`);
      }

      // Reset assert: one more clean sync under the NEW validity zeroes the
      // flap counter.
      const subjectC = `uidv C ${runId}`;
      await sendWithRetry(subjectC);
      deadline = Date.now() + 90_000;
      while (!(await subjectInInbox(subjectC, 20))) {
        if (Date.now() > deadline) throw new Error('phase-C message never synced');
        await new Promise((r) => setTimeout(r, 3000));
      }
      const final = await pgRow(connectionId);
      if ((final?.resync_count ?? -1) !== 0)
        throw new Error(`resync_count not reset after stable sync (=${final?.resync_count})`);

      return `validity ${before.uid_validity} -> ${server.uidValidity}: guard tripped, cache purged, no stale serving, counter reset`;
    } finally {
      await sql.end();
    }
  });
}

await leg('list-sort', async () => {
  // Append newer message first (so it gets the LOWER UID), then older second.
  // We explicitly set Date headers to control logical age independent of IMAP APPEND order.
  const subOlder = `sort older ${runId}`;
  const subNewer = `sort newer ${runId}`;
  const marker = `sort marker ${runId}`;
  
  const client = await rawImap();
  try {
    const newerRaw = `Date: ${hoursAgoHeader(2)}\r\nSubject: ${subNewer}\r\nFrom: e2e@test\r\n\r\n${marker}`;
    await client.append('INBOX', newerRaw, ['\\Seen']);
    const olderRaw = `Date: ${hoursAgoHeader(3)}\r\nSubject: ${subOlder}\r\nFrom: e2e@test\r\n\r\n${marker}`;
    await client.append('INBOX', olderRaw, ['\\Seen']);
  } finally {
    await client.logout();
  }

  // Force sync to ingest the new messages via jobs
  const result = await trpc('connections.list', { query: null });
  const all = result?.connections ?? [];
  const connectionId = (all.find((c) => c.email === mode.email) ?? all[0])?.id;
  await enqueueInboxSync(connectionId);

  // Poll until both are visible in the API. Window covers job completion.
  const windowMs = REAL ? 120_000 : 90_000;
  const deadline = Date.now() + windowMs;
  while (!((await subjectInInbox(subOlder, 25)) && (await subjectInInbox(subNewer, 25)))) {
    if (Date.now() > deadline) throw new Error('sort messages never synced');
    await new Promise((r) => setTimeout(r, 3000));
  }

  // Search by marker so both are returned
  const searchResult = await trpc('mail.listThreads', { query: { folder: 'inbox', q: marker } });
  const threads = searchResult.threads ?? [];
  if (threads.length < 2) throw new Error(`Expected at least 2 threads from search, got ${threads.length}`);

  // Newest first: the first thread returned must be the NEWER one by date, despite having the LOWER UID.
  const firstThread = await trpc('mail.get', { query: { id: threads[0].id } });
  if (firstThread?.latest?.subject !== subNewer) {
    throw new Error(`Search sorting failed: First thread was "${firstThread?.latest?.subject}", expected "${subNewer}"`);
  }

  return `search returns newer thread first despite lower UID`;
});

await leg('list-sort-page-slice', async () => {
  // Regression guard for the break-then-slice ordering bug.
  //
  // The list-sort leg above cannot catch it: it gives the NEWER message the
  // LOWER UID, and IMAP returns FETCH results UID-ascending, so the correct
  // answer sits first by accident even when the code slices before sorting.
  // Here the newer message gets the HIGHER UID, so a slice-before-sort
  // returns the OLDER one. maxResults:1 forces the early-break path
  // (allGroups.length >= maxResults) that does the slicing.
  const subOlder = `slice older ${runId}`;
  const subNewer = `slice newer ${runId}`;
  const marker = `slice marker ${runId}`;

  const client = await rawImap();
  try {
    // older first => LOWER uid
    const olderRaw = `Date: ${hoursAgoHeader(3)}\r\nSubject: ${subOlder}\r\nFrom: e2e@test\r\n\r\n${marker}`;
    await client.append('INBOX', olderRaw, ['\\Seen']);
    // newer second => HIGHER uid
    const newerRaw = `Date: ${hoursAgoHeader(2)}\r\nSubject: ${subNewer}\r\nFrom: e2e@test\r\n\r\n${marker}`;
    await client.append('INBOX', newerRaw, ['\\Seen']);
  } finally {
    await client.logout();
  }

  const result = await trpc('connections.list', { query: null });
  const all = result?.connections ?? [];
  const connectionId = (all.find((c) => c.email === mode.email) ?? all[0])?.id;
  await enqueueInboxSync(connectionId);

  const windowMs = REAL ? 120_000 : 90_000;
  const deadline = Date.now() + windowMs;
  while (!((await subjectInInbox(subOlder, 25)) && (await subjectInInbox(subNewer, 25)))) {
    if (Date.now() > deadline) throw new Error('slice-order messages never synced');
    await new Promise((r) => setTimeout(r, 3000));
  }

  const searchResult = await trpc('mail.listThreads', {
    query: { folder: 'inbox', q: marker, maxResults: 1 },
  });
  const threads = searchResult.threads ?? [];
  if (threads.length !== 1) {
    throw new Error(`Expected exactly 1 thread at maxResults:1, got ${threads.length}`);
  }

  const firstThread = await trpc('mail.get', { query: { id: threads[0].id } });
  if (firstThread?.latest?.subject !== subNewer) {
    throw new Error(
      `Page slice took the wrong end: got "${firstThread?.latest?.subject}", expected "${subNewer}". ` +
        `The capped page returned the OLDER message, i.e. groups were sliced before being sorted newest-first.`,
    );
  }

  return `capped page returns newest despite higher UID`;
});

await leg('derived-vs-stored-threadId', async () => {
  // Append two messages without Message-ID headers to verify synthetic fallback threadIDs
  // round-trip stably through search -> get.
  const sub1 = `derived no-id one ${runId}`;
  const sub2 = `derived no-id two ${runId}`;
  const marker = `derived marker ${runId}`;
  
  const client = await rawImap();
  try {
    const raw1 = `Date: ${hoursAgoHeader(3)}\r\nSubject: ${sub1}\r\nFrom: e2e@test\r\n\r\n${marker}`;
    await client.append('INBOX', raw1, ['\\Seen']);
    const raw2 = `Date: ${hoursAgoHeader(2)}\r\nSubject: ${sub2}\r\nFrom: e2e@test\r\n\r\n${marker}`;
    await client.append('INBOX', raw2, ['\\Seen']);
  } finally {
    await client.logout();
  }

  // Force sync
  const result = await trpc('connections.list', { query: null });
  const all = result?.connections ?? [];
  const connectionId = (all.find((c) => c.email === mode.email) ?? all[0])?.id;
  await enqueueInboxSync(connectionId);

  // Poll for visibility
  const windowMs = REAL ? 120_000 : 90_000;
  const deadline = Date.now() + windowMs;
  while (!((await subjectInInbox(sub1, 25)) && (await subjectInInbox(sub2, 25)))) {
    if (Date.now() > deadline) throw new Error('derived messages never synced');
    await new Promise((r) => setTimeout(r, 3000));
  }

  // Search matching only the SECOND one
  const searchResult = await trpc('mail.listThreads', { query: { folder: 'inbox', q: sub2 } });
  const threads = searchResult.threads ?? [];
  if (threads.length === 0) throw new Error('Search for second message returned 0 threads');

  const searchedId = threads[0].id;
  
  // Verify it can be fetched by ID and matches
  const fetched = await trpc('mail.get', { query: { id: searchedId } });
  if (fetched?.latest?.subject !== sub2) {
    throw new Error(`Fetched thread subject "${fetched?.latest?.subject}" != expected "${sub2}"`);
  }

  return `derived thread ID ${searchedId} round-trips correctly through search -> get`;
});

await leg('census-ceiling', async () => {
  // The standing 6.3 regression assertion, LAST on purpose: maxImap is the
  // running maximum since worker boot, so this covers every leg above
  // (including the GreenMail-restart churn of drop-recover and
  // uidvalidity-guard) — the fail2ban trigger cannot have recurred if this
  // holds.
  const census = await fetchCensus();
  if (!census.accounts?.[censusAccount])
    throw new Error(`census has no entry for ${censusAccount} — instrumentation not engaged`);
  const offenders = Object.entries(census.accounts).filter(
    ([, s]) => s.maxImap > census.imapCeiling,
  );
  if (offenders.length)
    throw new Error(
      offenders
        .map(
          ([account, s]) =>
            `${account}: maxImap=${s.maxImap}>${census.imapCeiling} at ${new Date(s.maxImapAt).toISOString()}`,
        )
        .join('; '),
    );
  const s = census.accounts[censusAccount];
  return `ceiling held for every account: maxImap=${s.maxImap}<=${census.imapCeiling} (opens: driver=${s.opens.driver} watcher=${s.opens.watcher} smtp=${s.opens.smtp})`;
});

console.log(`\n[e2e] mode=${mode.name} — ${failed ? 'FAILED' : 'ALL LEGS GREEN'}`);
process.exit(failed ? 1 : 0);
