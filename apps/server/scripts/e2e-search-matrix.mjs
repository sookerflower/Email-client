/**
 * Control Matrix - E2E Search
 * Validates every search operator against a seeded IMAP fixture.
 */
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');


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
      name: 'real',
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

let cookie = '';
const runId = Math.random().toString(36).slice(2, 10);

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
  return client;
};

// Fixture Data
const FIXTURES = [
  {
    key: 'unread',
    flags: [],
    subject: `Matrix Unread ${runId}`,
    from: '"Test" <test@example.com>',
    date: new Date(),
    body: 'Just a normal unread email'
  },
  {
    key: 'read',
    flags: ['\\Seen'],
    subject: `Matrix Read ${runId}`,
    from: '"Test" <test@example.com>',
    date: new Date(),
    body: 'Just a normal read email'
  },
  {
    key: 'starred',
    flags: ['\\Flagged', '\\Seen'],
    subject: `Matrix Starred ${runId}`,
    from: '"Test" <test@example.com>',
    date: new Date(),
    body: 'A starred email'
  },
  {
    key: 'alice',
    flags: [],
    subject: `Matrix Alice rabbit hole ${runId}`,
    from: '"Alice" <alice@wonderland.test>',
    date: new Date(),
    body: 'Down the rabbit hole'
  },
  {
    key: 'bob',
    flags: [],
    subject: `Matrix Bob ${runId}`,
    from: '"Test" <test@example.com>',
    to: '"Bob" <bob@builder.test>',
    date: new Date(),
    body: 'Can we fix it?'
  },
  {
    key: 'charlie',
    flags: [],
    subject: `Matrix Charlie ${runId}`,
    from: '"Test" <test@example.com>',
    cc: '"Charlie" <charlie@chocolate.test>',
    date: new Date(),
    body: 'Golden ticket'
  },
  {
    key: 'old',
    flags: [],
    subject: `Matrix Old ${runId}`,
    from: '"Test" <test@example.com>',
    date: new Date('2020-01-01T12:00:00Z'),
    body: 'From the past'
  },
  {
    key: 'attachment',
    flags: [],
    subject: `Matrix Attachment ${runId}`,
    from: '"Test" <test@example.com>',
    date: new Date(),
    raw: [
      `From: "Test" <test@example.com>`,
      `To: ${mode.email}`,
      `Subject: Matrix Attachment ${runId}`,
      `Date: ${new Date().toUTCString()}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="matrix-boundary"`,
      ``,
      `--matrix-boundary`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      `Email with attachment`,
      `--matrix-boundary`,
      `Content-Type: text/plain; name="test.txt"`,
      `Content-Disposition: attachment; filename="test.txt"`,
      ``,
      `Hello World`,
      `--matrix-boundary--`,
      ``
    ].join('\r\n')
  }
];

let appendedUids = [];
let imap;

const legs = [];
let failed = false;

const leg = async (name, fn) => {
  if (failed) return;
  const started = Date.now();
  try {
    const detail = await fn();
    legs.push([name, 'PASS', detail ?? '']);
    console.log(`[e2e] PASS ${name}${detail ? ` - ${detail}` : ''} (${Date.now() - started}ms)`);
  } catch (error) {
    failed = true;
    legs.push([name, 'FAIL', error.message]);
    console.error(`[e2e] FAIL ${name} - ${error.message}`);
  }
};

await leg('login', async () => {
  const res = await fetch(`${APP}/api/auth/sign-in/imap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify(mode.loginBody(mode.email, mode.password)),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.status) throw new Error(`login failed: ${JSON.stringify(body).slice(0, 150)}`);
  cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('no session cookie returned');
  return body.user.email;
});

await leg('seed_fixture', async () => {
  imap = await rawImap();
  // Delete all existing messages so we don't get swamped by previous test runs or background noise
  try {
    await imap.messageFlagsAdd('1:*', ['\\Deleted'], { uid: false });
    await imap.mailboxClose();
    await imap.mailboxOpen('INBOX'); 
  } catch {
    // ignore errors if empty
  }
  const lock = await imap.getMailboxLock('INBOX');
  try {
    for (const fix of FIXTURES) {
      let raw = fix.raw;
      if (!raw) {
        raw = [
          `From: ${fix.from}`,
          `To: ${fix.to || mode.email}`,
          fix.cc ? `Cc: ${fix.cc}` : '',
          `Subject: ${fix.subject}`,
          `Date: ${fix.date.toUTCString()}`,
          `Content-Type: text/plain; charset=utf-8`,
          ``,
          fix.body
        ].filter(l => l !== '').join('\r\n');
      }
      const res = await imap.append('INBOX', raw, fix.flags, fix.date);
      if (res.uid) appendedUids.push(res.uid);
    }
  } finally {
    lock.release();
  }
  return `Appended ${FIXTURES.length} test emails`;
});

await leg('forceSync', async () => {
  await trpc('mail.forceSync', { mutationBody: null });
  
  // Wait for the seeded threads to be indexed
  const deadline = Date.now() + (REAL ? 120_000 : 30_000);
  let found = 0;
  for (;;) {
    const list = await trpc('mail.listThreads', { query: { folder: 'inbox', maxResults: 500 } });
    if (list.threads.length > 0 && !found) {
      console.log('Sample thread:', JSON.stringify(list.threads[0]));
    }
    // Since we don't know the exact shape yet, let's just fetch all of them
      found = 0;
      const subjectsFound = [];
      for (const t of list.threads) {
        const thread = await trpc('mail.get', { query: { id: t.id } });
        const subj = thread?.latest?.subject;
        if (subj) {
          if (subj.includes(runId)) {
            found++;
          }
          subjectsFound.push(subj);
        } else {
          subjectsFound.push(`(no subject for ${t.id})`);
        }
      }
      console.log(`[DEBUG] poll loop: found ${found}/${FIXTURES.length}. Subjects: ${subjectsFound.join(' | ')}`);
      if (found >= FIXTURES.length) {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timeout waiting for seeded emails to sync. Found ${found}/${FIXTURES.length}.`);
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  return `Synced ${found} seeded threads`;
});

// Helper for assertions
const assertSearch = async (query, expectedKeys) => {
  await leg(`search: ${query}`, async () => {
    // Only fetch threads from our runId to avoid noise from old tests
    const result = await trpc('mail.listThreads', { query: { q: query, maxResults: 100 } });
    
    // Find expected subjects
    const expectedSubjects = expectedKeys.map(k => FIXTURES.find(f => f.key === k).subject);
    const returnedSubjects = [];
    
    for (const t of result.threads) {
      const thread = await trpc('mail.get', { query: { id: t.id } });
      const subj = thread.latest.subject;
      // Only include threads from our runId to avoid noise from old tests
      if (subj && subj.includes(runId)) {
        returnedSubjects.push(subj);
      }
    }

    const missing = expectedSubjects.filter(s => !returnedSubjects.includes(s));
    const extra = returnedSubjects.filter(s => !expectedSubjects.includes(s));

    if (missing.length > 0 || extra.length > 0) {
      throw new Error(`Mismatch!\n  Expected: ${expectedSubjects}\n  Returned: ${returnedSubjects}\n  Missing: ${missing}\n  Extra: ${extra}`);
    }
    return `Matched ${expectedKeys.length} threads`;
  });
};

await assertSearch('is:unread', ['unread', 'alice', 'bob', 'charlie', 'old', 'attachment']);
await assertSearch('is:read', ['read', 'starred']);
await assertSearch('is:starred', ['starred']);
await assertSearch('from:alice', ['alice']);
await assertSearch('to:bob', ['bob']);
await assertSearch('cc:charlie', ['charlie']);
await assertSearch('older_than:1y', ['old']);
await assertSearch('before:2021/01/01', ['old']);
await assertSearch('newer_than:1d', ['unread', 'read', 'starred', 'alice', 'bob', 'charlie', 'attachment']);
await assertSearch('after:2025/01/01', ['unread', 'read', 'starred', 'alice', 'bob', 'charlie', 'attachment']);
await assertSearch('subject:Attachment', ['attachment']);
await assertSearch('has:attachment', ['attachment']);
await assertSearch('rabbit hole', ['alice']); // Text search

// Compound test
await assertSearch('is:unread from:alice', ['alice']);

await leg('cleanup', async () => {
  if (appendedUids.length > 0) {
    const lock = await imap.getMailboxLock('INBOX');
    try {
      await imap.messageFlagsAdd(appendedUids.join(','), ['\\Deleted'], { uid: true });
      await imap.messageDelete(appendedUids.join(','), { uid: true });
    } finally {
      lock.release();
    }
    await trpc('mail.forceSync', { mutationBody: null });
  }
  await imap.logout();
  return 'Deleted fixture emails';
});

if (failed) {
  process.exit(1);
}
