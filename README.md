# AxMail — self-hosted email client

A self-hosted email client for a small classroom deployment (~20 users),
forked from [Zero / Mail Zero](https://github.com/Mail-0/Zero) (MIT — see
`LICENSE`) and ported off Cloudflare onto a plain, self-hostable Node stack.
The original upstream README is preserved in git history; the full port plan
and progress log live in `MIGRATION-PLAN.md`.

## Stack

- **API server** (`apps/server`): Hono on Node 22 (esbuild bundle), tRPC,
  better-auth (Google OAuth + Custom IMAP/SMTP logins), HTTP-streaming AI
  chat, SSE realtime beacons.
- **Mail worker** (`apps/server/src/worker`): the deployment's ONLY IMAP
  sockets — driver cache serving `/rpc`, IMAP IDLE watchers under a Redis
  leader lease, BullMQ job processors (sync / send / sweeps), per-account
  socket census with an asserted ≤2-connections-per-account ceiling.
- **Web client** (`apps/mail`): React Router SPA (Vite), talks to the API
  server; realtime via EventSource.
- **Storage**: PostgreSQL (mail index, auth, outbox, sync cursors), Valkey/
  Redis (queues, leader lease, ephemeral stores), local disk under
  `apps/server/data/` (thread blobs).
- **AI**: any OpenAI-compatible endpoint (`OPENAI_BASE_URL`), self-hosted
  LLM friendly.

## Running (dev)

Infra (Docker): Postgres :5432, Valkey :6379, Upstash-proxy :8079, and the
GreenMail test mail server (IMAP :3143 / SMTP :3025, accepts any
credentials) for fail2ban-safe testing.

```bash
# from apps/server — build both bundles, then boot (worker FIRST):
node src/node/build.mjs
node dist-node/worker.mjs     # :8791 — owns all IMAP sockets
node dist-node/server.mjs     # :8787 — API

# from apps/mail:
pnpm dev                      # :3000 — web client
```

Secrets/config: `apps/server/.dev.vars` (gitignored dotenv, merged with
process.env by `src/env.ts`).

## Verification standard

```bash
node scripts/e2e-mail.mjs        # GreenMail;  --real for the live server
node scripts/e2e-realtime.mjs    # GreenMail;  --real for the live server
npx vitest run --config vitest.integration.config.ts
pnpm --filter @zero/testing test # unit suite
```

All legs green on both backends is the bar for every change; `tsc --noEmit`
error counts must not rise above the recorded floors (see `CLAUDE.md`).
