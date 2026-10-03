import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const webRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: webRoot,
  base: './',
  resolve: {
    // 3d-force-graph and UnrealBloomPass must share one copy of three.
    dedupe: ['three'],
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    target: 'es2022',
    // three + 3d-force-graph make one ~1.3 MB chunk; that is expected for a local tool.
    chunkSizeWarningLimit: 2500,
  },
  server: {
    // `vite --config web/vite.config.ts` in dev proxies the socket to a running server.
    // The server only accepts its own Origin: start it with
    // NEURONS_ALLOWED_ORIGINS=http://localhost:5173 so the dev page can connect.
    // Do not use rewriteWsOrigin: it would let any page reach the socket through Vite.
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:7777', ws: true },
    },
  },
});
