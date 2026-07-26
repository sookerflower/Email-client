# Project: Self-hosted email client for a ~20-person classroom deployment

## Current status (as of 2026-07-25) — READ THIS FIRST

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

### Next: Phase 6 — hardening/cutover (needs user go before starting)
UIDVALIDITY guard + CONDSTORE/QRESYNC incremental-sync ladder (the 2–4 min
full-refetch syncs are the one big UX cost left; E2E `--real` windows are
240 s because of them), connection-discipline audit against the real
server, dead-code sweep (remaining empty DO shells ZeroDB/ZeroDriver/
ShardRegistry + WorkflowRunner/ThreadSyncWorker/workflows and the workerd
path at cutover), repo hygiene, fresh-mailbox resync drill.

## How to run / verify (Windows, Node 22)
- Build both bundles: `node src/node/build.mjs` (from `apps/server`).
- Run: `node dist-node/worker.mjs` (port 8791, MUST be up first — owns IMAP)
  then `node dist-node/server.mjs` (port 8787). Kill stale listeners on
  8787/8791 before restarting; a stale process answering /health has masked
  real failures before.
- **E2E (the verification standard)**: `node scripts/e2e-mail.mjs`
  (GreenMail) and `--real` (m.re.cx; it ban-probes first). All legs must be
  green after every change. Regression test:
  `npx vitest run --config vitest.integration.config.ts`.
- tsc baselines (must not increase): **server 27, mail 251** (as of Phase
  5 close; `npx tsc --noEmit`, count `error TS` lines; both apps have
  pre-existing errors — judge by delta).
- E2E realtime/chat: `node scripts/e2e-realtime.mjs` (and `--real`) —
  same green/red standard as e2e-mail.mjs.
- `npx wrangler deploy --dry-run --outdir /tmp/wc --env local` must build.
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
- Local infra creds/env: `apps/server/.dev.vars` (gitignored; cf-shim merges
  it + wrangler local vars + process.env, and mirrors into process.env).

## Working agreements (user-set, standing)
- Work sub-step by sub-step; **report after each sub-step and hold** for go.
- Run the E2E script after each step, not just at the end.
- Assert on specifics (label membership, message arrival), never bare counts.
- Commit + push on `path-b-migration` at each phase close.
- Memory files in `C:\Users\Abishek\.claude\projects\D--email-client\memory\`
  hold deployment/server details (fail2ban history, endpoints) — the
  Path C-era framing in older ones is superseded by this file.
