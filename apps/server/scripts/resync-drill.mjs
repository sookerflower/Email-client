// Phase 6.5 fresh-mailbox resync drill (run from apps/server).
// Empty DB + blobs -> login -> timed from-zero forceSync, with a probe
// message delivered MID-SYNC to test the ledgered-but-unindexed residual.
import { readFileSync } from 'node:fs';
import nodemailer from 'nodemailer';
import { Agent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new Agent({ headersTimeout: 900_000, bodyTimeout: 900_000 }));

const APP = 'http://127.0.0.1:8787';
const ORIGIN = 'http://localhost:3000';
const devVars = Object.fromEntries(
  readFileSync('.dev.vars', 'utf8').split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }),
);
const EMAIL = devVars.TEST_IMAP_USER, PASSWORD = devVars.TEST_IMAP_PASSWORD;
const runId = Math.random().toString(36).slice(2, 8);
let cookie = '';

const trpc = async (path, { query, mutationBody } = {}) => {
  const url = `${APP}/api/trpc/${path}?batch=1${query ? `&input=${encodeURIComponent(JSON.stringify({ 0: { json: query } }))}` : ''}`;
  const init = { method: 'GET', headers: { Origin: ORIGIN, Cookie: cookie } };
  if (mutationBody !== undefined) { init.method = 'POST'; init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify({ 0: { json: mutationBody } }); }
  const res = await fetch(url, init);
  const parsed = JSON.parse(await res.text());
  if (parsed[0]?.error) throw new Error(`${path}: ${parsed[0].error.json?.message}`);
  return parsed[0]?.result?.data?.json;
};

// 1. Login on the empty DB (creates user + connection from zero).
const t0 = Date.now();
const res = await fetch(`${APP}/api/auth/sign-in/imap`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const loginBody = await res.json();
if (!res.ok || !loginBody.status) throw new Error('login failed: ' + JSON.stringify(loginBody).slice(0, 200));
cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
console.log(`[drill] login on empty DB: ${Date.now() - t0}ms (user ${loginBody.user.email})`);

// 2. Probe message fired mid-sync (~25s into the full resync).
const probeSubject = `drill probe ${runId}`;
const probeTimer = setTimeout(async () => {
  try {
    const transporter = nodemailer.createTransport({
      host: devVars.IMAP_DEFAULT_SMTP_HOST, port: Number(devVars.IMAP_DEFAULT_SMTP_PORT || 587),
      secure: false, auth: { user: EMAIL, pass: PASSWORD }, tls: { rejectUnauthorized: false },
    });
    await transporter.sendMail({ from: EMAIL, to: EMAIL, subject: probeSubject, html: `<p>probe ${runId}</p>` });
    transporter.close();
    console.log(`[drill] probe "${probeSubject}" sent at +${Date.now() - t0}ms (mid-sync)`);
  } catch (e) { console.log('[drill] probe send FAILED:', e.message); }
}, 25_000);

// 3. Timed from-zero full resync.
const tSync = Date.now();
await trpc('mail.forceSync', { mutationBody: null });
const syncMs = Date.now() - tSync;
clearTimeout(probeTimer);
const inbox = await trpc('mail.listThreads', { query: { folder: 'inbox', maxResults: 100 } });
console.log(`[drill] from-zero forceSync: ${(syncMs / 1000).toFixed(1)}s, inbox now ${inbox.threads.length} threads`);

// 4. Sent view (repeatable sent sync may lag; sample it via direct listing later in suites).
// 5. Probe visibility: poll up to 180s (IDLE notify -> incremental should bring it in
//    UNLESS the completion cursor swallowed it — the 6.3 residual under test).
const deadline = Date.now() + 180_000;
let visibleAt = null;
while (Date.now() < deadline) {
  const listing = await trpc('mail.listThreads', { query: { folder: 'inbox', maxResults: 30 } });
  let found = false;
  for (const t of listing.threads.slice(0, 15)) {
    const thread = await trpc('mail.get', { query: { id: t.id } });
    if (thread?.latest?.subject === probeSubject) { found = true; break; }
  }
  if (found) { visibleAt = Date.now() - t0; break; }
  await new Promise((r) => setTimeout(r, 5000));
}
if (visibleAt) console.log(`[drill] probe VISIBLE in app at +${(visibleAt / 1000).toFixed(1)}s — residual did not manifest (or self-healed)`);
else console.log('[drill] PROBE NOT VISIBLE after 180s — the mid-sync-arrival residual MANIFESTED');
console.log(`[drill] total: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
