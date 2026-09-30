// Unit tests for the browser modules that do not need a DOM (run: npx vitest run --config web/vitest.config.ts).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
