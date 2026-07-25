import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Integration tests run under plain Node against live local services
 * (Postgres, Redis proxy, GreenMail). `cloudflare:workers` resolves to the
 * same shim the Node server uses, so `env` is built from .dev.vars +
 * process.env exactly like production-on-Node.
 */
export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(new URL('./src/node/cf-shim.mjs', import.meta.url)),
      'cloudflare:email': fileURLToPath(new URL('./src/node/cf-shim.mjs', import.meta.url)),
    },
  },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Sequential: tests share the local GreenMail + Postgres state.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
