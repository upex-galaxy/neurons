// `neu replay` on a log recorded by the real server (scripts/e2e/serve.mjs posts
// the run1 payloads 200 ms apart, so the timeline lasts about 8 s at 1x).
import { expect, test } from '@playwright/test';
import { E2E_PORTS } from '../../scripts/e2e/fixtures.mjs';
import { openViewer, sleep, vizState } from './helpers.ts';

const PORT = E2E_PORTS.replay;
// The assertions read the Spanish labels: a Spanish browser picks them (web/src/i18n.ts).
test.use({ locale: 'es-AR' });

test('replay: playback advances, pauses and honors the speed', async ({ page }) => {
  await openViewer(page, PORT);
  await expect(page.locator('#mode')).toHaveText('Repetición');
  await expect(page.locator('#replay-bar')).toBeVisible();
  // Replay mode has no live view to go back to.
  await expect(page.locator('#rp-exit')).toBeHidden();

  await expect.poll(async () => (await vizState(page)).replay.total).toBeGreaterThan(40);
  const first = await vizState(page);
  expect(first.mode).toBe('replay');
  expect(first.replay.durationMs).toBeGreaterThan(6_000);

  const elapsed = async () => (await vizState(page)).replay.elapsedMs;

  await test.step('1x', async () => {
    await page.getByRole('button', { name: 'Reiniciar' }).click();
    await expect(page.locator('[data-speed="1"]')).toHaveAttribute('aria-pressed', 'true');
    const a = await elapsed();
    await sleep(800);
    const d1 = (await elapsed()) - a;
    test.info().annotations.push({ type: 'avance 1x', description: `${d1} ms en 800 ms` });
    expect(d1).toBeGreaterThan(400);
    expect(d1).toBeLessThan(1_300);
  });

  await test.step('pausa', async () => {
    await expect(page.locator('#rp-play')).toHaveText('Pausa');
    await page.locator('#rp-play').click();
    await expect.poll(async () => (await vizState(page)).replay.playing).toBe(false);
    const a = await elapsed();
    await sleep(400);
    expect(await elapsed()).toBe(a);
  });

  await test.step('5x', async () => {
    await page.locator('[data-speed="5"]').click();
    await expect(page.locator('[data-speed="5"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#rp-play')).toHaveText('Reproducir');
    await page.locator('#rp-play').click();
    const a = await elapsed();
    await sleep(600);
    const s = await vizState(page);
    const d5 = s.replay.elapsedMs - a;
    test.info().annotations.push({ type: 'avance 5x', description: `${d5} ms en 600 ms` });
    // 5x of 600 ms, or the end of the timeline if it came first.
    expect(d5 >= 2_000 || s.replay.elapsedMs === s.replay.durationMs).toBe(true);
    expect(s.replay.speed).toBe(5);
  });

  await test.step('termina con todos los eventos aplicados', async () => {
    await expect
      .poll(async () => {
        const s = await vizState(page);
        return !s.replay.playing && s.replay.index === s.replay.total;
      }, { timeout: 15_000 })
      .toBe(true);
    await expect(page.locator('#rp-progress')).toHaveAttribute('aria-valuenow', '100');
    await expect(page.locator('#feed .row .chip-action', { hasText: 'lectura' }).first()).toBeVisible();
    await expect(page.locator('#feed .row .chip-action', { hasText: /^fallo$/ }).first()).toBeVisible();
    const s = await vizState(page);
    // The replayed Write created health.ts.
    expect(s.created).toContain('src/api/health.ts');
  });
});
