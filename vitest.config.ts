import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'apps/web/src/**/*.test.ts'],
          exclude: ['packages/server/test/media/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'media',
          include: ['packages/server/test/media/**/*.test.ts'],
          globalSetup: ['packages/server/test/fixtures/global-setup.ts'],
          environment: 'node',
          testTimeout: 180_000,
          hookTimeout: 300_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
