// E2E: the real CLI (dist/cli.mjs, so run `npm run build` first) on throwaway repos under
// os.tmpdir(). scripts/e2e/serve.mjs builds each repo, points CLAUDE_CONFIG_DIR at a temp
// dir and removes everything on SIGTERM.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { E2E_PORTS as PORTS } from './scripts/e2e/fixtures.mjs';

// Workers load this file again: the env var keeps one temp root per run.
process.env.RS_E2E_DIR ??= path.join(fs.realpathSync(os.tmpdir()), `neurons-e2e-${process.pid}`);

function server(mode: keyof typeof PORTS) {
  return {
    name: mode,
    command: `node scripts/e2e/serve.mjs ${mode} ${PORTS[mode]}`,
    url: `http://127.0.0.1:${PORTS[mode]}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 5_000 },
    stdout: 'ignore' as const,
    stderr: 'pipe' as const,
  };
}

export default defineConfig({
  testDir: 'test/e2e',
  // The live and replay specs share one server each and assert on its history: run in order.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /perf\.spec\.ts/,
    },
    {
      name: 'perf',
      testMatch: /perf\.spec\.ts/,
      use: {
        launchOptions: { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] },
      },
    },
  ],
  webServer: [server('live'), server('replay'), server('perf')],
});
