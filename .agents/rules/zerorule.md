---
trigger: always_on
---

# Zero mail — agent operating rules

Always on. If a task prompt conflicts with this file, follow this file and
flag the conflict in your report. Do not silently resolve it.

## 1. What this project is

A self-hosted Node mail client, forked from a Cloudflare-native SaaS build and
fully de-Cloudflared. Working branch: `path-b-migration`.

- `apps/server` — Hono api on :8787, tRPC routes, Postgres via Drizzle,
  BullMQ producer.
- Mail worker on :8791 — owns EVERY IMAP socket: driver cache, IDLE watchers,
  BullMQ consumers, and the `/rpc` choke point.
- `apps/mail` — React Router SPA.
- Storage: Postgres (28 `mail0_*` tables), Valkey (BullMQ + cache),
  local-disk blob store behind a MinIO-ready interface.
- Realtime: SSE at `/realtime/:connectionId`. Chat: HTTP streaming at
  `/api/chat/:connectionId`. Neither is a WebSocket. Do not add one.
- ZERO Cloudflare surface. Never reintroduce Workers, KV, R2, Durable Objects,
  Vectorize, Workflows, Queues, the agents SDK, or wrangler bindings. The only
  permitted "cloudflare" string in the tree is `@tsndr/cloudflare-worker-jwt`
  in the dormant Gmail push path.
- IMAP is the source of truth. There is no data migration, no export/import.
  A wiped database re-syncs from IMAP in ~207s. Design accordingly.

## 2. Environment

- Windows + PowerShell. Repo root `D:\email client\Email-client`. pnpm.
- Commit to `path-b-migration` only. `staging` tracks upstream HEAD — never
  commit there.
- Two IMAP backends, and they differ in ways that matter:
  - GreenMail (docker, :3143). Capability: `IMAP4rev1 LITERAL+ UIDPLUS SORT
    IDLE MOVE QUOTA`. No CONDSTORE, no ESEARCH. uidValidity is boot-derived,
    so a container restart is a genuine UIDVALIDITY change.
  - `m.re.cx` (Dovecot, :993, self-signed cert). CONDSTORE, QRESYNC, ESEARCH,
    SORT, SNIPPET/PREVIEW. No FTS plugin — `SEARCH TEXT` is a linear scan.
- Both login paths must work at all times: Google OAuth and custom IMAP/SMTP.
  The Gmail sync pipeline is dormant but Gmail login stays wired.
- Scale target: a ~20-person classroom on a single host.

## 3. Floors — never regress, always verify

Run and report all of these before calling any step done:

- `tsc --noEmit` for BOTH apps. Floors: `apps/server` 7, `apps/mail` 36.
  The 7 survivors are pre-existing Outlook/factory errors. Never exceed.
  For apps/mail the floor is ONLY reproducible as:
  `rm -f apps/mail/tsconfig.tsbuildinfo` then
  `cd apps/mail && pnpm tsc --project tsconfig.json --noEmit`
  and count with `grep -c "error TS"`. This floor has been "measured" as
  231, 36, and 16 at different times — the spread was measurement method
  (incremental tsbuildinfo runs re-check only a subset; stale docs), not
  code. Delete the tsbuildinfo first or the number is meaningless.
  Run tsc ALONE, never in parallel with suites or other builds: a
  memory-starved parallel run produced a bogus "0" (tsc died silently,
  grep counted nothing) — the fourth wrong number from this floor, and
  every one was measurement method, not code.
- Full unit suite, not one directory. Baseline 31 passing.
- Both E2E suites, on BOTH backends: `e2e-mail` and `e2e-realtime`, GreenMail
  and `--real`. 35 legs standing. `--real` windows are 120s.
- Socket census: never more than 2 concurrent IMAP sockets per account
  (1 driver + 1 watcher). Worker exposes `GET /census`, secret-guarded.
- Both login paths exercised.
- `git status` clean, no scratch files left behind.
- A worker restart does NOT give you a cold driver cache. Boot-time sync
  jobs re-warm it with clean engine auth within seconds of listen. The
  deterministic cold case is a FRESH-IDENTITY first login: the sign-in
  probe runs before the connection row exists, so no cached driver for
  that account can exist. This assumption hid the connectionId
  cache-poisoning bug (fixed in 8c20b714) — every "restart then test"
  attempt landed on a warm cache and passed. Any future test that treats
  "restart the worker" as "start clean" is invalid; use a fresh identity
  or prove the cache state explicitly.

If you cannot run one of these, say which and why. Do not substitute a
narrower check and report it as if it were the full one.

## 4. Security — non-negotiable

1. Never place a credential in a command line, a heredoc, an environment
   assignment you echo, or console output. A password has already leaked into
   a transcript this way.
2. Read secrets by reference from `.dev.vars` or the environment. Never `cat`,
   `Get-Content`, `Select-String`, or otherwise print a file containing
   secrets. If you need a value you cannot get without printing it, STOP and
   ask.
3. Never commit `.dev.vars`, `.env*`, keys, or tokens. Check before every
   commit.
4. Any cache key, log line, or error message that could carry account data
   must be scoped by `connectionId`. A cache key that omits it is a
   cross-account leak, not a performance detail.
5. Do not disable TLS verification anywhere new. `allowInsecureTls` exists
   only for the self-signed test server and is scheduled for removal.

## 5. Change discipline

- Smallest correct fix. No refactors, no rewrites, no reorganisation bundled
  into a bug fix.
- No new dependencies without explicit approval. Say what you want and why.
- Never silently degrade. If a capability is missing, an operator is
  unsupported, or a code path cannot serve a request, FAIL LOUDLY with a
  named error and surface it. Substituting an approximation that returns
  plausible-but-wrong results is the single worst outcome in this codebase and
  is how most of its bugs got there.
- Never widen a lock's granularity narrower than it currently is. Driver
  methods are serialized per account at `/rpc` for a reason (see 7.3).
- Prefer editing the real module over adding a parallel path. Two code paths
  that must agree will eventually disagree.
- Read the actual file before writing code against its API. Do not write a
  `switch` over types you assumed exist.

## 6. Testing discipline

1. A test must import and exercise the real module under test. Re-implementing
   logic inside the test file and asserting the re-implementation passes is
   not a test and will be rejected.
2. Failing-first is literal: check out or stash the pre-fix code, run the leg,
   capture it RED, apply the fix, run it again, capture it GREEN. Paste both
   outputs. A description of what you believe the old code did is not proof.
3. Every bug fixed gets a standing regression leg in the E2E suite, not a
   one-off script.
4. For anything with two code paths that must agree (incremental vs full sync,
   search-derived vs sync-stored IDs, cached vs fresh), write an equivalence
   oracle: compute the expected set independently and assert equality. This
   technique has caught more real defects here than any other.
5. Green on GreenMail is not green. Capability divergence means a real-server
   run can fail where GreenMail passes. Both, always.
6. Assert precision, not just recall. A filter that matches everything
   "passes" a naive test.

## 7. Known traps in this codebase

**7.1 The silent-drop class.** Most bugs here fail by returning a plausible
wrong answer rather than throwing. Precedents: `labelIds` not destructured so
a filter vanished; `conn.end()` killing the shared Postgres pool; label writes
being add-only so UNREAD never cleared; exact-key cache invalidation missing
the mounted query; `appendToSent` losing the Sent copy on a dead connection
because SMTP had already succeeded; `forceReSync` wiping sync state without
re-recording it; rate-limit IPs silently reading `no-ip`. When you touch a
path, ask what it does when its input is absent — not what it does when its
input is wrong.

**7.2 Capability strings lie about the client.** Dovecot advertises QRESYNC
and SORT; imapflow exposes neither. Always verify the LIBRARY supports what
the SERVER advertises before designing around it. This has now cost two
design passes.

**7.3 Concurrency is per account, not per connection.** Driver command
sequences are not atomic against mailbox SELECT. Whole driver methods are
serialized per account at the `/rpc` choke point, with `driverFor` inside the
lock. Any operation issuing multiple IMAP commands — search, sync, census —
holds the lock for its ENTIRE duration, including follow-up fetches. Releasing
between commands reopens a race that produced false vanishes and wrongful
deletions.

**7.4 Credential digests must use decrypted values.** Encryption uses a fresh
IV per login, so digesting ciphertext produces a new key every time. That
restarted the IDLE watcher and orphaned cached sockets on every login.

**7.5 UIDVALIDITY changes are real.** A GreenMail restart changes it. Blobs
embed validity + UID, so a stale validity is a corruption vector. The guard
purges threads and blobs, wipes cursors, and caps flapping at 3.

**7.6 Test harness timeouts are not product bugs.** The intermittent `--real`
"fetch failed" was undici's 300s default `headersTimeout` against multi-minute
tRPC responses. Scripts use a 900s dispatcher. Suspect the harness before the
product when a failure is timing-shaped.

**7.7 Environmental, not ours.** The classroom LLM endpoint `ws.re.cx` buffers
SSE, so token-level streaming is impossible regardless of app code.
`qwen2.5:32b` is flaky at multi-step tool chaining. Do not "fix" either in the
repo.

**7.8 Known residual.** Full-mailbox `SEARCH TEXT` on Dovecot scales linearly
with corpus size. Measurements taken on a 31-message mailbox prove round-trip
correctness, not scale.

## 8. Reporting format

- Report after each sub-step. Never batch several sub-steps into one report.
- Lead with evidence, not assertion. Paste real command output — test counts,
  tsc counts, timings — rather than describing them.
- State the mechanism of a bug, not a restatement of its symptom.
- Distinguish "measured" from "expected". If a number is estimated, say so.
- List anything you deliberately left open.
- END EVERY REPORT with a status line per numbered instruction in the prompt:
  DONE / SKIPPED / BLOCKED, one line each, no exceptions. Silence on an item
  will be read as a miss.

## 9. Stop and ask

Stop and ask rather than proceeding when:

- A fix would require a new dependency, a schema migration, or a lock change.
- A control or feature has no viable backend and the choice is remove vs
  re-implement. That is a product decision, not yours.
- A verification floor cannot be met and you would have to report a narrower
  check instead.
- You need a secret you cannot access without printing it.
- The task as written conflicts with anything in this file.
## 10. Commit and Cleanup Rules
- Stage the files belonging to the change BY NAME. Never `git add -A`,
  never `git commit -am`. `git add -A` is how an orphaned scratch test
  file (driver/test-list.ts) got committed and pushed the server tsc
  floor from 7 to 8, which then cost a stash-and-verify session to
  untangle. Run `git status --short` first and account for every line
  you stage.
- NEVER run `git clean -fd`. To remove scratch files, delete them by name.
- Commit at the end of every round, even mid-work, with a wip: message.
