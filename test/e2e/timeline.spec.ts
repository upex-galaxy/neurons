// Timeline view against the real CLI: run1 posted under a fresh session id (so the counts
// do not depend on what other specs posted), then the "Timeline" toggle; and the replay
// server, where the timeline follows the playback clock and a seek.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { E2E_PORTS, e2eDir, e2eRepo, fixturePayloads } from '../../scripts/e2e/fixtures.mjs';
import { openViewer, postHook, vizState } from './helpers.ts';

test.describe.configure({ mode: 'serial' });
test.use({ locale: 'en-US' });

type Viz = { __viz: { setFilters(f: Record<string, unknown>): void; setView(v: string): void; replay: { seek(f: number): void; pause(): void } } };

test('live: the Timeline lists the touched files as rows and every event as a mark', async ({ page, request }) => {
  const port = E2E_PORTS.live;
  const session = randomUUID();
  const repo = e2eRepo('live');
  const home = path.join(e2eDir(), 'live', 'home');
  const lines = fixturePayloads('run1.jsonl', repo, home).map((l) => JSON.stringify({ ...JSON.parse(l), session_id: session }));

  await openViewer(page, port);
  for (const line of lines) await postHook(request, port, line);
  await expect.poll(async () => (await vizState(page)).feed.filter((f) => f.action === 'turn_end').length).toBeGreaterThan(0);
  await page.evaluate((id) => (globalThis as unknown as Viz).__viz.setFilters({ session: id }), session);

  await page.locator('[data-view="timeline"]').click();
  await expect(page.locator('#timeline')).toBeVisible();
  await expect(page.locator('[data-view="timeline"]')).toHaveAttribute('aria-pressed', 'true');
  expect((await vizState(page)).view).toBe('timeline');

  await expect.poll(async () => (await vizState(page)).timeline.marks, { timeout: 5_000 }).toBeGreaterThanOrEqual(20);
  const s = await vizState(page);
  // CLAUDE.md, the root (find, failed cat), two reads, two rules, edit, create, delete, move
  // (both ends) and the subagent's read; a few may be classified differently by the tree.
  expect(s.timeline.rows).toBeGreaterThanOrEqual(8);
  expect(s.timeline.rows).toBe(s.timeline.rowPaths.length);
  expect(s.timeline.rowPaths).toEqual(expect.arrayContaining(['src/api/user.ts', 'src/utils/format.ts', 'src/api/order.ts']));
  // First touch order: the Read of user.ts comes before the Read of format.ts.
  expect(s.timeline.rowPaths.indexOf('src/api/user.ts')).toBeLessThan(s.timeline.rowPaths.indexOf('src/utils/format.ts'));
  expect(s.timeline.turns).toBe(1);
  expect(s.timeline.agents).toBe(1);
  expect(s.timeline.following).toBe(true);
  await expect(page.locator('.tl-empty')).toBeHidden();
  await expect(page.locator('#graph')).toBeHidden();

  // Language toggle relabels the controls.
  await expect(page.locator('[data-tl="follow"]')).toHaveText('Follow live');
  await page.locator('[data-lang="es"]').click();
  await expect(page.locator('[data-tl="follow"]')).toHaveText('Seguir en vivo');
  await expect(page.locator('[data-view="timeline"]')).toHaveText('Línea de tiempo');
  await page.locator('[data-lang="en"]').click();

  // Filters reach the timeline: no agent matches, so the empty state explains why.
  await page.evaluate(() => (globalThis as unknown as Viz).__viz.setFilters({ agent: 'no-such-agent' }));
  await expect(page.locator('.tl-empty')).toBeVisible();
  await expect(page.locator('.tl-empty-title')).toHaveText('Nothing matches the filters');
  await expect.poll(async () => (await vizState(page)).timeline.rows).toBe(0);
  await page.evaluate(() => (globalThis as unknown as Viz).__viz.setFilters({ agent: '' }));
  await expect.poll(async () => (await vizState(page)).timeline.rows).toBe(s.timeline.rows);

  // The choice survives a reload; 3D comes back with its canvas.
  await page.reload();
  await expect.poll(async () => (await vizState(page)).view).toBe('timeline');
  await page.locator('[data-view="3d"]').click();
  await expect(page.locator('#timeline')).toBeHidden();
  await expect(page.locator('#graph')).toBeVisible();
  expect((await vizState(page)).view).toBe('3d');
});

test('replay: the Timeline grows with playback and follows a seek', async ({ page }) => {
  await openViewer(page, E2E_PORTS.replay, '?view=timeline');
  expect((await vizState(page)).view).toBe('timeline');
  await expect(page.locator('[data-tl="follow"]')).toHaveText('Follow playback');
  await expect
    .poll(async () => {
      const s = await vizState(page);
      return s.replay.total > 0 && !s.replay.playing && s.replay.index === s.replay.total;
    }, { timeout: 20_000 })
    .toBe(true);
  const done = (await vizState(page)).timeline;
  expect(done.rows).toBeGreaterThanOrEqual(8);
  expect(done.marks).toBeGreaterThanOrEqual(20);
  expect(done.turns).toBe(1);

  // The log opens with a quiet stretch before the first hook: seek past it.
  await page.evaluate(() => (globalThis as unknown as Viz).__viz.replay.seek(0.7));
  await expect
    .poll(async () => {
      const m = (await vizState(page)).timeline.marks;
      return m > 0 && m < done.marks;
    })
    .toBe(true);
});
