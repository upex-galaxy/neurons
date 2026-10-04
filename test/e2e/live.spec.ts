// Live mode against the real CLI: real hook payloads (docs/PAYLOADS.md) POSTed to /hook
// and checked in the panel (Spanish labels) and in window.__vizState.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { E2E_PORTS, SENTINEL_SETTINGS, e2eDir, e2eRepo, fixturePayloads } from '../../scripts/e2e/fixtures.mjs';
import { counter, isSoftwareRenderer, openViewer, postHook, sleep, vizState, webglRenderer } from './helpers.ts';

const PORT = E2E_PORTS.live;
const AGENT_ID = 'aa2b318dfea4c1d08';
const NEW_FILE = 'src/api/health.ts';

test.describe.configure({ mode: 'serial' });
// The assertions read the Spanish labels: a Spanish browser picks them (web/src/i18n.ts).
test.use({ locale: 'es-AR' });

let repo: string;
let run1: string[];
let run3: string[];

test.beforeAll(() => {
  repo = e2eRepo('live');
  const home = path.join(e2eDir(), 'live', 'home');
  run1 = fixturePayloads('run1.jsonl', repo, home);
  run3 = fixturePayloads('run3.jsonl', repo, home);
});

/** run1 line i, checked against the event we expect there so a fixture change fails loudly. */
function r1(i: number, hook: string, tool?: string): string {
  const line = run1[i]!;
  const p = JSON.parse(line) as { hook_event_name: string; tool_name?: string };
  expect(p.hook_event_name).toBe(hook);
  if (tool) expect(p.tool_name).toBe(tool);
  return line;
}

/** "#rrggbb" as getComputedStyle prints it. */
function rgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

// First on purpose: the server is fresh, so these are the only two sessions it has seen.
test('two sessions in the same repo: one tint per session in the state and the feed', async ({ page, request }) => {
  await openViewer(page, PORT);
  const s1 = (JSON.parse(run1[0]!) as { session_id: string }).session_id;
  const s2 = '7c1e5a90-0b6e-4d3f-9a43-2f6c1d8e7b21';
  const asS2 = (l: string) => l.replaceAll(s1, s2);

  await postHook(request, PORT, r1(5, 'PreToolUse', 'Read'));
  await postHook(request, PORT, r1(6, 'PostToolUse', 'Read'));
  await postHook(request, PORT, asS2(run1[5]!));
  await postHook(request, PORT, asS2(run1[6]!));

  await expect.poll(async () => Object.keys((await vizState(page)).sessionColors).sort()).toEqual([s1, s2].sort());
  await expect.poll(async () => (await vizState(page)).multiSession).toBe(true);
  const colors = (await vizState(page)).sessionColors;
  expect(colors[s1]).not.toBe(colors[s2]);

  // Panel: "Sesiones" line with one chip per session, and feed borders in the session hue.
  await expect(page.locator('#session-legend')).toBeVisible();
  await expect(page.locator('#session-legend .sess-chip')).toHaveCount(2);
  const rowOf = (id: string) => page.locator('#feed .row').filter({ has: page.locator(`.sess[title="Sesión ${id}"]`) }).first();
  await expect(rowOf(s1)).toHaveCSS('border-left-color', rgb(colors[s1]!));
  await expect(rowOf(s2)).toHaveCSS('border-left-color', rgb(colors[s2]!));
  await expect(rowOf(s2)).toHaveCSS('border-left-width', '3px');
  // The action chip keeps the action color (lectura is cyan in both sessions).
  const chip = rowOf(s2).locator('.chip-action');
  await expect(chip).toHaveText('lectura');
  await expect(chip).toHaveCSS('color', rgb('#22d3ee'));
});

test('real hooks: feed, counters, active, created and deleted nodes', async ({ page, request }) => {
  await openViewer(page, PORT);
  const base = await vizState(page);
  const feedRow = (chip: string, p: string) =>
    page.locator('#feed .row').filter({ has: page.locator('.chip-action', { hasText: new RegExp(`^${chip}$`) }) }).filter({ hasText: p });

  await test.step('contexto, turno y búsqueda por Bash', async () => {
    for (let i = 0; i <= 4; i++) await postHook(request, PORT, run1[i]!);
    await expect(feedRow('contexto', 'CLAUDE.md').first()).toBeVisible();
    await expect(feedRow('búsqueda', '').first()).toBeVisible();
  });

  await test.step('Read ilumina el archivo en menos de 300 ms', async () => {
    await postHook(request, PORT, r1(5, 'PreToolUse', 'Read'));
    await postHook(request, PORT, r1(6, 'PostToolUse', 'Read'));
    await expect.poll(async () => (await vizState(page)).active, { timeout: 2_000 }).toContain('src/api/user.ts');
    await expect(feedRow('lectura', 'src/api/user.ts').first()).toBeVisible();
    const latency = (await vizState(page)).lastEventLatencyMs;
    expect(latency).not.toBeNull();
    // The 300 ms bar holds on a GPU. Software WebGL (SwiftShader on the Linux CI runner)
    // renders the 3D view at a few fps and the main thread waits behind each frame: there
    // the bound only catches a stalled pipeline (DECISIONS I53).
    const renderer = await webglRenderer(page);
    const bound = isSoftwareRenderer(renderer) ? 1_000 : 300;
    test.info().annotations.push({ type: 'latencia', description: `${latency} ms (POST /hook -> primer destello), renderer="${renderer}", límite ${bound} ms` });
    expect(latency!).toBeLessThan(bound);
  });

  await test.step('lectura, contexto anidado y edición', async () => {
    for (let i = 7; i <= 14; i++) await postHook(request, PORT, run1[i]!);
    await expect(feedRow('edición', 'src/api/user.ts').first()).toBeVisible();
  });

  await test.step('Write crea el nodo', async () => {
    await postHook(request, PORT, r1(15, 'PreToolUse', 'Write'));
    // Like Claude Code: the file lands on disk between Pre and Post.
    fs.writeFileSync(path.join(repo, NEW_FILE), 'export const ok = true;\n');
    await postHook(request, PORT, r1(16, 'PostToolUse', 'Write'));
    await postHook(request, PORT, r1(17, 'PostToolBatch'));
    await expect.poll(async () => (await vizState(page)).created, { timeout: 3_000 }).toContain(NEW_FILE);
    await expect(feedRow('creación', NEW_FILE).first()).toBeVisible();
  });

  await test.step('rm, git mv, comando fallido y subagente', async () => {
    for (let i = 18; i <= 38; i++) await postHook(request, PORT, run1[i]!);
    await expect(feedRow('fallo', 'cat does-not-exist.txt').first()).toBeVisible();
    await expect(page.locator('#f-agent option', { hasText: 'general-purpose' })).toHaveCount(1);
    await expect(page.locator(`#f-agent option[value="${AGENT_ID}"]`)).toHaveCount(1);
    await expect(feedRow('lectura', 'src/api/order.ts').filter({ hasText: 'general-purpose' }).first()).toBeVisible();
  });

  await test.step('rm con bashEditDiff quita el nodo creado', async () => {
    // run3's `rm src/utils/legacy.ts` (with bashEditDiff) aimed at the file created above.
    const retarget = (l: string) => l.replaceAll('src/utils/legacy.ts', NEW_FILE);
    for (let i = 0; i <= 3; i++) await postHook(request, PORT, run3[i]!);
    await postHook(request, PORT, retarget(run3[4]!));
    fs.rmSync(path.join(repo, NEW_FILE));
    await postHook(request, PORT, retarget(run3[5]!));
    await postHook(request, PORT, run3[6]!);
    await expect.poll(async () => (await vizState(page)).removed, { timeout: 3_000 }).toContain(NEW_FILE);
    await expect(feedRow('borrado', NEW_FILE).first()).toBeVisible();
    for (let i = 10; i <= 11; i++) await postHook(request, PORT, run3[i]!);
  });

  await test.step('contadores', async () => {
    await expect
      .poll(async () => {
        const s = await vizState(page);
        return {
          read: counter(s, 'read') - counter(base, 'read') >= 3,
          search: counter(s, 'search') > counter(base, 'search'),
          edit: counter(s, 'edit') > counter(base, 'edit'),
          create: counter(s, 'create') > counter(base, 'create'),
          delete: counter(s, 'delete') > counter(base, 'delete'),
          subagent: counter(s, 'subagent_start') > counter(base, 'subagent_start'),
          fail: s.failCount > base.failCount,
        };
      })
      .toEqual({ read: true, search: true, edit: true, create: true, delete: true, subagent: true, fail: true });
    // The panel shows the same numbers.
    const s = await vizState(page);
    await expect(page.locator('[data-counter="read"]')).toHaveText(String(counter(s, 'read')));
    await expect(page.locator('[data-counter="fail"]')).not.toHaveText('0');
  });

  await test.step('sin contenido de archivos ni hooks instalados', async () => {
    // Text that only exists inside file contents and stdout of the payloads.
    await expect(page.locator('body')).not.toContainText('validate id');
    const log = fs.readFileSync(path.join(repo, '.neurons', 'events.jsonl'), 'utf8');
    expect(log).not.toContain('validate id');
    expect(log).not.toContain('export const ok');
    // start --no-install touches neither the repo settings nor the user config.
    expect(fs.existsSync(path.join(repo, '.claude', 'settings.local.json'))).toBe(false);
    expect(fs.readFileSync(path.join(e2eDir(), 'live', 'claude-config', 'settings.json'), 'utf8')).toBe(SENTINEL_SETTINGS);
  });
});

test('an external disk change shows as external and hides with the toggle', async ({ page }) => {
  await openViewer(page, PORT);
  // Past the 600 ms grace of the last Bash window of the previous test.
  await sleep(800);
  const rel = 'notes-external.md';
  fs.writeFileSync(path.join(repo, rel), 'external\n');

  await expect
    .poll(async () => (await vizState(page)).feed.some((f) => f.path === rel && f.external === true), { timeout: 5_000 })
    .toBe(true);
  const row = page.locator('#feed .row.external', { hasText: rel });
  await expect(row.first()).toBeVisible();
  await expect(row.first().locator('.chip-action')).toHaveText('creación ext.');
  await expect.poll(async () => (await vizState(page)).created, { timeout: 3_000 }).toContain(rel);

  await page.locator('#f-external').uncheck();
  await expect(page.locator('#feed .row.external')).toHaveCount(0);
  expect((await vizState(page)).feed.some((f) => f.path === rel)).toBe(true);

  await page.locator('#f-external').check();
  await expect(row.first()).toBeVisible();
  fs.rmSync(path.join(repo, rel));
});

test('the "Reproducir log" button replays the live log', async ({ page }) => {
  await openViewer(page, PORT);
  await page.getByRole('button', { name: 'Reproducir log' }).click();
  await expect.poll(async () => (await vizState(page)).replay.active).toBe(true);
  await expect(page.locator('#replay-bar')).toBeVisible();
  await expect(page.locator('#mode')).toHaveText('Repetición');
  await page.locator('[data-speed="5"]').click();
  await expect.poll(async () => (await vizState(page)).replay.index, { timeout: 15_000 }).toBeGreaterThan(0);
  const s = await vizState(page);
  expect(s.replay.total).toBeGreaterThan(40);
  expect(s.replay.speed).toBe(5);
  await expect(page.locator('#feed .row').first()).toBeVisible();

  await page.getByRole('button', { name: 'Volver al vivo' }).click();
  await expect.poll(async () => (await vizState(page)).replay.active).toBe(false);
  await expect(page.locator('#mode')).toHaveText('En vivo');
  await expect.poll(async () => (await vizState(page)).connected).toBe(true);
});
