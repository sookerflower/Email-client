/**
 * Environment (Phase 6.4 of MIGRATION-PLAN.md — plain process-env typing).
 *
 * The workerd path is gone; env is Node's process.env, merged at module load
 * from (lowest to highest precedence):
 *   local defaults below → .dev.vars (wrangler's dotenv format, kept as the
 *   gitignored local secrets file) → the real process environment.
 * The merge is mirrored INTO process.env because libraries like better-auth
 * (secret resolution) and googleapis read process.env directly.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ZeroEnv = {
  NODE_ENV: 'local' | 'development' | 'production';
  JWT_SECRET: string;
  ELEVENLABS_API_KEY: string;
  DISABLE_CALLS: 'true' | '';
  DROP_AGENT_TABLES: string;
  THREAD_SYNC_MAX_COUNT: string;
  THREAD_SYNC_LOOP: string;
  DISABLE_WORKFLOWS: string;
  AUTORAG_ID: string;
  USE_OPENAI: string;
  BASE_URL: string;
  VITE_PUBLIC_APP_URL: string;
  DATABASE_URL: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  RESEND_API_KEY: string;
  VITE_PUBLIC_POSTHOG_KEY: string;
  VITE_PUBLIC_POSTHOG_HOST: string;
  COOKIE_DOMAIN: string;
  BETTER_AUTH_TRUSTED_ORIGINS: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GOOGLE_REDIRECT_URI: string;
  GOOGLE_APPLICATION_CREDENTIALS: string;
  HISTORY_OFFSET: string;
  ZERO_CLIENT_ID: string;
  ZERO_CLIENT_SECRET: string;
  VITE_PUBLIC_BACKEND_URL: string;
  REDIS_URL: string;
  REDIS_TOKEN: string;
  OPENAI_API_KEY: string;
  // Optional OpenAI-compatible endpoint (Ollama/vLLM/...); see lib/ai-provider.ts
  OPENAI_BASE_URL: string;
  BRAIN_URL: string;
  COMPOSIO_API_KEY: string;
  GROQ_API_KEY: string;
  EARLY_ACCESS_ENABLED: string;
  GOOGLE_GENERATIVE_AI_API_KEY: string;
  AI_SYSTEM_PROMPT: string;
  PERPLEXITY_API_KEY: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_PHONE_NUMBER: string;
  // IMAP transport worker (src/worker/) — owns all IMAP sockets.
  IMAP_SIDECAR_URL: string;
  IMAP_SIDECAR_SECRET: string;
  // Encrypts the imap connection password on save (api) and decrypts it in
  // the worker on use. 64 hex chars (32 bytes).
  IMAP_ENCRYPTION_KEY: string;
  // Default mail server for the "Custom IMAP/SMTP" login form, so users only
  // type email + password. Optional; the form accepts overrides.
  IMAP_DEFAULT_IMAP_HOST: string;
  IMAP_DEFAULT_IMAP_PORT: string;
  IMAP_DEFAULT_SMTP_HOST: string;
  IMAP_DEFAULT_SMTP_PORT: string;
  IMAP_DEFAULT_ALLOW_INSECURE_TLS: string;
  VITE_PUBLIC_ELEVENLABS_AGENT_ID: string;
  REACT_SCAN: string;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
  VOICE_SECRET: string;
  ARCADE_API_KEY: string;
  OPENAI_MODEL: string;
  OPENAI_MINI_MODEL: string;
  ANTHROPIC_API_KEY: string;
  GOOGLE_S_ACCOUNT: string;
  AXIOM_API_TOKEN: string;
  AXIOM_DATASET: string;
  DEV_PROXY: string;
  MEET_AUTH_HEADER: string;
  MEET_API_URL: string;
  ENABLE_MEET: 'true' | 'false';
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
  OTEL_SERVICE_NAME?: string;
};

// Local-dev defaults (formerly wrangler.jsonc [env.local].vars). Real
// deployments override via the environment or .dev.vars.
const localDefaults: Record<string, string> = {
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
  MEET_AUTH_HEADER: '',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/zerodotemail',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'https://api.axiom.co/v1/traces',
  OTEL_SERVICE_NAME: 'zero-email-server-local',
};

// Minimal dotenv parse for the .dev.vars format.
const parseDotenv = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
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
let devVars: Record<string, string> = {};
try {
  devVars = parseDotenv(readFileSync(join(serverDir, '.dev.vars'), 'utf8'));
} catch {
  console.warn(`[env] no .dev.vars found in ${serverDir}; using process.env only`);
}

for (const [key, value] of Object.entries({ ...localDefaults, ...devVars })) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}

const env = process.env as unknown as ZeroEnv;
export { env };
