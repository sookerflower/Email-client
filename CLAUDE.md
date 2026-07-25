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

### Next: Phase 4 — BullMQ (needs user go before starting)
Per MIGRATION-PLAN.md §3/§4: `sync-folder` jobs (deterministic jobId +
debounce, page checkpointing into `folder_sync_state`, bounded concurrency
**3 — do not raise**), outbox-backed `send-email` delayed jobs + undo,
unsnooze sweep, repeatables replacing the cron handler. Also fold in: a
one-shot reconnect-retry in the worker driver cache (transient post-APPEND
`Command failed` seen on m.re.cx — old bug #1's failure class). Then Phase 5
(SSE + HTTP chat replacing the agents-SDK WS; broadcasts are currently a
logged no-op hook in MailEngine), Phase 6 (hardening/cutover).

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
- tsc baselines (must not increase): **server 28, mail 257**
  (`npx tsc --noEmit`, count `error TS` lines; both apps have pre-existing
  errors — judge by delta).
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
