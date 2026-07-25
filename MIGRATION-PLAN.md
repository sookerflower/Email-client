# Path B Migration Plan — De-Cloudflaring Email-client (Mail Zero fork)

**Date:** 2026-07-24
**Decision:** Port `Email-client/` off Cloudflare primitives onto Node.js + Postgres + Redis + BullMQ + (disk|MinIO). Plan only — no code written yet.
**Scale target:** ~20-person classroom, single host, self-signed-cert IMAP server (`m.re.cx`).

**Hard constraint (both login methods must survive the port).** The app has two independent, side-by-side login paths built earlier and both MUST keep working through every phase: (1) **Google OAuth** (`socialProviders`/`getSocialProviders`, OAuth-only `connectionHandlerHook`, `auth.ts:161-329`) and (2) **Custom IMAP/SMTP** (`imapAuthPlugin()`, `POST /api/auth/sign-in/imap`, no `account` row, `auth-imap-plugin.ts`). Where this plan calls the **Gmail path "dormant,"** that refers *only* to the Gmail push/sync pipeline (`WorkflowRunner`/`thread-queue`/history processing, gated by `DISABLE_WORKFLOWS`) — a **sync** mechanism, deprioritized until the known `redirect_uri_mismatch` OAuth fix. It does **not** mean Google *login* is removed or disabled: Google OAuth login, the `google` social provider, `GoogleMailManager`, and `connectionHandlerHook` all stay wired and functional. No Gmail code is deleted — only deprioritized. Phase 0's "auth up on Node" means BOTH paths boot on the Node entrypoint.

This plan is based on a full file-level inventory of the codebase (six exploration passes, file:line cited throughout) and a research memo on production mail-system architecture (RFC 7162/8620, Nylas sync-engine, Mailspring-Sync, K-9/Thunderbird, Dovecot, Fastmail/Cyrus/JMAP, WildDuck, Stalwart, BullMQ dedup, Kleppmann on distributed locking). Sources are cited inline where a design choice leans on them.

---

## 0. Findings that reshape the plan (read first)

Three discoveries materially change the migration's shape vs. what we assumed:

1. **ZeroDB is already Postgres.** The `ZeroDB` DO never touches DO storage — every method delegates to external Postgres via Hyperdrive (`apps/server/src/main.ts:216-219`; wrangler migration registers it as a plain DO, not `new_sqlite_classes`, `wrangler.jsonc:124-127`). "ZeroDB → Postgres" is therefore *deleting an RPC wrapper*, not a data migration. The real DO-resident data lives in `ZeroDriver` (per-shard SQLite thread index), `ShardRegistry`, and `ZeroAgent` (chat messages table).

2. **The whole sharding subsystem exists only to dodge DO SQLite's size cap.** `ZeroDriver` is keyed `connection:{connectionId}:shard:{uuid}`; `ShardRegistry` + `getActiveShardId` (`server-utils.ts:315-346`) pick the smallest shard under 8 GiB (`MAX_SHARD_SIZE`, `server-utils.ts:17`) and the Effect aggregators (`server-utils.ts:92-259`) fan out/race queries across shards. Postgres has no such cap → **the registry, shard selection, dormroom addressing, and all aggregation/racing code get deleted, not ported.** This removes one of the nastiest concurrency risks (duplicate-shard creation race) by construction.

3. **The realtime layer is smaller than it looks.** The `agents` SDK WebSocket is the only realtime channel, and it carries exactly two things: (a) an AI-chat protocol that is a thin WS wrapper around a Vercel AI SDK data-stream `Response` the server *already produces* (`getDataStreamResponse`, `routes/agent/index.ts:1752-1809` — then manually re-pumped over WS at `:1973-1994` because DOs can't return streaming HTTP to the client), and (b) five invalidation/beacon message types (`Mail_List`, `Mail_Get`, `User_Topics`, `Do_State`, chat frames). The SDK's state-sync feature is unused; chat history is persisted but never loaded (`getInitialMessages: async()=>[]`, `ai-sidebar.tsx:393`). On Node we can return the streaming Response directly over HTTP and move beacons to SSE — both are *simplifications*, and both match how production systems do it (JMAP push = SSE invalidation tokens, RFC 8620; Vercel AI SDK's native transport is HTTP streaming).

Also load-bearing: the **IMAP sidecar already is the seed of the new backend.** `apps/server/imap-sidecar/server.ts` is a plain Node process holding the real `ImapSmtpMailManager` (imapflow/nodemailer), the IDLE watchers, debounced notify, and credential decryption. The workerd app already talks to it over localhost HTTP RPC (`imap-proxy.ts:25-238`). The port keeps that RPC boundary and grows the sidecar into the worker process.

### Target topology

```
┌────────────────────────────┐      ┌─────────────────────────────────┐
│  api (Node)                │      │  worker (Node)                  │
│  Hono + tRPC + better-auth │      │  BullMQ workers                 │
│  POST /api/chat (AI stream)│      │  ImapSmtpMailManager (in-proc)  │
│  GET  /api/realtime (SSE)  │      │  IMAP IDLE watchers             │
│  driver ops → worker /rpc  │      │  /rpc (absorbed sidecar API)    │
└──────┬──────────┬──────────┘      └──────┬──────────┬───────────────┘
       │          │                        │          │
   Postgres     Redis  ◄── pub/sub beacons, BullMQ, locks, caches
   (all durable state)      │
       │                    │
   BlobStore (local disk now; MinIO/S3 interface for later)
```

Two entrypoints, one codebase. At classroom scale they can run as one process; the split exists so IMAP connection ownership is unambiguous (see §2, connection discipline).

---

## 1. Data layer: ZeroDB → Postgres

### What actually moves

**Nothing moves for ZeroDB itself** — it's already Postgres (`mail0_*` schema, 17 tables, drizzle migrations `0000`–`0039` in `src/db/migrations/`). Work items:

1. **Delete the DO indirection.** Replace `getZeroDB(userId)` (`server-utils.ts:19-23`) with a plain `UserDb` class exposing the same ~30-method surface as `DbRpcDO` (`main.ts:58-213`), backed by a shared postgres-js pool (`src/db/index.ts` already builds one, `max: 20`). All ~30 call sites (trpc routes, `auth.ts`, `notes-manager.ts`, `templates-manager.ts`, `imap-connections.ts`, `auth-imap-plugin.ts`, `driver/utils.ts`) rewire mechanically — same method names, `await` stays.
2. **Replace Hyperdrive with `DATABASE_URL`.** Three direct `createDb(env.HYPERDRIVE.connectionString)` call sites bypass the DO already (`server-utils.ts:646`, `main.ts:1186`, `routes/agent/index.ts:705`) — they all collapse into the shared pool. Stop opening/closing a connection per operation (`setupAuth` opens one per DO init today).
3. **New tables** (drizzle migrations) replacing DO-SQLite and durable KV — defined here, consumed by later pieces:

| New Postgres table | Replaces | Notes |
|---|---|---|
| `thread` (+ `connection_id`) | DO-SQLite `threads` per shard (`routes/agent/db/schema.ts:5`) | PK `(connection_id, thread_id)`; indexed `latest_received_on` for folder listing |
| `label`, `thread_label` | DO-SQLite `labels`, `thread_labels` | unique `(connection_id, thread_id, label_id)` |
| `folder_sync_state` | (new — nothing tracks this today) | `connection_id, folder, uidvalidity, uidnext, highestmodseq, last_synced_at` — groundwork for incremental sync (§9, RFC 7162) |
| `outbox` | KV `pending_emails_status` + `pending_emails_payload` + `scheduled_emails` | full send payload + `status` (`pending/cancelled/sent/failed`) + `send_at` |
| `snooze` | KV `snoozed_emails` | `(thread_id, connection_id, wake_at)` |
| `connection_label_config` | KV `connection_labels` | user AI-labeling config (source of truth) |
| `prompt_override` | KV `prompts_storage` | user prompt customizations (source of truth) |
| `provider_subscription` | KV `subscribed_accounts` + `gmail_sub_age` | Gmail-only; carried for future Gmail support |
| `chat_message` | DO-SQLite `cf_ai_chat_agent_messages` (inside ZeroAgent) | per-connection AI chat history |
| `change_log` (optional, phase 6) | (new) | JMAP-style journal for `/changes`-token sync; see §8 deviation notes |

### Replacing DO single-threading with explicit locking

ZeroDB relies on DO serialization in exactly one place worth fixing:

- **`syncUserMatrix` (`main.ts:482-519`)** — SELECT-then-UPSERT inside a Postgres tx but *without* row locking; under real concurrency two writers race the read (last-writer-wins on the style matrix). Fix: `SELECT … FOR UPDATE` on the `writingStyleMatrix` row inside the existing transaction. One-line change once off the DO.
- Everything else in ZeroDB is single-statement or already transactional (`updateManyNotes` `main.ts:304`, `deleteUser` `main.ts:357`) — safe under concurrent Node processes as-is.

The label read-modify-write patterns in the DO-SQLite layer (`routes/agent/db/index.ts`) need hardening when they land in shared Postgres:
- `updateThreadLabels` (`db/index.ts:207`) does DELETE-all-then-INSERT **without** `onConflictDoNothing` — two concurrent runs → unique violation. Fix: `ON CONFLICT DO NOTHING` on all label inserts + keep the unique constraint as the correctness backstop.
- `addThreadLabels`/`modifyThreadLabels` (`db/index.ts:228/272`) SELECT-existing-then-INSERT-filtered — replace the filter-by-read with plain `INSERT … ON CONFLICT DO NOTHING` (atomic, no read needed).

**Estimate: 3 days** (2 d wrapper deletion + call-site rewiring + FOR UPDATE; 1 d new-table migrations, written here, consumed later).

---

## 2. Mail engine: ZeroDriver + ShardRegistry → Postgres/Redis

### Mapping

| Today | Target |
|---|---|
| `ZeroDriver` DO per `(connection, shard)` (`routes/agent/index.ts:322-1706`) | `MailEngine` plain class per connection, constructed on demand: `getMailEngine(connectionId)` replaces `getZeroAgent()` (`server-utils.ts:348-356`) |
| DO-SQLite `threads/labels/thread_labels` per shard | Postgres tables from §1, keyed by `connection_id` |
| `ShardRegistry` DO + `getActiveShardId` + 8 GiB routing (`server-utils.ts:315-346`) | **Deleted.** No size cap on Postgres |
| Effect shard aggregators/racers (`server-utils.ts:92-259`; `getThread` races shards at `:261-297`) | **Deleted.** Single indexed query |
| dormroom `createClient`/`@Migratable`/`@Queryable`/`Transfer` | **Deleted** (dependency removed) |
| `ThreadSyncWorker` DO (throwaway per call, `sync-worker.ts:9-41`) | Plain `fetchAndStoreThread()` function inside sync jobs, bounded concurrency |
| Driver passthrough methods (~20 methods, `index.ts:631-882`) | Kept verbatim on `MailEngine`, still calling `MailManager` |
| `notifyNewMail` → `triggerSyncWorkflow` (`index.ts:1669-1705`) | Sidecar notify → enqueue BullMQ `sync-folder` job (§3) |
| `getUserTopics` cache in `ctx.storage` (`index.ts:426/568`) | Redis key `topics:{connectionId}` TTL 24 h, generation guarded by `SET NX` lock |
| `recipientCache` in-memory (`index.ts:331-338`) | **Deleted** — `suggestRecipients` becomes an indexed Postgres query (20 users; optionally Redis TTL cache later) |
| `sendDoState` shard sizes/counts (`server-utils.ts:501-539`) | Postgres `count(*)` queries; `shardCount` concept dies (keep the `Do_State` message shape, fill with pg numbers) |
| `inboxRag` via `env.AI.autorag` (`index.ts:1064-1078`) | Already gated off (`AUTORAG_ID=''` locally) — tool returns "Not enabled"; keep the guard, drop the CF call |

### Who owns IMAP connections (the fail2ban lesson)

Production clients strictly separate connection roles and cap per-account connections: Mailspring runs exactly two per account (IDLE + worker); K-9 syncs on a *different* connection than the one IDLEing; Nylas caps connections and halts on resync storms. Our fail2ban ban and the "list fails under connection concurrency" bug are the documented failure mode of ignoring this.

Therefore: **all IMAP sockets live in the worker process, nowhere else.**
- The worker absorbs the sidecar wholesale (`imap-sidecar/server.ts` — driver cache, `watchers` map, `ensureWatcher`, debounce). Sync jobs run in the same process and call the driver **in-process** (no HTTP hop for job work).
- The api process keeps using `ImapSmtpProxyMailManager` (`imap-proxy.ts`) pointing at the worker's `/rpc` — unchanged pattern, so interactive driver ops (send, drafts, attachments) route through the single connection owner. This is deliberately *not* "simplified away": collapsing it into the api process would put IMAP sockets in two processes and recreate the concurrency bug.
- Per-account cap enforced in the worker's driver cache: one IDLE connection + one working connection, with backoff on auth/connect errors.

### Concurrency risks — where DO semantics were silently load-bearing

| Reliance | file:line | Replacement |
|---|---|---|
| `syncThreadsInProgress` in-memory Map dedups per-thread sync | `index.ts:326, 931-958` | BullMQ `jobId: sync-thread:{connectionId}:{threadId}` dedup (efficiency) + **idempotent upsert on PK `(connection_id, thread_id)`** (correctness). Per Kleppmann: locks for efficiency, idempotency for correctness — a rare double-sync wastes IO, corrupts nothing |
| `blockConcurrencyWhile(setupAuth)` init gate | `index.ts:389-391` | Per-process memoized init promise + idempotent `setupAuth`; no cross-process lock needed since nothing global is mutated (driver instances are per-process by design) |
| Lazy singletons `driver/agent/connection` | `index.ts:327-330, 702-716` | Same memoization; the "agent stub" field is replaced by the `publishBeacon()` helper (§8), which is stateless |
| Shard-registry read-modify-write (duplicate shard creation race) | `server-utils.ts:315-346` | **Eliminated** — sharding deleted |
| Topic-cache check-then-put | `index.ts:426/568` | Redis `SET NX EX` generation lock; stale regeneration is benign |
| `syncFolders` `threadCount < maxCount` read-then-act | `index.ts:727-733` | Benign duplicate sync at worst; jobId dedup coalesces |
| Sidecar single-process assumptions (driver cache, watcher registry, `.label-store.json` write chain) | `server.ts:96-136, 148, 62-89` | **Enforce one worker process** (documented invariant + a Redis-held `worker-leader` lease that refuses to start watchers without it). Label store moves from JSON file to Postgres (it's the IMAP `$zl_` label registry) |

**Estimate: 7–9 days** (4–5 d `MailEngine` port + sharding deletion + call-site rewiring across trpc/tools/mcp; 1 d absorbing sidecar into worker entrypoint; 1 d topic/recipient/do-state conversions; 1–2 d tests against the real server — carefully, with connection caps, so we don't re-trigger fail2ban).

---

## 3. Sync: Cloudflare Workflows → BullMQ

### What exists (three "workflow" systems — only one matters for self-host)

1. **CF Workflows** `SyncThreadsCoordinatorWorkflow` → spawns `SyncThreadsWorkflow` per page (`workflows/*.ts`). This is the live IMAP-notify sync path.
2. **`WorkflowRunner` DO** (`pipelines.ts:132`) — hand-rolled Effect pipeline for **Gmail push** history processing. Gated off in self-host config (`DISABLE_WORKFLOWS='true'` locally and in prod, `wrangler.jsonc:178/622`) — **dormant; not ported now** (mapping noted below for future Gmail support).
3. **`WorkflowEngine`** (`thread-workflow-utils/workflow-engine.ts:49`) — in-process AI enrichment step runner (summaries/labels/vectors). Plain TS; runs inside jobs unchanged *if* enrichment is enabled; currently staging-only. Not ported now.

### Job definitions

| Workflow construct | BullMQ equivalent |
|---|---|
| `SyncThreadsCoordinatorWorkflow` + child `SyncThreadsWorkflow` per page | **One `sync-folder` job** (`jobId: sync-folder:{connectionId}:{folder}`, BullMQ *debounce* dedup ~5 s). Internally loops pages sequentially, checkpointing `pageToken`/progress to `folder_sync_state` after each page so a retry resumes, not restarts. The coordinator's poll-child-every-5s loop (`coordinator-workflow.ts:143-165`, non-durable `setTimeout`) disappears — it only existed because CF Workflows can't just… call a function |
| Per-thread fetch inside a page (`Promise.allSettled` over `THREAD_SYNC_WORKER.newUniqueId()`, `sync-threads-workflow.ts:141-184`) | `fetchAndStoreThread()` with bounded concurrency (p-limit ~3) inside the job — the unbounded allSettled is part of what got us banned |
| `step.do` retry semantics (currently: **none configured anywhere**) | Explicit: `attempts: 3, backoff: {type: 'exponential', delay: 30_000}`; **errors rethrown, not swallowed** (today's queue consumers catch-and-swallow, defeating CF retries entirely — `main.ts:999/1070/1109`); failed jobs retained for inspection (Bull Board) |
| No workflow instance IDs → duplicate coordinators per IMAP notify burst (`index.ts:1677`; the deterministic-id fallback is commented out at `:1693`) | Fixed by construction: deterministic `jobId` + debounce. This closes known bug #1's amplification path (notify storm → sync storm → fail2ban) |
| `scheduled()` cron handler (`main.ts:1122-1273`; crons only configured in staging/prod) | BullMQ repeatable jobs: `promote-outbox` (due scheduled sends — actually unnecessary, see §4), `unsnooze-sweep` (hourly; **note: today's unsnooze dispatch is commented out**, `main.ts:1231-1240` — the port should actually fix snooze), `renew-gmail-subscriptions` (skipped until Gmail) |
| Gmail `thread-queue` → `WorkflowRunner.runMainWorkflow` with KV lock `history_{connectionId}__{historyId}` (`pipelines.ts:229-257`) | *(future)* `gmail-history` job, `jobId: history:{connectionId}:{historyId}` — the KV lock becomes the job ID |

**Sent-folder sync (known bug #2):** the sync path only ever pulls `inbox` (`syncFolders` → `triggerSyncWorkflow('inbox')`, notify hardcodes `folder:'inbox'` in the sidecar). The `sync-folder` job is folder-parameterized; the worker schedules periodic `sync-folder:{id}:sent` (and drafts/spam as configured) as repeatable jobs. This fixes bug #2 as a side effect of the port.

**Crash-only rule** (Mailspring): every unit of sync progress commits transactionally to Postgres; killing the worker at any instant must be safe. No sync state lives only in job memory.

**Estimate: 5–6 days** (1 d BullMQ infra + Bull Board + repeatables; 2–3 d `sync-folder` job with checkpointing/dedup/bounded concurrency; 1–2 d wiring notify path + folder scheduling + tests).

---

## 4. Sending: CF Queues → BullMQ

Today's flow (`trpc/routes/mail.ts:457-616`): immediate sends call the driver directly; scheduled/undo sends write payload+status to two KV namespaces, then either KV `scheduled_emails` (>12 h, promoted by hourly cron) or `send_email_queue.send(…, {delaySeconds})` (≤12 h). Consumer (`main.ts:1010-1077`) checks the KV cancellation flag, sends, deletes KV — **and deletes the payload even on failure, silently dropping the email.**

Target — **Postgres outbox + BullMQ delayed jobs**:

1. `mail.send` writes one `outbox` row (full payload, `status='pending'`, `send_at`) and enqueues `send-email` with `jobId: send:{messageId}`, `delay: send_at - now`. BullMQ delayed jobs handle any duration — **the 12-hour KV/cron split disappears entirely.**
2. Undo-send (15 s window, `mail.ts:518`) = same mechanism with `delay: 15_000`. `mail.unsend` sets `outbox.status='cancelled'` **and** removes the delayed job; the job handler re-checks the row status at fire time anyway (belt and braces — the Postgres row is the source of truth, the job is just a timer).
3. Job handler: load outbox row → skip if cancelled → driver send (SMTP via worker in-process driver; `appendToSent` already handled by `imap.ts:696`) → `status='sent'`. On exhausted retries: `status='failed'` + beacon to the UI. Nothing is ever silently dropped.
4. Weekly/startup reconciliation sweep: any `pending` outbox row past `send_at` with no live job gets re-enqueued (covers Redis data loss; Postgres survives).
5. `subscribe-queue` → `gmail-subscribe` queue, ported trivially but disabled until Gmail matters.

**Concurrency notes:** `jobId` dedup prevents double-enqueue; the status check at fire time is a plain row read — add `WHERE status='pending'` guard on the `UPDATE … SET status='sent'` (optimistic; if 0 rows updated, someone cancelled mid-send — log, don't resend).

**Estimate: 2–3 days** including outbox table wiring, undo flow, failure surfacing, reconciliation sweep.

---

## 5. KV (10 namespaces, 28 usages) → Redis *and Postgres*

**Deliberate deviation from the brief:** the instruction says "KV → Redis," but five namespaces are durable sources of truth (user config, sync cursors, scheduled sends). Production systems (Stalwart's four-store model) use Redis strictly for ephemeral state — locks, rate limits, caches — and put durable state in the data store. Redis persistence (RDB/AOF) is weaker and operationally easier to lose than Postgres backups. So: **ephemeral → Redis, durable → Postgres.** Flagged for your sign-off.

| KV namespace | Verdict | Target |
|---|---|---|
| `gmail_processing_threads` (locks + cooldowns, TTL'd) | ephemeral | Redis `SET NX EX` (lock) / `SET EX` (cooldown). Also kills `bulk-delete.ts`'s hardcoded namespace IDs + out-of-band REST calls (`bulk-delete.ts:5-9, 45-51`) |
| `pending_emails_status` / `pending_emails_payload` / `scheduled_emails` | replaced | `outbox` table (§4) |
| `snoozed_emails` | durable | `snooze` table + hourly `unsnooze-sweep` job (§3); the on-access unsnooze check in `listThreads` (`mail.ts:139-157`) becomes a join |
| `connection_labels` | durable (user config) | `connection_label_config` table |
| `prompts_storage` | durable (user config) | `prompt_override` table (read-through seeding logic in `brain.ts:31-33` carries over) |
| `subscribed_accounts` / `gmail_sub_age` | durable, Gmail-only | `provider_subscription` table (dormant until Gmail) |
| `gmail_history_id` | durable sync cursor, Gmail-only | column on `provider_subscription` (or `connection`) |

Only two namespaces use KV `list()` (`scheduled_emails`, `snoozed_emails`, `main.ts:1148/1207`) — both become indexed `WHERE wake_at <= now()` queries, which is strictly better.

**Estimate: 3 days** (mapping is mechanical; the time is in touching every call site and testing snooze/schedule flows end to end).

---

## 6. R2 → local disk (MinIO-ready interface)

`THREADS_BUCKET` stores parsed thread JSON (not raw MIME, not attachments), read/written whole via `.text()` — no presigned URLs, no streaming, no multipart. Fully rebuildable from the IMAP server on miss (`getThreadFromDB` re-syncs when absent, `index.ts:1427`).

1. Define `BlobStore` interface (`get/put/delete(key)`); implement `FsBlobStore` (files under `DATA_DIR/threads/{connectionId}/{threadId}.json`) and leave an `S3BlobStore` stub for MinIO if we ever go multi-node. For 20 users, disk + normal backups wins on operational simplicity.
2. **Fix the key-scheme split while porting:** `ThreadSyncWorker`/`ZeroAgent` use `{connectionId}/{threadId}.json` (`sync-worker.ts:14-16`, `index.ts:905-907`) but the dead `routes/chat.ts` writes without `.json` (`chat.ts:895-897`). `routes/chat.ts` is confirmed dead code (nothing imports it — it contains a stale second copy of ZeroAgent/ZeroMCP) → **delete the file**, standardize on `.json`.
3. **Flagged deviation from production practice:** WildDuck/Stalwart store *raw MIME* blobs (content-hash keyed, dedup'd, refcounted) and treat parsed forms as derived; we store only parsed JSON. Acceptable here because the IMAP server remains the source of truth and blobs are rebuildable — but if a parser bug ever mangles bodies, re-sync is the only fix. Optional later hardening: also write raw RFC 822 bytes alongside. Not in scope now.

**Estimate: 1–2 days.**

---

## 7. Vectorize (20 refs) → **drop it**

Recommendation: **drop, don't port to pgvector.** Evidence from the inventory:

- The only `VECTORIZE.query()` calls — actual semantic search — are **commented out** (`tools.ts:44-106`, `askZeroMailbox`/`askZeroThread`). No live user-facing semantic search exists.
- All vector **writes** happen inside the enrichment workflow, which is gated by `DISABLE_WORKFLOWS` and live **only in staging** (`wrangler.jsonc:178/404/622`). Local/prod have never written a vector.
- Embeddings hardcode Workers AI `@cf/baai/bge-large-en-v1.5` (`pipelines.effect.ts:109-117`, `tools.ts:22-42`), which is **unbound in local config** — these paths already throw today.
- The remaining reads (`getByIds` for summary reuse/dedup + the `generateSummary` tRPC/MCP short-summary, `brain.ts:39`, `mcp.ts:87`) additionally require Workers AI bart summarization — also unbound locally. Dead on arrival in self-host.

Replacement for the one real feature (thread short-summaries): generate via the existing OpenAI-compatible endpoint (`USE_OPENAI` path, `lib/ai-provider`) and store in the **already-existing** `mail0_summary` Postgres table (`db/schema.ts:156` — currently written by nothing in the live path). If semantic search is ever actually wanted, pgvector + the same summary rows is a clean bolt-on later; we lose nothing by deferring.

**Estimate: 1 day** (remove refs behind the existing guards, wire `generateSummary` → LLM → `summary` table).

---

## 8. Realtime + AI chat: `agents` SDK → HTTP streaming + SSE + Redis pub/sub

Highest-risk piece per the brief — but the inventory shrank it substantially (§0 finding 3). The design splits the one WebSocket into two boring, standard channels:

### 8a. AI chat → plain HTTP streaming (Vercel AI SDK native)

**Server:** new Hono route `POST /api/chat/:connectionId`. Body: `{messages, threadId, currentFolder, currentFilter}` (same context the WS frames carry today, `index.ts:1850-1935`). Handler is `getDataStreamResponse` (`index.ts:1752-1809`) **almost verbatim** — `streamText` + `createDataStreamResponse` + `ToolOrchestrator` + `processToolCalls` — except the resulting `Response` is *returned* instead of being chunk-pumped over WS (`reply()`, `index.ts:1973-1994`, is deleted). The entire tool set (`tools.ts:480-514`: getThread, composeEmail, sendEmail, labels, bulkDelete, webSearch, inboxRag, buildGmailSearchQuery, …) carries over — tools already call `getZeroAgent(connectionId)`, which becomes `getMailEngine(connectionId)` per §2.

- **Abort:** HTTP request abort → `AbortSignal` into `streamText`. Strictly better than today (the abort-controller map exists but was never wired into `streamText` — `index.ts:1885` commented out).
- **Streaming tools:** `ToolOrchestrator.mergeIntoDataStream` for webSearch/inboxRag works unchanged — it operates on the data stream, not the transport.
- **Human-in-the-loop approval:** `processToolCalls`/`APPROVAL` (`routes/agent/utils.ts`) is the AI SDK HITL cookbook pattern — designed for HTTP `useChat`; works as-is.
- **Persistence:** `persistMessages` → insert into `chat_message` (Postgres, §1) in `onFinish`. Add `GET /api/chat/:connectionId/history` — optional UI improvement (today history is persisted but never loaded); parity option is to keep returning `[]`.
- **MCP:** `ThinkingMCP`'s single `sequentialthinking` tool is registered **directly in the tool set in-process** (the `SequentialThinkingProcessor` class is plain TS) — the MCP transport indirection is dropped. `ZeroMCP` (external OAuth-protected MCP surface, `/sse` + `/mcp` mounts, `main.ts:791-842`) is **deferred**: it's not consumed by the in-app chat (`registerZeroMCP` is defined but never called, `index.ts:1711`). If external MCP access is wanted later: plain `@modelcontextprotocol/sdk` Streamable-HTTP server on Node reusing `tools.ts` (~2–3 d, not in this plan's critical path).

**Client:** swap `useAgentChat` (`agents/ai-react`) → `useChat` (`@ai-sdk/react`) in `ai-sidebar.tsx:393-464`. `useAgentChat` *is* a wrapper around `useChat` speaking the WS protocol, so the returned surface (`messages` with `parts`, `status`, `stop`, `setMessages`, `addToolResult`, `onToolCall`, `onResponse`) is the same contract `ai-chat.tsx` already renders — tool-invocation parts, `<thread id>` placeholders, markdown streaming all unchanged. New-chat = `setMessages([])` + a `DELETE /api/chat/:connectionId` (replaces `cf_agent_chat_clear`).

**Accepted regression (flagged):** today, chat requests are broadcast to other tabs of the same mailbox (`ChatMessages` frames). With per-request HTTP chat, a second tab won't see a live chat mid-stream (it will on next history load, if we add it). For a classroom single-tab UX this is acceptable; if not, a `chat-updated` beacon (§8b) restores cross-tab refresh cheaply.

### 8b. Mail invalidation beacons → SSE + Redis pub/sub

This is the JMAP/WildDuck pattern verbatim: **durable state in the DB, ephemeral "something changed" ping over pub/sub, client refetches on ping**. Lost pings cost latency, never correctness — which is exactly how the current client already behaves (beacons trigger React Query invalidations; data always flows over tRPC).

**Server:**
- `publishBeacon(connectionId, msg)` helper → Redis `PUBLISH beacon:{connectionId} {json}`. Replaces every `this.agent?.broadcastChatMessage(...)` / `ZeroDriver.broadcast` call site (`reloadFolder` `index.ts:918-923`, thread-sync completion `:1012-1016`, label changes `:1403-1408`, delete/draft paths `:888/:912`, topics `:585`, `sendDoState` `server-utils.ts:501-539`, IMAP notify chain). **Publish after commit** — Redis pub/sub has no transactional tie-in, so beacons fire only once the Postgres write is visible (the race this prevents: client refetches before the row exists, renders stale, never refetches again).
- `GET /api/realtime/:connectionId` (SSE): auth via better-auth session cookie **+ an ownership check that the session's user owns the connection** — fixing today's hole where `onBeforeConnect` only checks a Cookie header exists (`main.ts:848-852`). Subscribes to the Redis channel, relays messages as SSE events, heartbeats every ~25 s (proxies kill idle SSE).
- Message payloads: keep the existing five type shapes (`party.tsx` enums) so client handling code is unchanged.
- Fan-in works from any process: worker jobs publish to Redis; whichever api instance holds the SSE connection relays. This replaces the `getZeroSocketAgent` DO-stub fan-in with infrastructure that doesn't care about process boundaries.

**Client:** replace `useAgent` (`ai-sidebar.tsx:385-391`) with a ~50-line `useRealtimeBeacons(connectionId)` hook wrapping `EventSource`: auto-reconnect (native to SSE), and **on reconnect fire one blanket invalidation** of the active folder queries (covers beacons missed while disconnected — the JMAP "resync on reconnect" discipline). The `onMessage` body (`ai-sidebar.tsx:351-383`) — React Query invalidations per message type, `Do_State` → jotai — moves over unchanged.

**Why SSE over WebSocket** (flagged reasoning, since this deviates from the current app): the channel is now strictly server→client (chat no longer needs client→server frames); SSE auto-reconnects natively, traverses proxies better, needs no ws server library, and is what JMAP standardized for exactly this job (RFC 8620 EventSource push; Cyrus implements it). If a bidirectional need appears later, this layer is small enough to swap.

**Deleted:** `agents`, `hono-agents`, `partysocket` deps; `ZeroAgent` class; `agentsMiddleware` mount; `routes/chat.ts` (already dead).

**Risks & mitigations (this piece):**
- *Protocol parity for tool rendering* — mitigated by `useAgentChat`⊃`useChat` (same message/parts model, same AI SDK v4 line on both sides: server `ai@^4.3.13` / client `^4.3.9`). Verify each `ToolResponse` branch (`ai-chat.tsx:188-199`) renders under HTTP streaming during step 17.
- *Multi-tab beacon fan-out* — SSE per tab, Redis pub/sub broadcasts to all subscribers; the current `exclude sender` semantics (WS-specific) are dropped — harmless, invalidations are idempotent.
- *Beacon-before-commit ordering* — enforced by the publish-after-commit rule; add a lint-level convention (publish only via `publishBeacon`, never inside a transaction callback).

**Estimate: 8–10 days** (2–3 d SSE endpoint + Redis pub/sub + `publishBeacon` rewiring; 1–2 d client beacon hook; 2–3 d chat HTTP route + thinking-tool inlining + persistence; 2 d client `useChat` swap + HITL + tool-render verification; buffer for the unknown-unknowns this piece owns).

---

## 9. Research sanity-check: where our design deviates from production practice

Patterns we **adopt** (and where): beacon-not-payload push over SSE (JMAP/WildDuck → §8b); publish-after-commit (→ §8b); crash-only transactional sync (Mailspring → §3); jobId-dedup + debounce for per-account sync with idempotent-upsert correctness and locks-as-efficiency-only (BullMQ docs, Kleppmann → §2/§3); strict IMAP connection-role separation and per-account caps (Mailspring/K-9/Nylas → §2); durable-in-Postgres/ephemeral-in-Redis split (Stalwart → §5); blob store for bodies + relational metadata (WildDuck/Stalwart → §6).

Deviations we **keep, with eyes open**:

1. **Full-refetch sync stays initially.** The current driver re-lists the last N messages per sync — the exact anti-pattern RFC 7162 exists to eliminate (and what Nylas/Mailspring/K-9 all replaced with CONDSTORE/QRESYNC ladders). We keep it for the port (it works today and the port shouldn't change sync semantics and infrastructure simultaneously), but **step 19 adds the `folder_sync_state` table now and the QRESYNC → CONDSTORE → UID-diff capability ladder as the first post-port improvement.** At minimum, the UIDVALIDITY guard (discard cached UIDs on change, cap resync attempts like Nylas) ships in phase 6 — running without it is how clients corrupt their caches.
2. **Parsed-JSON blobs, no raw MIME** (§6) — acceptable because the IMAP server holds the originals; revisit if we ever become the primary store.
3. **Threading stays as-is** — the RFC 5256 grouping in `imap-threading.ts` runs at fetch time in the driver and results persist via `storeThreadInDB`, which is close enough to the "thread at ingest, persist threadId" consensus. A WildDuck-style `{threadId, id-set, normalized-subject}` lookup table is the right shape if threading quality becomes an issue — noted, not scheduled.
4. **No JMAP-style `/changes` endpoint yet.** Our beacons say "refetch folder X," not "here's the delta since token T"; a lost beacon is healed by the reconnect-invalidation rule rather than a state token. At 20 users this is fine (JMAP's model exists for scale and flaky mobile links). The optional `change_log` table (§1) is the upgrade path; not scheduled.
5. **KV→Redis instruction partially overridden** (§5) — durable namespaces go to Postgres instead. Needs your sign-off.

---

## 10. Build order, estimates, and sequencing rationale

Same philosophy as the IMAP work: smallest safest pieces first, each phase leaves the system runnable, riskiest piece (realtime) lands last on a stable base. Estimates are focused working days for one developer with AI assistance, including tests; ranges reflect discovery risk.

| # | Step | Days |
|---|---|---|
| **Phase 0 — Node scaffolding** | | **3–4** |
| 1 | Node entrypoint for the Hono app (`@hono/node-server`), env loader building the `ZeroEnv` shape from `process.env`, `waitUntil` shim (a `MockExecutionContext` already exists, `server-utils.ts:26`), boot with DO-backed features behind a flag. Auth + tRPC health up on Node | 2–3 |
| 2 | docker-compose: Redis added (Postgres exists); MinIO optional/off | 0.5 |
| 3 | Integration-test harness against the Node server (reuse `packages/testing`) | 1 |
| **Phase 1 — Data layer (§1) + dead-SaaS removal** | | **4** |
| 4 | Delete ZeroDB/DbRpcDO → `UserDb`; rewire ~30 call sites; `FOR UPDATE` in syncUserMatrix | 2 |
| 5 | All new-table migrations (thread/label/outbox/snooze/config/chat/folder_sync_state) | 1 |
| 5b | **Remove Autumn (billing) and Sentry entirely** (user-added 2026-07-24): delete deps, routes/autumn.ts + mount, auth.ts beforeDelete Autumn call, AutumnProvider, pricing components, upgrade-nag in add.tsx, all useBilling/isPro refs (features unconditionally available); Sentry tunnel route + client instrumentation. Verification: tsc error counts don't increase (baseline: server 89, mail 321), Node server boots, both login paths work | 1 |
| **Phase 2 — KV + blobs (§5, §6)** | | **3–4** |
| 6 | KV namespace migration (Redis ephemeral / Postgres durable); delete `bulk-delete.ts` path | 2 |
| 7 | `BlobStore` + fs impl; standardize keys; delete dead `routes/chat.ts` | 1–2 |
| **Phase 3 — Mail engine (§2, §7)** | | **7–9** |
| 8 | `MailEngine` replacing ZeroDriver; sharding/dormroom/Effect-aggregator deletion; call-site rewiring | 4–5 |
| 9 | Worker process absorbs sidecar (IDLE watchers, driver cache, `/rpc` kept for api); leader lease | 1 |
| 10 | Vectorize removal; summaries → LLM → `summary` table | 1 |
| 11 | Topic cache → Redis; recipients → SQL; do-state → pg counts | 1 |
| **Phase 4 — Jobs (§3, §4)** | | **5–6** |
| 12 | BullMQ infra, queues, repeatable schedulers, Bull Board | 1 |
| 13 | `sync-folder` job (dedup/debounce, page checkpointing, bounded concurrency, real retries); notify path; **sent-folder sync (fixes bug #2)** | 2–3 |
| 14 | `send-email` job + outbox + undo/scheduled + failure surfacing + reconciliation sweep; unsnooze sweep (fixes dormant snooze) | 2 |
| **Phase 5 — Realtime + chat (§8)** | | **8–10** |
| 15 | SSE endpoint (with real ownership auth) + Redis pub/sub + `publishBeacon` rewiring | 2–3 |
| 16 | Client `useRealtimeBeacons` hook (EventSource + reconnect-invalidate) | 1–2 |
| 17 | Chat HTTP route (port `getDataStreamResponse`), thinking tool inlined, persistence | 2–3 |
| 18 | Client `useChat` swap, HITL, tool-render verification | 2 |
| **Phase 6 — Hardening + cutover** | | **4–6** |
| 19 | UIDVALIDITY guard + `folder_sync_state` wiring; CONDSTORE/QRESYNC ladder if time allows (else first post-port task) | 2–3 |
| 20 | Connection-discipline audit: caps, role separation, backoff — validated against the real server without tripping fail2ban | 1 |
| 21 | E2E on `m.re.cx`, fresh mailbox resync (no mail-data migration needed — IMAP is source of truth; Postgres user/auth rows carry over unchanged), dead-code + wrangler/dep removal | 1–2 |
| **Total** | | **≈ 33–42 days (~7–8.5 weeks)** |

**Sequencing rationale:** Phases 0–2 are low-risk and independently verifiable (app boots on Node, data reads/writes work) before anything touches mail flow. Phase 3 is the biggest single chunk but is mostly *deletion* (sharding) plus mechanical rewiring, and the sidecar — the one battle-tested Node component — anchors it. Phase 4 changes *when* things run, not *what* runs, on top of an engine already proven in Phase 3. Phase 5 (the flagged highest-risk piece) then lands on a fully working backend, so any regression is unambiguously the transport's fault. Phase 6 pays down the two known bugs' root causes (both are fixed structurally by phases 3–4, but 6 verifies under real-server conditions).

**What is explicitly out of scope:** Gmail/Microsoft push pipelines (code kept, dormant), `ZeroMCP` external MCP surface, `WorkflowEngine` AI enrichment (summaries/autolabel pipeline), pgvector/semantic search, raw-MIME storage, JMAP `/changes` tokens, the AxMail rebrand (separate decision), and any data migration of existing DO-SQLite/R2 contents (a fresh resync from the IMAP server replaces it — cheaper and safer than exporting DO state).

## Progress log

- **2026-07-24 — Phase 0 complete.** Node entrypoint at `apps/server/src/node/entry.ts`; esbuild bundle (`src/node/build.mjs`, aliases `cloudflare:*` → `src/node/cf-shim.mjs`, `.sql` as text) — bundling was chosen over a tsx loader because tsx's hooks break CJS named-export detection (esbuild mirrors wrangler's own semantics). Run: `pnpm dev:node` (port 8787). Verified on Node: `/health`; Google OAuth authorization-URL generation (full flow still gated on the known Google-side `redirect_uri_mismatch` fix); **Custom IMAP/SMTP login end-to-end** (sidecar probe → user + connection in Postgres → session cookie → `get-session`) against a disposable GreenMail container (`greenmail-test`, IMAP 3143/SMTP 3025 — kept for later phases; the real mail server was TCP-unreachable, the pre-existing fail2ban/network condition); authenticated tRPC (`connections.list`) through the Node-branch `getZeroDB` (direct `ZeroDB` instantiation — it's pure Postgres); DO-backed mail routes fail cleanly with `NotPortedError` and the server survives; `wrangler deploy --dry-run` still builds (workerd path unregressed). Redis was already in `docker-compose.db.yaml` (Valkey + Upstash proxy), so Phase 0 step 2 was a no-op. Shim gotcha worth remembering: libraries (better-auth secret resolution) read `process.env` directly, so the shim mirrors merged vars into it — without this, JWKS rows created under workerd fail to decrypt.

- **2026-07-24 — Phase 1 step 5b complete (Autumn + Sentry fully removed).** Deleted: `autumn-js` and `@sentry/*` deps from both apps; server `routes/autumn.ts` + `/autumn` mount, Autumn call in auth `beforeDelete`, `isProCustomer`/pro-gating in `meet.ts`, `AUTUMN_SECRET_KEY` env, Sentry tunnel route; mail `hooks/use-billing.ts`, `components/pricing/` (both files), `pricing-dialog.tsx`, `app/instrument.ts`, `AutumnProvider` wrapper, upgrade-nag blocks (add.tsx, app-sidebar, nav-user, ai-chat, ai-sidebar usage gauge, connections page), Sentry init/handlers in `entry.client.tsx`/`root.tsx`. All features unconditionally available; no billing concept, no third-party monitoring. Verified: tsc error counts vs baseline server 89→87, mail 321→321; Node server rebuilds/boots; GreenMail IMAP login + session + Google OAuth URL generation all pass; `wrangler deploy --dry-run` builds; `react-router build` (apps/mail) succeeds.

- **2026-07-24 — Phase 1 complete (data layer).** `ZeroDB`/`DbRpcDO` (~530 lines) collapsed into plain `UserDb` class (`src/lib/user-db.ts`) on the shared drizzle pool; `getZeroDB()` returns it on both runtimes, so all ~30 call sites needed zero edits; `syncUserMatrix` now takes `SELECT … FOR UPDATE` inside its transaction (the DO's single-thread gate replacement). `ZeroDB` remains as an empty deprecated DO shell in main.ts solely for wrangler binding compat (deleted in Phase 3/6). New-table migration `0040` generated and applied cleanly to local Postgres: `thread`, `label`, `thread_label`, `outbox`, `snooze`, `connection_label_config`, `prompt_override`, `provider_subscription` (incl. Gmail `history_id` cursor), `chat_message`, `folder_sync_state` — all `mail0_*`-prefixed with FKs/indexes. (Two auto-generated FK constraint names exceed Postgres's 63-char limit and were truncated — distinct after truncation, deterministic on fresh DBs; cosmetic only.) Verified: tsc server 87→87, mail 321→321; Node bundle rebuilds/boots; GreenMail IMAP login + session + authenticated tRPC (`connections.list`, exercising UserDb) + Google OAuth URL all pass; `wrangler deploy --dry-run` builds.

- **2026-07-24 — Datadog removed + Phase 2 complete (KV + blobs).** Datadog got the Sentry treatment: `datadog-service`, `logging-service`, `trpc-logging` (the per-procedure Datadog shipper), the `logging` tRPC router, `types/logging`, `DD_*` vars, and the `@datadog/datadog-api-client` dep are gone; tRPC procedures no longer carry the logging middleware (TraceContext self-cleans via TTL, so no leak). **Phase 2a:** all 10 KV namespaces replaced via `src/lib/stores.ts` — ephemeral → Redis (`acquireProcessingLock` is now real SET NX EX; the old KV "lock" never was atomic; resync cooldown likewise), durable → Phase 1 tables (`snoozeStore`, `outboxStore`, `labelConfigStore`, `promptStore`, `subscriptionStore` incl. Gmail historyId cursor). Scheduled/undo-send now rides the `outbox` table as source of truth (statuses pending/queued/cancelled/sent/failed); the consumer no longer deletes payloads on failure (was silently dropping emails); `cleanupOnFailure`'s KV key-format no-op bug fixed. `bulk-delete.ts` (hardcoded namespace IDs + CF REST) deleted along with the `cloudflare` npm dep; KV bindings stripped from env.ts/cf-shim/wrangler.jsonc; worker types regenerated. **Phase 2b:** `src/lib/blob-store.ts` — `BlobStore` interface with `FsBlobStore` (Node, `DATA_DIR/threads`, atomic write-then-rename, path-sanitized keys) and `R2BlobStore` (workerd until cutover); canonical `.json` key via `threadBlobKey`; dead `routes/chat.ts` (stale ZeroAgent/ZeroMCP copies + the divergent no-suffix key scheme) deleted. Verified: tsc server 87→**84**, mail 321→**318** (both below baseline — dead-code deletion took its errors along); migrations state clean; Node boots; GreenMail IMAP login + session + `connections.list` + `brain.getState` (exercises subscriptionStore→Postgres) + Google OAuth URL all pass; wrangler dry-run builds.

- **2026-07-24 — Phase 3.1 complete (MailEngine + sharding deletion).** `MailEngine` (`src/lib/mail-engine.ts`) + Postgres index layer (`src/lib/mail-index.ts`) replace the ZeroDriver DO: ~1,410 lines of DO body deleted (ZeroDriver/ShardRegistry remain as empty shells for wrangler); the dormroom clients, `getActiveShardId`, 8 GiB shard selection, and all Effect aggregators/racers are gone from server-utils; `getZeroAgent` keeps its `{stub}` shape so ~40 call sites compiled through (raw `exec` SQL sites converted to engine methods). Sync is in-process for now (`syncFolderOnce`/`syncThread`, bounded concurrency 3; BullMQ wraps these in Phase 4; broadcasts are a logged no-op hook until Phase 5 SSE). **Latent bug found & fixed:** the DO/workflow sync stored only message tags, never folder membership — IMAP threads never got INBOX labels, so index-backed folder listing could never match; `syncFolderOnce` now passes the folder label into `syncThread`. Verified: tsc server 84→**66**, mail 318→**299** (deleted dead code took its errors); wrangler dry-run builds; both logins pass. **E2E on GreenMail:** send → forceSync → list → get (full body from BlobStore) all pass. **E2E on real m.re.cx (fail2ban ban has lifted; probe confirmed reachable):** login, forceSync (19 threads), get (INBOX+UNREAD labels correct), self-addressed SMTP send, and — critically — the **live IDLE push loop**: sidecar IDLE detected the new message, hit `/api/public/imap-notify`, engine auto-synced (19→20 threads). That is the flow that previously produced known bug #1 (concurrent-list "Command failed" + fail2ban churn), now clean because sync runs through one engine with bounded concurrency.

- **2026-07-25 — Hardening + Phase 3.2 complete (worker absorbs sidecar).** *Hardening:* GreenMail regression test for the 3.1 folder-label bug (`tests/integration/folder-label-regression.test.ts`, `pnpm test:integration`) asserts **label membership** (`thread_label` contains INBOX), proven sensitive by temporarily reverting the fix (fails with `expected ['UNREAD'] to include 'INBOX'`); one-command E2E (`scripts/e2e-mail.mjs`, `--real`/`--skip-idle` flags): probe → login → send → forceSync → list → get (body + INBOX label) → idle-push (raw SMTP, poll count increment, no manual refresh), non-zero exit per leg — run green after every 3.2 step. *3.2 (in the mandated order):* (1) label registry `.label-store.json` → `mail0_imap_label_registry` (migration `0041`; boot-time JSON import path, file renamed `*.migrated`); (2) sidecar logic extracted to `src/worker/core.ts` (shared by the legacy `imap-sidecar` wrapper and the new entrypoint), `src/worker/index.ts` bundled to `dist-node/worker.mjs` (`pnpm worker`); **architecture decision: /rpc is the sole IMAP entry point — the api process never gets a second connection pool**; MailEngine keeps proxying every IMAP op to the worker's single driver cache (sync orchestration stays api-side until Phase 4 jobs); (3) Redis leader lease (`src/worker/leader-lease.ts`: SET NX PX + Lua check-and-expire renew/release, TTL 15s/tick 5s, conservative self-demotion) verified with two instances — single acquisition, renewal past TTL, hard-kill failover in 14s; (4) IDLE watchers gated on the lease with a 5s reconciler, **autonomous watcher bootstrap from Postgres on leadership acquisition** (failover doesn't wait for api traffic), cutover: worker owns :8791, old sidecar retired to a wrapper. Failover with real IDLE: follower held 0 watchers while leader lived, took over and re-established 2/2 idling watchers in 20s — never two concurrent IMAP connections per account. Verified: tsc 66/66 server, 299/299 mail; regression test green; full E2E green through the worker topology; wrangler dry-run builds; both login paths pass.

- **2026-07-25 — Phase 3.3 complete (Vectorize dropped, summaries → Postgres).** Pre-deletion audit confirmed the plan's claim: the only `VECTORIZE.query()` calls were commented out; all vector writes lived in the `DISABLE_WORKFLOWS`-gated enrichment pipeline; the live readers were exactly the summary feature (three copies of the same getByIds+bart pattern: `brain.generateSummary`, ZeroMCP `getThreadSummary`, and the chat `getThreadSummary` tool — one more copy than the Phase 2 inventory listed, in tools.ts). Deleted: both vector workflow definitions + five vector step functions from the enrichment engine, both `getEmbeddingVector` helpers, the commented `askZero*` blocks, VECTORIZE bindings from env/shim/wrangler (types regenerated). Added `src/lib/summary-service.ts`: `getOrGenerateThreadSummary` — reads `mail0_summary`, on miss generates via the OpenAI-compatible provider (`OPENAI_MINI_MODEL`) from BlobStore-backed thread content, upserts keyed `messageId = threadId`. All three consumers rewired, response shapes unchanged; zero Workers-AI dependence in the summary path (env.AI remains only in the dormant Gmail enrichment module). No pgvector (deferred by design; summary rows are the bolt-on point). *Incident during the work:* an over-broad regex deletion in tools.ts destroyed live tool definitions; restored from git HEAD + reconstructed the two legitimate uncommitted changes (ai-provider import, flat tools registry) from the pre-damage esbuild bundle — noting the whole migration is uncommitted working-tree state on top of upstream HEAD. *E2E script fix:* the idle-push leg asserted on thread COUNT, which saturates at one page (mailboxes >20 threads) — false negative on m.re.cx; now asserts arrival of the specific message. Verified: LLM summary generated live and persisted to `mail0_summary` (cached re-read 0.5 s); tsc server 66→**53**, mail 299→**281**; E2E **ALL GREEN on both GreenMail and m.re.cx** (real IDLE push 18 s); Google OAuth URL; wrangler dry-run builds.

- **2026-07-25 — Committed & pushed.** `d9aa4589` on branch `path-b-migration` (152 files, +17,307/−8,636), pushed to `origin` (github.com/sookerflower/Email-client). Single commit by design: phases share edits to the same files and interleave with the pre-pivot IMAP work, so per-phase untangling was riskier than it was worth. The pre-commit hook (oxlint `--deny-warnings`) forced clearing 103 lint findings first — which itself dropped tsc counts to server **28** / mail **257** (unused-import cleanup removed error sources, incl. the dormroom type dependency). E2E GreenMail re-verified green post-cleanup. Newly gitignored: `dist-node/`, `apps/server/data/` (synced mail bodies), `docker-data/`, `.claude/`, `.agents/`. Local `staging` branch left untouched at upstream HEAD.

- **2026-07-25 — Phase 3.4 complete; PHASE 3 CLOSED.** Topics: `MailEngine.getUserTopics` regenerates via the self-hosted LLM behind a Redis cache (`topics:{connectionId}`, TTL 24 h) with a SET NX generation guard (losers return `[]`, winner fills — stale regen benign by design). Recipients: confirmed zero `recipientCache` references remain (deleted with ZeroDriver in 3.1); `suggestRecipients` reads the indexed `(connection_id, latest_received_on)` Postgres path. Do_State: `storageSize` now a real pg number (`getIndexSizeBytes` — `pg_column_size` over the three index tables, the moral equivalent of the old shard `databaseSize`, which also covered only the index); wire shape `{isSyncing, syncingFolders, storageSize, counts, shards}` statically verified against the client destructure (ai-sidebar.tsx:333); `shards` fixed at 0. **Phase 3 close-out:** marquee deletions — ZeroDriver+ShardRegistry bodies ~1,410 lines, routes/chat.ts 1,610, server-utils sharding/aggregators ~415, vector workflows+functions ~350, plus dormroom out of the module graph entirely; `ZeroDriver`/`ShardRegistry`/`ZeroDB` are now literally `export class X extends DurableObject<ZeroEnv> {}` — wrangler-binding compat only, zero live logic. Final Phase 3 baseline: server tsc **28**, mail **257**. E2E ALL GREEN on GreenMail and m.re.cx (one transient real-server `Command failed` on a post-APPEND dead connection, recovered on reconnect — same failure class as old bug #1; systematic fix = Phase 4 job retries + a reconnect-retry in the worker driver cache, deliberately not patched ad hoc here). Sub-step states: 3.1 MailEngine live; 3.2 worker owns all IMAP sockets under a Redis lease; 3.3 summaries in mail0_summary via own LLM; 3.4 topics/recipients/do-state on Redis/Postgres.

- **2026-07-25 — Phase 4.1 complete (BullMQ infrastructure).** New `src/lib/queue/index.ts`: three queues (`mail-sync`, `mail-send`, `mail-sweep`) over Redis TCP (`QUEUE_REDIS_URL`, default `redis://127.0.0.1:6379` — Valkey direct, NOT the Upstash HTTP proxy `lib/stores.ts` uses), default job options per §3 (attempts 3, exponential backoff 30 s, failed jobs retained 7 d for inspection), `startQueueWorker` wrapper with failure logging. **Bundle-hygiene rule: the queue module is imported only by the worker process and scripts — never from `src/main.ts`/workerd-reachable code** (ioredis would break the wrangler build; enqueue-from-api gets designed around this in 4.2). Worker process (`src/worker/jobs.ts`, wired into `src/worker/index.ts` startup/shutdown) hosts all processors; sub-step scope deliberately behavior-neutral: `ping` handler + repeatable `heartbeat` scheduler (15 min, upsertJobScheduler) as scheduler liveness canary. Bull Board runs as a standalone UNBUNDLED script `scripts/bull-board.mjs` (port 8793) — it serves static assets from node_modules, so it stays out of the esbuild bundles by design; `scripts/queue-ping.mjs` proves the round-trip. Verified: ping enqueued from a separate process → worker returns `{pong:true, echo:{nonce}}`; Bull Board API lists all three queues with the completed ping + completed and next-delayed heartbeat; tsc server **28**/mail **257** (baseline held); E2E ALL GREEN on GreenMail and m.re.cx (real forceSync 162 s; one first-attempt `--real` run failed its forceSync leg with a client-side `fetch failed` while the server-side sync completed fine — transient, passed clean on re-run; incremental sync in a later phase shrinks this window); Google OAuth URL generation OK; wrangler dry-run builds. Deps added to @zero/server: bullmq, ioredis (direct dep — pnpm strict layout), @bull-board/api, @bull-board/express, express.

- **2026-07-25 — Phase 4.2 + 4.3 complete (sync-folder job + reconnect hardening; bugs #1 AND #2 closed).** Landed together because 4.2's `--real` verification could not go green without 4.3 — the real server's natural mid-operation drops fail any multi-minute sync without the reconnect. **4.2:** `MailEngine.syncFolderJob` — sequential page loop (page size 20, cap `THREAD_SYNC_MAX_COUNT`), pageToken checkpointed to `folder_sync_state` after every page (`mail-index.ts` helpers), per-thread concurrency 3 (unchanged), errors RETHROWN; "No latest message" is a logged skip, not a job failure. Checkpoint resume applies ONLY to BullMQ retry attempts (`job.attemptsMade > 0`) — a fresh job honoring a stale checkpoint from a dead run would skip the newest page (observed live: "resuming at pageToken 20" skipped page 1). IMAP-notify rewired: the worker's watcher now enqueues directly (`core.ts` `enqueueSync` option; HTTP `/api/public/imap-notify` kept as the legacy-sidecar fallback and still serves the api). Sent-folder scheduling = `sync-sent-folders` repeatable (10 min) enqueuing `sync-folder:{id}:sent` per IMAP connection — **bug #2 closed**, guarded by the new E2E `sent-sync` leg (asserts the app-sent message appears in the Sent view WITH the SENT label). Three job-layer lessons baked in: (1) **per-account job serialization** (in-process promise chain in `jobs.ts`) — concurrent inbox+sent jobs interleaving mailboxOpen/FETCH on the one cached connection reproduced bug #1's exact failure class at the job layer; (2) **extended dedup, not a 5 s ttl window** — real-server syncs run minutes, so window-based dedup let every IDLE notify pile up identical full syncs that starved other folders behind the account lock; dedup key `sync-folder:{cid}:{folder}` now holds until the job finishes (deterministic jobId rejected: collides with retained completed/failed jobs and silently drops future syncs); (3) **dirty-flag trailing re-enqueue** — a notify landing mid-sync may postdate the running job's listing; enqueue sets `sync-dirty:{cid}:{folder}`, the processor claims it at start, and a worker `completed` hook re-enqueues if it was re-set (no new-mail signal is ever lost to dedup). Cross-account sync concurrency 8 (2 starved GreenMail behind slow real-server jobs; per-account discipline is enforced by the lock + single cached connection, not the slot count). **4.3:** dead cached connections report `usable` until a command fails, so the failure IS the detection — `/rpc` now does a one-shot evict → **await** dispose (old socket fully closed before a new one opens; 3.2 cap invariant) → 1 s settle → rebuild → retry once, on connection-class errors only (`Command failed`, `Unexpected close`, NoConnection, socket family — auth/argument errors excluded). `imap.ts get()` rethrows `mailboxOpen` failures when the client is unusable instead of `continue`-ing past every folder and fabricating an empty thread. **Bug #1 closure evidence:** natural mid-operation drop on m.re.cx → `get failed on cached connection (Command failed) — evicting driver, one-shot reconnect retry` → `get recovered after reconnect` → job completed 14/14, zero manual intervention; regression-locked by the E2E `drop-recover` leg (GreenMail `docker restart` kills all connections mid-session, then `forceSync` must go green with no manual retry — recovery via either detection path: imapflow `usable=false` on clean FIN, `/rpc` retry on half-open). E2E windows for `--real` widened to 240 s (sent-sync/idle-push serialize behind ~2 min full-refetch syncs; incremental sync — the next work item — is what tightens these). Verified (final code): tsc server **28** / mail **257** (a +2 blip from `Queue#client`'s narrow typing fixed by using a plain ioredis connection for the flags); GreenMail E2E **ALL 10 LEGS GREEN** incl. sent-sync + drop-recover; real m.re.cx E2E **ALL LEGS GREEN** (forceSync 138 s, sent-sync 3.6 s, idle-push 216 s worst-case path: mid-flight sync + dirty-flag re-enqueue); folder-label regression test green; wrangler dry-run builds (queue module stays out of the workerd graph); Google OAuth URL OK. *Observed but deferred:* every Custom-IMAP login re-encrypts the password (fresh IV), churning the watcher credDigest → watcher restart per login; harmless at classroom scale but worth a stable digest later.

- **2026-07-25 — Phase 4.4 complete (send-email job + outbox timers; PHASE 4 BUILD DONE, pending Phase 5 go).** The outbox row (already source of truth since Phase 2) now gets a real delivery timer on Node: `mail.send` enqueues via the `send_email_queue` binding whose cf-shim is no longer a dropped stub but POSTs the worker's new `/enqueue-send` (secret-guarded; workerd-reachable code still never imports BullMQ), which creates a `send-email` job with `jobId send-{messageId}` (BullMQ forbids `:` in custom jobIds) and `delay = send_at − now`. **The 12-hour KV/cron split is deleted from `mail.ts`** — any delay is one delayed job; if the enqueue fails the row stays `pending` and reconciliation recovers it (send no longer errors out on a timer failure). Undo = same mechanism, delay 15 s; `mail.unsend` cancels the row AND best-effort removes the job via `/cancel-send`; the handler re-checks row status at fire time regardless. Processor (worker, concurrency 1): status re-check (cancelled/sent/failed skip) → attachments rehydrated → `sendDraft`/`create` → **guarded** `markSent` (`WHERE status IN pending,queued`, returns false on a raced cancel — logged, never resent; store updated accordingly). Transport errors RETHROW; on exhausted retries a `failed` hook sets `status='failed'` + beacon log (no-op until Phase 5) — the old consumer's delete-payload-on-failure silent drop is structurally impossible. Sweeps (mail-sweep repeatables, 10 min each + startup run): `outbox-reconcile` — `listOverdueUnsent` (pending OR queued past send_at) re-enqueues rows with no live timer job (covers worker-down windows and Redis loss; **proven live**: two rows orphaned by the jobId-colon bug were auto-recovered at next worker boot — `outbox-reconcile: re-enqueued overdue send 6535eded…`); `unsnooze-sweep` — wakes due snoozes via `MailEngine.unsnoozeThreadsHandler` (INBOX back, SNOOZED off, snooze row deleted), **fixing the dormant snooze dispatch** that was commented out in the old cron. New E2E leg `scheduled-send`: schedules a self-addressed mail 8 s out + a second one 120 s out which is immediately undo-sent; asserts queued+messageId, undo success, and (GreenMail) actual delivery by the delayed job. *Incident:* a PowerShell scripted find-replace mangled the queue module's UTF-8 (the standing lesson about scripted edits — file rewritten clean by hand). Verified: tsc server **28** / mail **257**; GreenMail E2E **ALL 11 LEGS GREEN** (scheduled-send delivered in 13 s); real m.re.cx E2E **ALL LEGS GREEN** (idle-push 21 s this run); folder-label regression green; wrangler dry-run builds; Google OAuth URL OK. Phase 4 remaining niceties deferred to later phases: incremental sync (shrinks the 2–4 min full-refetch windows the widened E2E timeouts accommodate), Phase 5 beacons replacing the logged no-op hooks.

## Decisions needing your sign-off before build starts

1. **Durable KV namespaces → Postgres instead of Redis** (§5) — deviation from the brief, recommended.
2. **Vectorize: drop entirely** (§7) — recommended over pgvector; semantic search doesn't exist today.
3. **Chat over HTTP streaming + beacons over SSE** instead of one WebSocket (§8) — recommended; accepts the minor cross-tab live-chat regression.
4. **Blob store: local disk now, MinIO interface later** (§6).
5. **Incremental sync (QRESYNC ladder) in phase 6 vs. first post-port task** — affects whether the total is ~7 or ~8.5 weeks.
