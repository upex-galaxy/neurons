import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Normalizer, bashDetail, parseHookPayload, type HookPayload } from '../../src/server/normalize.ts';
import { createPathResolver } from '../../src/server/paths.ts';
import { TreeIndex, scanTree } from '../../src/server/tree.ts';
import type { VizEvent } from '../../src/shared/types.ts';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/payloads');
const FAKE_HOME = '/Users/fake-home';

/** Files of the phase 0 probe repo (docs/PAYLOADS.md). */
const PROBE_FILES: Record<string, string> = {
  'CLAUDE.md': '# Probe\n',
  'src/CLAUDE.md': '# src rules\n',
  '.claude/rules/api.md': '---\npaths: src/api/**/*.ts\n---\n',
  'src/api/user.ts': "export function getUser(id: string) {\n  // TODO: validate id\n  return { id, name: 'Ada' };\n}\n",
  'src/api/order.ts': 'export function getOrder(id: string) {\n  return { id, total: 42 };\n}\n',
  'src/utils/format.ts': 'export function formatMoney(n: number) {\n  // TODO: locale\n  return `$${n.toFixed(2)}`;\n}\n',
  'src/utils/legacy.ts': 'legacy\n',
  'docs/old.md': 'old notes\n',
};

const tmpDirs: string[] = [];
let repo: string; // non-realpath spelling (os.tmpdir() is /var/... on macOS)

beforeAll(() => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-cfg-'));
  tmpDirs.push(cfg);
  process.env.CLAUDE_CONFIG_DIR = cfg;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-probe-'));
  tmpDirs.push(repo);
  for (const [rel, content] of Object.entries(PROBE_FILES)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content);
  }
});

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function loadFixture(name: string, repoPath = repo): HookPayload[] {
  const raw = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const p = parseHookPayload(l.replaceAll('__REPO__', repoPath).replaceAll('__HOME__', FAKE_HOME));
      if (!p) throw new Error(`bad fixture line in ${name}`);
      return p;
    });
}

async function makeNormalizer(opts: { fileExists?: (abs: string) => boolean } = {}) {
  const resolver = createPathResolver(repo);
  const index = new TreeIndex(await scanTree(repo));
  let n = 0;
  const normalizer = new Normalizer({
    resolver,
    index,
    now: () => 1000 + n,
    newId: () => `id-${++n}`,
    ...opts,
  });
  return { normalizer, index, resolver };
}

/** Normalizes every payload; returns events grouped by payload index. */
async function runFixture(name: string, repoPath = repo) {
  const payloads = loadFixture(name, repoPath);
  const { normalizer } = await makeNormalizer();
  const perPayload = payloads.map((p) => normalizer.normalize(p));
  return { payloads, perPayload, all: perPayload.flat(), normalizer };
}

/** The main (non session_start) event for a payload. */
function main(evs: VizEvent[]): VizEvent {
  const e = evs.filter((x) => x.action !== 'session_start');
  expect(e).toHaveLength(1);
  return e[0] as VizEvent;
}

describe('parseHookPayload', () => {
  it('accepts valid payloads and rejects junk', () => {
    expect(parseHookPayload('{"hook_event_name":"Stop","session_id":"s"}')).toEqual({ hook_event_name: 'Stop', session_id: 's' });
    expect(parseHookPayload('﻿{"hook_event_name":"Stop","session_id":"s"}')).not.toBeNull();
    for (const bad of ['', 'not json', '[]', 'null', '42', '"x"', '{"hook_event_name":"Stop"}', '{"session_id":"s"}', '{"hook_event_name":1,"session_id":"s"}', '{"hook_event_name":"","session_id":"s"}']) {
      expect(parseHookPayload(bad)).toBeNull();
    }
  });
});

describe('Normalizer with real fixtures (run1)', () => {
  it('session is created on the first session_id with a session_start event', async () => {
    const { perPayload, normalizer } = await runFixture('run1.jsonl');
    const first = perPayload[0] as VizEvent[];
    expect(first.map((e) => e.action)).toEqual(['session_start', 'context_load']);
    expect(first[0]).toMatchObject({ phase: 'info', paths: [], source: 'hook', sessionId: '2c67fea2-a55c-499b-96ca-337317f82b0d' });
    expect(perPayload.flat().filter((e) => e.action === 'session_start')).toHaveLength(1);
    const [s] = normalizer.sessions();
    expect(s).toMatchObject({ sessionId: '2c67fea2-a55c-499b-96ca-337317f82b0d', ended: true, agents: { aa2b318dfea4c1d08: 'general-purpose' } });
    expect(s?.firstSeen).toBeLessThanOrEqual(s?.lastSeen ?? 0);
  });

  it('InstructionsLoaded -> context_load with load_reason and trigger as secondary', async () => {
    const { perPayload } = await runFixture('run1.jsonl');
    expect(main(perPayload[0] as VizEvent[])).toMatchObject({ action: 'context_load', phase: 'info', paths: ['CLAUDE.md'], detail: 'session_start' });
    expect(main(perPayload[0] as VizEvent[]).secondary).toBeUndefined();
    expect(main(perPayload[10] as VizEvent[])).toMatchObject({ paths: ['src/CLAUDE.md'], detail: 'nested_traversal', secondary: ['src/api/user.ts'] });
    expect(main(perPayload[11] as VizEvent[])).toMatchObject({ paths: ['.claude/rules/api.md'], detail: 'path_glob_match', secondary: ['src/api/user.ts'] });
    // Loaded while the subagent read order.ts, but no agent_id in the payload.
    expect(main(perPayload[32] as VizEvent[]).agentId).toBeUndefined();
  });

  it('UserPromptSubmit -> turn_start with the prompt on one line, max 120 chars', async () => {
    const { perPayload } = await runFixture('run1.jsonl');
    const e = main(perPayload[1] as VizEvent[]);
    expect(e).toMatchObject({ action: 'turn_start', phase: 'info', promptId: '1974ef12-2e39-4ef8-8e3e-e43637a84ab1' });
    expect(e.detail?.startsWith('Do these steps in order')).toBe(true);
    expect(e.detail?.length).toBeLessThanOrEqual(120);
    expect(e.detail).not.toContain('\n');
  });

  it('Bash search (find; grep) -> search on the root, stdout paths as secondary', async () => {
    const { perPayload } = await runFixture('run1.jsonl');
    const pre = main(perPayload[2] as VizEvent[]);
    expect(pre).toMatchObject({ action: 'search', phase: 'pre', paths: [''], toolName: 'Bash', toolUseId: 'toolu_01AzrnHMjVSLQHRXxpzG8E8P' });
    expect(pre.detail?.startsWith('find . -name "*.ts"')).toBe(true);
    expect(pre.detail?.length).toBeLessThanOrEqual(120);
    const post = main(perPayload[3] as VizEvent[]);
    expect(post).toMatchObject({ action: 'search', phase: 'post', paths: [''] });
    expect(post.secondary).toEqual(['src/utils/format.ts', 'src/utils/legacy.ts', 'src/api/order.ts', 'src/api/user.ts']);
  });

  it('PostToolBatch -> batch_end', async () => {
    const { perPayload } = await runFixture('run1.jsonl');
    for (const i of [4, 9, 14, 17, 20, 23, 26, 31, 36]) {
      expect(main(perPayload[i] as VizEvent[])).toMatchObject({ action: 'batch_end', phase: 'info', paths: [] });
    }
    expect(main(perPayload[31] as VizEvent[]).agentId).toBe('aa2b318dfea4c1d08');
  });

  it('Read -> read (pre and post)', async () => {
    const { perPayload } = await runFixture('run1.jsonl');
    expect(main(perPayload[5] as VizEvent[])).toMatchObject({ action: 'read', phase: 'pre', paths: ['src/api/user.ts'], toolName: 'Read', toolUseId: 'toolu_017FAcCfSxjRXyHCAf1uK3FU' });
    expect(main(perPayload[6] as VizEvent[])).toMatchObject({ action: 'read', phase: 'post', paths: ['src/api/user.ts'] });
    expect(main(perPayload[8] as VizEvent[])).toMatchObject({ action: 'read', phase: 'post', paths: ['src/utils/format.ts'] });
  });

  it('Edit -> edit', async () => {
    const { perPayload } = await runFixture('run1.jsonl');
    expect(main(perPayload[12] as VizEvent[])).toMatchObject({ action: 'edit', phase: 'pre', paths: ['src/api/user.ts'], toolName: 'Edit' });
    expect(main(perPayload[13] as VizEvent[])).toMatchObject({ action: 'edit', phase: 'post', paths: ['src/api/user.ts'] });
  });

  it('Write of a new file -> create (pre by disk check, post by tool_response.type)', async () => {
    const { perPayload } = await runFixture('run1.jsonl');
    expect(main(perPayload[15] as VizEvent[])).toMatchObject({ action: 'create', phase: 'pre', paths: ['src/api/health.ts'], toolName: 'Write' });
    expect(main(perPayload[16] as VizEvent[])).toMatchObject({ action: 'create', phase: 'post', paths: ['src/api/health.ts'] });
  });

  it('Bash rm -> delete (pre by classifier, post by bashEditDiff)', async () => {
    const { perPayload } = await runFixture('run1.jsonl');
    expect(main(perPayload[18] as VizEvent[])).toMatchObject({ action: 'delete', phase: 'pre', paths: ['src/utils/legacy.ts'], detail: 'rm src/utils/legacy.ts' });
    expect(main(perPayload[19] as VizEvent[])).toMatchObject({ action: 'delete', phase: 'post', paths: ['src/utils/legacy.ts'] });
  });

  it('Bash git mv -> move; bashEditDiff created+deleted pair -> one move with fromPaths', async () => {
    const { perPayload } = await runFixture('run1.jsonl');
    expect(main(perPayload[21] as VizEvent[])).toMatchObject({ action: 'move', phase: 'pre', paths: ['docs/notes.md'], fromPaths: ['docs/old.md'] });
    const post = main(perPayload[22] as VizEvent[]);
    expect(post).toMatchObject({ action: 'move', phase: 'post', paths: ['docs/notes.md'], fromPaths: ['docs/old.md'] });
  });

  it('failing Bash -> bash pre, then bash fail (PostToolUseFailure)', async () => {
    const { perPayload } = await runFixture('run1.jsonl');
    expect(main(perPayload[24] as VizEvent[])).toMatchObject({ action: 'bash', phase: 'pre', paths: [''], detail: 'cat does-not-exist.txt' });
    const fail = main(perPayload[25] as VizEvent[]);
    expect(fail).toMatchObject({ action: 'bash', phase: 'fail', paths: [''], toolUseId: 'toolu_01LFuVRxY4ufeuNpWDtLzyq8' });
    expect(JSON.stringify(fail)).not.toContain('No such file');
  });

  it('Agent -> tool with description; Subagent lifecycle carries agent id/type', async () => {
    const { perPayload } = await runFixture('run1.jsonl');
    expect(main(perPayload[27] as VizEvent[])).toMatchObject({ action: 'tool', phase: 'pre', toolName: 'Agent', detail: 'Read order.ts export', paths: [] });
    expect(main(perPayload[28] as VizEvent[])).toMatchObject({ action: 'subagent_start', phase: 'info', agentId: 'aa2b318dfea4c1d08', agentType: 'general-purpose' });
    expect(main(perPayload[29] as VizEvent[])).toMatchObject({ action: 'read', phase: 'pre', paths: ['src/api/order.ts'], agentId: 'aa2b318dfea4c1d08', agentType: 'general-purpose' });
    expect(main(perPayload[34] as VizEvent[])).toMatchObject({ action: 'subagent_stop', agentId: 'aa2b318dfea4c1d08', agentType: 'general-purpose' });
    expect(main(perPayload[35] as VizEvent[])).toMatchObject({ action: 'tool', phase: 'post', toolName: 'Agent', detail: 'Read order.ts export' });
    expect(main(perPayload[35] as VizEvent[]).agentId).toBeUndefined();
  });

  it('Stop -> turn_end, SessionEnd -> session_end', async () => {
    const { perPayload } = await runFixture('run1.jsonl');
    expect(main(perPayload[37] as VizEvent[])).toMatchObject({ action: 'turn_end', phase: 'info', paths: [] });
    expect(main(perPayload[38] as VizEvent[])).toMatchObject({ action: 'session_end', phase: 'info', detail: 'other' });
  });

  it('every event has id, ts, source hook and relative paths only', async () => {
    const { all } = await runFixture('run1.jsonl');
    for (const e of all) {
      expect(e.id).toMatch(/^id-\d+$/);
      expect(typeof e.ts).toBe('number');
      expect(e.source).toBe('hook');
      for (const p of [...e.paths, ...(e.secondary ?? []), ...(e.fromPaths ?? [])]) {
        expect(p.startsWith('/')).toBe(false);
        expect(p).not.toContain('\\');
      }
    }
  });

  it('works with the realpath spelling of the repo too', async () => {
    const { perPayload } = await runFixture('run1.jsonl', fs.realpathSync(repo));
    expect(main(perPayload[5] as VizEvent[]).paths).toEqual(['src/api/user.ts']);
    expect(main(perPayload[3] as VizEvent[]).secondary).toHaveLength(4);
  });
});

describe('Normalizer with real fixtures (run3)', () => {
  it('InstructionsLoaded outside the repo -> outsideRepo, no paths', async () => {
    const { perPayload } = await runFixture('run3.jsonl');
    expect(main(perPayload[0] as VizEvent[])).toMatchObject({ action: 'context_load', paths: [], outsideRepo: [`${FAKE_HOME}/.claude/CLAUDE.md`], detail: 'session_start' });
    expect(main(perPayload[1] as VizEvent[]).outsideRepo).toEqual([`${FAKE_HOME}/.claude/rules/context7.md`]);
    expect(main(perPayload[2] as VizEvent[])).toMatchObject({ paths: ['CLAUDE.md'] });
    expect(main(perPayload[2] as VizEvent[]).outsideRepo).toBeUndefined();
  });

  it('echo > new file: bash pre, create post from bashEditDiff', async () => {
    const { perPayload } = await runFixture('run3.jsonl');
    expect(main(perPayload[7] as VizEvent[])).toMatchObject({ action: 'bash', phase: 'pre', paths: [''], detail: 'echo … > src/new.txt' });
    expect(main(perPayload[8] as VizEvent[])).toMatchObject({ action: 'create', phase: 'post', paths: ['src/new.txt'], toolName: 'Bash' });
  });

  it('rm with bashEditDiff -> delete post', async () => {
    const { perPayload } = await runFixture('run3.jsonl');
    expect(main(perPayload[5] as VizEvent[])).toMatchObject({ action: 'delete', phase: 'post', paths: ['src/utils/legacy.ts'] });
  });
});

describe('Normalizer: creation vs edition (Write)', () => {
  const base = { session_id: 's1', cwd: '' };
  const write = (event: string, file: string, id: string, extra: Record<string, unknown> = {}): HookPayload => ({
    ...base,
    cwd: repo,
    hook_event_name: event,
    tool_name: 'Write',
    tool_use_id: id,
    tool_input: { file_path: path.join(repo, file), content: 'SECRET-WRITE-CONTENT' },
    ...extra,
  });

  it('existing file -> edit on pre and post (no response type)', async () => {
    const { normalizer } = await makeNormalizer();
    expect(main(normalizer.normalize(write('PreToolUse', 'src/api/user.ts', 'w1')))).toMatchObject({ action: 'edit', phase: 'pre' });
    expect(main(normalizer.normalize(write('PostToolUse', 'src/api/user.ts', 'w1')))).toMatchObject({ action: 'edit', phase: 'post' });
  });

  it('missing file -> create remembered by tool_use_id until Post', async () => {
    const { normalizer } = await makeNormalizer();
    expect(main(normalizer.normalize(write('PreToolUse', 'src/brand-new.ts', 'w2')))).toMatchObject({ action: 'create', phase: 'pre' });
    // The file exists by now, but the Pre observation wins without a response type.
    fs.writeFileSync(path.join(repo, 'src/brand-new.ts'), 'x');
    try {
      expect(main(normalizer.normalize(write('PostToolUse', 'src/brand-new.ts', 'w2')))).toMatchObject({ action: 'create', phase: 'post' });
    } finally {
      fs.rmSync(path.join(repo, 'src/brand-new.ts'));
    }
  });

  it('tool_response.type overrides the Pre observation', async () => {
    const { normalizer } = await makeNormalizer({ fileExists: () => false });
    expect(main(normalizer.normalize(write('PreToolUse', 'src/api/user.ts', 'w3')))).toMatchObject({ action: 'create' });
    expect(main(normalizer.normalize(write('PostToolUse', 'src/api/user.ts', 'w3', { tool_response: { type: 'update' } })))).toMatchObject({ action: 'edit' });
    const { normalizer: n2 } = await makeNormalizer({ fileExists: () => true });
    expect(main(n2.normalize(write('PreToolUse', 'x.ts', 'w4')))).toMatchObject({ action: 'edit' });
    expect(main(n2.normalize(write('PostToolUse', 'x.ts', 'w4', { tool_response: { type: 'create' } })))).toMatchObject({ action: 'create' });
  });

  it('failed Write keeps the Pre action with phase fail', async () => {
    const { normalizer } = await makeNormalizer({ fileExists: () => false });
    normalizer.normalize(write('PreToolUse', 'n.ts', 'w5'));
    expect(main(normalizer.normalize(write('PostToolUseFailure', 'n.ts', 'w5', { error: 'boom' })))).toMatchObject({ action: 'create', phase: 'fail' });
  });
});

describe('Normalizer: other rules', () => {
  const ev = (e: Record<string, unknown>): HookPayload => ({ session_id: 's2', cwd: repo, ...e }) as unknown as HookPayload;

  it('MultiEdit and NotebookEdit -> edit', async () => {
    const { normalizer } = await makeNormalizer();
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'MultiEdit', tool_input: { file_path: 'src/api/user.ts', edits: [] } })))).toMatchObject({ action: 'edit', paths: ['src/api/user.ts'] });
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(repo, 'nb.ipynb'), new_source: 'x' } })))).toMatchObject({ action: 'edit', paths: ['nb.ipynb'] });
  });

  it('Glob/Grep -> search on tool_input.path (or cwd) with filenames as secondary', async () => {
    const { normalizer } = await makeNormalizer();
    const pre = main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_use_id: 'g1', tool_input: { pattern: 'TODO', path: 'src' } })));
    expect(pre).toMatchObject({ action: 'search', phase: 'pre', paths: ['src'], detail: 'TODO' });
    const post = main(
      normalizer.normalize(
        ev({
          hook_event_name: 'PostToolUse',
          tool_name: 'Grep',
          tool_use_id: 'g1',
          tool_input: { pattern: 'TODO', path: 'src' },
          tool_response: { filenames: [path.join(repo, 'src/api/user.ts'), 'utils/format.ts', '/elsewhere/x.ts', 'src/not-in-index.ts'] },
        }),
      ),
    );
    expect(post.secondary).toEqual(['src/api/user.ts', 'src/utils/format.ts']);
    const glob = main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'Glob', tool_input: { pattern: '**/*.ts' }, cwd: path.join(repo, 'src') })));
    expect(glob).toMatchObject({ action: 'search', paths: ['src'], detail: '**/*.ts' });
  });

  it('Bash search with cd prefix and no path args lights the cd dir', async () => {
    const { normalizer } = await makeNormalizer();
    const pre = main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'cd src && ls' } })));
    expect(pre).toMatchObject({ action: 'search', paths: ['src'] });
    const post = main(normalizer.normalize(ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'cd src && ls' }, tool_response: { stdout: 'api\nutils\nCLAUDE.md\nnope\n' } })));
    expect(post.secondary).toEqual(['src/api', 'src/utils', 'src/CLAUDE.md']);
    const rg = main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rg -n foo src/api/*.ts' } })));
    expect(rg.paths).toEqual(['src/api']);
  });

  it('Bash without bashEditDiff: delete post keeps the pre classification; move pre/fail', async () => {
    const { normalizer } = await makeNormalizer();
    const cmd = { command: 'cd src && rm utils/legacy.ts' };
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b2', tool_input: cmd })))).toMatchObject({ action: 'delete', phase: 'pre', paths: ['src/utils/legacy.ts'] });
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b2', tool_input: cmd, tool_response: { stdout: '' } })))).toMatchObject({ action: 'delete', phase: 'post', paths: ['src/utils/legacy.ts'] });
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'b3', tool_input: { command: 'mv a.ts b.ts' }, error: 'x' })))).toMatchObject({ action: 'move', phase: 'fail', paths: ['b.ts'], fromPaths: ['a.ts'] });
  });

  // Regression: globs, find roots and `rm -rf .` used to mark a surviving dir (or the root) as deleted,
  // and mv put its source in `paths` with no fromPaths.
  it('Bash rm/find -delete without literal targets -> bash on the dirs involved, never a delete of a dir that survives', async () => {
    const { normalizer } = await makeNormalizer();
    const run = (command: string) => main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })));
    expect(run("find . -name '*.log' -delete")).toMatchObject({ action: 'bash', paths: [''] });
    expect(run('rm -rf src/*')).toMatchObject({ action: 'bash', paths: ['src'] });
    expect(run('find src -name "*.orig" -delete')).toMatchObject({ action: 'bash', paths: ['src'] });
    expect(run('rm -rf .')).toMatchObject({ action: 'bash', paths: [''] });
    // Literal targets still count; the glob next to them does not.
    expect(run('rm docs/old.md src/utils/*.ts')).toMatchObject({ action: 'delete', paths: ['docs/old.md'] });
  });

  it('Bash mv without bashEditDiff: paths are the new locations, fromPaths the old ones, aligned', async () => {
    const { normalizer } = await makeNormalizer();
    const run = (command: string, id?: string, event = 'PreToolUse') =>
      main(normalizer.normalize(ev({ hook_event_name: event, tool_name: 'Bash', ...(id ? { tool_use_id: id } : {}), tool_input: { command } })));
    expect(run('git mv docs/old.md docs/notes.md')).toMatchObject({ action: 'move', paths: ['docs/notes.md'], fromPaths: ['docs/old.md'] });
    // Into an existing dir: the source keeps its name there.
    expect(run('mv docs/old.md src')).toMatchObject({ action: 'move', paths: ['src/old.md'], fromPaths: ['docs/old.md'] });
    expect(run('mv -t src CLAUDE.md docs/old.md')).toMatchObject({ paths: ['src/CLAUDE.md', 'src/old.md'], fromPaths: ['CLAUDE.md', 'docs/old.md'] });
    expect(run('cd src && mv utils/legacy.ts api/')).toMatchObject({ paths: ['src/api/legacy.ts'], fromPaths: ['src/utils/legacy.ts'] });
    // Out of the repo: a delete; into it: a create.
    expect(run('mv docs/old.md /tmp/elsewhere.md')).toMatchObject({ action: 'delete', paths: ['docs/old.md'], outsideRepo: ['/tmp/elsewhere.md'] });
    expect(run('mv /tmp/in.md docs/in.md')).toMatchObject({ action: 'create', paths: ['docs/in.md'], outsideRepo: ['/tmp/in.md'] });
    // The Post reuses the Pre decision (the tree may already show the new dir by then).
    expect(run('mv src/utils newdir', 'm1')).toMatchObject({ phase: 'pre', paths: ['newdir'], fromPaths: ['src/utils'] });
    expect(run('mv src/utils newdir', 'm1', 'PostToolUse')).toMatchObject({ phase: 'post', paths: ['newdir'], fromPaths: ['src/utils'] });
  });

  it('bashEditDiff with only edits -> one edit per file; excluded paths dropped', async () => {
    const { normalizer } = await makeNormalizer();
    const evs = normalizer.normalize(
      ev({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'sed -i "" s/a/b/ src/a.ts src/b.ts' },
        tool_response: {
          stdout: '',
          bashEditDiff: {
            files: [
              { filePath: path.join(repo, 'src/a.ts'), hunks: [{ lines: ['-HUNK-SECRET'] }] },
              { filePath: path.join(repo, 'src/b.ts'), hunks: [] },
              { filePath: path.join(repo, '.git/index'), hunks: [] },
            ],
          },
        },
      }),
    ).filter((e) => e.action !== 'session_start');
    expect(evs.map((e) => [e.action, e.paths])).toEqual([
      ['edit', ['src/a.ts']],
      ['edit', ['src/b.ts']],
    ]);
    expect(JSON.stringify(evs)).not.toContain('HUNK-SECRET');
  });

  it('PermissionDenied -> tool action with phase fail and detail denied', async () => {
    const { normalizer } = await makeNormalizer();
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_use_id: 'd1', tool_input: { command: 'rm -rf src' } })))).toMatchObject({ action: 'delete', phase: 'fail', detail: 'denied', paths: ['src'] });
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PermissionDenied', tool_name: 'Read', tool_input: { file_path: 'src/api/user.ts' } })))).toMatchObject({ action: 'read', phase: 'fail', detail: 'denied' });
  });

  it('other tools -> tool; file_path/path used when it resolves', async () => {
    const { normalizer } = await makeNormalizer();
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: 'https://x', prompt: 'p' } })))).toMatchObject({ action: 'tool', toolName: 'WebFetch', paths: [] });
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'x' } })))).toMatchObject({ action: 'tool', toolName: 'Skill', paths: [] });
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'mcp__fs__read', tool_input: { file_path: path.join(repo, 'docs/old.md') } })))).toMatchObject({ action: 'tool', paths: ['docs/old.md'] });
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'mcp__x__y', tool_input: { path: 'src' } })))).toMatchObject({ action: 'tool', paths: ['src'] });
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'mcp__x__y', tool_input: { path: '/api/v1/users' } })))).toMatchObject({ action: 'tool', paths: [] });
  });

  it('paths in .git or .repo-synapse are dropped', async () => {
    const { normalizer } = await makeNormalizer();
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(repo, '.git/config') } })))).toMatchObject({ action: 'read', paths: [] });
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '.repo-synapse/events.jsonl' } }))).paths).toEqual([]);
  });

  it('Read outside the repo -> outsideRepo', async () => {
    const { normalizer } = await makeNormalizer();
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } })))).toMatchObject({ paths: [], outsideRepo: ['/etc/hosts'] });
  });

  it('StopFailure, compaction, unknown events', async () => {
    const { normalizer } = await makeNormalizer();
    expect(main(normalizer.normalize(ev({ hook_event_name: 'StopFailure', error: 'rate_limit' })))).toMatchObject({ action: 'turn_end', phase: 'fail' });
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PreCompact', trigger: 'auto' })))).toMatchObject({ action: 'compact', phase: 'pre', detail: 'auto' });
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PostCompact', trigger: 'manual' })))).toMatchObject({ action: 'compact', phase: 'post' });
    expect(normalizer.normalize(ev({ hook_event_name: 'Notification', message: 'x' }))).toEqual([]);
  });

  it('agentId comes only from agent_id; subagents are tracked per session', async () => {
    const { normalizer } = await makeNormalizer();
    const noId = main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'Read', agent_type: 'Explore', tool_input: { file_path: 'CLAUDE.md' } })));
    expect(noId.agentId).toBeUndefined();
    expect(noId.agentType).toBeUndefined();
    normalizer.normalize(ev({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' }));
    expect(normalizer.sessions()[0]?.agents).toEqual({ a1: 'Explore' });
  });

  it('a new event after SessionEnd revives the session with a new session_start', async () => {
    const { normalizer } = await makeNormalizer();
    normalizer.normalize(ev({ hook_event_name: 'Stop' }));
    normalizer.normalize(ev({ hook_event_name: 'SessionEnd', reason: 'clear' }));
    expect(normalizer.sessions()[0]?.ended).toBe(true);
    const evs = normalizer.normalize(ev({ hook_event_name: 'UserPromptSubmit', prompt: 'again' }));
    expect(evs.map((e) => e.action)).toEqual(['session_start', 'turn_start']);
    expect(normalizer.sessions()[0]?.ended).toBe(false);
  });

  it('uses crypto.randomUUID and Date.now by default', async () => {
    const normalizer = new Normalizer({ resolver: createPathResolver(repo), index: new TreeIndex(await scanTree(repo)) });
    const [e] = normalizer.normalize(ev({ hook_event_name: 'Stop', session_id: 'fresh' }));
    expect(e?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Math.abs((e?.ts ?? 0) - Date.now())).toBeLessThan(5000);
  });
});

describe('privacy', () => {
  /** Strings that must never leave the normalizer: file contents, edit strings, stdout text, hunk lines. */
  function secretsFrom(payloads: HookPayload[]): string[] {
    const secrets = new Set<string>();
    const addLines = (v: unknown): void => {
      if (typeof v !== 'string') return;
      for (const line of v.split('\n')) {
        const t = line.replace(/^[+\- ]/, '').trim();
        if (t.length >= 8) secrets.add(t);
      }
    };
    for (const p of payloads) {
      const input = (p.tool_input ?? {}) as Record<string, unknown>;
      addLines(input.content);
      addLines(input.old_string);
      addLines(input.new_string);
      const res = p.tool_response as Record<string, unknown> | undefined;
      if (!res || typeof res !== 'object') continue;
      addLines(res.content);
      addLines(res.originalFile);
      addLines(res.oldString);
      addLines(res.newString);
      addLines((res.file as Record<string, unknown> | undefined)?.content);
      for (const h of (res.structuredPatch as { lines?: string[] }[] | undefined) ?? []) for (const l of h.lines ?? []) addLines(l);
      const diff = res.bashEditDiff as { files?: { hunks?: { lines?: string[] }[] }[] } | undefined;
      for (const f of diff?.files ?? []) for (const h of f.hunks ?? []) for (const l of h.lines ?? []) addLines(l);
      // stdout: only the matched text after "path:line:" (paths are allowed to flow).
      if (typeof res.stdout === 'string') {
        for (const line of res.stdout.split('\n')) {
          const m = /^[^:]+:\d+:(.*)$/.exec(line);
          if (m) addLines(m[1]);
        }
      }
    }
    return [...secrets];
  }

  it('events contain no file contents, old/new strings, hunks or stdout text', async () => {
    for (const name of ['run1.jsonl', 'run3.jsonl']) {
      const { payloads, all } = await runFixture(name);
      const secrets = secretsFrom(payloads);
      // run3 only carries short hunk lines ("-legacy", "+hi") that also appear in paths/commands.
      if (name === 'run1.jsonl') expect(secrets.length).toBeGreaterThan(5);
      const json = JSON.stringify(all);
      for (const s of secrets) expect(json, `leaked: ${s}`).not.toContain(s);
      // Tool response metadata that is not a path must not leak either.
      expect(json).not.toContain('last_assistant_message');
      expect(json).not.toContain('getOrder');
      expect(json).not.toContain('structuredPatch');
    }
  });

  it('Bash commands that write files do not leak what they write (heredoc, echo, inline code)', async () => {
    const { normalizer } = await makeNormalizer();
    const secrets = ['sk_live_51HxYzABCDEF0123456789', 'hunter2', 'TOKEN_abc123', 'SUPERSECRET', 'NEWSECRET', 'multiline-secret'];
    const commands = [
      "cat > .env <<'EOF'\nSTRIPE_SECRET_KEY=sk_live_51HxYzABCDEF0123456789\nDATABASE_URL=postgres://admin:hunter2@db.internal/prod\nEOF",
      "python3 - <<'PY'\nopen('src/config.ts','w').write('export const TOKEN=TOKEN_abc123')\nPY",
      `python3 -c "open('src/config.ts','w').write('TOKEN_abc123')"`,
      `node -e 'require("fs").writeFileSync("x.txt", "SUPERSECRET")'`,
      'echo SUPERSECRET > .env',
      'echo "KEY=SUPERSECRET" | tee -a .env',
      "printf 'KEY=%s\\n' SUPERSECRET >> .env",
      'cat <<< SUPERSECRET > .env',
      "sed -i '' 's/old/NEWSECRET/' src/api/user.ts",
      'echo "first line\nmultiline-secret" > notes.txt',
    ];
    const all: VizEvent[] = [];
    commands.forEach((command, i) => {
      for (const phase of ['PreToolUse', 'PostToolUse'] as const) {
        all.push(
          ...normalizer.normalize({
            hook_event_name: phase,
            session_id: 'priv',
            cwd: repo,
            tool_name: 'Bash',
            tool_use_id: `b${i}`,
            tool_input: { command },
            ...(phase === 'PostToolUse' ? { tool_response: { stdout: '', stderr: '', interrupted: false } } : {}),
          } as unknown as HookPayload),
        );
      }
    });
    const json = JSON.stringify(all);
    for (const secret of secrets) expect(json, `leaked: ${secret}`).not.toContain(secret);
    const details = all.filter((e) => e.toolName === 'Bash').map((e) => e.detail);
    expect(details).toContain("cat > .env <<'…' …");
    expect(details).toContain('echo … > .env');
  });

  it('bashDetail keeps commands that do not write as they are', () => {
    expect(bashDetail('find . -name "*.ts" -type f')).toBe('find . -name "*.ts" -type f');
    expect(bashDetail('grep -rn "TODO" src 2>/dev/null')).toBe('grep -rn "TODO" src 2>/dev/null');
    expect(bashDetail('rm src/utils/legacy.ts')).toBe('rm src/utils/legacy.ts');
    expect(bashDetail('npm test \\\n  --silent')).toBe('npm test --silent');
    expect(bashDetail('ls > /dev/null 2>&1')).toBe('ls > /dev/null 2>&1');
    expect(bashDetail('x'.repeat(300))).toHaveLength(120);
  });

  it('known fixture contents are covered by the secret list', async () => {
    const secrets = secretsFrom(loadFixture('run1.jsonl'));
    expect(secrets).toContain("return { id, name: 'Ada' };");
    expect(secrets).toContain("throw new Error('id is required');");
    expect(secrets).toContain('// TODO: validate id');
    expect(secrets).toContain('old notes');
  });
});
