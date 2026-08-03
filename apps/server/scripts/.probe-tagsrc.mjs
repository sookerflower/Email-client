/**
 * Item 4 verification: do rendered tags track thread_label rather than the
 * message blob?
 *
 * Two directions, because the blob is wrong in both:
 *   - LOCAL action (star)      -> blob never updated, icon used to go dark
 *   - EXTERNAL change (\Seen)  -> blob never updated, was wrong even before
 *                                 write-through existed
 * File-based, not `node -e`: the escaping for '\Seen' collapses through bash
 * double-quotes and silently sets a custom keyword named "Seen" instead.
 */
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

const APP = 'http://127.0.0.1:8787';
const ORIGIN = 'http://localhost:3000';
const EMAIL = 'student2@classroom.test';
const PASS = 'secret123';
const runId = Math.random().toString(36).slice(2, 7);
const subj = `tagsrc ${runId}`;

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

const { ImapFlow } = await import('imapflow');
const mk = async () => {
  const c = new ImapFlow({
    host: '127.0.0.1', port: 3143, secure: false,
    auth: { user: EMAIL, pass: PASS }, logger: false,
  });
  c.on('error', () => {});
  await c.connect();
  return c;
};

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

const r = await fetch(`${APP}/api/auth/sign-in/imap`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
  body: JSON.stringify({ email: EMAIL, password: PASS, imapHost: '127.0.0.1', imapPort: 3143, smtpHost: '127.0.0.1', smtpPort: 3025 }),
});
cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

{
  const c = await mk();
  const lock = await c.getMailboxLock('INBOX');
  try {
    await c.append('INBOX', [
      `Message-ID: <${runId}@tag.test>`, `From: t@x.test`, `To: ${EMAIL}`,
      `Subject: ${subj}`, `Date: ${new Date(Date.now() - 7200000).toUTCString()}`,
      `Content-Type: text/plain`, ``, `body`,
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
if (!tid) { console.error('FATAL: never indexed'); process.exit(2); }

const view = async () => {
  const th = await trpc('mail.get', { query: { id: tid } });
  const tags = (th?.latest?.tags ?? []).map((t) => t.name);
  return { starIcon: tags.includes('STARRED'), unreadTag: tags.includes('UNREAD'), hasUnread: th?.hasUnread, tags };
};
const serverFlags = async () => {
  const c = await mk();
  const lock = await c.getMailboxLock('INBOX');
  try {
    const u = (await c.search({ header: { subject: subj } }, { uid: true })) || [];
    const m = await c.fetchOne(String(u[0]), { flags: true }, { uid: true });
    return [...(m?.flags ?? [])];
  } finally { lock.release(); await c.logout(); }
};

let v = await view();
check('baseline: star off, unread on', v.starIcon === false && v.unreadTag === true, JSON.stringify(v.tags));

await trpc('mail.toggleStar', { mutationBody: { ids: [tid] } });
await new Promise((r) => setTimeout(r, 1500));
v = await view();
check('LOCAL star -> icon lights from thread_label', v.starIcon === true, JSON.stringify(v.tags));
check('LOCAL star -> reached the server', (await serverFlags()).includes('\\Flagged'), JSON.stringify(await serverFlags()));

// EXTERNAL: an independent client marks it read. The blob can never learn this.
{
  const c = await mk();
  const lock = await c.getMailboxLock('INBOX');
  try {
    const u = (await c.search({ header: { subject: subj } }, { uid: true })) || [];
    await c.messageFlagsAdd(String(u[0]), ['\\Seen'], { uid: true });
  } finally { lock.release(); }
  await c.logout();
}
const flagsAfter = await serverFlags();
check('EXTERNAL \\Seen actually set on server', flagsAfter.includes('\\Seen'), JSON.stringify(flagsAfter));

await trpc('mail.forceSync', { mutationBody: null });
let cleared = false;
for (let i = 0; i < 10 && !cleared; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  v = await view();
  cleared = v.unreadTag === false && v.hasUnread === false;
}
check('EXTERNAL read -> UNREAD clears in rendered tags', cleared, JSON.stringify(v.tags));
check('EXTERNAL read -> star survives (independent state)', v.starIcon === true, JSON.stringify(v.tags));

await trpc('mail.toggleStar', { mutationBody: { ids: [tid] } });
await new Promise((r) => setTimeout(r, 1500));
v = await view();
check('LOCAL unstar -> icon clears', v.starIcon === false, JSON.stringify(v.tags));

{
  const c = await mk();
  const lock = await c.getMailboxLock('INBOX');
  try {
    const u = (await c.search({ header: { subject: 'tagsrc' } }, { uid: true })) || [];
    if (u.length) await c.messageDelete(u.join(','), { uid: true });
  } finally { lock.release(); }
  await c.logout();
}
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
