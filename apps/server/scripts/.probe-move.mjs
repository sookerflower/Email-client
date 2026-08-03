/**
 * Item 3 verification: moves via the write-through path.
 * GreenMail only. Asserts at all three levels; independent IMAP for level (c).
 */
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import { execSync } from 'node:child_process';

const APP = 'http://127.0.0.1:8787';
const ORIGIN = 'http://localhost:3000';
const EMAIL = 'student2@classroom.test';
const PASS = 'secret123';
const runId = 'mv' + Math.random().toString(36).slice(2, 7);

let cookie = '';
const trpc = async (p, o = {}) => {
  const u = `${APP}/api/trpc/${p}?batch=1${
    o.query !== undefined ? `&input=${encodeURIComponent(JSON.stringify({ 0: { json: o.query } }))}` : ''
  }`;
  const i = { method: 'GET', headers: { Origin: ORIGIN, Cookie: cookie } };
  if (o.mutationBody !== undefined) {
    i.method = 'POST';
    i.headers['Content-Type'] = 'application/json';
    i.body = JSON.stringify({ 0: { json: o.mutationBody } });
  }
  const r = await fetch(u, i);
  const j = JSON.parse(await r.text());
  if (j[0]?.error) throw new Error(`${p}: ${j[0].error.json?.message}`);
  return j[0]?.result?.data?.json;
};

const sql = (q) =>
  execSync(
    `docker exec zerodotemail-db psql -U postgres -d zerodotemail -t -A -c "${q.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' },
  ).trim();

const mk = async () => {
  const { ImapFlow } = await import('imapflow');
  const c = new ImapFlow({
    host: '127.0.0.1', port: 3143, secure: false,
    auth: { user: EMAIL, pass: PASS }, logger: false,
  });
  c.on('error', () => {});
  await c.connect();
  return c;
};

const FOLDERS = ['INBOX', 'Trash', 'Junk', 'Archive'];
const whereIs = async (subject) => {
  const c = await mk();
  const out = {};
  try {
    for (const f of FOLDERS) {
      let lock;
      try { lock = await c.getMailboxLock(f); } catch { continue; }
      try {
        const u = (await c.search({ header: { subject } }, { uid: true })) || [];
        if (u.length) out[f] = u;
      } finally { lock.release(); }
    }
  } finally { await c.logout(); }
  return out;
};

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

// ---- login + seed
const r = await fetch(`${APP}/api/auth/sign-in/imap`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
  body: JSON.stringify({ email: EMAIL, password: PASS, imapHost: '127.0.0.1', imapPort: 3143, smtpHost: '127.0.0.1', smtpPort: 3025 }),
});
cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const conns = await trpc('connections.list', { query: null });
const cid = (conns?.connections ?? []).find((c) => c.email === EMAIL)?.id;

const subj = `moveprobe ${runId}`;
{
  const c = await mk();
  const lock = await c.getMailboxLock('INBOX');
  try {
    // Message-ID present ON PURPOSE: thread identity derives from it and
    // survives a move. Without one the id is synthetic
    // encodeMessageId(folder, uidValidity, uid) and changes on every move --
    // documented behaviour, not a bug (the first probe tripped over this).
    await c.append('INBOX', [
      `Message-ID: <${runId}@probe.test>`,
      `From: m@x.test`, `To: ${EMAIL}`, `Subject: ${subj}`,
      `Date: ${new Date(Date.now() - 7200000).toUTCString()}`,
      `Content-Type: text/plain`, ``, `move probe body`,
    ].join('\r\n'), [], new Date(Date.now() - 7200000));
  } finally { lock.release(); }
  await c.logout();
}

await trpc('mail.forceSync', { mutationBody: null });
let tid = null;
for (let i = 0; i < 25 && !tid; i++) {
  const list = await trpc('mail.listThreads', { query: { folder: 'inbox', maxResults: 50 } });
  for (const t of list.threads ?? []) {
    const th = await trpc('mail.get', { query: { id: t.id } });
    if (th?.latest?.subject === subj) { tid = t.id; break; }
  }
  if (!tid) await new Promise((r) => setTimeout(r, 2000));
}
if (!tid) { console.error('FATAL: probe never indexed'); process.exit(2); }
console.log(`threadId ${tid}\n`);

const ledger = () => sql(`select folder||'|'||uid from mail0_folder_message where connection_id='${cid}' and thread_id='${tid}' order by folder`);
const indexLabels = () => sql(`select label_id from mail0_thread_label where connection_id='${cid}' and thread_id='${tid}' order by label_id`).split('\n').filter(Boolean);
const inIndex = () => sql(`select count(*) from mail0_thread where connection_id='${cid}' and thread_id='${tid}'`) === '1';

const step = async (name, mutation, wantFolder, wantLabels, notLabels = []) => {
  await trpc('mail.modifyLabels', { mutationBody: mutation });
  await new Promise((r) => setTimeout(r, 2500));
  const loc = await whereIs(subj);
  const folders = Object.keys(loc);
  check(`${name}: server folder`, folders.length === 1 && folders[0] === wantFolder, JSON.stringify(loc));
  check(`${name}: still in index`, inIndex());
  const labels = indexLabels();
  const hasAll = wantLabels.every((l) => labels.includes(l));
  const hasNone = notLabels.every((l) => !labels.includes(l));
  check(`${name}: index labels`, hasAll && hasNone, labels.join(','));
  // Ledger keys are canonical APP names: IMAP 'Junk' is keyed 'spam'.
  check(`${name}: ledger follows uid`, ledger().includes(`${wantFolder === 'Junk' ? 'spam' : wantFolder.toLowerCase()}|${loc[wantFolder]?.[0]}`), ledger().replace(/\n/g, ' '));
};

console.log('--- baseline ---');
check('baseline: in INBOX on server', JSON.stringify(Object.keys(await whereIs(subj))) === '["INBOX"]');
check('baseline: ledger inbox row', ledger().startsWith('inbox|'), ledger());

console.log('\n--- move to bin ---');
await step('bin', { threadId: [tid], addLabels: ['TRASH'], removeLabels: ['INBOX'] }, 'Trash', ['TRASH'], ['INBOX']);

console.log('\n--- IDLE-survival window (the defect-2 regression: wait out a natural sync) ---');
{
  const c = await mk();
  const lock = await c.getMailboxLock('INBOX');
  try {
    await c.append('INBOX', [`From: t@x.test`, `To: ${EMAIL}`, `Subject: trigger ${runId}`, `Date: ${new Date().toUTCString()}`, `Content-Type: text/plain`, ``, `t`].join('\r\n'), [], new Date());
  } finally { lock.release(); }
  await c.logout();
}
await new Promise((r) => setTimeout(r, 40000));
check('post-IDLE-sync: thread still in index', inIndex(), indexLabels().join(','));
check('post-IDLE-sync: TRASH label intact', indexLabels().includes('TRASH'));

console.log('\n--- forced resync survival ---');
await trpc('mail.forceSync', { mutationBody: null });
await new Promise((r) => setTimeout(r, 8000));
check('post-forceSync: thread still in index', inIndex(), indexLabels().join(','));
check('post-forceSync: TRASH label intact', indexLabels().includes('TRASH'));
check('post-forceSync: still only in Trash on server', JSON.stringify(Object.keys(await whereIs(subj))) === '["Trash"]');

console.log('\n--- restore from bin (INBOX by design) ---');
await step('restore', { threadId: [tid], addLabels: ['INBOX'], removeLabels: ['TRASH'] }, 'INBOX', ['INBOX'], ['TRASH']);

console.log('\n--- archive ---');
await step('archive', { threadId: [tid], addLabels: [], removeLabels: ['INBOX'] }, 'Archive', ['ARCHIVE'], ['INBOX']);

console.log('\n--- spam (from archive) ---');
await step('spam', { threadId: [tid], addLabels: ['SPAM'], removeLabels: [] }, 'Junk', ['SPAM'], []);

console.log('\n--- not-spam ---');
await step('not-spam', { threadId: [tid], addLabels: ['INBOX'], removeLabels: ['SPAM'] }, 'INBOX', ['INBOX'], ['SPAM']);

// ---- cleanup
{
  const c = await mk();
  for (const f of FOLDERS) {
    let lock;
    try { lock = await c.getMailboxLock(f); } catch { continue; }
    try {
      const u = (await c.search({ or: [{ header: { subject: 'moveprobe' } }, { header: { subject: 'trigger' } }] }, { uid: true })) || [];
      if (u.length) await c.messageDelete(u.join(','), { uid: true });
    } finally { lock.release(); }
  }
  await c.logout();
}
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
