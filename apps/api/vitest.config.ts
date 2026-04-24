import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Integration tests touch a real Postgres and must not race each other.
    poolOptions: { threads: { singleThread: true } },
  },
});
