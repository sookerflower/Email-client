/**
 * Control Matrix - E2E Search
 *
 * Exercises every search control in the Step 1 inventory against a seeded
 * IMAP fixture set where each control has a KNOWN-CORRECT expected result.
 *
 * Design notes:
 *  - Every leg runs. Nothing short-circuits on first failure: the point of
 *    this harness is the complete picture, not the first red.
 *  - Assertions are set-equality over the fixture universe, so a filter that
 *    matches everything FAILS on precision (extra), not just recall (missing).
 *  - Results are scoped to this run's fixtures by runId so pre-existing
 *    mailbox contents are ignored. The fixture universe still contains the
 *    negative cases, so over-matching is caught.
 *  - This harness NEVER bulk-deletes the mailbox. Cleanup removes only the
 *    UIDs it appended. Do not reintroduce a '1:*' \Deleted sweep here -- on
 *    --real that is the user's actual mail.
 */
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import net from 'node:net';
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
const LABEL_NAME = `matrix${runId}`;

let cookie = '';

// ---------------------------------------------------------------- date grid
const now = new Date();
const daysAgo = (n) => new Date(now.getTime() - n * 86_400_000);
const ymd = (d) =>
  `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;

const D_TODAY = now;
const D_MID = daysAgo(10);
const D_OLD = new Date('2020-01-01T12:00:00Z');

// ------------------------------------------------------------------- fixtures
const ALICE = '"Alice Liddell" <alice@wonderland.test>';
const BOB = '"Bob Builder" <bob@builder.test>';
const CAROL = '"Carol Danvers" <carol@marvel.test>';

const S = (label) => `Matrix ${label} ${runId}`;

const plain = (from, subject, body, date, to) =>
  [
    `From: ${from}`,
    `To: ${to || mode.email}`,
    `Subject: ${subject}`,
    `Date: ${date.toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
  ].join('\r\n');

const FIXTURES = [
  {
    key: 'alice_rabbit',
    sender: 'alice',
    date: D_TODAY,
    flags: [],
    subject: S('AliceRabbit'),
    raw: (f) => plain(ALICE, f.subject, 'Down the rabbithole we go', f.date),
  },
  {
    key: 'bob_plain',
    sender: 'bob',
    date: D_TODAY,
    flags: [],
    subject: S('BobPlain'),
    raw: (f) => plain(BOB, f.subject, 'Can we fix it', f.date),
  },
  {
    // Operator-vs-text: body contains the literal string "from:alice".
    // `from:alice` must NOT return this (it is from Bob).
    key: 'literal_from',
    sender: 'bob',
    date: D_TODAY,
    flags: [],
    subject: S('LiteralOperator'),
    raw: (f) =>
      plain(BOB, f.subject, 'Someone wrote from:alice in the body of this message', f.date),
  },
  {
    key: 'read_msg',
    sender: 'alice',
    date: D_TODAY,
    flags: ['\\Seen'],
    subject: S('ReadMessage'),
    raw: (f) => plain(ALICE, f.subject, 'This one has been read', f.date),
  },
  {
    key: 'starred_msg',
    sender: 'alice',
    date: D_TODAY,
    flags: ['\\Flagged', '\\Seen'],
    subject: S('StarredMessage'),
    raw: (f) => plain(ALICE, f.subject, 'This one is flagged', f.date),
  },
  {
    // Real attachment: multipart/mixed WITH Content-Disposition: attachment.
    key: 'attach_real',
    sender: 'bob',
    date: D_TODAY,
    flags: [],
    subject: S('RealAttachment'),
    raw: (f) =>
      [
        `From: ${BOB}`,
        `To: ${mode.email}`,
        `Subject: ${f.subject}`,
        `Date: ${f.date.toUTCString()}`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/mixed; boundary="mtx-mixed"`,
        ``,
        `--mtx-mixed`,
        `Content-Type: text/plain; charset=utf-8`,
        ``,
        `Body with a real attachment`,
        `--mtx-mixed`,
        `Content-Type: text/plain; name="notes.txt"`,
        `Content-Disposition: attachment; filename="notes.txt"`,
        ``,
        `Hello World`,
        `--mtx-mixed--`,
        ``,
      ].join('\r\n'),
  },
  {
    // Precision case: text+HTML multipart/alternative with NO attachment.
    // has:attachment must NOT match this.
    key: 'alt_noattach',
    sender: 'bob',
    date: D_TODAY,
    flags: [],
    subject: S('AltNoAttachment'),
    raw: (f) =>
      [
        `From: ${BOB}`,
        `To: ${mode.email}`,
        `Subject: ${f.subject}`,
        `Date: ${f.date.toUTCString()}`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/alternative; boundary="mtx-alt"`,
        ``,
        `--mtx-alt`,
        `Content-Type: text/plain; charset=utf-8`,
        ``,
        `Plain part, no attachment here`,
        `--mtx-alt`,
        `Content-Type: text/html; charset=utf-8`,
        ``,
        `<p>HTML part, no attachment here</p>`,
        `--mtx-alt--`,
        ``,
      ].join('\r\n'),
  },
  {
    key: 'mid_date',
    sender: 'alice',
    date: D_MID,
    flags: [],
    subject: S('MidDate'),
    raw: (f) => plain(ALICE, f.subject, 'Ten days old', f.date),
  },
  {
    key: 'old_date',
    sender: 'alice',
    date: D_OLD,
    flags: [],
    subject: S('OldDate'),
    raw: (f) => plain(ALICE, f.subject, 'From the distant past', f.date),
  },
  {
    // NOTE: no keyword stamped on APPEND. The label is created THROUGH THE
    // APP after sync (see the apply_label leg) so it lands in the label
    // registry. A raw APPENDed keyword is not registered, so `label:<name>`
    // could never resolve against it -- a leg that passed against an
    // unregistered keyword would be testing the wrong thing.
    key: 'labelled',
    sender: 'alice',
    date: D_TODAY,
    flags: [],
    subject: S('Labelled'),
    raw: (f) => plain(ALICE, f.subject, 'This message carries a user label', f.date),
  },
  {
    key: 'unlabelled',
    sender: 'bob',
    date: D_TODAY,
    flags: [],
    subject: S('Unlabelled'),
    raw: (f) => plain(BOB, f.subject, 'This message carries no user label', f.date),
  },
  {
    key: 'to_carol',
    sender: 'alice',
    date: D_TODAY,
    flags: [],
    subject: S('ToCarol'),
    raw: (f) => plain(ALICE, f.subject, 'Addressed to Carol', f.date, CAROL),
  },
];

const keysWhere = (pred) => FIXTURES.filter(pred).map((f) => f.key);
const byKeySubject = (key) => FIXTURES.find((f) => f.key === key)?.subject;

// Set by the apply_label leg from the registry, not assumed from LABEL_NAME:
// createLabel mints the $zl_ id via its own slug rules.
let resolvedLabelId = null;

const TODAY_KEYS = keysWhere((f) => f.date === D_TODAY);
const ALICE_KEYS = keysWhere((f) => f.sender === 'alice');
const BOB_KEYS = keysWhere((f) => f.sender === 'bob');
const UNREAD_KEYS = keysWhere((f) => !f.flags.includes('\\Seen'));
// Unread AND today-dated. At the UI's default page size the result is the
// NEWEST maxResults threads, so genuinely older unread fixtures (the 10-day
// and 2020 ones) legitimately fall outside the window whenever the mailbox
// holds other unread mail newer than them. Only these must always appear.
const TODAY_UNREAD_KEYS = keysWhere((f) => !f.flags.includes('\\Seen') && f.date === D_TODAY);

// ------------------------------------------------------------------- plumbing
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
    throw new Error(`${path}: non-JSON response (HTTP ${res.status}): ${text.slice(0, 160)}`);
  }
  const item = parsed[0];
  if (item?.error) throw new Error(`${path}: ${item.error.json?.message ?? 'tRPC error'}`);
  return item?.result?.data?.json;
};

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
  // ImapFlow is an EventEmitter: an 'error' event with no listener is an
  // UNHANDLED error and takes the whole process down. That skips cleanup and
  // strands fixture messages in the mailbox -- on --real, in the user's real
  // inbox. A transient ECONNRESET mid-run did exactly that. Swallow it here;
  // the awaited calls still reject and are handled per-leg.
  client.on('error', (e) => {
    console.warn(`[e2e] raw IMAP client error (non-fatal): ${e?.code ?? e?.message ?? e}`);
  });
  await client.connect();
  return client;
};

// control -> [expected, actual, verdict, detail]
const matrix = [];
let imap;
let appendedUids = [];

const record = (control, expected, actual, ok, detail = '') => {
  matrix.push({ control, expected, actual, verdict: ok ? 'PASS' : 'FAIL', detail });
  console.log(`[matrix] ${ok ? 'PASS' : 'FAIL'}  ${control}`);
  if (!ok) console.log(`         expected: ${expected}\n         actual:   ${actual}${detail ? `\n         ${detail}` : ''}`);
};

// Legs that are infrastructure (login/seed/sync) still abort the run if they
// fail -- without them no assertion below means anything.
const hardLeg = async (name, fn) => {
  try {
    const detail = await fn();
    console.log(`[e2e] PASS ${name}${detail ? ` - ${detail}` : ''}`);
    return true;
  } catch (error) {
    console.error(`[e2e] FATAL ${name} - ${error.message}`);
    matrix.push({
      control: name,
      expected: 'infrastructure leg to succeed',
      actual: error.message,
      verdict: 'FATAL',
      detail: '',
    });
    return false;
  }
};

const subjectCache = new Map();
const subjectOf = async (threadId) => {
  if (subjectCache.has(threadId)) return subjectCache.get(threadId);
  let subj = null;
  try {
    const thread = await trpc('mail.get', { query: { id: threadId } });
    subj = thread?.latest?.subject ?? null;
  } catch {
    subj = null;
  }
  subjectCache.set(threadId, subj);
  return subj;
};

/** Run a listThreads call and reduce the result to the set of fixture keys. */
const fixtureKeysFor = async (queryInput) => {
  // Default to a page large enough that a BROAD filter cannot push this run's
  // fixtures off page 1. Without this, recall failures are indistinguishable
  // from pagination truncation. Legs that want the UI's default page size
  // pass maxResults explicitly.
  const result = await trpc('mail.listThreads', { query: { maxResults: 200, ...queryInput } });
  const keys = new Set();
  for (const t of result.threads ?? []) {
    const subj = await subjectOf(t.id);
    if (!subj || !subj.includes(runId)) continue;
    const fix = FIXTURES.find((f) => f.subject === subj);
    if (fix) keys.add(fix.key);
  }
  return keys;
};

const fmt = (keys) => (keys.length === 0 ? '(none)' : [...keys].sort().join(','));

/**
 * Assert set-equality over the fixture universe.
 * `message` is the distinct failure message for this control.
 */
const assertControl = async (control, queryInput, expectedKeys, message) => {
  try {
    const got = await fixtureKeysFor(queryInput);
    const expected = [...expectedKeys].sort();
    const actual = [...got].sort();
    const missing = expected.filter((k) => !got.has(k));
    const extra = actual.filter((k) => !expectedKeys.includes(k));
    const ok = missing.length === 0 && extra.length === 0;
    record(
      control,
      fmt(expected),
      fmt(actual),
      ok,
      ok ? '' : `${message} [missing: ${fmt(missing)}] [extra: ${fmt(extra)}]`,
    );
  } catch (error) {
    record(control, fmt([...expectedKeys].sort()), `ERROR: ${error.message}`, false, message);
  }
};

// ------------------------------------------------------------------- ban probe
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
    console.error(
      `[e2e] ABORT: ${host}:${port} is not reachable (timeout/refused).\n` +
        `      This is the fail2ban signature. Refusing to run --real and make the ban worse.`,
    );
    process.exit(2);
  }
  console.log(`[e2e] ban probe OK: ${host}:${port} reachable`);
}

// ----------------------------------------------------------------------- run
console.log(`[e2e] search control matrix - backend: ${mode.name}, runId=${runId}`);

let ok = await hardLeg('login', async () => {
  const res = await fetch(`${APP}/api/auth/sign-in/imap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify(mode.loginBody(mode.email, mode.password)),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.status) throw new Error(`login failed: ${JSON.stringify(body).slice(0, 200)}`);
  cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('no session cookie returned');
  return body.user.email;
});

if (ok) {
  ok = await hardLeg('seed_fixture', async () => {
    imap = await rawImap();
    const lock = await imap.getMailboxLock('INBOX');
    try {
      for (const fix of FIXTURES) {
        const raw = fix.raw(fix);
        let res;
        try {
          res = await imap.append('INBOX', raw, fix.flags, fix.date);
        } catch (e) {
          // Some servers reject unknown keywords on APPEND; retry without them
          // so the rest of the matrix still runs, and note it.
          if (fix.flags.some((f) => f.startsWith('$zl_'))) {
            console.warn(`[e2e] server rejected keyword flag on ${fix.key}: ${e.message}`);
            res = await imap.append('INBOX', raw, [], fix.date);
          } else {
            throw e;
          }
        }
        if (res?.uid) appendedUids.push(res.uid);
      }
    } finally {
      lock.release();
    }
    return `appended ${appendedUids.length}/${FIXTURES.length} fixtures`;
  });
}

if (ok) {
  ok = await hardLeg('sync_index', async () => {
    await trpc('mail.forceSync', { mutationBody: null });
    const deadline = Date.now() + (REAL ? 180_000 : 60_000);
    for (;;) {
      subjectCache.clear();
      const list = await trpc('mail.listThreads', {
        query: { folder: 'inbox', maxResults: 500 },
      });
      let found = 0;
      for (const t of list.threads ?? []) {
        const subj = await subjectOf(t.id);
        if (subj && subj.includes(runId)) found++;
      }
      if (found >= FIXTURES.length) return `indexed ${found}/${FIXTURES.length}`;
      if (Date.now() > deadline) {
        throw new Error(`timeout waiting for index: ${found}/${FIXTURES.length} indexed`);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  });
}

if (ok) {
  ok = await hardLeg('apply_label', async () => {
    // Reordered seeding: append -> sync -> create label -> apply -> re-poll.
    // Two new timing dependencies vs the old one-shot APPEND, and BOTH are
    // bounded polls, never setTimeout: the label must appear in the registry
    // before it can be applied, and the applied label must reach the index
    // before `label:` can find it.
    const deadline = Date.now() + (REAL ? 180_000 : 60_000);

    // Locate the target thread by subject.
    const target = async () => {
      const list = await trpc('mail.listThreads', {
        query: { folder: 'inbox', maxResults: 200 },
      });
      for (const t of list.threads ?? []) {
        const subj = await subjectOf(t.id);
        if (subj === byKeySubject('labelled')) return t.id;
      }
      return null;
    };
    let threadId = null;
    for (;;) {
      threadId = await target();
      if (threadId) break;
      if (Date.now() > deadline) throw new Error('labelled fixture never appeared in the index');
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Create through the app so the label is REGISTERED (createLabel mints
    // the $zl_ id and writes the registry). This is what makes label:<name>
    // resolvable at all.
    await trpc('labels.create', { mutationBody: { name: LABEL_NAME } });

    // Poll the registry rather than assuming the write is visible.
    let resolvedId = null;
    for (;;) {
      const labels = await trpc('labels.list', { query: null });
      const hit = (labels ?? []).find(
        (l) => l.name?.toLowerCase() === LABEL_NAME.toLowerCase(),
      );
      if (hit) {
        resolvedId = hit.id;
        resolvedLabelId = hit.id;
        break;
      }
      if (Date.now() > deadline) throw new Error(`label ${LABEL_NAME} never appeared in the registry`);
      await new Promise((r) => setTimeout(r, 2000));
    }

    await trpc('mail.modifyLabels', {
      mutationBody: { threadId: [threadId], addLabels: [resolvedId], removeLabels: [] },
    });

    // Poll until the label is actually searchable, so downstream legs are not
    // racing the index write.
    for (;;) {
      subjectCache.clear();
      const got = await fixtureKeysFor({ q: `label:${LABEL_NAME}`, maxResults: 200 });
      if (got.has('labelled')) break;
      if (Date.now() > deadline) {
        throw new Error(`label ${LABEL_NAME} never became searchable after modifyLabels`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    return `label ${LABEL_NAME} -> ${resolvedId}, applied and searchable`;
  });
}

if (ok) {
  // 1. free text
  await assertControl(
    'free text ("rabbithole")',
    { q: 'rabbithole' },
    ['alice_rabbit'],
    'Free-text search did not return exactly the one message whose body contains "rabbithole".',
  );

  // 2. from: (right and wrong), incl. operator-vs-text precision
  await assertControl(
    'from:alice',
    { q: 'from:alice' },
    ALICE_KEYS,
    'from:alice must return Alice-sent messages only. If literal_from appears, the operator is being text-matched against the body instead of parsed.',
  );
  await assertControl(
    'from:bob',
    { q: 'from:bob' },
    BOB_KEYS,
    'from:bob must return Bob-sent messages only -- proves from: discriminates between the two senders.',
  );

  // 3. to:
  await assertControl(
    'to:carol',
    { q: 'to:carol' },
    ['to_carol'],
    'to:carol must return only the message addressed to Carol, not every message addressed to the account.',
  );

  // 4. subject:
  await assertControl(
    'subject:AltNoAttachment',
    { q: 'subject:AltNoAttachment' },
    ['alt_noattach'],
    'subject: must match the subject header of exactly one fixture.',
  );

  // 5. is:unread
  await assertControl(
    'is:unread',
    { q: 'is:unread' },
    UNREAD_KEYS,
    'is:unread must return unseen messages only and must exclude the two \\Seen fixtures.',
  );

  // 6. is:starred
  await assertControl(
    'is:starred',
    { q: 'is:starred' },
    ['starred_msg'],
    'is:starred must return only the \\Flagged fixture.',
  );

  // 7. has:attachment (the precision case)
  await assertControl(
    'has:attachment',
    { q: 'has:attachment' },
    ['attach_real'],
    'has:attachment must match the multipart/mixed message with a real attachment and must NOT match the multipart/alternative text+HTML message that has none.',
  );

  // 8. after:
  await assertControl(
    `after:${ymd(daysAgo(3))}`,
    { q: `after:${ymd(daysAgo(3))}` },
    TODAY_KEYS,
    'after: must exclude both the 10-day-old and the 2020 fixture.',
  );

  // 9. before:
  await assertControl(
    'before:2021/01/01',
    { q: 'before:2021/01/01' },
    ['old_date'],
    'before: must return only the 2020 fixture.',
  );

  // 10. after + before range
  await assertControl(
    `after:${ymd(daysAgo(15))} before:${ymd(daysAgo(5))}`,
    { q: `after:${ymd(daysAgo(15))} before:${ymd(daysAgo(5))}` },
    ['mid_date'],
    'The after+before range must bracket the 10-day-old fixture alone -- today and 2020 must both fall outside.',
  );

  // 11. label: -- both the form a user types and the internal id
  await assertControl(
    `label:${LABEL_NAME} (name, as typed by a user)`,
    { q: `label:${LABEL_NAME}` },
    ['labelled'],
    'label:<name> must return the labelled thread and not the unlabelled one.',
  );
  await assertControl(
    `label:${resolvedLabelId} (internal id form)`,
    { q: `label:${resolvedLabelId}` },
    ['labelled'],
    'label:<$zl_ id> must return the labelled thread and not the unlabelled one.',
  );

  // Case sensitivity: resolveKeyword matches label NAMES case-insensitively.
  // A user typing label:Work for a label registered as "work" must resolve,
  // not quietly return nothing while looking like a working filter.
  await assertControl(
    `label:${LABEL_NAME.toUpperCase()} (name, wrong case)`,
    { q: `label:${LABEL_NAME.toUpperCase()}` },
    ['labelled'],
    'label:<NAME> in the wrong case must resolve case-insensitively to the same label, not silently return empty.',
  );

  // Fail closed: an unknown label must return NOTHING, never fall through to
  // the raw value and behave like an unfiltered search.
  await assertControl(
    'label:<nonexistent> fails closed',
    { q: `label:definitelynotalabel${runId}` },
    [],
    'An unresolvable label name must return no results. Returning the full fixture set means the filter degraded to unfiltered -- the original defect.',
  );

  // 12. category dropdown -> labelIds, no q
  await assertControl(
    'category dropdown: Unread (labelIds=[UNREAD])',
    { labelIds: ['UNREAD'], folder: 'inbox', maxResults: 200 },
    UNREAD_KEYS,
    'The Unread category must filter the inbox down to unseen threads.',
  );
  // No "Important" category leg: the category was removed from
  // defaultMailCategories (see schemas.ts). Nothing produces an IMPORTANT
  // label, and mapping it to \Flagged would duplicate STARRED.

  // 13. the four quick filters
  await assertControl(
    'quick filter 1/4: Unread Emails',
    { q: 'is:unread' },
    UNREAD_KEYS,
    'Quick filter "Unread Emails" emits is:unread.',
  );
  await assertControl(
    'quick filter 2/4: Starred Emails',
    { q: 'is:starred' },
    ['starred_msg'],
    'Quick filter "Starred Emails" emits is:starred.',
  );
  await assertControl(
    'quick filter 3/4: With Attachments',
    { q: 'has:attachment' },
    ['attach_real'],
    'Quick filter "With Attachments" emits has:attachment.',
  );
  await assertControl(
    `quick filter 4/4: Last 7 Days (after:${ymd(daysAgo(7))})`,
    { q: `after:${ymd(daysAgo(7))}` },
    TODAY_KEYS,
    'Quick filter "Last 7 Days" emits after:<7 days ago>; the 10-day-old and 2020 fixtures must fall outside.',
  );

  // 14. AI search: natural language -> generated query -> results
  for (const [nl, expectedKeys, why] of [
    ['show me unread emails from alice', ALICE_KEYS.filter((k) => UNREAD_KEYS.includes(k)), 'unread + from:alice'],
    ['emails with attachments', ['attach_real'], 'has:attachment'],
  ]) {
    let generated = null;
    try {
      const res = await trpc('ai.generateSearchQuery', { mutationBody: { query: nl } });
      generated = res?.query ?? null;
      if (!generated) throw new Error('no query returned');
      await assertControl(
        `AI search: "${nl}" -> "${generated}"`,
        { q: generated },
        expectedKeys,
        `Natural language should compile to a query equivalent to ${why}. Generated: ${JSON.stringify(generated)}`,
      );
    } catch (error) {
      record(
        `AI search: "${nl}"`,
        `a query equivalent to ${why} -> ${fmt(expectedKeys)}`,
        `ERROR: ${error.message}${generated ? ` (generated: ${JSON.stringify(generated)})` : ''}`,
        false,
        'AI search failed before results could be compared.',
      );
    }
  }

  // 14b. Same broad filter at the UI's DEFAULT page size. If this diverges
  // from the maxResults=200 run above, the operator is fine and the defect is
  // pagination/ordering in the result window the UI actually asks for.
  await assertControl(
    'is:unread at UI default page size (no maxResults)',
    { q: 'is:unread', maxResults: undefined },
    TODAY_UNREAD_KEYS,
    'Broad filter at the default page size must surface the NEWEST matching mail. Returning none (or only old mail) means groups were sliced before being sorted newest-first.',
  );

  // Ordering guard: the direct regression test for the slice-before-sort
  // defect.
  //
  // TIME BASE: the pager sorts on internalDate (imap.ts) while the display
  // sort and `receivedOn` use the parsed Date header. For arbitrary mailbox
  // mail those disagree (forged, delayed, timezone-mangled dates are common),
  // so asserting order over whatever the page happens to contain can go red
  // while the code behaves exactly as designed. This run's fixtures are
  // appended with Date header and INTERNALDATE set to the SAME value, so the
  // assertion below holds identically under either base. Scope it to them.
  //
  // maxResults is wide so all 12 fixtures are in scope -- three distinct
  // dates spanning six years, rather than only the near-simultaneous
  // today-dated ones, which would make the ordering claim trivially true.
  try {
    const out = await trpc('mail.listThreads', { query: { q: runId, maxResults: 200 } });
    const dates = [];
    for (const t of out.threads ?? []) {
      const th = await trpc('mail.get', { query: { id: t.id } });
      const subj = th?.latest?.subject;
      if (!subj || !subj.includes(runId)) continue; // fixtures only -- see TIME BASE above
      const iso = th?.latest?.receivedOn;
      if (iso) dates.push(new Date(iso).getTime());
    }
    let firstBreak = -1;
    for (let i = 1; i < dates.length; i++) {
      if (dates[i] > dates[i - 1]) {
        firstBreak = i;
        break;
      }
    }
    record(
      'search result ordering is newest-first',
      `non-increasing over ${dates.length} threads`,
      firstBreak === -1
        ? `non-increasing over ${dates.length} threads`
        : `order breaks at index ${firstBreak} (${new Date(dates[firstBreak]).toISOString()} newer than previous)`,
      firstBreak === -1 && dates.length > 1,
      dates.length > 1 ? '' : 'Too few threads returned to judge ordering.',
    );
  } catch (error) {
    record('search result ordering is newest-first', 'non-increasing dates', `ERROR: ${error.message}`, false);
  }

  // 15. Trash/Spam/Drafts exclusion -- --real only (GreenMail has INBOX only)
  if (REAL) {
    await assertControl(
      'default search excludes Trash/Spam/Drafts',
      { q: `Matrix` },
      FIXTURES.map((f) => f.key),
      'A default search must return inbox fixtures only; special-use folders are excluded by compileSearch.',
    );
  } else {
    matrix.push({
      control: 'Trash/Spam/Drafts exclusion',
      expected: 'special-use folders excluded',
      actual: 'SKIPPED - GreenMail provisions INBOX only',
      verdict: 'SKIP',
      detail: 'Runs on --real where Dovecot advertises special-use tags.',
    });
    console.log('[matrix] SKIP  Trash/Spam/Drafts exclusion (GreenMail: INBOX only)');
  }
}

// ---------------------------------------------------------------------- clean
// Cleanup must run even if the process is about to die, or fixtures are left
// behind in a real mailbox. Belt and braces alongside the 'error' handler.
const emergencyCleanup = async (why) => {
  try {
    if (imap && appendedUids.length > 0) {
      console.error(`[e2e] ${why} -- emergency cleanup of ${appendedUids.length} fixtures`);
      const lock = await imap.getMailboxLock('INBOX');
      try {
        await imap.messageDelete(appendedUids.join(','), { uid: true });
      } finally {
        lock.release();
      }
    }
  } catch (e) {
    console.error(`[e2e] EMERGENCY CLEANUP FAILED: ${e.message}`);
    console.error(`[e2e] fixture UIDs still in the mailbox: ${appendedUids.join(',')}`);
  }
};
process.on('uncaughtException', async (e) => {
  await emergencyCleanup(`uncaught: ${e.message}`);
  process.exit(3);
});
process.on('unhandledRejection', async (e) => {
  await emergencyCleanup(`unhandled rejection: ${e?.message ?? e}`);
  process.exit(3);
});

await hardLeg('cleanup', async () => {
  if (!imap) return 'nothing to clean';
  if (appendedUids.length > 0) {
    const lock = await imap.getMailboxLock('INBOX');
    try {
      await imap.messageDelete(appendedUids.join(','), { uid: true });
    } finally {
      lock.release();
    }
    try {
      await trpc('mail.forceSync', { mutationBody: null });
    } catch {
      /* index cleanup is best-effort */
    }
  }
  await imap.logout();
  return `removed ${appendedUids.length} fixture messages`;
});

// ---------------------------------------------------------------------- report
const pad = (s, n) => String(s).padEnd(n);
const w1 = Math.max(24, ...matrix.map((m) => m.control.length));
const w2 = Math.max(10, ...matrix.map((m) => String(m.expected).length));
const w3 = Math.max(10, ...matrix.map((m) => String(m.actual).length));

console.log(`\n\n=== SEARCH CONTROL MATRIX - ${mode.name} (runId ${runId}) ===\n`);
console.log(`${pad('CONTROL', w1)} | ${pad('EXPECTED', w2)} | ${pad('ACTUAL', w3)} | VERDICT`);
console.log(`${'-'.repeat(w1)}-+-${'-'.repeat(w2)}-+-${'-'.repeat(w3)}-+--------`);
for (const m of matrix) {
  console.log(`${pad(m.control, w1)} | ${pad(m.expected, w2)} | ${pad(m.actual, w3)} | ${m.verdict}`);
}

const pass = matrix.filter((m) => m.verdict === 'PASS').length;
const fail = matrix.filter((m) => m.verdict === 'FAIL').length;
const fatal = matrix.filter((m) => m.verdict === 'FATAL').length;
const skip = matrix.filter((m) => m.verdict === 'SKIP').length;
console.log(`\n${pass} pass, ${fail} fail, ${fatal} fatal, ${skip} skipped\n`);

if (fail || fatal) {
  console.log('=== FAILURE DETAIL ===\n');
  for (const m of matrix.filter((x) => x.verdict === 'FAIL' || x.verdict === 'FATAL')) {
    console.log(`- ${m.control}\n    expected: ${m.expected}\n    actual:   ${m.actual}\n    ${m.detail}\n`);
  }
}

process.exit(fatal ? 2 : fail ? 1 : 0);
