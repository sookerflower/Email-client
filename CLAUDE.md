# Project: Self-hosted email client for a ~20-person classroom deployment

## Current status (as of 2026-07-26) — READ THIS FIRST

**Direction: Path B — de-Cloudflaring THIS repo (`Email-client/`, a Mail Zero
fork) onto plain Node + Postgres + Redis.** This supersedes the older
"Path C / AXMail" decision some memory files reference; the user reversed it
on 2026-07-24. `AXMail/`, `mail-bridge-main/`, `Mailspring/` in the workspace
are all out of scope.

**Authoritative plan + progress log: `MIGRATION-PLAN.md` at this repo's
root.** Its "Progress log" section records exactly what each phase changed,
with the incidents and verification numbers. Read it before doing anything.

### Done (committed + pushed, branch `path-b-migration`, remote = user's fork sookerflower/Email-client)
- **Phase 0**: Node entrypoint — esbuild bundle (`src/node/build.mjs`,
  `cloudflare:*` → `src/node/cf-shim.mjs`); do NOT run server TS under
  tsx/loader-hooks (breaks CJS named-export detection).
- **Phase 1**: ZeroDB DO → plain `UserDb`; new tables (thread/label/outbox/
  snooze/config/chat/folder_sync_state, migrations 0040-0041).
- **Removed entirely** (not neutralized): Autumn billing, Sentry, Datadog,
  Vectorize, dormroom, sharding.
- **Phase 2**: 10 KV namespaces → `lib/stores.ts` (Redis ephemeral /
  Postgres durable); R2 → `lib/blob-store.ts` (fs under `DATA_DIR`, default
  `apps/server/data` — gitignored, contains real mail).
- **Phase 3 (closed)**: `lib/mail-engine.ts` + `lib/mail-index.ts` replace
  ZeroDriver (per-connection engine on Postgres; folder-label bug fixed with
  regression test); worker process (`src/worker/`) owns ALL IMAP sockets
  (driver cache + IDLE watchers under a Redis leader lease; `/rpc` serves the
  api process — never open IMAP sockets in the api process, that's the
  fail2ban lesson); summaries via self-hosted LLM → `mail0_summary`; topics
  in Redis; Do_State from pg counts. `ZeroDriver`/`ShardRegistry`/`ZeroDB`
  are EMPTY DO shells kept only so `wrangler deploy --dry-run` still builds.

- **Phase 4 (closed 2026-07-25)**: BullMQ on Valkey TCP (`QUEUE_REDIS_URL`,
  default redis://127.0.0.1:6379 — NOT the Upstash proxy). Queues
  mail-sync/mail-send/mail-sweep; processors live in the worker process;
  **never import `lib/queue` from workerd-reachable code** (main.ts and
  below) — the api reaches the queues via the worker's /enqueue-send +
  /cancel-send HTTP bridge (cf-shim's send_email_queue). `sync-folder`
  jobs: page-checkpointed into `folder_sync_state` (retries resume; fresh
  jobs never honor stale checkpoints), per-account serialization, extended
  dedup + dirty-flag trailing re-enqueue, per-thread concurrency **3 — do
  not raise**. Sent-folder repeatable fixed old bug #2; the /rpc one-shot
  reconnect-retry closed old bug #1 (E2E `drop-recover` leg guards it).
  `send-email` delayed jobs ride the outbox row (12h split gone); sweeps:
  outbox-reconcile + unsnooze (snooze actually works now). Bull Board:
  `node scripts/bull-board.mjs` (:8793, unbundled on purpose).

- **Phase 5 (closed 2026-07-26)**: realtime + chat, agents SDK fully gone.
  Beacons: `publishBeacon` (Upstash REST, workerd-safe) → Redis pub/sub →
  Node-only SSE relay at **GET /realtime/:connectionId** (`src/node/
  realtime.ts`, registered from entry.ts — NOT /api, the tRPC catch-all
  would eat late-registered /api paths). Chat: **POST /api/chat/
  :connectionId** (`routes/chat.ts`, registered inside the /api chain
  before the catch-all). Both routes enforce real ownership auth (401/403,
  missing≡not-owned). Client: `useRealtimeBeacons` (EventSource,
  predicate-based invalidations, blanket invalidation on reconnect) +
  `useChat`; BulkDelete is HITL approval-gated end to end. Publish only
  AFTER the awaited write (audit list in MIGRATION-PLAN 5.1 entry).
  `createDb` no-ops `end()` on the shared pg pool — never "fix" callers
  to close it. E2E: `scripts/e2e-realtime.mjs` (15 legs + cleanup) joins
  e2e-mail.mjs as the verification standard; `--real` runs self-clean
  their messages (mailbox bloat slows syncs and flakes windows).
  Accepted regression (user-approved): no cross-tab live chat mid-stream.
  Known env constraint: the ws.re.cx LLM proxy BUFFERS SSE — chat arrives
  as one burst; fixing that proxy is outside this repo.

- **Phase 6 — hardening/cutover, IN PROGRESS.** Order (confirmed with user,
  correctness before speed): 6.1 UIDVALIDITY guard → 6.2 incremental ladder
  → 6.3 connection-discipline audit → 6.4 workerd deletion + repo hygiene →
  6.5 fresh-mailbox resync drill — **ALL DONE. PHASE 6 IS CLOSED; the
  migration is complete.** What remains is deployment/ops (real TLS cert on
  the mail server, ws.re.cx SSE buffering, model choice for chat) and the
  paused rebrand — product decisions, not migration work.
  - **6.1 (closed)**: `MailManager.getFolderState` (optional; IMAP driver +
    proxy implement it) + `syncFolderJob` compares server `uidValidity` to
    `folder_sync_state` before every sync. On change: purge folder-labeled
    threads + blobs (stale blobs encode the OLD validity+UID — the
    corruption vector), wipe cached cursors, persist new validity BEFORE
    syncing, full resync. Flap cap: `resync_count` column (migration 0042),
    ≥3 consecutive validity resyncs fail loudly instead of looping, ages out
    after 1h quiet. E2E leg `uidvalidity-guard` (GreenMail restart = a real
    validity change + mailbox swap).
  - **6.2 (closed)**: `fetchFolderDelta` ladder — `condstore` rung (FETCH
    CHANGEDSINCE; QRESYNC-advertising servers run this rung too — imapflow
    has no QRESYNC SELECT/VANISHED, so deletions on BOTH rungs use a uid-only
    presence scan) and `uid-diff` floor (uidNext delta + bounded flags
    sweep). New `folder_message` UID→thread ledger (migration 0043, window-
    bounded — deletion attribution is impossible without it) + `sync_mode`
    column. Guard trip clears ladder cursors AND ledger; `forceReSync` resets
    both with the index. **Two real defects the equivalence oracle caught
    before merge**: (1) `upsertThread` label writes were ADD-ONLY — UNREAD
    could never clear after a `\Seen` flip on ANY sync path, fixed by
    replacing tag-derived labels from fresh flags; (2) driver multi-command
    sequences weren't atomic vs mailbox selection — concurrent `/rpc` callers
    interleaved SELECTs on the shared connection, corrupting deletion
    detection — fixed with `withDriverLock` (whole methods serialize per
    cached driver in `src/worker/core.ts`). E2E: `incremental-equivalence`
    (the gate — snapshot-identical incremental vs from-scratch resync on
    BOTH rungs, deletions included) + `ladder-mode` (asserts the rung matches
    server capabilities). Speed logged not asserted: m.re.cx steady-state
    0.5–7 s vs 60–280 s full-refetch; `--real` E2E windows tightened
    240 s→120 s in a separate confirming commit after the equivalence legs
    were green.
  - **6.3 (closed)**: per-account socket census in the worker
    (`src/worker/socket-census.ts`, worker `GET /census`, secret-guarded) —
    every IMAP/SMTP socket counted per account from connection attempt to
    close. Design ceiling **2 concurrent IMAP sockets per account** (1
    cached driver + 1 IDLE watcher), ASSERTED by standing legs in BOTH
    suites: `census-ceiling` (last leg, max-since-boot ≤ 2 for every
    account), `census-discipline` (the 6.2 interleave shape — 10 concurrent
    mixed-folder /rpc + sync jobs + api calls — bounded wall-clock, no
    stall, ceiling held: 3.2 lease + 4.2 job serialization + method lock
    compose), `census-login-churn` (2 re-logins → watcher opens +0, driver
    opens +0). Login churn fixed: cache key + watcher credDigest digest the
    DECRYPTED password now (ciphertext digests churned the watcher AND
    orphaned the cached driver's socket on every login). Seams closed: the
    6.2 method lock widened to per-ACCOUNT with `driverFor` inside it;
    watcher restarts await predecessor logout; evictions awaited via a
    disposing map. Fixed in-flight: `forceReSync` now records cursor+ledger
    at completion (was: wiped sync state and never re-recorded — raced job
    syncs' cursor writes, forfeited the ladder after every forceSync);
    incremental vanish no longer deletes TRASH/BIN/SPAM-labeled threads
    (driver member-folder search can't see trash — an index-side-binned
    thread would silently leave the Bin view); e2e-realtime now converges
    the index (sync + wait) before picking mutation victims — e2e-mail's
    out-of-band cleanup deletions left ghost threads a leg then mutated.
    Real-run census: driver opens=1, watcher opens=1 over a full --real
    e2e-mail run.
  - **6.4 (closed)**: the workerd/Cloudflare path is GONE. Deleted:
    wrangler.jsonc (both apps) + wrangler deps + worker-configuration.d.ts,
    DO shells (ZeroDB/ZeroDriver/ShardRegistry/WorkflowRunner/
    ThreadSyncWorker), the SyncThreads* CF workflow classes + the CF
    workflow engine (thread-workflow-utils, except live workflow-utils.ts),
    the workerd `Entry` class, pipelines.ts (getPromptName moved to
    lib/prompts.ts), routes/agent/db (durable-sqlite leftovers), the legacy
    imap-sidecar/ wrapper, cf-shim + build-time cloudflare:* aliasing (src/
    env.ts now loads defaults + .dev.vars into process.env itself), the
    mail app's @cloudflare/vite-plugin (SPA mode — plain vite). Live-site
    conversions: env.HYPERDRIVE.connectionString → env.DATABASE_URL (15
    sites); send_email_queue binding → lib/send-queue.ts (worker
    /enqueue-send); subscribe_queue/thread_queue → documented dormant-Gmail
    no-op logs (mapping comments at the sites, plan in MIGRATION-PLAN §3);
    blob-store fs-only; getConnInfo from @hono/node-server (rate-limit IPs
    are real now, were 'no-ip' under the CF import); Intercom token signed
    with jose. KEPT on purpose: Gmail driver + /a8n/notify webhook
    (documented future-Gmail-push mapping), @tsndr/cloudflare-worker-jwt
    inside google-subscription.factory.ts only (runtime-agnostic lib, part
    of the dormant Gmail path). Both logins verified immediately after the
    deletion compiled, before anything else.
  - **6.5 (planned)**: fresh-mailbox resync drill — wipe Postgres index/blobs,
    boot worker+api from nothing, full resync from m.re.cx, both suites
    green, timings recorded. Live proof of "no data migration needed."
  - **RESOLVED 2026-07-31 — `idle-push` on `--real`. There was never anything
    wrong with the server or the watcher.** Recorded because four wrong
    diagnoses were written down before the right one, and two of them nearly
    became work items:
      1. "VPN NAT timeout kills the IDLE connection" — wrong.
      2. "Aged IDLE connections stop receiving" — wrong; an APPEND to a
         watcher idling for many minutes notified in 2.1s.
      3. "The mail server does not notify IDLE listeners for SMTP-delivered
         mail; needs LMTP/LDA notify config" — wrong, and this one would have
         sent someone to audit `mailbox_transport` / `mail_plugins` on a
         correctly-configured server. A controlled SMTP send notified
         immediately.
      4. Actual cause: `list-sort` and `derived-vs-stored-threadId` dated
         their fixtures **2030-01-01**, and cleanup was skipped whenever any
         leg failed. Survivors permanently occupied the top 8 of every
         newest-first list; `subjectInInbox` scans only the first 8; so the
         new message arrived (3-4s, verified by INTERNALDATE), synced, and
         sat at position 9 — invisible to the assertion. Self-reinforcing:
         each failure skipped cleanup and poisoned the next run.
    Fixed in the harness: fixtures are past-dated (`hoursAgoHeader`), cleanup
    runs via `{always: true}`, cleanup pages 100 not 20, and a
    `preflight-clean-mailbox` leg aborts loudly if any fixture survives.
  - **OPS PREREQUISITE (not hygiene): the fail2ban allowlist for the deploy
    IP.** The machine's real IP (`103.126.42.2` per the memory notes —
    RE-CONFIRM, it may be dynamic) is banned by the mail server, so `--real`
    can only run over a VPN. That makes the VPN load-bearing for the entire
    regression suite: if it drops mid-run the worker resumes hammering the
    banned address. Separately, 5 watcher restarts were observed in one
    session over the VPN — real churn, though NOT the cause of the
    `idle-push` failure above.
    What it needs, all root on the mail server:
      - `ignoreip` in `/etc/fail2ban/jail.local` under `[DEFAULT]` for the
        deploy egress IP, applied to the `dovecot` and `postfix-sasl` jails;
      - check the ban ACTION too — the observed block hit every port
        including 80/443, so it is all-ports (`iptables-allports` or
        equivalent) and a per-service allowlist alone may not clear it;
      - `fail2ban-client set <jail> unbanip <ip>` to clear the current ban.
      - If the deploy IP is dynamic, an allowlist is the wrong instrument —
        that needs a static egress or a per-account exemption.
  - **Worker has no backoff against a dead endpoint** — 25 consecutive
    retries against a black-holed host in one session. Connection discipline
    asserts socket COUNT, not retry behaviour against an unreachable peer.
    This is what re-triggers the ban.
  - **Classroom rollout note (not a change now): the 29-minute IDLE refresh
    can outlive a home router's NAT timeout.** Students on domestic
    connections may see watcher restarts for this reason. It self-heals — the
    next sync catches anything missed — so it degrades to DELAYED push, not
    lost mail. If push latency matters for the demo, a shorter refresh
    interval is the lever. Note this is a SEPARATE concern from the
    `idle-push` failure above, which is server-side notification and would
    not be fixed by a shorter refresh.
  - **Cutover-readiness realities carried forward, NOT Phase 6 code tasks**:
    the ws.re.cx LLM proxy buffers SSE (chat arrives as one burst regardless
    of our streaming — proven ours delivers progressively; fix is proxy
    config, outside this repo).

    **CORRECTED 2026-07-31** — this used to read "qwen2.5:32b is unreliable at
    multi-step tool chains … model-choice issue, not a repo bug". That was
    wrong in its conclusion and it stopped anyone from testing AI search for
    weeks. Measured directly against ws.re.cx:
      - `tool_choice` omitted / `'auto'` / `'required'` → NO tool call, empty
        content. `'required'` is what the AI SDK's `generateObject` sends, so
        every `generateObject` call against this endpoint fails with "No
        object generated: the tool was not called".
      - `tool_choice: {type:'function', function:{name:…}}` (named) → correct
        tool call with valid JSON arguments.
      - With a NAMED tool_choice but a substantial system prompt (~2.6k chars),
        the model ignores the forced call and returns the answer as plain
        content — and the answer is CORRECT. Only the delivery shape varies.
    So it is a request-shape/prompt-size interaction, NOT a model capability
    limit, and it IS actionable in this repo. `ai/search.ts` now uses
    `generateText` + a named `toolChoice` and accepts a bare text answer as a
    fallback; AI search passes end to end.

    Chat (`routes/chat.ts`) uses `streamText` with `tools` and NO `toolChoice`
    (auto) plus a large system prompt — a superset of the failing conditions
    above, so the same behaviour very likely explains "narrates instead of
    calling" there. Chat legitimately needs auto tool choice (the model must
    pick), so the search fix does not transfer. NOT yet scoped or fixed.

## How to run / verify (Windows, Node 22)

### Full local start, in order (GreenMail — no real mail server touched)
```bash
# 1. Datastores: Postgres 5432, Valkey 6379, Upstash-REST proxy 8079
pnpm docker:db:up                                  # repo root

# 2. GreenMail test mail server (NOT in the compose file — standalone)
docker start greenmail-test || docker run -d --name greenmail-test \
  -p 3025:3025 -p 3143:3143 \
  -e GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled' \
  greenmail/standalone:2.1.3

# 3. Schema (drizzle.config.ts reads process.env.DATABASE_URL DIRECTLY —
#    it does NOT load .dev.vars/.env, so export it for this command)
cd apps/server
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/zerodotemail" pnpm db:migrate

# 4. Build both bundles, then WORKER FIRST (owns every IMAP socket)
pnpm build:node                                    # -> dist-node/{server,worker}.mjs
pnpm worker                                        # :8791 — leave running
pnpm dev                                           # :8787 — separate terminal (rebuilds + serves)

# 5. Client
cd ../mail && pnpm dev                             # :3000
```
`pnpm go` / `pnpm dev` at the repo root do NOT start the worker (turbo's
dev pipeline covers api + client only) — start `pnpm worker` yourself or
mail never syncs. Kill stale listeners on 8787/8791 before restarting; a
stale process answering /health has masked real failures before.

**The login form defaults to the REAL server**, not GreenMail:
`IMAP_DEFAULT_*` in `.dev.vars` point at m.re.cx. For a GreenMail-only
session, type the overrides in the login form (host `127.0.0.1`, IMAP
3143 / SMTP 3025, any credentials — auth is disabled) or repoint
`IMAP_DEFAULT_*`. Only the E2E scripts default to GreenMail.

**Env sources** (both gitignored, same key set): `apps/server/.dev.vars`
is read by `src/env.ts` for the **api**; repo-root `.env` is what the
**worker** loads (`src/worker/index.ts`, when `IMAP_SIDECAR_SECRET` is
absent from the environment) — keep the two in sync. `apps/mail/.env`
supplies the client's `VITE_PUBLIC_BACKEND_URL`. Worker-critical keys:
`IMAP_SIDECAR_SECRET`, `IMAP_ENCRYPTION_KEY`, `DATABASE_URL`, `REDIS_URL`,
`REDIS_TOKEN` (+ `QUEUE_REDIS_URL`, defaulted to redis://127.0.0.1:6379).

### Verify
- **E2E (the verification standard)**: `node scripts/e2e-mail.mjs`
  (GreenMail) and `--real` (m.re.cx; it ban-probes first). All legs must be
  green after every change. Regression test:
  `npx vitest run --config vitest.integration.config.ts`.
- tsc baselines (must not increase): **server 7, mail 36**. Both apps have
  pre-existing upstream errors — judge by delta, not by zero.
  ```bash
  cd apps/server && npx tsc --noEmit                       # expect 7
  cd apps/mail && rm -f tsconfig.tsbuildinfo && \
    pnpm tsc --project tsconfig.json --noEmit              # expect 36
  ```
  **Delete `tsconfig.tsbuildinfo` first for the mail app** or tsc runs
  incrementally and reports only re-checked files (36 became a misleading
  "36" that happened to match, and an earlier incremental run showed a
  different subset). Count with `| grep -c "error TS"`.
  Mail was documented as 231 through 2026-07-31; the real number moved to 36
  during the search work (last apps/mail commit 3802a845) and the doc was
  simply stale. Re-verified non-incrementally at that date.
- E2E realtime/chat: `node scripts/e2e-realtime.mjs` (and `--real`) —
  same green/red standard as e2e-mail.mjs.
- The standard is Node build + boot + both suites green (wrangler dry-run
  retired at 6.4 — there is no workerd path anymore).
- Both login paths must keep working: Google OAuth (URL generation; full
  flow blocked on a Google-console redirect_uri fix) AND Custom IMAP/SMTP.
  Gmail *sync* pipeline is dormant — never delete Google login code.
- pnpm installs need: `npx -y pnpm@10.15.0 --store-dir "D:\.pnpm-store\v10"
  --filter <pkg> add ...`
- Pre-commit hook = `oxlint --deny-warnings`: keep lint clean; prefer hand
  edits over scripted find-replace (two scripted over-matches caused real
  damage on 2026-07-25 — tools.ts had to be restored from git + the
  pre-damage esbuild bundle).
- GreenMail fixture: docker `greenmail-test` (IMAP 3143 / SMTP 3025, accepts
  any credentials). Compose: Postgres 5432, Valkey 6379, Upstash proxy 8079.
- Local infra creds/env: `apps/server/.dev.vars` (gitignored; src/env.ts
  merges local defaults + .dev.vars + process.env and mirrors the result
  into process.env at module load).

## Working agreements (user-set, standing)
- Work sub-step by sub-step; **report after each sub-step and hold** for go.
- Run the E2E script after each step, not just at the end.
- Assert on specifics (label membership, message arrival), never bare counts.
- **Assert what the code controls (ordering, precision at a fixed page size),
  not what the mailbox happens to contain.** Set-equality against a live
  mailbox produced two false reds in one session: a broad filter's page
  membership depends on how many messages the mailbox holds, which the code
  does not decide. Pin `maxResults` and assert ordering/precision there;
  assert recall separately and do not claim anything about extras.
- **Read the assertion before theorising about the mechanism. A leg that
  fails is telling you what it CHECKED failed, not what you assume it
  tests.** `idle-push` produced four wrong diagnoses (VPN, connection age,
  server notify config, twice nearly written up as ops work) because every
  one of them explained why *push* might fail — while the leg never asserted
  push. It asserted "appears in the first 8 threads of the inbox list", and
  the message was at position 9 behind future-dated junk. Push was working
  the whole time.
- A test that passes against the broken code is worse than no test. Prove a
  new regression leg goes RED on the pre-fix build before trusting it — two
  legs this session (`list-sort`, the first ordering guard) passed against
  the very defect they were written for, one because the fixture happened to
  give the correct answer the lowest UID, one because its page size never
  triggered the slice.
- Commit + push on `path-b-migration` at each phase close.
- Memory files in `C:\Users\Abishek\.claude\projects\D--email-client\memory\`
  hold deployment/server details (fail2ban history, endpoints) — the
  Path C-era framing in older ones is superseded by this file.
