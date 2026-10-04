import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    environment: 'node',
    // Windows: every `neu stop` and lock check reads process identity from WMI through
    // PowerShell (about a second each, the first one of a runner over 10 s), and the CLI
    // tests close viewers with `neu stop`.
    testTimeout: process.platform === 'win32' ? 60000 : 15000,
  },
});
