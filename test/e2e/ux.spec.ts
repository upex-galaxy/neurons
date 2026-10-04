// Viewer UX against the live server (real CLI): language toggle, resizable panel, detail
// drawer, floating "now" stream, tools counters (run-skill-mcp fixture), collapse feedback,
// entry animations, focus kept across file history updates and refused calls.
// Runs after live.spec.ts on the same server, so it only asserts on what it posts itself.
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { E2E_PORTS, e2eDir, e2eRepo, fixturePayloads } from '../../scripts/e2e/fixtures.mjs';
import { openViewer, postHook, vizState } from './helpers.ts';

const PORT = E2E_PORTS.live;

test.describe.configure({ mode: 'serial' });
test.use({ locale: 'en-US' });

let run1: string[];
let skillMcp: string[];

test.beforeAll(() => {
  const repo = e2eRepo('live');
  const home = path.join(e2eDir(), 'live', 'home');
  run1 = fixturePayloads('run1.jsonl', repo, home);
  skillMcp = fixturePayloads('run-skill-mcp.jsonl', repo, home);
});

/** run1 lines 5 and 6: PreToolUse / PostToolUse Read of src/api/user.ts. */
async function postRead(request: Parameters<typeof postHook>[0]): Promise<void> {
  await postHook(request, PORT, run1[5]!);
  await postHook(request, PORT, run1[6]!);
}

test('language toggle switches every label without a reload and is remembered', async ({ page }) => {
  await openViewer(page, PORT);
  expect((await vizState(page)).lang).toBe('en');
  await expect(page.locator('#mode')).toHaveText('Live');
  await expect(page.getByRole('button', { name: 'Replay log' })).toBeVisible();
  await expect(page.locator('#link-help')).toHaveText('Help');
  await expect(page.locator('#link-help')).toHaveAttribute('href', './help');
  await expect(page.locator('#link-arch')).toHaveAttribute('target', '_blank');

  await page.locator('[data-lang="es"]').click();
  await expect.poll(async () => (await vizState(page)).lang).toBe('es');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.locator('#mode')).toHaveText('En vivo');
  await expect(page.getByRole('button', { name: 'Reproducir log' })).toBeVisible();
  await expect(page.locator('#link-arch')).toHaveText('Arquitectura');
  await expect(page.locator('[data-counter="read"]').locator('xpath=preceding-sibling::span')).toHaveText('lectura');
  await expect(page.locator('#f-session option').first()).toHaveText('Todas las sesiones');
  await expect(page.locator('[data-lang="es"]')).toHaveAttribute('aria-pressed', 'true');

  // localStorage wins over the browser language on the next visit.
  await page.reload();
  await expect.poll(async () => (await vizState(page)).lang).toBe('es');
  await expect(page.locator('#mode')).toHaveText('En vivo');
  await page.locator('[data-lang="en"]').click();
  await expect(page.locator('#mode')).toHaveText('Live');
});

test('the side panel resizes by drag and keyboard, keeps its width and the canvas follows', async ({ page }) => {
  await openViewer(page, PORT);
  const handle = page.locator('#panel-resize');
  await expect(handle).toHaveCSS('cursor', 'col-resize');
  expect((await vizState(page)).panelWidth).toBe(360);
  const canvasWidth = () => page.locator('#graph canvas').first().evaluate((c) => (c as unknown as { clientWidth: number }).clientWidth);
  const before = await canvasWidth();

  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + 200, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + 200, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await vizState(page)).panelWidth).toBe(480);
  await expect(page.locator('#panel')).toHaveCSS('width', '480px');
  await expect.poll(canvasWidth).toBe(before - 120);

  // Clamped to min(720, 60vw) = 720 at 1280 px, and to 280 at the other end.
  await page.evaluate(() => (globalThis as unknown as { __viz: { setPanelWidth(n: number): void } }).__viz.setPanelWidth(5000));
  expect((await vizState(page)).panelWidth).toBe(720);

  await handle.focus();
  await page.keyboard.press('ArrowRight');
  expect((await vizState(page)).panelWidth).toBe(704);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  expect((await vizState(page)).panelWidth).toBe(720);

  await page.reload();
  await expect.poll(async () => (await vizState(page)).panelWidth).toBe(720);
  await page.locator('#panel-resize').dblclick();
  await expect.poll(async () => (await vizState(page)).panelWidth).toBe(360);
});

test('a feed row opens the detail drawer; arrows move between events and Esc closes it', async ({ page, request }) => {
  await openViewer(page, PORT);
  await postRead(request);
  const row = page.locator('#feed .row').filter({ hasText: 'src/api/user.ts' }).first();
  await expect(row).toBeVisible();
  await row.click();
  const drawer = page.locator('#detail');
  await expect(drawer).toHaveClass(/open/);
  const opened = (await vizState(page)).detail;
  expect(opened).not.toBeNull();
  await expect(drawer.locator('.detail-path code').first()).toHaveText('src/api/user.ts');
  await expect(drawer.getByRole('button', { name: 'Show in graph' })).toBeVisible();
  // The main agent has no label in the feed.
  await expect(row.locator('.agent')).toHaveText('');

  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await vizState(page)).detail).not.toBe(opened);
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await vizState(page)).detail).toBe(opened);

  await drawer.getByRole('button', { name: 'Show in graph' }).click();
  await expect.poll(async () => (await vizState(page)).active).toContain('src/api/user.ts');

  await page.keyboard.press('Escape');
  await expect(drawer).not.toHaveClass(/open/);
  expect((await vizState(page)).detail).toBeNull();

  // A file node click opens its history in the same drawer.
  await page.evaluate(() => (globalThis as unknown as { __viz: { openFile(p: string): void } }).__viz.openFile('src/api/user.ts'));
  await expect(drawer).toHaveClass(/open/);
  expect((await vizState(page)).detailPath).toBe('src/api/user.ts');
  await expect(drawer.locator('.detail-event').first()).toBeVisible();
  await drawer.locator('.detail-event').first().click();
  await expect.poll(async () => (await vizState(page)).detail).not.toBeNull();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(drawer).not.toHaveClass(/open/);
});

test('the floating stream shows the file being read and opens its detail', async ({ page, request }) => {
  await openViewer(page, PORT);
  expect((await vizState(page)).streamOn).toBe(true);
  await postRead(request);
  const line = page.locator('#stream .stream-line').filter({ hasText: 'src/api/user.ts' });
  await expect(line).toHaveCount(1);
  await expect(line).toContainText('Reading');
  // Pre and Post of the same call share one line.
  await expect.poll(async () => (await vizState(page)).stream.filter((s) => s.text === 'Reading src/api/user.ts').length).toBe(1);
  await line.locator('button').click();
  await expect(page.locator('#detail')).toHaveClass(/open/);
  await page.keyboard.press('Escape');

  await page.locator('#f-stream').uncheck();
  await expect(page.locator('#stream')).toBeHidden();
  expect((await vizState(page)).stream).toEqual([]);
  await page.locator('#f-stream').check();
});

test('tools counters: skill, MCP server and tool, CLI programs and Claude tools', async ({ page, request }) => {
  await openViewer(page, PORT);
  for (const line of skillMcp) await postHook(request, PORT, line);
  await expect
    .poll(async () => {
      const s = await vizState(page);
      return { skill: s.tools.skills.humanizer ?? 0, mcp: s.tools.mcp.context7?.['resolve-library-id'] ?? 0 };
    })
    .toEqual({ skill: 1, mcp: 1 });
  const tools = page.locator('#tools');
  await expect(tools.locator('[data-tools="skills"] [data-tool="humanizer"]')).toContainText('1');
  await expect(tools.locator('[data-tools="mcp"] [data-tool="context7"]')).toBeVisible();
  await expect(tools.locator('[data-tools="mcp"] [data-tool="context7/resolve-library-id"]')).toContainText('1');
  // run1 (posted by live.spec and above) ran Bash (find, grep...) and Read.
  const s = await vizState(page);
  expect(s.tools.builtin.Read ?? 0).toBeGreaterThan(0);
  expect(Object.keys(s.tools.cli).length).toBeGreaterThan(0);
  // Skill and MCP rows and chips.
  await expect(page.locator('#feed .row .chip-action', { hasText: /^skill$/ }).first()).toBeVisible();
  await expect(page.locator('#feed .row .chip-action', { hasText: /^MCP$/ }).first()).toBeVisible();
  await expect(page.locator('#legend li', { hasText: /^MCP$/ })).toHaveCount(1);

  // The session filter narrows the tools too.
  const other = (JSON.parse(run1[0]!) as { session_id: string }).session_id;
  await page.evaluate((id) => (globalThis as unknown as { __viz: { setFilters(f: { session: string }): void } }).__viz.setFilters({ session: id }), other);
  await expect.poll(async () => (await vizState(page)).tools.skills.humanizer ?? 0).toBe(0);
  await expect(tools.locator('[data-tools="skills"] .tool-empty')).toHaveText('No skills used yet.');
});

test('collapsing and expanding a folder gives a toast and keeps the layout calm', async ({ page }) => {
  // A tiny budget collapses the probe repo's folders.
  await openViewer(page, PORT, '?budget=4');
  const s0 = await vizState(page);
  expect(s0.visibleNodeCount).toBeLessThan(s0.nodeCount);
  await page.evaluate(() => (globalThis as unknown as { __viz: { toggleCollapse(id: string): void } }).__viz.toggleCollapse('src'));
  await expect(page.locator('#toasts .toast').last()).toHaveText(/^Opened src: \d+ items?$/);
  await expect.poll(async () => (await vizState(page)).visibleNodeCount).toBeGreaterThan(s0.visibleNodeCount);
  await page.evaluate(() => (globalThis as unknown as { __viz: { toggleCollapse(id: string): void } }).__viz.toggleCollapse('src'));
  await expect(page.locator('#toasts .toast').last()).toHaveText('Collapsed src');
});

/** The CSS animation-name of an element (the spec compiles without the DOM lib). */
const animationName = (el: unknown): string =>
  (globalThis as unknown as { getComputedStyle(e: unknown): { animationName: string } }).getComputedStyle(el).animationName;

test('new stream lines and toasts play their entry animation', async ({ page, request }) => {
  await openViewer(page, PORT);
  await postRead(request);
  const line = page.locator('#stream .stream-line').filter({ hasText: 'src/api/user.ts' }).first();
  await expect(line).toBeVisible();
  // A keyframe animation runs on insertion; a class removed in the next frame never did.
  expect(await line.evaluate(animationName)).toBe('stream-enter');
  await page.evaluate(() => (globalThis as unknown as { __viz: { toggleCollapse(id: string): void } }).__viz.toggleCollapse('src'));
  const toast = page.locator('#toasts .toast').last();
  await expect(toast).toBeVisible();
  expect(await toast.evaluate(animationName)).toBe('toast-enter');
  await page.evaluate(() => (globalThis as unknown as { __viz: { toggleCollapse(id: string): void } }).__viz.toggleCollapse('src'));
});

test('new events for the open file history keep the keyboard focus', async ({ page, request }) => {
  await openViewer(page, PORT);
  await postRead(request);
  await page.evaluate(() => (globalThis as unknown as { __viz: { openFile(p: string): void } }).__viz.openFile('src/api/user.ts'));
  const drawer = page.locator('#detail');
  const count = drawer.locator('.detail-count');
  await expect(count).toBeVisible();
  const before = await count.textContent();
  const focused = drawer.locator('.detail-event').nth(1);
  await focused.focus();
  const key = await focused.getAttribute('data-focus-key');
  expect(key).toMatch(/^event:/);
  await postRead(request);
  await expect(count).not.toHaveText(before!);
  const activeKey = () =>
    page.evaluate(() => (globalThis as unknown as { document: { activeElement: { getAttribute(n: string): string | null } | null } }).document.activeElement?.getAttribute('data-focus-key'));
  expect(await activeKey()).toBe(key);
  await page.keyboard.press('Escape');
  await expect(drawer).not.toHaveClass(/open/);
});

test('a refused call is worded by the viewer, in its language', async ({ page, request }) => {
  await openViewer(page, PORT);
  const sessionId = (JSON.parse(run1[5]!) as { session_id: string }).session_id;
  const denied = (id: string) =>
    JSON.stringify({ session_id: sessionId, cwd: e2eRepo('live'), hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'curl -s https://example.com' } });
  await postHook(request, PORT, denied('deny-e2e-1'));
  await expect(page.locator('#feed .row .path').filter({ hasText: 'denied · curl -s https://example.com' })).toHaveCount(1);
  await page.locator('[data-lang="es"]').click();
  await expect(page.locator('#feed .row .path').filter({ hasText: 'denegado · curl -s https://example.com' })).toHaveCount(1);
  await page.locator('[data-lang="en"]').click();
});
