import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { route } from '../../src/cli/args.ts';
import { CliError } from '../../src/cli/output.ts';
import { DEFAULT_PORT } from '../../src/shared/types.ts';
import { setLang } from '../../src/i18n.ts';

// The messages asserted below are the Spanish ones.
setLang('es');

const dirs = new Set(['api', '../otro', '/abs/repo', 'start']);
const isDir = (p: string) => dirs.has(p);

function run(argv: string[]) {
  const r = route(argv, isDir);
  if (r.kind !== 'run') throw new Error(`expected run, got ${r.kind}`);
  return r;
}

function failure(argv: string[]): string {
  try {
    route(argv, isDir);
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    return (e as Error).message;
  }
  throw new Error('expected a CliError');
}

describe('route', () => {
  it('no command is start on the current directory', () => {
    const r = run([]);
    expect(r.command).toBe('start');
    expect(r.positionals).toEqual([]);
    expect(r.opts).toMatchObject({ port: DEFAULT_PORT, portGiven: false, open: true, install: true, bashDiff: true, strictPort: false });
  });

  it('options alone still route to start', () => {
    const r = run(['--no-open', '--port', '8080', '--strict-port', '--no-bash-diff', '--no-install']);
    expect(r.command).toBe('start');
    expect(r.opts).toMatchObject({ port: 8080, portGiven: true, open: false, install: false, bashDiff: false, strictPort: true });
  });

  it('an existing directory that is not a command is start <dir>', () => {
    expect(run(['api', '--no-open'])).toMatchObject({ command: 'start', positionals: ['api'], opts: { open: false } });
    expect(run(['../otro'])).toMatchObject({ command: 'start', positionals: ['../otro'] });
    expect(run(['/abs/repo'])).toMatchObject({ command: 'start', positionals: ['/abs/repo'] });
  });

  it('command names win over directories with the same name', () => {
    expect(run(['start'])).toMatchObject({ command: 'start', positionals: [] });
    expect(run(['start', 'api'])).toMatchObject({ command: 'start', positionals: ['api'] });
  });

  it('routes every command with its positionals', () => {
    for (const c of ['install', 'uninstall', 'replay', 'doctor', 'ls', 'stop', 'open'] as const) {
      expect(run([c, 'x'])).toMatchObject({ command: c, positionals: ['x'] });
    }
    expect(run(['stop', '--all', '--force']).opts).toMatchObject({ all: true, force: true });
    expect(run(['stop']).opts).toMatchObject({ all: false, force: false });
  });

  it('help, --help and -h show help; -v shows the version', () => {
    expect(route(['help'], isDir)).toEqual({ kind: 'help' });
    expect(route(['--help'], isDir)).toEqual({ kind: 'help' });
    expect(route(['-h'], isDir)).toEqual({ kind: 'help' });
    expect(route(['stop', '-h'], isDir)).toEqual({ kind: 'help' });
    expect(route(['-v'], isDir)).toEqual({ kind: 'version' });
    expect(route(['--version'], isDir)).toEqual({ kind: 'version' });
  });

  it('an unknown command that is not a directory fails in Spanish with a hint', () => {
    const typo = failure(['stpo']);
    expect(typo).toContain('Comando desconocido: "stpo".');
    expect(typo).toContain('¿Quisiste decir "neu stop"?');
    expect(typo).toContain('neu --help');

    const missingDir = failure(['./no-existe']);
    expect(missingDir).toContain('Comando desconocido: "./no-existe".');
    expect(missingDir).toContain('no existe');

    const far = failure(['zzzzzzzz']);
    expect(far).not.toContain('Quisiste');
    expect(far).toContain('neu --help');
  });

  it('a word that names an existing file says it is a file, and a .jsonl points to replay', () => {
    const isFile = (p: string) => p === 'README.md' || p === 'events.jsonl';
    const msg = (argv: string[]): string => {
      try {
        route(argv, () => false, isFile);
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error('route did not fail');
    };
    const readme = msg(['README.md']);
    expect(readme).toContain('Comando desconocido: "README.md".');
    expect(readme).toContain(`${path.resolve('README.md')} es un archivo, no una carpeta.`);
    expect(readme).not.toContain('no existe');
    expect(readme).not.toContain('replay');
    expect(msg(['events.jsonl'])).toContain('neu replay events.jsonl');
  });

  it('rejects unknown options and bad ports in Spanish', () => {
    expect(failure(['--nope'])).toContain('Ejecutá "neu --help"');
    expect(failure(['--port', 'abc'])).toContain('Puerto inválido');
    expect(failure(['start', '--port', '70000'])).toContain('Puerto inválido');
  });
});
