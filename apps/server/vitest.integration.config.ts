import { defineConfig } from 'vitest/config';

/**
 * Integration tests run under plain Node against live local services
 * (Postgres, Redis proxy, GreenMail). `env` is built from .dev.vars +
 * process.env by src/env.ts, exactly like the production Node processes.
 */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Sequential: tests share the local GreenMail + Postgres state.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
