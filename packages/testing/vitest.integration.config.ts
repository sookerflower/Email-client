import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['integration/**/*.spec.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Live network tests: one at a time, in order.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
