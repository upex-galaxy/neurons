// Helpers shared by the e2e specs. The page is read through window.__vizState only.
import { expect, type APIRequestContext, type Page } from '@playwright/test';

/** The subset of web/src/state.ts VizState the specs read (that module needs DOM types). */
export interface VizStateLite {
  ready: boolean;
  lang: 'en' | 'es';
  panelWidth: number;
  stream: { id: string; action: string; phase: string; text: string }[];
  streamOn: boolean;
  detail: string | null;
  detailPath: string | null;
  tools: {
    skills: Record<string, number>;
    mcp: Record<string, Record<string, number>>;
    cli: Record<string, number>;
    builtin: Record<string, number>;
  };
  mode: 'live' | 'replay' | null;
  renderer: '3d' | '2d';
  view: '3d' | '2d' | 'timeline';
  timeline: { rows: number; marks: number; groups: number; turns: number; agents: number; following: boolean; rowPaths: string[] };
  nodeCount: number;
  visibleNodeCount: number;
  active: string[];
  created: string[];
  removed: string[];
  feed: { id: string; action: string; phase: string; path: string; agentId?: string; external?: boolean }[];
  feedShown: number;
  counters: Record<string, number | undefined>;
  sessionColors: Record<string, string>;
  multiSession: boolean;
  failCount: number;
  fps: number;
  lastEventLatencyMs: number | null;
  connected: boolean;
  replay: { active: boolean; playing: boolean; speed: number; index: number; total: number; elapsedMs: number; durationMs: number };
}

export function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export async function vizState(page: Page): Promise<VizStateLite> {
  return page.evaluate(() => (globalThis as unknown as { __vizState: VizStateLite }).__vizState);
}

/** Opens the page and waits for the first layout and, in live mode, the socket. */
export async function openViewer(page: Page, port: number, query = ''): Promise<void> {
  await page.goto(`${baseUrl(port)}/${query}`);
  await expect
    .poll(async () => {
      const s = await vizState(page);
      return s.ready && (s.mode === 'replay' || s.connected);
    }, { timeout: 30_000 })
    .toBe(true);
}

/** POSTs one raw payload like Claude Code does and checks the 204 with an empty body. */
export async function postHook(request: APIRequestContext, port: number, body: string): Promise<void> {
  const res = await request.post(`${baseUrl(port)}/hook?src=neurons`, {
    headers: { 'content-type': 'application/json' },
    data: body,
  });
  expect(res.status()).toBe(204);
  expect((await res.body()).length).toBe(0);
}

export function counter(s: VizStateLite, action: string): number {
  return s.counters[action] ?? 0;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The WebGL renderer string of the page ('no WebGL' without a context). */
export async function webglRenderer(page: Page): Promise<string> {
  return page.evaluate(() => {
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
}

/** True for software WebGL (SwiftShader, llvmpipe), as on CI runners without a GPU. */
export function isSoftwareRenderer(renderer: string): boolean {
  return /swiftshader|llvmpipe|software/i.test(renderer) || renderer === 'no WebGL';
}
