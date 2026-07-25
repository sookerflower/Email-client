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
 *   8. idle-push   — raw SMTP delivery (bypassing the app), then poll list
 *                    WITHOUT any manual sync until the count increments:
 *                    watcher -> /api/public/imap-notify -> auto-sync
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
  throw new Error(`sent thread "${sentSubject}" not found in first 15 threads`);
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
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      if (await subjectInInbox(idleSubject)) {
        return `"${idleSubject}" auto-synced into inbox, no manual refresh`;
      }
    }
    throw new Error(`"${idleSubject}" not in inbox after 90s — IDLE push not working`);
  });
}

console.log(`\n[e2e] mode=${mode.name} — ${failed ? 'FAILED' : 'ALL LEGS GREEN'}`);
process.exit(failed ? 1 : 0);
