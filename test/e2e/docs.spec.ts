// The docs pages (guide and architecture) in both languages: served by the viewer at /help
// and /architecture, and opened straight from disk (file://), where browsers block fetch and
// the pages fall back to their embedded dictionaries.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { E2E_PORTS } from '../../scripts/e2e/fixtures.mjs';
import { baseUrl } from './helpers.ts';

const PORT = E2E_PORTS.live;
const DOCS = path.resolve(import.meta.dirname, '../../docs');
const fileUrl = (page: string, query = ''): string => pathToFileURL(path.join(DOCS, page)).href + query;

const ARCH_H1 = { en: 'How the network lights up', es: 'Cómo se enciende la red' };

test.describe('opened from disk', () => {
  test.use({ locale: 'es-AR' });

  test('the architecture page switches language with no server', async ({ page }) => {
    await page.goto(fileUrl('architecture.html'));
    await expect(page.locator('h1')).toHaveText(ARCH_H1.es);
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await expect(page.locator('[data-lang="es"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('[data-lang="en"]').click();
    await expect(page.locator('h1')).toHaveText(ARCH_H1.en);
    await page.locator('[data-lang="es"]').click();
    await expect(page.locator('h1')).toHaveText(ARCH_H1.es);
    await expect(page.locator('[data-lang="es"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('diagram announcements follow the page language', async ({ page }) => {
    await page.goto(fileUrl('architecture.html', '?lang=es'));
    const figure = page.locator('#lifecycle [data-motion-root]');
    const status = figure.locator('[data-motion-status]');
    await figure.locator('[data-motion-action="pause"]').click();
    await expect(status).toHaveText(/^En pausa en el paso \d+ de 8$/);
    await figure.locator('.diagram-container').focus();
    await page.keyboard.press('Home');
    await expect(status).toHaveText('Paso 0 de 8: Listo');
    await page.keyboard.press('ArrowRight');
    await expect(status).toHaveText(/^Paso 1 de 8: \S/);
    // The step label comes from the translated aria-labels, not the English markup.
    const es = (await status.textContent())!.replace(/^Paso 1 de 8: /, '');
    await page.locator('[data-lang="en"]').click();
    await expect(status).toHaveText(/^Step 1 of 8: \S/);
    expect((await status.textContent())!.replace(/^Step 1 of 8: /, '')).not.toBe(es);
  });
});

test.describe('served by the viewer', () => {
  test.use({ locale: 'en-US' });

  test('?lang= picks the language of both docs pages', async ({ page }) => {
    await page.goto(`${baseUrl(PORT)}/help?lang=es`);
    await expect(page.locator('h1')).toHaveText('Mirá lo que hace Claude Code en tu repo, mientras lo hace');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await page.goto(`${baseUrl(PORT)}/architecture?lang=es`);
    await expect(page.locator('h1')).toHaveText(ARCH_H1.es);
    await page.goto(`${baseUrl(PORT)}/help`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });
});
