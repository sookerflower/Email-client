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
  - **Cutover-readiness realities carried forward, NOT Phase 6 code tasks**:
    the ws.re.cx LLM proxy buffers SSE (chat arrives as one burst regardless
    of our streaming — proven ours delivers progressively; fix is proxy
    config, outside this repo); qwen2.5:32b is unreliable at multi-step tool
    chains (sometimes narrates a tool call as text instead of making it —
    model-choice issue, not a repo bug). Both belong on an ops checklist, not
    in code.

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
- tsc baselines (must not increase): **server 7, mail 231** (re-baselined at
  6.4 close after the CF types left the tree; `npx tsc --noEmit`, count
  `error TS` lines; both apps have pre-existing upstream errors — judge by
  delta).
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
- Commit + push on `path-b-migration` at each phase close.
- Memory files in `C:\Users\Abishek\.claude\projects\D--email-client\memory\`
  hold deployment/server details (fail2ban history, endpoints) — the
  Path C-era framing in older ones is superseded by this file.
