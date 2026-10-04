// Re-rooting of the recorded hook payloads (test/fixtures/payloads), whose paths were
// replaced by __REPO__ and __HOME__ when they were extracted (scripts/probe/extract-fixtures.mjs).

import path from 'node:path';

/** `s` ready to sit inside a JSON string literal (backslashes and quotes escaped). */
function jsonInner(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

/**
 * One raw payload line with `repo` and `home` in place of __REPO__ and __HOME__, spelled the
 * way Claude Code sends them on this OS: `__REPO__/src/a.ts` becomes path.join(repo, 'src/a.ts'),
 * so on Windows it is `C:\Users\...\src\a.ts` with backslashes (JSON-escaped), and on macOS
 * and Linux the same bytes as a plain substitution.
 */
export function rerootPayloadLine(line: string, repo: string, home: string): string {
  return line
    .replace(/__REPO__((?:\/[^"\s\\/]+)*)/g, (_m, rest: string) => jsonInner(rest ? path.join(repo, rest) : repo))
    .replaceAll('__HOME__', jsonInner(home));
}
