import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// scripts/make-demo-repo.sh is a documented user step (guide, #faq-demo-small), so its
// messages and the demo files follow the user's language like the CLI does.
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/make-demo-repo.sh');
const tmpDirs: string[] = [];

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'neu-demo-'));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** Runs the script with a clean language environment plus `langEnv`; never reads the user's git config. */
function run(target: string, langEnv: Record<string, string>) {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: path.dirname(target),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ...langEnv,
  };
  return spawnSync('bash', [SCRIPT, target], { encoding: 'utf8', env });
}

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

// On Windows `bash` may be WSL's, with other paths; the script is for macOS and Linux shells.
const unix = process.platform !== 'win32';

describe('scripts/make-demo-repo.sh', () => {
  it.runIf(unix)('speaks English by default and with NEURONS_LANG=en, also in the demo files', () => {
    const base = tmp();
    const target = path.join(base, 'demo');
    const r = run(target, {});
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`Demo repo created in ${target} (14 files)\n`);
    expect(fs.readFileSync(path.join(target, 'CLAUDE.md'), 'utf8')).toMatch(/^# Demo shop/);
    expect(fs.readFileSync(path.join(target, 'src/api/products.ts'), 'utf8')).toContain('// TODO: validate id');
    expect(fs.readFileSync(path.join(target, 'src/utils/money.ts'), 'utf8')).toContain('return `$${(cents / 100).toFixed(2)}`;');

    const again = run(target, { NEURONS_LANG: 'en', LANG: 'es_AR.UTF-8' });
    expect(again.status).toBe(1);
    expect(again.stderr).toBe(`Already exists: ${target} (delete it or pick another path)\n`);
  });

  it.runIf(unix)('speaks Spanish with NEURONS_LANG=es or a Spanish locale, with the same file names', () => {
    const base = tmp();
    const en = path.join(base, 'en');
    const es = path.join(base, 'es');
    expect(run(en, { LANG: 'C' }).status).toBe(0);
    const r = run(es, { LC_ALL: '', LC_MESSAGES: 'es_AR.UTF-8', LANG: 'en_US.UTF-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`Repo de demo creado en ${es} (14 archivos)\n`);
    expect(fs.readFileSync(path.join(es, 'CLAUDE.md'), 'utf8')).toMatch(/^# Tienda demo/);
    expect(fs.readFileSync(path.join(es, 'src/api/products.ts'), 'utf8')).toContain('// TODO: validar id');
    // The guide's prompts name paths, so both languages must create the same files.
    expect(files(es)).toEqual(files(en));
    expect(files(es)).toContain('src/utils/legacy-format.ts');

    const again = run(es, { NEURONS_LANG: 'es' });
    expect(again.status).toBe(1);
    expect(again.stderr).toBe(`Ya existe: ${es} (borralo o elegí otra ruta)\n`);
  });

  it('keeps every user-facing message in both languages', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    // Every echo goes through msg/pick; no bare hardcoded message is left.
    expect(src).not.toMatch(/^\s*echo "/m);
    for (const key of ['exists', 'created']) {
      expect(src).toContain(`es:${key})`);
      expect(src).toContain(`en:${key})`);
    }
  });
});
