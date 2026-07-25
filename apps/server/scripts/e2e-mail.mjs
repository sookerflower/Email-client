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

const legs = [];
let failed = false;

const leg = async (name, fn) => {
  if (failed) return;
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

/** True if a thread whose latest subject matches is within the first `depth` inbox threads. */
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

  // Real-server window: the sent job serializes behind any in-flight inbox
  // sync for the account (~2 min under full-refetch).
  const sentWindowMs = REAL ? 240_000 : 90_000;
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
    // Real-server window covers the worst case under full-refetch sync: a
    // mid-flight inbox job whose listing predates the message must finish
    // (~100 s) before the dirty-flag re-enqueue syncs the new arrival.
    // Incremental sync (next work item) will let this tighten again.
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
    for (const folder of ['inbox', 'sent']) {
      const listing = await rpc('list', [{ folder, maxResults: 20 }]);
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
    return `${deleted} thread(s) of run ${runId} hard-deleted from the real server`;
  });
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

console.log(`\n[e2e] mode=${mode.name} — ${failed ? 'FAILED' : 'ALL LEGS GREEN'}`);
process.exit(failed ? 1 : 0);
