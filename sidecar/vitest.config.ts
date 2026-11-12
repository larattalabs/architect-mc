import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
    pool: 'forks',
  },
});
