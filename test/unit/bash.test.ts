import { describe, expect, it } from 'vitest';
import { classifyBash, extractPathsFromOutput, type BashClassification } from '../../src/server/bash.ts';

process.env.CLAUDE_CONFIG_DIR = '/nonexistent/neurons-test-config';

type Row = [command: string, kind: BashClassification['kind'], pathArgs: string[], pattern?: string];

const TABLE: Row[] = [
  // Required cases
  ['cd src && rm a.ts', 'delete', ['src/a.ts']],
  ['git mv a b', 'move', ['a', 'b']],
  ['find . -name "*.ts"; grep -rn TODO .', 'search', ['.'], '*.ts'],
  ['rg -n foo src', 'search', ['src'], 'foo'],
  ['echo hi > x', 'other', []],
  // Real fixture commands
  ['find . -name "*.ts" -not -path "./node_modules/*" -not -path "./.git/*"; grep -rn "TODO" . --exclude-dir=node_modules --exclude-dir=.git', 'search', ['.'], '*.ts'],
  ['rm src/utils/legacy.ts', 'delete', ['src/utils/legacy.ts']],
  ['git mv docs/old.md docs/notes.md', 'move', ['docs/old.md', 'docs/notes.md']],
  ['cat does-not-exist.txt', 'other', []],
  // Search family
  ['grep -e foo -e bar src lib', 'search', ['src', 'lib'], 'foo'],
  ['grep -E "a|b" file.txt', 'search', ['file.txt'], 'a|b'],
  ["grep -rn 'x y' --include '*.ts' src", 'search', ['src'], 'x y'],
  ['rg -g "*.ts" foo', 'search', [], 'foo'],
  ['rg -t ts -C 2 needle packages/a packages/b', 'search', ['packages/a', 'packages/b'], 'needle'],
  ['ugrep -rn needle lib', 'search', ['lib'], 'needle'],
  ['ag foo app', 'search', ['app'], 'foo'],
  ['ls -la src', 'search', ['src']],
  ['tree -L 2 src', 'search', ['src']],
  ['git grep -n foo -- src', 'search', ['src'], 'foo'],
  ['git ls-files src docs', 'search', ['src', 'docs']],
  ['fd -e ts foo src', 'search', ['src'], 'foo'],
  ['bfs . -name "*.md"', 'search', ['.'], '*.md'],
  ['find -L src test -type f', 'search', ['src', 'test']],
  ['ls | grep foo', 'search', [], 'foo'],
  ['time command grep foo bar.txt', 'search', ['bar.txt'], 'foo'],
  ['cd /abs/dir && ls', 'search', []],
  // Delete family
  ['rm -rf dist build', 'delete', ['dist', 'build']],
  ['sudo rm -f /etc/hosts', 'delete', ['/etc/hosts']],
  ['FOO=1 BAR=2 rm x', 'delete', ['x']],
  ['git rm --cached old.ts', 'delete', ['old.ts']],
  ['unlink tmp/file', 'delete', ['tmp/file']],
  ['rmdir empty', 'delete', ['empty']],
  ['trash old.txt', 'delete', ['old.txt']],
  ['/bin/rm -- -weird-name', 'delete', ['-weird-name']],
  ['find . -name "*.tmp" -print0 | xargs -0 rm -f', 'delete', []],
  ['find src -name "*.orig" -delete', 'delete', ['src'], '*.orig'],
  ['ls src && rm -r build', 'delete', ['build']],
  ['cd src && cd api && rm x.ts', 'delete', ['src/api/x.ts']],
  ['cd src\nrm a.ts ../b.ts', 'delete', ['src/a.ts', 'b.ts']],
  ['mv a.ts b.ts && rm c.ts', 'delete', ['c.ts']],
  // Move family
  ['mv a.ts b.ts', 'move', ['a.ts', 'b.ts']],
  ['mv -t dest a b', 'move', ['a', 'b']],
  ['git -C sub mv x y', 'move', ['sub/x', 'sub/y']],
  ['cd pkg && git mv src/a.ts src/b.ts', 'move', ['pkg/src/a.ts', 'pkg/src/b.ts']],
  ['ls && mv x y', 'move', ['x', 'y']],
  // Other
  ['npm test', 'other', []],
  ['git status && git diff', 'other', []],
  ['echo "rm -rf /"', 'other', []],
  ["cat <<'EOF' > notes.md\nrm -rf /\nmv a b\nEOF", 'other', []],
  ['npx vitest run 2>&1 | tail -20', 'other', []],
  ['', 'other', []],
];

describe('classifyBash', () => {
  it.each(TABLE)('%j -> %s %j', (command, kind, pathArgs, pattern) => {
    const res = classifyBash(command);
    expect(res.kind).toBe(kind);
    expect(res.pathArgs).toEqual(pathArgs);
    if (pattern !== undefined) expect(res.pattern).toBe(pattern);
  });

  it('has at least 25 table rows', () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(25);
  });

  it('reports the leading cd directory', () => {
    expect(classifyBash('cd src && rm a.ts').cdDir).toBe('src');
    expect(classifyBash('cd /abs/dir && ls').cdDir).toBe('/abs/dir');
    expect(classifyBash('rm a.ts').cdDir).toBeUndefined();
  });

  // Regression: mv lost which argument was the destination, and find roots looked like delete targets.
  it('splits each mv into sources and destination', () => {
    expect(classifyBash('git mv docs/old.md docs/notes.md').moves).toEqual([{ sources: ['docs/old.md'], dest: 'docs/notes.md', intoDir: false }]);
    expect(classifyBash('mv a b dir').moves).toEqual([{ sources: ['a', 'b'], dest: 'dir', intoDir: true }]);
    expect(classifyBash('mv a dir/').moves).toEqual([{ sources: ['a'], dest: 'dir/', intoDir: true }]);
    expect(classifyBash('mv -t dest a b').moves).toEqual([{ sources: ['a', 'b'], dest: 'dest', intoDir: true }]);
    expect(classifyBash('mv --target-directory=dest a').moves).toEqual([{ sources: ['a'], dest: 'dest', intoDir: true }]);
    expect(classifyBash('mv -T a b').moves).toEqual([{ sources: ['a'], dest: 'b', intoDir: false }]);
    expect(classifyBash('cd pkg && mv x y && git -C sub mv p q').moves).toEqual([
      { sources: ['pkg/x'], dest: 'pkg/y', intoDir: false },
      { sources: ['pkg/sub/p'], dest: 'pkg/sub/q', intoDir: false },
    ]);
    expect(classifyBash('mv onlyone').moves).toEqual([]);
    expect(classifyBash('rm a').moves).toBeUndefined();
  });

  it('marks find -delete roots as bases, not targets', () => {
    expect(classifyBash('find src -name "*.orig" -delete').bases).toEqual(['src']);
    expect(classifyBash('rm a && cd lib && find . -delete').bases).toEqual(['lib']);
    expect(classifyBash('rm -rf dist').bases).toBeUndefined();
  });

  it('never throws on odd input', () => {
    for (const cmd of ['"unterminated', "'x", 'a && && b', '$(', '`', 'rm \\', ')(', '<<EOF', '> x']) {
      expect(() => classifyBash(cmd)).not.toThrow();
    }
  });
});

describe('extractPathsFromOutput', () => {
  it('extracts find paths and grep path:line prefixes from the fixture output', () => {
    const stdout =
      './src/utils/format.ts\n./src/utils/legacy.ts\n./src/api/order.ts\n./src/api/user.ts\n' +
      'src/api/user.ts:2:  // TODO: validate id\nsrc/utils/format.ts:2:  // TODO: locale';
    expect(extractPathsFromOutput(stdout)).toEqual([
      'src/utils/format.ts',
      'src/utils/legacy.ts',
      'src/api/order.ts',
      'src/api/user.ts',
    ]);
  });

  it('never returns matched text and skips prose lines', () => {
    const out = extractPathsFromOutput('src/a.ts:10:secret stuff here\nBinary file x matches\nhello world\n\nsrc/b.ts:3\nlib/\n');
    expect(out).toEqual(['src/a.ts', 'src/b.ts', 'lib']);
    expect(out.join(' ')).not.toContain('secret');
  });

  it('dedupes and honors the limit', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `f${i % 10}.ts:1:x`).join('\n');
    expect(extractPathsFromOutput(lines)).toHaveLength(10);
    expect(extractPathsFromOutput(lines, 3)).toEqual(['f0.ts', 'f1.ts', 'f2.ts']);
    expect(extractPathsFromOutput('a\nb\nc\n'.repeat(1).concat(Array.from({ length: 300 }, (_, i) => `p${i}`).join('\n')))).toHaveLength(200);
  });

  it('handles CRLF and empty input', () => {
    expect(extractPathsFromOutput('a.ts\r\nb.ts\r\n')).toEqual(['a.ts', 'b.ts']);
    expect(extractPathsFromOutput('')).toEqual([]);
  });
});
