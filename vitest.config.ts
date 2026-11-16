import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],

    // These are integration tests: they share one database and truncate it
    // between cases, so they must not run concurrently.
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,

    // Argon2 hashing on registration makes the auth tests genuinely slow.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
