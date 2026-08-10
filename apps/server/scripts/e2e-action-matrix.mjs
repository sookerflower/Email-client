/**
 * Control Matrix - E2E Mail ACTIONS
 *
 * Four PRIMITIVES rather than nineteen wrappers, because the nineteen UI
 * controls reduce to four things the server can actually do:
 *   1. flag set/clear      (\Flagged via STARRED, \Seen via UNREAD)
 *   2. folder move         (INBOX -> Trash -> back)
 *   3. keyword add/remove  ($zl_ user label)
 *   4. permanent delete    (EXPUNGE, guarded: only from Trash)
 *
 * EVERY assertion checks THREE LEVELS, because one can be right while another
 * is wrong -- and for most of this project's life they disagreed silently:
 *   (a) app     - what tRPC returns, i.e. what the UI renders
 *   (b) index   - Postgres thread_label / folder_message, read via SQL
 *   (c) SERVER  - an INDEPENDENT IMAP session, never the driver under test
 *
 * Level (c) is the one that matters. Every user action used to write only to
 * Postgres; (a) and (b) agreed with each other and both were wrong.
 *
 * Every toggle asserts BOTH DIRECTIONS and IDEMPOTENCY (set -> unset -> set
 * twice). The un-set direction is where the bugs lived: labels were once
 * ADD-ONLY, so UNREAD could never clear.
 *
 * Every action is then re-checked after a FORCED RESYNC, and one action is
 * re-checked after a full DB WIPE. Those two are the assertions this entire
 * class of bug would have failed on day one: state that exists only in the
 * index is silently re-derived away by a resync and destroyed by a wipe.
 *
 * GreenMail by default; --real for Dovecot.
 */
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import net from 'node:net';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(new Agent({ headersTimeout: 900_000, bodyTimeout: 900_000 }));

const REAL = process.argv.includes('--real');
const APP = process.env.E2E_APP_URL || 'http://127.0.0.1:8787';
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
      name: 'real (m.re.cx)',
      email: devVars.TEST_IMAP_USER,
      password: devVars.TEST_IMAP_PASSWORD,
      loginBody: (email, password) => ({ email, password }),
    }
  : {
      name: 'GreenMail (local)',
      email: 'student2@classroom.test',
      password: 'secret123',
      loginBody: (email, password) => ({
        email,
        password,
        imapHost: '127.0.0.1',
        imapPort: 3143,
        smtpHost: '127.0.0.1',
        smtpPort: 3025,
      }),
    };

if (!mode.email || !mode.password) {
  console.error('[e2e] missing credentials for mode', mode.name);
  process.exit(2);
}

const runId = Math.random().toString(36).slice(2, 10);
const FIXTURE_PREFIX = 'ActionMatrix';
const LABEL_NAME = `actlbl${runId}`;
const SEARCH_FOLDERS = ['INBOX', 'Trash', 'Junk', 'Archive'];

let cookie = '';
let connectionId = null;
let resolvedLabelId = null;
let imap = null;
let appendedSubjects = [];

// ------------------------------------------------------------------ plumbing
/**
 * Transient-failure retry, --real's survival kit.
 *
 * On GreenMail every hop is localhost and nothing blips. On --real a single
 * run makes ~200 network operations (each server() assertion is a fresh TLS
 * IMAP login; every leg round-trips the api), and this session lost two
 * consecutive 20-minute runs to two DIFFERENT sub-second blips (a DNS
 * ENOTFOUND, then one 'fetch failed'). A harness that dies on any one of 200
 * transients is measuring the network, not the code. Retries are bounded and
 * logged; a persistent failure still fails.
 */
const TRANSIENT = /ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|fetch failed|Connect Timeout|Socket closed|getaddrinfo|Connection not available/i;
const withRetry = async (label, fn, attempts = 5) => {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (!TRANSIENT.test(e?.message ?? '') || i === attempts) throw e;
      console.warn(`[e2e] transient on ${label} (attempt ${i}/${attempts}): ${e.message.slice(0, 80)} -- retrying`);
      // Exponential: 3s,6s,12s,24s -- the DNS failures here arrive as BURSTS
      // lasting tens of seconds, not single blips; 3 linear retries (~9s)
      // died inside one.
      await new Promise((r) => setTimeout(r, 3000 * 2 ** (i - 1)));
    }
  }
  throw lastError;
};

const trpc = async (path, { query, mutationBody } = {}) => withRetry(`trpc ${path}`, async () => {
  const url = `${APP}/api/trpc/${path}?batch=1${
    query !== undefined ? `&input=${encodeURIComponent(JSON.stringify({ 0: { json: query } }))}` : ''
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
    throw new Error(`${path}: non-JSON (HTTP ${res.status}): ${text.slice(0, 140)}`);
  }
  if (parsed[0]?.error) throw new Error(`${path}: ${parsed[0].error.json?.message ?? 'tRPC error'}`);
  return parsed[0]?.result?.data?.json;
});

const sql = (q) =>
  execSync(
    `docker exec zerodotemail-db psql -U postgres -d zerodotemail -t -A -c "${q.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' },
  ).trim();

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
  // An 'error' event with no listener is UNHANDLED and kills the process,
  // skipping cleanup and stranding fixtures in a real mailbox.
  client.on('error', (e) => console.warn(`[e2e] raw IMAP error (non-fatal): ${e?.code ?? e?.message}`));
  await client.connect();
  return client;
};

// --------------------------------------------------------------- the 3 levels
/** (c) SERVER: where the message lives and what flags it carries. */
const server = async (subject) => withRetry(`server(${subject.slice(-12)})`, async () => {
  const c = await rawImap();
  try {
    for (const path of SEARCH_FOLDERS) {
      let lock;
      try {
        lock = await c.getMailboxLock(path);
      } catch {
        continue;
      }
      try {
        const uids = (await c.search({ header: { subject } }, { uid: true })) || [];
        if (uids.length) {
          const m = await c.fetchOne(String(uids[0]), { flags: true }, { uid: true });
          return { folder: path, uid: uids[0], flags: [...(m?.flags ?? [])], exists: true };
        }
      } finally {
        lock.release();
      }
    }
    return { folder: null, uid: null, flags: [], exists: false };
  } finally {
    await c.logout();
  }
});

/** (b) INDEX: thread labels and the folder_message ledger. */
const index = (threadId) => ({
  labels: sql(
    `select label_id from mail0_thread_label where connection_id='${connectionId}' and thread_id='${threadId}' order by label_id`,
  )
    .split('\n')
    .filter(Boolean),
  ledger: sql(
    `select folder||'|'||uid from mail0_folder_message where connection_id='${connectionId}' and thread_id='${threadId}' order by folder`,
  )
    .split('\n')
    .filter(Boolean),
  present: sql(
    `select count(*) from mail0_thread where connection_id='${connectionId}' and thread_id='${threadId}'`,
  ) === '1',
});

/** (a) APP: what tRPC returns, i.e. what the UI renders. */
const app = async (threadId) => {
  const th = await trpc('mail.get', { query: { id: threadId } });
  return {
    tags: (th?.latest?.tags ?? []).map((t) => t.name),
    labels: (th?.labels ?? []).map((l) => l.id),
    hasUnread: th?.hasUnread ?? null,
    subject: th?.latest?.subject ?? null,
  };
};

// ------------------------------------------------------------------ recording
const matrix = [];
let fatal = false;
const record = (primitive, control, expected, actual, ok, detail = '') => {
  matrix.push({ primitive, control, expected, actual, verdict: ok ? 'PASS' : 'FAIL', detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${primitive}] ${control}`);
  if (!ok) console.log(`        expected: ${expected}\n        actual:   ${actual}${detail ? `\n        ${detail}` : ''}`);
};

/**
 * A leg that is EXPECTED to fail today -- a named, understood gap, not a
 * regression. Reported loudly (never silently skipped) but tracked
 * separately from FAIL so a real regression can never hide next to it, and a
 * clean run's exit code isn't poisoned by a gap everyone already knows about.
 * `ok` here means "behaves as the gap predicts" (i.e. still broken); if the
 * gap ever gets FIXED this flips to UNEXPECTED_PASS, which is loud on
 * purpose -- the comment describing the gap needs updating, not silent green.
 */
const recordKnownGap = (primitive, control, expected, actual, stillBroken, detail = '') => {
  const verdict = stillBroken ? 'KNOWN_GAP' : 'UNEXPECTED_PASS';
  matrix.push({ primitive, control, expected, actual, verdict, detail });
  console.log(`${verdict}  [${primitive}] ${control}`);
  console.log(`        expected: ${expected}\n        actual:   ${actual}${detail ? `\n        ${detail}` : ''}`);
};

const hardLeg = async (name, fn) => {
  try {
    const detail = await fn();
    console.log(`[e2e] PASS ${name}${detail ? ` - ${detail}` : ''}`);
    return true;
  } catch (error) {
    console.error(`[e2e] FATAL ${name} - ${error.message}`);
    matrix.push({ primitive: 'infra', control: name, expected: 'succeeds', actual: error.message, verdict: 'FATAL', detail: '' });
    fatal = true;
    return false;
  }
};

/**
 * Assert one action at all three levels.
 * Predicates receive the level snapshot and return true when correct.
 */
/**
 * Self-test. `E2E_NEGATIVE_CONTROL=server|index|app` inverts the FIRST
 * assertion that has a predicate at that level, which MUST turn exactly that
 * one leg red.
 *
 * A brand-new harness reporting all-green is indistinguishable from one whose
 * predicates never run -- and this project has shipped exactly that twice
 * (list-sort passed against the bug it was written for; the first ordering
 * guard passed against broken code). One inverted level proves nothing about
 * the other two: an inert INDEX predicate looks identical to a passing one
 * unless INDEX itself is proven able to fail. Run all three after any change
 * to assertLevels:
 *   E2E_NEGATIVE_CONTROL=server node scripts/e2e-action-matrix.mjs
 *   E2E_NEGATIVE_CONTROL=index  node scripts/e2e-action-matrix.mjs
 *   E2E_NEGATIVE_CONTROL=app    node scripts/e2e-action-matrix.mjs
 * Each must report exactly 1 fail, at that level, on the first assertion that
 * has a predicate there.
 */
const NEGATIVE_CONTROL_LEVEL = process.env.E2E_NEGATIVE_CONTROL || null;
if (NEGATIVE_CONTROL_LEVEL && !['server', 'index', 'app'].includes(NEGATIVE_CONTROL_LEVEL)) {
  console.error(`[e2e] E2E_NEGATIVE_CONTROL must be server|index|app, got ${NEGATIVE_CONTROL_LEVEL}`);
  process.exit(2);
}
let negativeControlArmed = !!NEGATIVE_CONTROL_LEVEL;

const assertLevels = async (primitive, control, subject, threadId, want) => {
  if (negativeControlArmed && want[NEGATIVE_CONTROL_LEVEL]) {
    negativeControlArmed = false;
    const original = want[NEGATIVE_CONTROL_LEVEL];
    want = { ...want, [NEGATIVE_CONTROL_LEVEL]: (x) => !original(x) };
    console.log(`[e2e] NEGATIVE CONTROL: inverted the ${NEGATIVE_CONTROL_LEVEL.toUpperCase()} predicate for the next assertion`);
  }
  // SERVER: immediate read. The IMAP write IS awaited by the mutation, so
  // server truth must hold the moment the tRPC call returns -- no grace.
  if (want.server) {
    const c = await server(subject);
    record(
      primitive,
      `${control} (SERVER)`,
      want.describe ?? 'see predicate',
      `${c.folder}:${JSON.stringify(c.flags)}`,
      want.server(c),
    );
  }

  // INDEX/APP: bounded poll to convergence. The index refresh is a BACKGROUND
  // CONTINUATION since the latency fix -- the mutation returns before the
  // re-derivation lands, so an immediate read here is a race, not an
  // assertion. This does NOT weaken the claim: convergence must arrive within
  // the deadline or the leg FAILS. (An inverted negative-control predicate
  // simply polls out the full deadline and then fails, as it should.)
  if (want.app || want.index) {
    const deadline = Date.now() + (REAL ? 30_000 : 15_000);
    let a = await app(threadId);
    let b = index(threadId);
    for (;;) {
      const appOk = want.app ? want.app(a) : true;
      const idxOk = want.index ? want.index(b) : true;
      if (appOk && idxOk) break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 1000));
      a = await app(threadId);
      b = index(threadId);
    }
    if (want.app) {
      record(primitive, `${control} (app)`, want.describe ?? 'see predicate', JSON.stringify(a.tags), want.app(a));
    }
    if (want.index) {
      record(primitive, `${control} (index)`, want.describe ?? 'see predicate', JSON.stringify(b.labels), want.index(b));
    }
  }
};

/** forceSync, then re-assert. The index is rebuilt from the server here. */
const afterResync = async (primitive, control, subject, threadId, want) => {
  await trpc('mail.forceSync', { mutationBody: null });
  await new Promise((r) => setTimeout(r, REAL ? 12000 : 6000));
  await assertLevels(primitive, `${control} SURVIVES forced resync`, subject, threadId, want);
};

// ------------------------------------------------------------------- fixtures
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000);
const S = (label) => `${FIXTURE_PREFIX} ${label} ${runId}`;

/**
 * Message-ID is present ON PURPOSE. Thread identity derives from it and
 * survives a MOVE; without one the id is synthetic
 * encodeMessageId(folder, uidValidity, uid), which changes on every move --
 * documented behaviour, but it makes threadId-stability assertions meaningless.
 *
 * Past-dated, never future-dated: a future date pins a stranded fixture to the
 * top of every newest-first list forever.
 */
const rawMessage = (subject, hours) =>
  [
    `Message-ID: <${subject.replace(/\s+/g, '.')}@actionmatrix.test>`,
    `From: "Action Fixture" <fixture@action.test>`,
    `To: ${mode.email}`,
    `Subject: ${subject}`,
    `Date: ${hoursAgo(hours).toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `action matrix fixture body`,
  ].join('\r\n');

const seed = async (subject, hours) => {
  const lock = await imap.getMailboxLock('INBOX');
  try {
    await imap.append('INBOX', rawMessage(subject, hours), [], hoursAgo(hours));
    appendedSubjects.push(subject);
  } finally {
    lock.release();
  }
};

const findThread = async (subject) => {
  const deadline = Date.now() + (REAL ? 180_000 : 60_000);
  for (;;) {
    const list = await trpc('mail.listThreads', { query: { folder: 'inbox', maxResults: 200 } });
    for (const t of list.threads ?? []) {
      const th = await trpc('mail.get', { query: { id: t.id } });
      if (th?.latest?.subject === subject) return t.id;
    }
    if (Date.now() > deadline) throw new Error(`never indexed: ${subject}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
};

// ------------------------------------------------------- emergency cleanup
// Registered BEFORE anything is appended: this script is top-level-await
// sequential, so handlers declared next to the cleanup leg would not exist
// during seeding -- exactly when a crash strands fixtures in a real mailbox.
const purge = async (why) => {
  try {
    if (!imap || !appendedSubjects.length) return;
    console.error(`[e2e] ${why} -- emergency purge of ${appendedSubjects.length} fixtures`);
    for (const path of SEARCH_FOLDERS) {
      let lock;
      try {
        lock = await imap.getMailboxLock(path);
      } catch {
        continue;
      }
      try {
        const uids = (await imap.search({ header: { subject: FIXTURE_PREFIX } }, { uid: true })) || [];
        if (uids.length) await imap.messageDelete(uids.join(','), { uid: true });
      } finally {
        lock.release();
      }
    }
  } catch (e) {
    console.error(`[e2e] EMERGENCY PURGE FAILED: ${e.message}; subjects: ${appendedSubjects.join(' | ')}`);
  }
};
process.on('uncaughtException', async (e) => {
  await purge(`uncaught: ${e.message}`);
  process.exit(3);
});
process.on('unhandledRejection', async (e) => {
  await purge(`unhandled rejection: ${e?.message ?? e}`);
  process.exit(3);
});

// ------------------------------------------------------------------ ban probe
if (REAL) {
  const host = devVars.IMAP_DEFAULT_IMAP_HOST;
  const port = Number(devVars.IMAP_DEFAULT_IMAP_PORT || 993);
  const reachable = await new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(8000);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
  if (!reachable) {
    console.error(`[e2e] ABORT: ${host}:${port} unreachable -- refusing to run --real and worsen a ban.`);
    process.exit(2);
  }
}

// ----------------------------------------------------------------------- run
console.log(`[e2e] ACTION matrix - backend: ${mode.name}, runId=${runId}\n`);

let ok = await hardLeg('login', async () => {
  const res = await fetch(`${APP}/api/auth/sign-in/imap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify(mode.loginBody(mode.email, mode.password)),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.status) throw new Error(`login failed: ${JSON.stringify(body).slice(0, 160)}`);
  cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('no session cookie');
  const conns = await trpc('connections.list', { query: null });
  connectionId = (conns?.connections ?? []).find((c) => c.email === mode.email)?.id;
  if (!connectionId) throw new Error('no connection id');
  return `${body.user.email} (${connectionId})`;
});

// Preflight: refuse to run against a mailbox holding fixtures from a previous
// run. Leftovers compound silently -- that cost four consecutive red runs in
// the search suite before anyone noticed.
if (ok) {
  ok = await hardLeg('preflight-clean-mailbox', async () => {
    imap = await rawImap();
    const found = [];
    for (const path of SEARCH_FOLDERS) {
      let lock;
      try {
        lock = await imap.getMailboxLock(path);
      } catch {
        continue;
      }
      try {
        const uids = (await imap.search({ header: { subject: FIXTURE_PREFIX } }, { uid: true })) || [];
        for (const u of uids) found.push(`${path}:${u}`);
      } finally {
        lock.release();
      }
    }
    if (found.length) {
      throw new Error(
        `${found.length} fixture(s) from a previous run still present (${found.join(', ')}). ` +
          `They distort every assertion here. Remove messages with subject prefix "${FIXTURE_PREFIX}" before re-running.`,
      );
    }
    return 'no leftovers';
  });
}

// ---------------------------------------------------------------- PRIMITIVE 1
// flag set/clear -- both directions and idempotency.
if (ok) {
  const subject = S('Flags');
  let tid = null;
  ok = await hardLeg('seed:flags', async () => {
    await seed(subject, 2);
    await trpc('mail.forceSync', { mutationBody: null });
    tid = await findThread(subject);
    return tid;
  });

  if (ok) {
    const starred = {
      describe: 'STARRED set',
      app: (a) => a.tags.includes('STARRED'),
      index: (b) => b.labels.includes('STARRED'),
      server: (c) => c.flags.includes('\\Flagged'),
    };
    const unstarred = {
      describe: 'STARRED clear',
      app: (a) => !a.tags.includes('STARRED'),
      index: (b) => !b.labels.includes('STARRED'),
      server: (c) => !c.flags.includes('\\Flagged'),
    };

    await trpc('mail.toggleStar', { mutationBody: { ids: [tid] } });
    await new Promise((r) => setTimeout(r, 2000));
    await assertLevels('flag', 'star SET', subject, tid, starred);
    await afterResync('flag', 'star SET', subject, tid, starred);

    // UN-SET is where the bugs lived: labels were once add-only, so a cleared
    // flag could never propagate.
    await trpc('mail.toggleStar', { mutationBody: { ids: [tid] } });
    await new Promise((r) => setTimeout(r, 2000));
    await assertLevels('flag', 'star CLEAR', subject, tid, unstarred);
    await afterResync('flag', 'star CLEAR', subject, tid, unstarred);

    // Idempotency: setting twice must not corrupt or double-apply.
    await trpc('mail.toggleStar', { mutationBody: { ids: [tid] } });
    await new Promise((r) => setTimeout(r, 1500));
    await trpc('mail.bulkStar', { mutationBody: { ids: [tid] } });
    await new Promise((r) => setTimeout(r, 2000));
    await assertLevels('flag', 'star SET TWICE (idempotent)', subject, tid, starred);

    // \Seen via UNREAD, both directions.
    const read = {
      describe: 'read (UNREAD cleared)',
      app: (a) => a.hasUnread === false && !a.tags.includes('UNREAD'),
      index: (b) => !b.labels.includes('UNREAD'),
      server: (c) => c.flags.includes('\\Seen'),
    };
    const unread = {
      describe: 'unread (UNREAD set)',
      app: (a) => a.hasUnread === true && a.tags.includes('UNREAD'),
      index: (b) => b.labels.includes('UNREAD'),
      server: (c) => !c.flags.includes('\\Seen'),
    };
    await trpc('mail.markAsRead', { mutationBody: { ids: [tid] } });
    await new Promise((r) => setTimeout(r, 2000));
    await assertLevels('flag', 'markAsRead', subject, tid, read);
    await afterResync('flag', 'markAsRead', subject, tid, read);

    await trpc('mail.markAsUnread', { mutationBody: { ids: [tid] } });
    await new Promise((r) => setTimeout(r, 2000));
    await assertLevels('flag', 'markAsUnread', subject, tid, unread);
    await afterResync('flag', 'markAsUnread', subject, tid, unread);
  }
}

// ---------------------------------------------------------------- PRIMITIVE 2
// folder move -- INBOX -> Trash -> back, with threadId stability and the
// UID-following ledger assertion.
if (ok && !fatal) {
  const subject = S('Move');
  let tid = null;
  const seeded = await hardLeg('seed:move', async () => {
    await seed(subject, 3);
    await trpc('mail.forceSync', { mutationBody: null });
    tid = await findThread(subject);
    return tid;
  });

  if (seeded) {
    const inTrash = {
      describe: 'in Trash',
      index: (b) => b.labels.includes('TRASH') && !b.labels.includes('INBOX'),
      server: (c) => c.exists && /trash|deleted|bin/i.test(c.folder ?? ''),
    };
    const inInbox = {
      describe: 'in INBOX',
      index: (b) => b.labels.includes('INBOX') && !b.labels.includes('TRASH'),
      server: (c) => c.exists && (c.folder ?? '').toUpperCase() === 'INBOX',
    };

    const before = await server(subject);
    await trpc('mail.modifyLabels', {
      mutationBody: { threadId: [tid], addLabels: ['TRASH'], removeLabels: ['INBOX'] },
    });
    await new Promise((r) => setTimeout(r, 2500));
    await assertLevels('move', 'INBOX -> Trash', subject, tid, inTrash);

    // A MOVE assigns a NEW uid and expunges the source. The ledger must follow
    // it, not hold the stale one.
    const afterMove = await server(subject);
    const led = index(tid).ledger;
    record(
      'move',
      'ledger followed the NEW uid (index)',
      `trash|${afterMove.uid} (was inbox|${before.uid})`,
      led.join(' '),
      led.some((e) => e.endsWith(`|${afterMove.uid}`)) && !led.some((e) => e.startsWith('inbox|')),
      'MOVE changes the uid; a ledger holding the source uid mis-attributes the next deletion.',
    );
    record(
      'move',
      'threadId unchanged across the move (app)',
      subject,
      (await app(tid)).subject ?? '(thread gone)',
      (await app(tid)).subject === subject,
      'Thread identity derives from Message-ID, which a move does not touch.',
    );
    await afterResync('move', 'INBOX -> Trash', subject, tid, inTrash);

    // Restore. Deliberately to INBOX -- IMAP remembers no origin and the
    // ledger cannot supply one (a MOVE expunges the source and
    // applyFolderLedgerDelta drops rows for vanished uids).
    await trpc('mail.modifyLabels', {
      mutationBody: { threadId: [tid], addLabels: ['INBOX'], removeLabels: ['TRASH'] },
    });
    await new Promise((r) => setTimeout(r, 2500));
    await assertLevels('move', 'Trash -> INBOX (restore)', subject, tid, inInbox);
    await afterResync('move', 'Trash -> INBOX (restore)', subject, tid, inInbox);
  }
}

// ---------------------------------------------------------------- PRIMITIVE 3
// keyword add/remove -- the $zl_ user label, created THROUGH THE APP so it is
// registered. A raw APPENDed keyword is not in the registry and could never
// resolve by name.
if (ok && !fatal) {
  const subject = S('Keyword');
  let tid = null;
  const seeded = await hardLeg('seed:keyword', async () => {
    await seed(subject, 4);
    await trpc('mail.forceSync', { mutationBody: null });
    tid = await findThread(subject);
    await trpc('labels.create', { mutationBody: { name: LABEL_NAME } });
    const deadline = Date.now() + 60_000;
    for (;;) {
      const labels = await trpc('labels.list', { query: null });
      const hit = (labels ?? []).find((l) => l.name?.toLowerCase() === LABEL_NAME.toLowerCase());
      if (hit) {
        resolvedLabelId = hit.id;
        break;
      }
      if (Date.now() > deadline) throw new Error('label never appeared in the registry');
      await new Promise((r) => setTimeout(r, 2000));
    }
    return `${tid} label=${resolvedLabelId}`;
  });

  if (seeded) {
    const applied = {
      describe: 'keyword applied',
      app: (a) => a.labels.includes(resolvedLabelId),
      index: (b) => b.labels.includes(resolvedLabelId),
      server: (c) => c.flags.includes(resolvedLabelId),
    };
    const removed = {
      describe: 'keyword removed',
      app: (a) => !a.labels.includes(resolvedLabelId),
      index: (b) => !b.labels.includes(resolvedLabelId),
      server: (c) => !c.flags.includes(resolvedLabelId),
    };

    await trpc('mail.modifyLabels', {
      mutationBody: { threadId: [tid], addLabels: [resolvedLabelId], removeLabels: [] },
    });
    await new Promise((r) => setTimeout(r, 2500));
    await assertLevels('keyword', 'label ADD', subject, tid, applied);
    await afterResync('keyword', 'label ADD', subject, tid, applied);

    await trpc('mail.modifyLabels', {
      mutationBody: { threadId: [tid], addLabels: [], removeLabels: [resolvedLabelId] },
    });
    await new Promise((r) => setTimeout(r, 2500));
    await assertLevels('keyword', 'label REMOVE', subject, tid, removed);
    await afterResync('keyword', 'label REMOVE', subject, tid, removed);

    // Idempotency: adding twice.
    await trpc('mail.modifyLabels', {
      mutationBody: { threadId: [tid], addLabels: [resolvedLabelId], removeLabels: [] },
    });
    await new Promise((r) => setTimeout(r, 1500));
    await trpc('mail.modifyLabels', {
      mutationBody: { threadId: [tid], addLabels: [resolvedLabelId], removeLabels: [] },
    });
    await new Promise((r) => setTimeout(r, 2500));
    await assertLevels('keyword', 'label ADD TWICE (idempotent)', subject, tid, applied);
  }
}

// ---------------------------------------------------------------- PRIMITIVE 5
// stale ledger -> verified fallback (item C, ledger-first member resolution).
//
// The ledger can be WRONG, not just absent: it is window-bounded and a
// message can have moved since its row was written. This section proves the
// four properties that make ledger-first safe to ship:
//   (a) a healthy thread actually TAKES the ledger fast path (else the
//       latency win is fiction and nothing would notice);
//   (b) a deliberately-staled row is DETECTED, not trusted -- staled via an
//       INDEPENDENT IMAP session so the app never learns of the move;
//   (c) the flag still lands on the RIGHT message, and the resolution report
//       says the fallback FIRED -- end state alone cannot distinguish a
//       fallback that triggered from one that never runs;
//   (d) the ledger is REPAIRED from the fallback's discovery, so one external
//       move costs exactly ONE fallback, not a permanent slow path.
if (ok && !fatal) {
  const subject = S('Stale');
  let tid = null;
  const seeded = await hardLeg('seed:stale-ledger', async () => {
    await seed(subject, 7);
    await trpc('mail.forceSync', { mutationBody: null });
    tid = await findThread(subject);
    return tid;
  });

  if (seeded) {
    // (a) Control: fresh, fully-ledgered thread -> ledger path, no fallback.
    const r0 = await trpc('mail.modifyLabels', {
      mutationBody: { threadId: [tid], addLabels: ['STARRED'], removeLabels: [] },
    });
    record(
      'stale-ledger',
      'healthy thread takes the ledger fast path',
      "resolution.mode === 'ledger', no fallback",
      JSON.stringify(r0?.resolution ?? null),
      r0?.resolution?.mode === 'ledger' && (r0?.resolution?.fallback ?? []).length === 0,
      'Pre-fix builds return no resolution field at all, so this leg is RED against them by design.',
    );
    await trpc('mail.modifyLabels', {
      mutationBody: { threadId: [tid], addLabels: [], removeLabels: ['STARRED'] },
    });
    await new Promise((r) => setTimeout(r, 1500));

    // (b) STALE the ledger: move the message out of INBOX and straight back
    // via the independent session. It returns to INBOX under a NEW uid; the
    // app saw none of it, so its ledger still holds the old one. Act
    // IMMEDIATELY afterwards -- before the IDLE watcher's sync can correct
    // the ledger -- so the driver must catch the stale uid itself. (If the
    // sync ever wins this race the assertion below fails with mode='ledger',
    // which is the signal to widen the staleness window, not a code bug.)
    const before = await server(subject);
    {
      const lock = await imap.getMailboxLock('INBOX');
      try {
        try {
          await imap.mailboxCreate('Archive');
        } catch {
          /* already exists */
        }
        await imap.messageMove(String(before.uid), 'Archive', { uid: true });
      } finally {
        lock.release();
      }
      const lock2 = await imap.getMailboxLock('Archive');
      try {
        const uids = (await imap.search({ header: { subject } }, { uid: true })) || [];
        if (!uids.length) throw new Error('stale-ledger: fixture vanished during the way-station move');
        await imap.messageMove(uids.join(','), 'INBOX', { uid: true });
      } finally {
        lock2.release();
      }
    }
    const r1 = await trpc('mail.modifyLabels', {
      mutationBody: { threadId: [tid], addLabels: ['STARRED'], removeLabels: [] },
    });
    const after = await server(subject);
    const fb = (r1?.resolution?.fallback ?? []).find((f) => f.threadId === tid);
    record(
      'stale-ledger',
      'stale uid DETECTED, fallback FIRED',
      `fallback for this thread, reason uid-missing`,
      fb ? `fired (${fb.reason})` : `no fallback (mode=${r1?.resolution?.mode ?? 'missing'})`,
      !!fb && fb.reason === 'uid-missing',
      'The STORE response accounts for zero of the hinted uids; that must condemn the thread to the search path, never be trusted silently.',
    );
    record(
      'stale-ledger',
      'flag landed on the RIGHT message (SERVER)',
      `INBOX, new uid (was ${before.uid}), \\Flagged set`,
      `${after.folder}:${after.uid}:${JSON.stringify(after.flags)}`,
      after.exists &&
        after.folder === 'INBOX' &&
        after.uid !== before.uid &&
        after.flags.includes('\\Flagged'),
      'A STORE at the stale uid flags nothing; only the fallback search can find the post-move uid.',
    );
    // (d) Repair is AWAITED by the mutation, so read the ledger immediately.
    const led = index(tid).ledger;
    record(
      'stale-ledger',
      'ledger repaired from the fallback discovery (index)',
      `inbox|${after.uid} present, inbox|${before.uid} gone`,
      led.join(' ') || '(none)',
      led.includes(`inbox|${after.uid}`) && !led.includes(`inbox|${before.uid}`),
      'Stale row dropped and discovered row re-seeded by applyLabels step 1c.',
    );
    const r2 = await trpc('mail.modifyLabels', {
      mutationBody: { threadId: [tid], addLabels: [], removeLabels: ['STARRED'] },
    });
    record(
      'stale-ledger',
      'next action returns to the ledger fast path',
      "resolution.mode === 'ledger', no fallback",
      JSON.stringify(r2?.resolution ?? null),
      r2?.resolution?.mode === 'ledger' && (r2?.resolution?.fallback ?? []).length === 0,
      'One external move must cost exactly ONE fallback.',
    );
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// ---------------------------------------------------------------- PRIMITIVE 4
// permanent delete -- EXPUNGE, guarded. mail.delete on a thread NOT in Trash
// must MOVE it there; only from Trash does it destroy.
if (ok && !fatal) {
  const subject = S('Delete');
  let tid = null;
  const seeded = await hardLeg('seed:delete', async () => {
    await seed(subject, 5);
    await trpc('mail.forceSync', { mutationBody: null });
    tid = await findThread(subject);
    return tid;
  });

  if (seeded) {
    await trpc('mail.delete', { mutationBody: { id: tid } });
    await new Promise((r) => setTimeout(r, 2500));
    await assertLevels('delete', 'delete OUTSIDE Trash moves, does not destroy', subject, tid, {
      describe: 'moved to Trash, still exists',
      server: (c) => c.exists && /trash|deleted|bin/i.test(c.folder ?? ''),
      index: (b) => b.present && b.labels.includes('TRASH'),
    });

    await trpc('mail.delete', { mutationBody: { id: tid } });
    await new Promise((r) => setTimeout(r, 2500));
    const gone = await server(subject);
    record(
      'delete',
      'delete FROM Trash expunges everywhere (SERVER)',
      'message absent from every folder',
      gone.exists ? `still in ${gone.folder}` : 'absent',
      !gone.exists,
      'Previously this deleted an index row only, so the message returned on the next full resync.',
    );
    const idx = index(tid);
    record(
      'delete',
      'expunged thread removed from the index',
      'no thread row',
      idx.present ? `still present (${idx.labels.join(',')})` : 'absent',
      !idx.present,
    );
    // Expunged fixture must not be chased by cleanup.
    appendedSubjects = appendedSubjects.filter((s) => s !== subject);

    await trpc('mail.forceSync', { mutationBody: null });
    await new Promise((r) => setTimeout(r, REAL ? 12000 : 6000));
    const afterSync = await server(subject);
    record(
      'delete',
      'stays deleted after a forced resync (SERVER)',
      'absent',
      afterSync.exists ? `resurrected in ${afterSync.folder}` : 'absent',
      !afterSync.exists,
    );
  }
}

// ------------------------------------------------------------- THE DB-WIPE LEG
//
// The assertion this entire class of bug would have failed on day one.
//
// The documented invariant is "IMAP is the source of truth, Postgres is a
// cache, a wipe re-syncs". That was FALSE for user state: stars, reads,
// archives and labels lived only in the cache, so a wipe destroyed them
// silently, with no error. This proves the invariant holds now.
//
// SNOOZE IS DELIBERATELY EXCLUDED. It is a known split-brain -- Redis drives
// waking, Postgres drives visibility, neither derives from the other -- so no
// current design gives it wipe-survival, and asserting it here would demand a
// guarantee nothing provides. See INDEX_ONLY_LABELS in mail-engine.ts.
if (ok && !fatal) {
  const subject = S('Wipe');
  let tid = null;
  const seeded = await hardLeg('seed:wipe', async () => {
    await seed(subject, 6);
    await trpc('mail.forceSync', { mutationBody: null });
    tid = await findThread(subject);
    return tid;
  });

  if (seeded) {
    // One fixture carries all three primitives at once -- flag, move, AND
    // keyword -- because a real message can be starred, in Trash, and
    // labelled simultaneously, and the wipe must rebuild all three together,
    // not each in isolation.
    await trpc('mail.toggleStar', { mutationBody: { ids: [tid] } });
    await trpc('mail.markAsRead', { mutationBody: { ids: [tid] } });
    await trpc('mail.modifyLabels', {
      mutationBody: { threadId: [tid], addLabels: ['TRASH'], removeLabels: ['INBOX'] },
    });
    if (resolvedLabelId) {
      await trpc('mail.modifyLabels', {
        mutationBody: { threadId: [tid], addLabels: [resolvedLabelId], removeLabels: [] },
      });
    }
    await new Promise((r) => setTimeout(r, 3000));

    const pre = await server(subject);
    record(
      'db-wipe',
      'pre-wipe: flag + move + keyword all reached the SERVER',
      `\\Flagged, \\Seen, Trash, ${resolvedLabelId}`,
      `${pre.folder}:${JSON.stringify(pre.flags)}`,
      pre.flags.includes('\\Flagged') &&
        pre.flags.includes('\\Seen') &&
        /trash|deleted|bin/i.test(pre.folder ?? '') &&
        (!resolvedLabelId || pre.flags.includes(resolvedLabelId)),
    );

    // Scoped to THIS connection only -- never the whole database. Mirrors
    // exactly what forceReSync's own clearIndex + clearFolderSyncData wipe
    // (thread_label, thread, label, folder_sync_state/ledger) -- this is the
    // wipe the app performs on itself, not a broader DB reset.
    sql(`delete from mail0_thread_label where connection_id='${connectionId}'`);
    sql(`delete from mail0_folder_message where connection_id='${connectionId}'`);
    sql(`delete from mail0_folder_sync_state where connection_id='${connectionId}'`);
    sql(`delete from mail0_thread where connection_id='${connectionId}'`);
    console.log('[e2e] index wiped for this connection; re-syncing from IMAP');

    await trpc('mail.forceSync', { mutationBody: null });
    let rebuilt = false;
    const deadline = Date.now() + (REAL ? 240_000 : 90_000);
    for (;;) {
      try {
        const b = index(tid);
        if (
          b.present &&
          b.labels.includes('STARRED') &&
          !b.labels.includes('UNREAD') &&
          b.labels.includes('TRASH') &&
          (!resolvedLabelId || b.labels.includes(resolvedLabelId))
        ) {
          rebuilt = true;
          break;
        }
      } catch { /* transient */ }
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 3000));
    }

    const b = index(tid);
    const a = await app(tid);
    record(
      'db-wipe',
      'STARRED survives a full index wipe (index)',
      'STARRED re-derived from \\Flagged',
      b.labels.join(',') || '(none)',
      rebuilt && b.labels.includes('STARRED'),
      'If this fails, user state lives only in the cache and a wipe destroys it silently -- the original defect.',
    );
    record(
      'db-wipe',
      'read state survives a full index wipe (index)',
      'UNREAD absent, re-derived from \\Seen',
      b.labels.join(',') || '(none)',
      rebuilt && !b.labels.includes('UNREAD'),
    );
    record(
      'db-wipe',
      'MOVE survives a full index wipe (index)',
      'TRASH re-derived from server folder membership',
      b.labels.join(',') || '(none)',
      rebuilt && b.labels.includes('TRASH') && !b.labels.includes('INBOX'),
      'forceReSync only rebuilds inbox by default -- if this fails, check the bin/spam rebuild passes added in item 3.',
    );
    if (resolvedLabelId) {
      record(
        'db-wipe',
        'KEYWORD survives a full index wipe (index)',
        `${resolvedLabelId} re-derived from the IMAP keyword`,
        b.labels.join(',') || '(none)',
        rebuilt && b.labels.includes(resolvedLabelId),
        'This survives ONLY because the label REGISTRY (name -> $zl_ id) is untouched by this wipe scope -- see the registry-wipe leg below for what happens when it is not.',
      );
    }
    record(
      'db-wipe',
      'app agrees after the wipe (app)',
      'star + trash + keyword shown, not unread',
      `${JSON.stringify(a.tags)} hasUnread=${a.hasUnread} labels=${JSON.stringify(a.labels)}`,
      a.tags.includes('STARRED') &&
        a.hasUnread === false &&
        a.labels.includes('TRASH') &&
        (!resolvedLabelId || a.labels.includes(resolvedLabelId)),
    );

    // ---- THE LABEL REGISTRY GAP -------------------------------------
    //
    // NAMED HERE, NOT FIXED. The four assertions above wipe the same scope
    // forceReSync wipes on itself -- thread/thread_label/folder_message/
    // folder_sync_state -- and the label REGISTRY (name -> $zl_ id mapping,
    // table mail0_imap_label_registry) is untouched by that scope, so the
    // keyword leg above passes for a reason that does not generalize.
    //
    // A broader reset does destroy the registry -- e.g. the Phase 6.5
    // "wipe Postgres index/blobs, boot worker+api from nothing" drill.
    // getUserLabels/resolveKeyword read ONLY imap_label_registry; nothing
    // scans server IMAP keywords to reconstruct the name -> id mapping, so
    // after a registry wipe the mapping is gone until the user recreates the
    // label by hand. The keyword is still on the message -- level (c) below
    // proves that -- but `label:<name>` cannot find it: resolveKeyword
    // returns undefined, the search fails CLOSED (correct per item 2's
    // fail-closed contract), and the thread is invisible under its label
    // even though the label is still physically on it.
    //
    // This is a REAL gap in the same class as the original bug -- state
    // reachable only through Postgres, silently lost on a broader reset --
    // and it is reported as a KNOWN_GAP below, not swept into a SKIP.
    //
    // EXPOSURE SCOPE, precisely: forceReSync does NOT touch the registry, so
    // ordinary resyncs -- including everything the app does to itself -- are
    // safe. The exposure is specifically a FROM-NOTHING rebuild, i.e. the
    // Phase 6.5 "wipe Postgres, boot worker+api from nothing" drill, which
    // is the project's STATED recovery story. After that drill: the keyword
    // survives (it lives on the server); the human-readable name does not.
    //
    // Fix options, with a recorded PREFERENCE (decision still open):
    //   1. PREFERRED: rebuild-by-scanning. The $zl_ ids are already on the
    //      server; a scan of live keywords reconstructs the mapping without
    //      adding a second write path that can drift. Same shape as
    //      driver.get's trash/junk fallback rebuilding thread content.
    //      (Limitation to solve: the server carries only the slug-derived
    //      id, so a display name with casing/spacing lost by the slug cannot
    //      be recovered exactly -- acceptable, or store the name in the
    //      keyword.)
    //   2. Mirroring the registry onto IMAP (e.g. $zl_meta_<id>=<name>).
    //      Rejected as first choice: two stores kept in sync is exactly the
    //      shape that produced the snooze split-brain.
    // Neither is implemented; this is the record that the gap exists and was
    // found on purpose.
    if (resolvedLabelId) {
      const registryKeyLike = `%${mode.email}%`;
      sql(`delete from mail0_imap_label_registry where key like '${registryKeyLike}'`);
      console.log('[e2e] label REGISTRY wiped (name -> $zl_ id mapping only)');

      const stillOnServer = await server(subject);
      record(
        'db-wipe',
        'KNOWN GAP: keyword remains on the SERVER after a registry wipe (SERVER)',
        `${resolvedLabelId} still among IMAP flags`,
        JSON.stringify(stillOnServer.flags),
        stillOnServer.flags.includes(resolvedLabelId),
        'Confirms the keyword itself is untouched -- only the name mapping was destroyed.',
      );

      let found = false;
      try {
        const searchResult = await trpc('mail.listThreads', {
          query: { q: `label:${LABEL_NAME}`, maxResults: 50 },
        });
        found = (searchResult?.threads ?? []).some((t) => t.id === tid);
      } catch {
        found = false; // fail-closed also throws in some paths; either is "not found"
      }
      recordKnownGap(
        'db-wipe',
        'label:<name> after a registry wipe',
        'thread invisible under its own label (fails closed)',
        found ? 'UNEXPECTED: resolved and found it -- gap may be fixed, update this comment' : 'fails closed, thread invisible',
        !found,
        'NOT a harness bug. imap_label_registry (name -> $zl_ id) has no IMAP mirror and no rebuild-from-server path. ' +
          'Reported per explicit instruction to name this rather than fix it in passing.',
      );
    }
  }
}

// ------------------------------------------------ FORCE-RESYNC SURVIVAL LEGS
//
// The db-wipe legs above assert inbox/trash/keyword survival ONLY — which is
// exactly why forceReSync erasing Sent (invisible until the 10-minute
// repeatable), Archive (PERMANENTLY — nothing re-listed the archive folder)
// and Snoozed (permanently, PLUS wake rows left orphaned for the unsnooze
// sweep to act on blindly) went unseen through a matrix built to catch
// precisely this class. These legs close that hole: each of the three states
// is built the way the APP builds it, then must survive mail.forceSync.
//
// The orphan assertion is scoped to THIS run's wake row (assert what the
// code controls — ambient rows from other runs are not this leg's claim).
if (ok && !fatal) {
  const subjArch = S('WipeArch');
  const subjSnooze = S('WipeSnooze');
  const subjSent = S('WipeSent');

  const prepared = await hardLeg('seed:resync-survival', async () => {
    await seed(subjArch, 5);
    await seed(subjSnooze, 4);
    const archTid = await findThread(subjArch);
    const snoozeTid = await findThread(subjSnooze);
    // Archive and snooze exactly as the UI does.
    await trpc('mail.modifyLabels', {
      mutationBody: { threadId: [archTid], addLabels: [], removeLabels: ['INBOX'] },
    });
    await trpc('mail.snoozeThreads', {
      mutationBody: { ids: [snoozeTid], wakeAt: new Date(Date.now() + 7_200_000).toISOString() },
    });
    // Sent fixture via a real app send. SETUP may lean on a manual enqueue
    // so the pre-state exists even on builds without the post-send sync
    // hook — the survival claim here is about forceSync, not indexing.
    await trpc('mail.send', {
      mutationBody: {
        to: [{ email: mode.email, name: 'e2e' }],
        subject: subjSent,
        message: `<p>${subjSent}</p>`,
        attachments: [],
      },
    });
    await new Promise((r) => setTimeout(r, 12_000));
    const { Queue } = await import('bullmq');
    const IORedis = (await import('ioredis')).default;
    const redisConn = new IORedis(process.env.QUEUE_REDIS_URL ?? 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: null,
    });
    const syncQueue = new Queue('mail-sync', { connection: redisConn });
    await syncQueue.add('sync-folder', { connectionId, folder: 'sent' });
    await syncQueue.close();
    redisConn.disconnect();

    let sentTid = null;
    const deadline = Date.now() + (REAL ? 180_000 : 90_000);
    for (;;) {
      const sent = await trpc('mail.listThreads', { query: { folder: 'sent', maxResults: 30 } });
      for (const t of sent?.threads ?? []) {
        const th = await trpc('mail.get', { query: { id: t.id } }).catch(() => null);
        if (th?.latest?.subject === subjSent) sentTid = t.id;
      }
      if (sentTid) break;
      if (Date.now() > deadline) throw new Error('sent fixture never indexed (setup)');
      await new Promise((r) => setTimeout(r, 3000));
    }
    // Pin the pre-state at level (c) — the SERVER, not the index. The
    // ARCHIVE label can appear in the index (ledger-derived continuation)
    // moments before the IMAP MOVE itself lands; asserting survival against
    // a forceSync that ran before the server state settled produced a false
    // red on first execution. Poll until BOTH messages are physically in
    // the archive folder.
    const preDeadline = Date.now() + 90_000;
    for (;;) {
      const [sArch, sSnooze] = [await server(subjArch), await server(subjSnooze)];
      if (/archive/i.test(sArch.folder ?? '') && /archive/i.test(sSnooze.folder ?? '')) break;
      if (Date.now() > preDeadline)
        throw new Error(
          `pre-state: fixtures not in archive folder (arch=${sArch.folder}, snooze=${sSnooze.folder})`,
        );
      await new Promise((r) => setTimeout(r, 3000));
    }
    const preSnooze = index(snoozeTid);
    if (!preSnooze.labels.includes('SNOOZED'))
      throw new Error(`pre-state: SNOOZED missing (${preSnooze.labels.join(',')})`);
    return { archTid, snoozeTid, sentTid, toString: () => 'archived + snoozed + sent pre-state ready' };
  });

  if (prepared) {
    await trpc('mail.forceSync', { mutationBody: null });

    // Resolve by SUBJECT through the app views, never by a pinned thread id:
    // the seed-time id does not survive the move+resync round trip (thread
    // ids re-derive; the id-stability caveat on rawMessage documents this),
    // and a user finds their mail by looking at the view, not by an id. A
    // first version of these legs pinned the seed-time id and went red
    // against a HEALTHY index — the thread was present under its canonical
    // id with the right labels while index(<stale id>) said "gone".
    //
    // Poll to a deadline like the db-wipe legs: continuations and worker
    // syncs converge seconds after the route returns. The window stays FAR
    // below the 10-minute repeatable, so a pre-fix build (which never
    // re-lists archive at all, and restores sent only via that repeatable)
    // still goes red here.
    const findInView = async (folder, subject) => {
      const list = await trpc('mail.listThreads', { query: { folder, maxResults: 30 } });
      for (const t of list?.threads ?? []) {
        const th = await trpc('mail.get', { query: { id: t.id } }).catch(() => null);
        if (
          th?.latest?.subject === subject ||
          (th?.messages ?? []).some((m) => m.subject === subject)
        )
          return t.id;
      }
      return null;
    };
    const survDeadline = Date.now() + 90_000;
    let archId = null;
    let snoozeId = null;
    let sentId = null;
    for (;;) {
      archId = archId ?? (await findInView('archive', subjArch));
      snoozeId = snoozeId ?? (await findInView('snoozed', subjSnooze));
      sentId = sentId ?? (await findInView('sent', subjSent));
      if ((archId && snoozeId && sentId) || Date.now() > survDeadline) break;
      await new Promise((r) => setTimeout(r, 3000));
    }

    record(
      'resync-survival',
      'ARCHIVED thread survives forceSync (archive view)',
      'thread findable in the archive view by subject',
      archId ?? '(absent)',
      !!archId,
      'forceReSync must re-list the archive folder — before the fix NOTHING did, so this loss was permanent.',
    );
    record(
      'resync-survival',
      'SNOOZED thread survives forceSync (snoozed view)',
      'thread findable in the snoozed view by subject',
      snoozeId ?? '(absent)',
      !!snoozeId,
      'SNOOZED is index-only; forceReSync must snapshot and re-apply it — no folder pass can.',
    );
    const wakeState = snoozeId
      ? sql(
          `select count(*), count(tl.thread_id) from mail0_snooze s left join mail0_thread_label tl on tl.connection_id=s.connection_id and tl.thread_id=s.thread_id and tl.label_id='SNOOZED' where s.connection_id='${connectionId}' and s.thread_id='${snoozeId}'`,
        )
      : '(no snoozed thread found)';
    record(
      'resync-survival',
      'wake row not orphaned by forceSync',
      'wake row present AND its SNOOZED label present (1|1)',
      wakeState,
      wakeState === '1|1',
      'An orphaned wake row makes the unsnooze sweep act on a thread the index no longer has — the documented split-brain corruption. NB the wake row must FOLLOW the re-derived thread id (or the id must be stable); a row keyed to a dead id is an orphan even when the thread survived.',
    );
    record(
      'resync-survival',
      'SENT thread survives forceSync (sent view)',
      'thread findable in the sent view by subject',
      sentId ?? '(absent)',
      !!sentId,
      'Before the fix, forceSync blanked the Sent view until the next 10-minute repeatable tick.',
    );

    // Fixture hygiene: unsnooze so the wake row does not outlive the
    // message the cleanup below deletes.
    if (snoozeId)
      await trpc('mail.unsnoozeThreads', { mutationBody: { ids: [snoozeId] } }).catch(() => {});
  }
}

// ---------------------------------------------------------------------- clean
// Always runs, and matches the fixture PREFIX rather than this run's ids, so a
// previous crashed run is cleared too.
await hardLeg('cleanup', async () => {
  let deleted = 0;
  if (imap) {
    for (const path of SEARCH_FOLDERS) {
      let lock;
      try {
        lock = await imap.getMailboxLock(path);
      } catch {
        continue;
      }
      try {
        const uids = (await imap.search({ header: { subject: FIXTURE_PREFIX } }, { uid: true })) || [];
        if (uids.length) {
          await imap.messageDelete(uids.join(','), { uid: true });
          deleted += uids.length;
        }
      } finally {
        lock.release();
      }
    }
  }
  let labelNote = 'no label';
  if (resolvedLabelId) {
    try {
      await trpc('labels.delete', { mutationBody: { id: resolvedLabelId } });
      labelNote = `removed ${resolvedLabelId}`;
    } catch (e) {
      labelNote = `LABEL CLEANUP FAILED (${resolvedLabelId}): ${e.message}`;
      console.error(`[e2e] ${labelNote}`);
    }
  }
  if (imap) await imap.logout();
  try {
    await trpc('mail.forceSync', { mutationBody: null });
  } catch { /* best effort */ }
  return `${deleted} fixture message(s); ${labelNote}`;
});

// --------------------------------------------------------------------- report
const pad = (s, n) => String(s).padEnd(n);
const w0 = Math.max(9, ...matrix.map((m) => m.primitive.length));
const w1 = Math.max(24, ...matrix.map((m) => m.control.length));
console.log(`\n\n=== ACTION MATRIX - ${mode.name} (runId ${runId}) ===\n`);
console.log(`${pad('PRIMITIVE', w0)} | ${pad('CONTROL', w1)} | VERDICT`);
console.log(`${'-'.repeat(w0)}-+-${'-'.repeat(w1)}-+--------`);
for (const m of matrix) {
  console.log(`${pad(m.primitive, w0)} | ${pad(m.control, w1)} | ${m.verdict}`);
}
const pass = matrix.filter((m) => m.verdict === 'PASS').length;
const fail = matrix.filter((m) => m.verdict === 'FAIL').length;
const fatals = matrix.filter((m) => m.verdict === 'FATAL').length;
const knownGaps = matrix.filter((m) => m.verdict === 'KNOWN_GAP').length;
const unexpectedPasses = matrix.filter((m) => m.verdict === 'UNEXPECTED_PASS').length;
console.log(
  `\n${pass} pass, ${fail} fail, ${fatals} fatal, ${knownGaps} known gap(s)` +
    (unexpectedPasses ? `, ${unexpectedPasses} UNEXPECTED PASS (a documented gap appears fixed -- update its comment)` : ''),
);

if (fail || fatals || unexpectedPasses) {
  console.log('\n=== FAILURE DETAIL ===\n');
  for (const m of matrix.filter((x) => x.verdict === 'FAIL' || x.verdict === 'FATAL' || x.verdict === 'UNEXPECTED_PASS')) {
    console.log(`- [${m.primitive}] ${m.control}\n    expected: ${m.expected}\n    actual:   ${m.actual}\n    ${m.detail}\n`);
  }
}
if (knownGaps) {
  console.log('=== KNOWN GAPS (expected, not regressions) ===\n');
  for (const m of matrix.filter((x) => x.verdict === 'KNOWN_GAP')) {
    console.log(`- [${m.primitive}] ${m.control}\n    ${m.detail}\n`);
  }
}
// UNEXPECTED_PASS is treated as a failure: it means a documented gap silently
// closed, which needs the comment updated, not a quiet green.
process.exit(fatals ? 2 : fail || unexpectedPasses ? 1 : 0);
