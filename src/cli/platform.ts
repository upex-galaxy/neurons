// Platform differences of the CLI (macOS, Linux, Windows), kept pure so they are unit
// tested on any OS.

/**
 * How to open `url` in the default browser on `platform`, without a shell of our own:
 * `open` (macOS), `xdg-open` (Linux and the rest), and on Windows `cmd /c start "" "<url>"`
 * with verbatim arguments, since Node's quoting would turn the empty title `""` into `\"\"`.
 * Our URLs are http://127.0.0.1:<port>[/path]: nothing in them that cmd would interpret.
 */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[]; verbatim: boolean } {
  if (platform === 'darwin') return { cmd: 'open', args: [url], verbatim: false };
  if (platform === 'win32') return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `start "" "${url}"`], verbatim: true };
  return { cmd: 'xdg-open', args: [url], verbatim: false };
}

/**
 * Signals that close the viewer. Windows never delivers SIGTERM (`process.kill` there is
 * TerminateProcess, which runs no handler): Ctrl+C is SIGINT, Ctrl+Break is SIGBREAK, and
 * closing the console window is SIGHUP.
 */
export function shutdownSignals(platform: NodeJS.Platform = process.platform): NodeJS.Signals[] {
  return platform === 'win32' ? ['SIGINT', 'SIGBREAK', 'SIGHUP', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
}

/**
 * `p` ready to paste in a shell: as is when it has only plain path characters, else
 * single-quoted (POSIX shells) or double-quoted (Windows, where a path holds no `"`: cmd and PowerShell both take it).
 */
export function shellArg(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return /^[\w@%+=:,./~\\-]+$/.test(p) ? p : `"${p}"`;
  return /^[\w@%+=:,./~-]+$/.test(p) ? p : `'${p.replaceAll("'", `'\\''`)}'`;
}
