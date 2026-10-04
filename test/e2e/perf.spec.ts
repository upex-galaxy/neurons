// Performance: 2,000-file repo, 3D view, about 10 Read events per second for 5 s while
// sampling window.__vizState.fps. The 30 fps bar applies only on a GPU-backed context;
// software WebGL (SwiftShader, llvmpipe) skips with the measured value annotated.
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { E2E_PORTS, e2eDir, e2eRepo, fixturePayloads } from '../../scripts/e2e/fixtures.mjs';
import { counter, openViewer, postHook, sleep, vizState } from './helpers.ts';

const PORT = E2E_PORTS.perf;
const SAMPLE_MS = 5_000;
const EVENTS_PER_SECOND = 10;
const MIN_FPS = 30;

interface ReadPost {
  tool_use_id: string;
  tool_input: { file_path: string };
  tool_response: { file: { filePath: string; content: string } };
}

test('2,000 files at 30 fps or more with live events (with a GPU)', async ({ page, request }) => {
  test.setTimeout(120_000);
  const repo = e2eRepo('perf');
  // run1 line 6 is a real PostToolUse(Read); it is re-aimed at the synthetic files.
  const template = JSON.parse(fixturePayloads('run1.jsonl', repo, path.join(e2eDir(), 'perf', 'home'))[6]!) as ReadPost;

  await openViewer(page, PORT);
  const loaded = await vizState(page);
  expect(loaded.nodeCount).toBeGreaterThan(2_000);
  expect(loaded.renderer).toBe('3d');

  const gpu = await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: { createElement(t: 'canvas'): { getContext(k: string): unknown } } }).document;
    const gl = doc.createElement('canvas').getContext('webgl') as {
      getExtension(n: string): { UNMASKED_RENDERER_WEBGL: number } | null;
      getParameter(p: number): unknown;
      RENDERER: number;
    } | null;
    if (!gl) return 'no WebGL';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  });

  // Let the layout settle (warmup + cooldown) before measuring.
  await sleep(3_000);

  const sampling = page.evaluate(
    (ms) =>
      new Promise<number[]>((resolve) => {
        const g = globalThis as unknown as { __vizState: { fps: number } };
        const out: number[] = [];
        const t = setInterval(() => out.push(g.__vizState.fps), 250);
        setTimeout(() => {
          clearInterval(t);
          resolve(out);
        }, ms);
      }),
    SAMPLE_MS,
  );

  const files = Array.from({ length: 2_000 }, (_, i) => `pkg${Math.floor(i / 400)}/mod${Math.floor(i / 20) % 20}/file${i}.ts`);
  let sent = 0;
  const start = Date.now();
  while (Date.now() - start < SAMPLE_MS) {
    const rel = files[Math.floor(Math.random() * files.length)]!;
    const abs = path.join(repo, rel);
    const p: ReadPost = structuredClone(template);
    p.tool_use_id = `toolu_perf_${sent}`;
    p.tool_input.file_path = abs;
    p.tool_response.file.filePath = abs;
    p.tool_response.file.content = '';
    await postHook(request, PORT, JSON.stringify(p));
    sent++;
    await sleep(1000 / EVENTS_PER_SECOND);
  }
  const samples = (await sampling).slice(2); // the first 500 ms still carry the settle average
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const min = sorted[0] ?? 0;
  const avg = Math.round(samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length));

  const after = await vizState(page);
  const summary = `renderer="${gpu}", nodes=${after.nodeCount} (visible ${after.visibleNodeCount}), events=${sent}, fps median=${median} mean=${avg} min=${min}`;
  console.log(`[perf] ${summary}`);
  test.info().annotations.push({ type: 'fps', description: summary });

  // Every Read reached the page.
  expect(counter(after, 'read')).toBeGreaterThanOrEqual(sent - 1);

  const software = /swiftshader|llvmpipe|software/i.test(gpu) || gpu === 'no WebGL';
  test.skip(software, `software WebGL (${gpu}): measured ${median} fps, ${MIN_FPS} not required`);
  expect(median).toBeGreaterThanOrEqual(MIN_FPS);
});
