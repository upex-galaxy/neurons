import { describe, expect, it } from 'vitest';
import { browserCommand, shellArg, shutdownSignals } from '../../src/cli/platform.ts';

describe('CLI platform helpers', () => {
  it('opens the browser with open, xdg-open, or cmd start with verbatim arguments', () => {
    expect(browserCommand('http://127.0.0.1:7777', 'darwin')).toEqual({ cmd: 'open', args: ['http://127.0.0.1:7777'], verbatim: false });
    expect(browserCommand('http://127.0.0.1:7777', 'linux')).toEqual({ cmd: 'xdg-open', args: ['http://127.0.0.1:7777'], verbatim: false });
    const win = browserCommand('http://127.0.0.1:7777/help', 'win32');
    expect(win.verbatim).toBe(true);
    expect(win.cmd).toMatch(/cmd(\.exe)?$/i);
    expect(win.args.at(-1)).toBe('start "" "http://127.0.0.1:7777/help"');
  });

  it('closes on SIGINT/SIGTERM/SIGHUP, plus SIGBREAK on Windows', () => {
    expect(shutdownSignals('darwin')).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP']);
    expect(shutdownSignals('linux')).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP']);
    expect(shutdownSignals('win32')).toContain('SIGBREAK');
    expect(shutdownSignals('win32')).toContain('SIGINT');
  });

  it('quotes paths for the shell of the platform', () => {
    expect(shellArg('/Users/me/repo', 'darwin')).toBe('/Users/me/repo');
    expect(shellArg("/Users/me/it's here", 'linux')).toBe(`'/Users/me/it'\\''s here'`);
    expect(shellArg('C:\\Users\\me\\repo', 'darwin')).toBe(`'C:\\Users\\me\\repo'`);
    expect(shellArg('C:\\Users\\me\\repo', 'win32')).toBe('C:\\Users\\me\\repo');
    expect(shellArg('C:\\Users\\me\\my repo', 'win32')).toBe('"C:\\Users\\me\\my repo"');
  });
});
