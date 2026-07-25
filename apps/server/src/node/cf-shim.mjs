/**
 * Node.js shim for `cloudflare:workers` (and `cloudflare:email`).
 *
 * The resolver hook (cf-resolver.mjs) redirects every `cloudflare:*` import —
 * including those inside node_modules packages like `agents`/`partyserver` —
 * to this module. It provides:
 *
 *  - `env`: the ZeroEnv-shaped object, merged from (lowest to highest
 *    precedence) wrangler.jsonc env.local vars → .dev.vars → process.env,
 *    plus stubs for Cloudflare-only bindings. Durable-storage bindings THROW
 *    a NotPortedError on use (loud failure beats silent data loss); queue
 *    sends warn-and-drop (fire-and-forget semantics, Gmail sync is dormant).
 *  - Inert base classes (DurableObject, RpcTarget, WorkerEntrypoint,
 *    WorkflowEntrypoint, WorkflowStep, EmailMessage) so class *definitions*
 *    evaluate; DO classes are never instantiated on Node except ZeroDB,
 *    which is pure Postgres (see server-utils getZeroDB).
 *
 * Plain .mjs on purpose: it must load without the TS transform and with zero
 * package dependencies.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export class NotPortedError extends Error {
  constructor(what) {
    super(
      `[node-port] ${what} is a Cloudflare binding that has not been ported yet. ` +
        `See MIGRATION-PLAN.md for the phase that replaces it.`,
    );
    this.name = 'NotPortedError';
  }
}

const notPorted = (what) => {
  throw new NotPortedError(what);
};

// ---------------------------------------------------------------------------
// Vars: wrangler.jsonc [env.local].vars defaults, mirrored verbatim.
// wrangler.jsonc is deleted at the end of the migration; until then keep this
// block in sync with it by hand (it is small and changes rarely).
// ---------------------------------------------------------------------------
const wranglerLocalVars = {
  NODE_ENV: 'local',
  COOKIE_DOMAIN: 'localhost',
  VITE_PUBLIC_BACKEND_URL: 'http://localhost:8787',
  VITE_PUBLIC_APP_URL: 'http://localhost:3000',
  JWT_SECRET: 'secret',
  ELEVENLABS_API_KEY: '1234567890',
  DISABLE_CALLS: 'true',
  VOICE_SECRET: '1234567890',
  GOOGLE_S_ACCOUNT: '{}',
  DROP_AGENT_TABLES: 'false',
  THREAD_SYNC_MAX_COUNT: '60',
  THREAD_SYNC_LOOP: 'false',
  DISABLE_WORKFLOWS: 'true',
  AUTORAG_ID: '',
  USE_OPENAI: 'true',
  CLOUDFLARE_ACCOUNT_ID: '',
  CLOUDFLARE_API_TOKEN: '',
  MEET_AUTH_HEADER: '',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'https://api.axiom.co/v1/traces',
  OTEL_SERVICE_NAME: 'zero-email-server-local',
};

// Minimal dotenv parse for wrangler's .dev.vars format.
const parseDotenv = (text) => {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
};

const serverDir = process.env.ZERO_SERVER_DIR || process.cwd();
let devVars = {};
try {
  devVars = parseDotenv(readFileSync(join(serverDir, '.dev.vars'), 'utf8'));
} catch {
  console.warn(`[node-port] no .dev.vars found in ${serverDir}; using process.env only`);
}

const stringVars = { ...wranglerLocalVars, ...devVars, ...process.env };

// Libraries like better-auth (secret resolution), Dub, and googleapis read
// process.env directly — wrangler's nodejs_compat populated it from vars, so
// mirror the merged vars back (without clobbering real environment values).
for (const [key, value] of Object.entries(stringVars)) {
  if (typeof value === 'string' && process.env[key] === undefined) {
    process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Binding stubs
// ---------------------------------------------------------------------------
const doNamespaceStub = (name) => ({
  idFromName: () => notPorted(`${name}.idFromName`),
  idFromString: () => notPorted(`${name}.idFromString`),
  newUniqueId: () => notPorted(`${name}.newUniqueId`),
  get: () => notPorted(`${name}.get`),
  getByName: () => notPorted(`${name}.getByName`),
  jurisdiction: () => notPorted(`${name}.jurisdiction`),
});

// Queue sends are fire-and-forget in the app; dropping them (loudly) keeps
// auth flows alive if e.g. GOOGLE_S_ACCOUNT is ever configured before Phase 4
// replaces queues with BullMQ. Nothing critical rides on queues in Phase 0.
const queueStub = (name) => ({
  send: async (msg) => {
    console.warn(`[node-port] queue ${name}.send dropped (not ported yet):`, JSON.stringify(msg));
  },
  sendBatch: async (msgs) => {
    console.warn(`[node-port] queue ${name}.sendBatch dropped (not ported yet): ${msgs?.length} msgs`);
  },
});

const r2Stub = (name) => ({
  get: () => notPorted(`R2 ${name}.get`),
  put: () => notPorted(`R2 ${name}.put`),
  delete: () => notPorted(`R2 ${name}.delete`),
  head: () => notPorted(`R2 ${name}.head`),
  list: () => notPorted(`R2 ${name}.list`),
});

const workflowStub = (name) => ({
  create: () => notPorted(`Workflow ${name}.create`),
  createBatch: () => notPorted(`Workflow ${name}.createBatch`),
  get: () => notPorted(`Workflow ${name}.get`),
});

const aiStub = {
  run: () => notPorted('env.AI.run'),
  autorag: () => notPorted('env.AI.autorag'),
};

export const env = {
  ...stringVars,

  HYPERDRIVE: {
    connectionString:
      stringVars.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/zerodotemail',
  },

  ZERO_DRIVER: doNamespaceStub('ZERO_DRIVER'),
  SHARD_REGISTRY: doNamespaceStub('SHARD_REGISTRY'),
  ZERO_DB: doNamespaceStub('ZERO_DB'),
  ZERO_AGENT: doNamespaceStub('ZERO_AGENT'),
  ZERO_MCP: doNamespaceStub('ZERO_MCP'),
  THINKING_MCP: doNamespaceStub('THINKING_MCP'),
  WORKFLOW_RUNNER: doNamespaceStub('WORKFLOW_RUNNER'),
  THREAD_SYNC_WORKER: doNamespaceStub('THREAD_SYNC_WORKER'),

  SYNC_THREADS_WORKFLOW: workflowStub('SYNC_THREADS_WORKFLOW'),
  SYNC_THREADS_COORDINATOR_WORKFLOW: workflowStub('SYNC_THREADS_COORDINATOR_WORKFLOW'),

  thread_queue: queueStub('thread_queue'),
  subscribe_queue: queueStub('subscribe_queue'),
  send_email_queue: queueStub('send_email_queue'),

  THREADS_BUCKET: r2Stub('THREADS_BUCKET'),
  AI: aiStub,
};

// ---------------------------------------------------------------------------
// Base classes (inert). DO subclasses only need to *define* on Node; the one
// class we instantiate (ZeroDB) uses only `this.env`.
// ---------------------------------------------------------------------------
export class RpcTarget {}

export class DurableObject {
  constructor(ctx, envArg) {
    this.ctx = ctx;
    this.env = envArg;
  }
}

export class WorkerEntrypoint {
  constructor(ctx, envArg) {
    this.ctx = ctx;
    this.env = envArg;
  }
}

export class WorkflowEntrypoint {
  constructor(ctx, envArg) {
    this.ctx = ctx;
    this.env = envArg;
  }
}

export class WorkflowStep {}

// `cloudflare:email` (imported by the `agents` package; never used on Node).
export class EmailMessage {
  constructor() {
    notPorted('cloudflare:email EmailMessage');
  }
}
