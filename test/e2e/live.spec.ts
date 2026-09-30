// Live mode against the real CLI: real hook payloads (docs/PAYLOADS.md) POSTed to /hook
// and checked in the panel (Spanish labels) and in window.__vizState.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { E2E_PORTS, SENTINEL_SETTINGS, e2eDir, e2eRepo, fixturePayloads } from '../../scripts/e2e/fixtures.mjs';
import { counter, openViewer, postHook, sleep, vizState } from './helpers.ts';

const PORT = E2E_PORTS.live;
const AGENT_ID = 'aa2b318dfea4c1d08';
const NEW_FILE = 'src/api/health.ts';

test.describe.configure({ mode: 'serial' });

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

test('hooks reales: feed, contadores, nodos activos, creados y borrados', async ({ page, request }) => {
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
    test.info().annotations.push({ type: 'latencia', description: `${latency} ms (POST /hook -> primer destello)` });
    expect(latency!).toBeLessThan(300);
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
    const log = fs.readFileSync(path.join(repo, '.repo-synapse', 'events.jsonl'), 'utf8');
    expect(log).not.toContain('validate id');
    expect(log).not.toContain('export const ok');
    // start --no-install touches neither the repo settings nor the user config.
    expect(fs.existsSync(path.join(repo, '.claude', 'settings.local.json'))).toBe(false);
    expect(fs.readFileSync(path.join(e2eDir(), 'live', 'claude-config', 'settings.json'), 'utf8')).toBe(SENTINEL_SETTINGS);
  });
});

test('un cambio externo en disco aparece como externo y se oculta con el toggle', async ({ page }) => {
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

test('el botón "Reproducir log" reproduce el registro en vivo', async ({ page }) => {
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
