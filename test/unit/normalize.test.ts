import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bashPrograms } from '../../src/server/bash.ts';
import {
  Normalizer,
  bashCommand,
  bashDetail,
  errorLine,
  parseHookPayload,
  promptDetail,
  redactSecrets,
  toolInfo,
  writesRedirect,
  type HookPayload,
} from '../../src/server/normalize.ts';
import { createPathResolver, splitWorktreeRel } from '../../src/server/paths.ts';
import { TreeIndex, scanTree } from '../../src/server/tree.ts';
import type { VizEvent } from '../../src/shared/types.ts';
import { setLang } from '../../src/i18n.ts';
import { emptyTally, snapshotTally, tallyEvent } from '../../web/src/tools.ts';

// The injected-prompt labels asserted below are the Spanish ones.
setLang('es');

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

  it('a multi-file Bash call is several events but one call in the Tools counters', async () => {
    const { normalizer } = await makeNormalizer();
    const evs = normalizer
      .normalize(
        ev({
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_use_id: 'multi1',
          tool_input: { command: 'npx prettier --write src' },
          tool_response: {
            stdout: '',
            bashEditDiff: {
              files: ['src/api/user.ts', 'src/api/order.ts', 'src/utils/format.ts'].map((rel) => ({ filePath: path.join(repo, rel), hunks: [] })),
            },
          },
        }),
      )
      .filter((e) => e.action !== 'session_start');
    expect(evs).toHaveLength(3);
    const tally = emptyTally();
    for (const e of evs) tallyEvent(tally, e);
    expect(snapshotTally(tally)).toMatchObject({ cli: { npx: 1 }, builtin: { Bash: 1 } });
  });

  it('PermissionDenied -> tool action with phase fail and the denied flag (no English word in detail)', async () => {
    const { normalizer } = await makeNormalizer();
    const bash = main(normalizer.normalize(ev({ hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_use_id: 'd1', tool_input: { command: 'rm -rf src' } })));
    expect(bash).toMatchObject({ action: 'delete', phase: 'fail', denied: true, detail: 'rm -rf src', paths: ['src'] });
    const read = main(normalizer.normalize(ev({ hook_event_name: 'PermissionDenied', tool_name: 'Read', tool_input: { file_path: 'src/api/user.ts' } })));
    expect(read).toMatchObject({ action: 'read', phase: 'fail', denied: true });
    expect(read.detail).not.toBe('denied');
    const post = main(normalizer.normalize(ev({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'src/api/user.ts' } })));
    expect(post.denied).toBeUndefined();
  });

  it('other tools -> tool; file_path/path used when it resolves', async () => {
    const { normalizer } = await makeNormalizer();
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: 'https://x', prompt: 'p' } })))).toMatchObject({ action: 'tool', toolName: 'WebFetch', paths: [] });
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: 'https://x', prompt: 'p' } }))).tool).toEqual({ kind: 'builtin', name: 'WebFetch' });
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'x' } })))).toMatchObject({ action: 'skill', toolName: 'Skill', paths: [], detail: 'x', tool: { kind: 'skill', name: 'x' } });
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'mcp__fs__read', tool_input: { file_path: path.join(repo, 'docs/old.md') } })))).toMatchObject({ action: 'mcp', paths: ['docs/old.md'], detail: 'fs/read' });
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'mcp__x__y', tool_input: { path: 'src' } })))).toMatchObject({ action: 'mcp', paths: ['src'] });
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'mcp__x__y', tool_input: { path: '/api/v1/users' } })))).toMatchObject({ action: 'mcp', paths: [] });
  });

  it('paths in .git or .neurons are dropped', async () => {
    const { normalizer } = await makeNormalizer();
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(repo, '.git/config') } })))).toMatchObject({ action: 'read', paths: [] });
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '.neurons/events.jsonl' } }))).paths).toEqual([]);
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
    // /clear: the window goes on under a new session id (see SessionInfo.cleared).
    expect(normalizer.sessions()[0]?.cleared).toBe(true);
    const evs = normalizer.normalize(ev({ hook_event_name: 'UserPromptSubmit', prompt: 'again' }));
    expect(evs.map((e) => e.action)).toEqual(['session_start', 'turn_start']);
    expect(normalizer.sessions()[0]?.ended).toBe(false);
    expect(normalizer.sessions()[0]?.cleared).toBeUndefined();
    normalizer.normalize(ev({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }));
    expect(normalizer.sessions()[0]).toMatchObject({ ended: true });
    expect(normalizer.sessions()[0]?.cleared).toBeUndefined();
  });

  it('uses crypto.randomUUID and Date.now by default', async () => {
    const normalizer = new Normalizer({ resolver: createPathResolver(repo), index: new TreeIndex(await scanTree(repo)) });
    const [e] = normalizer.normalize(ev({ hook_event_name: 'Stop', session_id: 'fresh' }));
    expect(e?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Math.abs((e?.ts ?? 0) - Date.now())).toBeLessThan(5000);
  });
});

describe('Normalizer: Claude Code subagent worktrees', () => {
  const WT = '.claude/worktrees/agent-af7ec553e0c4e91b1';
  const ev = (e: Record<string, unknown>): HookPayload =>
    ({ session_id: 's3', agent_id: 'af7ec553e0c4e91b1', agent_type: 'general-purpose', cwd: path.join(repo, WT), ...e }) as unknown as HookPayload;

  it('splitWorktreeRel', () => {
    expect(splitWorktreeRel(`${WT}/web/src/main.ts`)).toEqual({ worktree: 'agent-af7ec553e0c4e91b1', rel: 'web/src/main.ts' });
    expect(splitWorktreeRel(WT)).toEqual({ worktree: 'agent-af7ec553e0c4e91b1', rel: '' });
    expect(splitWorktreeRel(`${WT}/`)).toEqual({ worktree: 'agent-af7ec553e0c4e91b1', rel: '' });
    expect(splitWorktreeRel('.claude/worktrees')).toBeUndefined();
    expect(splitWorktreeRel('.claude/worktrees-old/x/a.ts')).toBeUndefined();
    expect(splitWorktreeRel('src/.claude/worktrees/x/a.ts')).toBeUndefined();
  });

  it('rewrites a Read inside the worktree to the main-repo path and names the worktree', async () => {
    const { normalizer } = await makeNormalizer();
    const e = main(normalizer.normalize(ev({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'w1', tool_input: { file_path: path.join(repo, WT, 'src/api/user.ts') } })));
    expect(e).toMatchObject({ action: 'read', paths: ['src/api/user.ts'], worktree: 'agent-af7ec553e0c4e91b1', agentId: 'af7ec553e0c4e91b1' });
    expect(e.outsideRepo).toBeUndefined();
  });

  it('relative paths resolve against the worktree cwd; a Write of a new file stays a create', async () => {
    const { normalizer } = await makeNormalizer({ fileExists: () => false });
    const pre = main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'w2', tool_input: { file_path: 'src/api/only-here.ts', content: 'x' } })));
    expect(pre).toMatchObject({ action: 'create', phase: 'pre', paths: ['src/api/only-here.ts'], worktree: 'agent-af7ec553e0c4e91b1' });
  });

  it('a Bash in the worktree lights the root, and a Grep keeps hits that exist in the main tree', async () => {
    const { normalizer } = await makeNormalizer();
    const bash = main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'w3', tool_input: { command: 'npm test' } })));
    expect(bash).toMatchObject({ action: 'bash', paths: [''], worktree: 'agent-af7ec553e0c4e91b1' });
    const grep = main(
      normalizer.normalize(
        ev({
          hook_event_name: 'PostToolUse',
          tool_name: 'Grep',
          tool_use_id: 'w4',
          tool_input: { pattern: 'TODO', path: path.join(repo, WT, 'src') },
          tool_response: { filenames: [path.join(repo, WT, 'src/api/user.ts'), path.join(repo, WT, 'src/new.ts')] },
        }),
      ),
    );
    expect(grep).toMatchObject({ action: 'search', paths: ['src'], secondary: ['src/api/user.ts'], worktree: 'agent-af7ec553e0c4e91b1' });
  });

  it('the worktrees dir itself is dropped; main-repo paths carry no worktree', async () => {
    const { normalizer } = await makeNormalizer();
    const dir = main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'w5', tool_input: { file_path: path.join(repo, '.claude/worktrees') } })));
    expect(dir.paths).toEqual([]);
    expect(dir.worktree).toBeUndefined();
    const plain = main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'w6', cwd: repo, tool_input: { file_path: 'src/api/user.ts' } })));
    expect(plain.paths).toEqual(['src/api/user.ts']);
    expect(plain.worktree).toBeUndefined();
  });

  it('a command that mixes main-repo and worktree paths tags each path by its own tree', async () => {
    const { normalizer } = await makeNormalizer();
    const run = (command: string, id: string, extra: Record<string, unknown> = {}): VizEvent[] =>
      normalizer
        .normalize({ session_id: 's5', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: id, tool_input: { command }, ...extra } as unknown as HookPayload)
        .filter((e) => e.action !== 'session_start');
    const rm = run(`rm docs/old.md ${WT}/src/api/user.ts`, 'x1');
    expect(rm).toHaveLength(2);
    expect(rm[0]).toMatchObject({ action: 'delete', paths: ['docs/old.md'] });
    expect(rm[0]?.worktree).toBeUndefined();
    expect(rm[1]).toMatchObject({ action: 'delete', paths: ['src/api/user.ts'], worktree: 'agent-af7ec553e0c4e91b1' });

    // Out of the worktree into the main repo: a delete there and a create here, never one move.
    const mv = run(`mv ${WT}/src/api/user.ts src/api/moved.ts`, 'x2');
    expect(mv).toHaveLength(2);
    expect(mv[0]).toMatchObject({ action: 'create', paths: ['src/api/moved.ts'] });
    expect(mv[0]?.worktree).toBeUndefined();
    expect(mv[1]).toMatchObject({ action: 'delete', paths: ['src/api/user.ts'], worktree: 'agent-af7ec553e0c4e91b1' });
    const same = run(`mv ${WT}/src/api/user.ts src/api/user.ts`, 'x3');
    expect(same.map((e) => [e.action, e.paths, e.worktree])).toEqual([
      ['create', ['src/api/user.ts'], undefined],
      ['delete', ['src/api/user.ts'], 'agent-af7ec553e0c4e91b1'],
    ]);

    // Same move reported by bashEditDiff.
    const post = normalizer
      .normalize({
        session_id: 's5',
        cwd: repo,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_use_id: 'x4',
        tool_input: { command: 'mv x y' },
        tool_response: {
          bashEditDiff: {
            files: [
              { filePath: path.join(repo, 'src/api/moved.ts'), created: true },
              { filePath: path.join(repo, WT, 'src/api/user.ts'), deleted: true },
            ],
          },
        },
      } as unknown as HookPayload)
      .filter((e) => e.action !== 'session_start');
    expect(post.map((e) => [e.action, e.paths, e.worktree])).toEqual([
      ['create', ['src/api/moved.ts'], undefined],
      ['delete', ['src/api/user.ts'], 'agent-af7ec553e0c4e91b1'],
    ]);
  });

  it('a git worktree outside the root stays outsideRepo', async () => {
    const { normalizer } = await makeNormalizer();
    const outside = path.join(os.tmpdir(), 'orca', 'workspaces', 'feature', 'src', 'api', 'user.ts');
    const e = main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'w7', cwd: repo, tool_input: { file_path: outside } })));
    expect(e.paths).toEqual([]);
    expect(e.outsideRepo).toEqual([outside]);
    expect(e.worktree).toBeUndefined();
  });
});

describe('Normalizer: prompts injected by Claude Code', () => {
  const ev = (e: Record<string, unknown>): HookPayload => ({ session_id: 's4', cwd: repo, ...e }) as unknown as HookPayload;

  it('a <task-notification> prompt becomes a fixed label, never the raw tags', async () => {
    const { normalizer } = await makeNormalizer();
    const prompt =
      '<task-notification>\n<task-id>af7ec553e0c4e91b1</task-id>\n<tool-use-id>toolu_01CoRroNzfR2WXWHd4Tp12Mw</tool-use-id>\n<output-file>/tmp/x</output-file>\n</task-notification>';
    const e = main(normalizer.normalize(ev({ hook_event_name: 'UserPromptSubmit', prompt })));
    expect(e).toMatchObject({ action: 'turn_start', detail: 'notificación de tarea en segundo plano' });
    expect(JSON.stringify(e)).not.toContain('toolu_01CoRroNzfR2WXWHd4Tp12Mw');
  });

  it('promptDetail', () => {
    expect(promptDetail('  <system-reminder>hola</system-reminder>')).toBe('notificación del sistema');
    expect(promptDetail('<task-notification> <task-id>x</task-id>')).toBe('notificación de tarea en segundo plano');
    expect(promptDetail('Arreglá <b>esto</b> y <a href="x">aquello</a>')).toBe('Arreglá esto y aquello');
    expect(promptDetail('mirá esto <command-name>/foo</command-name>')).toBe('mirá esto /foo');
    // Tags are stripped before truncating, so a trailing `<x` is something the user typed.
    expect(promptDetail('cortado al final <out')).toBe('cortado al final <out');
    expect(promptDetail('fijate a<b')).toBe('fijate a<b');
    expect(promptDetail('si a<b y c>d')).toBe('si a<b y c>d');
    // A typed prompt that opens with an HTML tag is not a Claude Code notification.
    expect(promptDetail('<div> no se centra')).toBe('no se centra');
    expect(promptDetail('<button type="submit"> no responde')).toBe('no responde');
    expect(promptDetail('<command-message>init</command-message>')).toBe('notificación del sistema');
    expect(promptDetail('si a < b y c > d')).toBe('si a < b y c > d');
    expect(promptDetail('<Button> no anda')).toBe('no anda');
    expect(promptDetail('<task-id>')).toBe('notificación del sistema');
    expect(promptDetail('</x>')).toBeUndefined();
    expect(promptDetail('x'.repeat(300))).toHaveLength(120);
  });
});

describe('Normalizer: tool metadata (tool, cli, command, description, durationMs, error, pattern)', () => {
  const ev = (e: Record<string, unknown>): HookPayload => ({ session_id: 's6', cwd: repo, ...e }) as unknown as HookPayload;

  it('Skill and MCP from the real fixture (run-skill-mcp)', async () => {
    const { perPayload, payloads, all } = await runFixture('run-skill-mcp.jsonl');
    const idx = (event: string, tool: string) => payloads.findIndex((p) => p.hook_event_name === event && p.tool_name === tool);
    const skillPre = main(perPayload[idx('PreToolUse', 'Skill')] as VizEvent[]);
    expect(skillPre).toMatchObject({ action: 'skill', phase: 'pre', paths: [], detail: 'humanizer', tool: { kind: 'skill', name: 'humanizer' } });
    expect(skillPre.durationMs).toBeUndefined();
    const skillPost = main(perPayload[idx('PostToolUse', 'Skill')] as VizEvent[]);
    expect(skillPost).toMatchObject({ action: 'skill', phase: 'post', durationMs: 7 });

    const mcpName = 'mcp__context7__resolve-library-id';
    const mcpPre = main(perPayload[idx('PreToolUse', mcpName)] as VizEvent[]);
    expect(mcpPre).toMatchObject({ action: 'mcp', phase: 'pre', paths: [], detail: 'context7/resolve-library-id', toolName: mcpName });
    expect(mcpPre.tool).toEqual({ kind: 'mcp', name: 'resolve-library-id', server: 'context7' });
    expect(main(perPayload[idx('PostToolUse', mcpName)] as VizEvent[])).toMatchObject({ action: 'mcp', phase: 'post', durationMs: 1611 });

    // The MCP tool input (the query typed for it) and its response never leave the normalizer.
    const json = JSON.stringify(all);
    for (const p of payloads.filter((x) => x.tool_name === mcpName)) {
      for (const v of Object.values((p.tool_input ?? {}) as Record<string, unknown>)) {
        if (typeof v === 'string' && v.length >= 8) expect(json).not.toContain(v);
      }
    }
  });

  it('MCP names: payload server name wins, plugin servers with underscores, no server info', () => {
    expect(toolInfo('mcp__plugin_engram_engram__mem_save', {}, undefined)).toEqual({ kind: 'mcp', name: 'mem_save', server: 'plugin_engram_engram' });
    expect(toolInfo('mcp__claude_ai_Slack__slack_send', {}, { name: 'claude.ai Slack' })).toEqual({ kind: 'mcp', name: 'slack_send', server: 'claude.ai Slack' });
    expect(toolInfo('mcp__a__b__c', {}, { name: 'a__b' })).toEqual({ kind: 'mcp', name: 'c', server: 'a__b' });
    expect(toolInfo('mcp__solo', {}, undefined)).toEqual({ kind: 'mcp', name: 'solo', server: 'solo' });
    expect(toolInfo('Skill', {}, undefined)).toEqual({ kind: 'skill', name: '?' });
    expect(toolInfo('Bash', { skill: 'x' }, undefined)).toEqual({ kind: 'builtin', name: 'Bash' });
  });

  it('run1: Bash carries cli, command and description; Post the duration; Failure the first error line', async () => {
    const { perPayload, payloads } = await runFixture('run1.jsonl');
    const pre = main(perPayload[2] as VizEvent[]);
    expect(pre.tool).toEqual({ kind: 'builtin', name: 'Bash' });
    expect(pre.cli).toEqual(['find', 'grep']);
    expect(pre.command?.startsWith('find . -name "*.ts"')).toBe(true);
    expect(pre.description).toBe((payloads[2]?.tool_input as { description: string }).description);
    expect(pre.pattern).toBe('*.ts');
    expect(pre.durationMs).toBeUndefined();
    expect(main(perPayload[3] as VizEvent[]).durationMs).toBe(74);

    const fail = main(perPayload[25] as VizEvent[]);
    expect(fail).toMatchObject({ phase: 'fail', error: 'Exit code 1', durationMs: 8, cli: ['cat'], command: 'cat does-not-exist.txt' });
    expect(JSON.stringify(fail)).not.toContain('No such file');

    const agent = main(perPayload[27] as VizEvent[]);
    expect(agent).toMatchObject({ action: 'tool', tool: { kind: 'builtin', name: 'Agent' }, description: 'Read order.ts export' });
    expect(main(perPayload[35] as VizEvent[]).durationMs).toBe(3243);
    expect(main(perPayload[5] as VizEvent[]).tool).toEqual({ kind: 'builtin', name: 'Read' });
    // Non-tool events carry none of it.
    expect(main(perPayload[1] as VizEvent[]).tool).toBeUndefined();
  });

  it('Glob/Grep pattern; Bash rg pattern; description capped at 300 chars on one line', async () => {
    const { normalizer } = await makeNormalizer();
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'TODO|FIXME', path: 'src' } }))).pattern).toBe('TODO|FIXME');
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'Glob', tool_input: { pattern: '**/*.ts' } }))).pattern).toBe('**/*.ts');
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rg -n "useState" web/src' } }))).pattern).toBe('useState');
    expect(main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }))).pattern).toBeUndefined();
    const long = main(normalizer.normalize(ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls', description: `line one\n${'x'.repeat(400)}` } })));
    expect(long.description).toHaveLength(300);
    expect(long.description).not.toContain('\n');
  });

  it('error is one line, at most 200 chars, without wrapper tags; denied events have no duration', async () => {
    const { normalizer } = await makeNormalizer();
    const fail = (error: unknown) =>
      main(normalizer.normalize(ev({ hook_event_name: 'PostToolUseFailure', tool_name: 'Edit', tool_input: { file_path: 'src/api/user.ts' }, error, duration_ms: 3.6 })));
    const e1 = fail('<tool_use_error>String to replace not found in file.\nString: SECRET_OLD_STRING</tool_use_error>');
    expect(e1.error).toBe('String to replace not found in file.');
    expect(e1.durationMs).toBe(4);
    expect(JSON.stringify(e1)).not.toContain('SECRET_OLD_STRING');
    const e2 = fail(`\n\n${'e'.repeat(500)}\nsecond`);
    expect(e2.error).toHaveLength(200);
    expect(e2.error).not.toContain('\n');
    expect(fail(42).error).toBeUndefined();
    expect(errorLine('  \n ')).toBeUndefined();
    const denied = main(normalizer.normalize(ev({ hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_input: { command: 'rm -rf src' }, duration_ms: 5 })));
    expect(denied.durationMs).toBeUndefined();
    expect(denied.denied).toBe(true);
    expect(denied.detail).not.toBe('denied');
  });

  it('cli: programs after wrappers and env assignments, no keywords or builtins, at most 8', () => {
    expect(bashPrograms('cd web && NODE_ENV=test npx vitest run | tee out.log')).toEqual(['npx', 'tee']);
    expect(bashPrograms('sudo -u root /usr/bin/env FOO=1 time git status; find . | xargs -n1 rm')).toEqual(['git', 'find', 'rm']);
    expect(bashPrograms('if [ -f x ]; then echo yes; else exit 1; fi')).toEqual(['echo', 'exit']);
    expect(bashPrograms('for f in *.ts; do wc -l "$f"; done')).toEqual(['wc']);
    expect(bashPrograms('$CMD --flag && "C:\\\\Program Files\\\\Git\\\\bin\\\\git.exe" log')).toEqual(['git']);
    expect(bashPrograms("cat > f <<'EOF'\nrm -rf /\nEOF\nls")).toEqual(['cat', 'ls']);
    expect(bashPrograms('a; b; c; d; e; f; g; h; i; j')).toHaveLength(8);
    expect(bashPrograms('')).toEqual([]);
  });
});

describe('bashCommand', () => {
  it('keeps the shape and newlines of commands that do not write', () => {
    expect(bashCommand('npm run build && \\\n  npm test')).toBe('npm run build && \\\n  npm test');
    expect(bashCommand('git status\ngit log --oneline -5')).toBe('git status\ngit log --oneline -5');
    expect(bashCommand('grep -rn "TODO" src 2>/dev/null')).toBe('grep -rn "TODO" src 2>/dev/null');
    expect(bashCommand('x'.repeat(3000))).toHaveLength(2000);
  });

  it('cuts heredoc bodies, also inside $( ) and with <<-', () => {
    expect(bashCommand("cat > .env <<'EOF'\nSTRIPE_KEY=sk_live_123456789\nEOF\nnpm test")).toBe("cat > .env <<'…'\n…\nEOF\nnpm test");
    const commit = bashCommand(`git commit -m "$(cat <<'EOF'\nfeat: PRIVATE COMMIT BODY\nEOF\n)"\ngit log -1`);
    expect(commit).not.toContain('PRIVATE COMMIT BODY');
    expect(commit.endsWith('git log -1')).toBe(true);
    expect(bashCommand('cat <<-END > x\n\tSECRET_TABBED\n\tEND\nls')).not.toContain('SECRET_TABBED');
    // A heredoc never closed hides everything after it.
    expect(bashCommand('python3 - <<PY\nprint("SECRET_UNCLOSED")\nmore')).not.toContain('SECRET_UNCLOSED');
  });

  it('redacts literals across lines when the statement writes or runs inline code', () => {
    const multi = bashCommand('echo "first line\nMULTILINE_SECRET" > notes.txt\nls -la');
    expect(multi).toBe('echo … > notes.txt\nls -la');
    expect(bashCommand(`node -e 'require("fs").writeFileSync("x", "SUPERSECRET")'`)).toBe("node -e '…'");
    expect(bashCommand(`python3 -c "\nopen('a','w').write('TOKEN_X')\n"`)).toBe('python3 -c "…"');
    expect(bashCommand('cat <<< "HERE STRING SECRET" > .env')).toBe('cat <<< … > .env');
    expect(bashCommand("printf $'a\\'SECRET_ANSI' > f")).not.toContain('SECRET_ANSI');
    // An unterminated literal keeps only its quote.
    expect(bashCommand("echo 'never closed\nSECRET_TAIL")).toBe("echo '…");
    // Comments are not quotes.
    expect(bashCommand("# don't panic\nls")).toBe("# don't panic\nls");
  });

  /** Both outputs that leave the server must keep `secret` out. */
  const neither = (command: string, secret: string): void => {
    expect(bashCommand(command), `command: ${command}`).not.toContain(secret);
    expect(bashDetail(command), `detail: ${command}`).not.toContain(secret);
  };

  it('decides writes for the whole command: a redirect or tee on another line still redacts (P1)', () => {
    expect(bashCommand('{\n  echo "SECRET_C"\n  echo "SECRET_D"\n} > f')).toBe('{\n  echo …\n  echo …\n} > f');
    expect(bashCommand("while read l; do\n  printf '%s\\n' \"SECRET_E\"\ndone > out")).toBe('while read l; do\n  printf …\ndone > out');
    neither('if true; then echo "SECRET_X"\nfi > f', 'SECRET_X');
    neither("printf '%s' \"SECRETa\" |\n  sudo tee /etc/x", 'SECRETa');
    expect(bashDetail("printf '%s' \"SECRETa\" |\n  sudo tee /etc/x")).toBe('printf … | …');
    neither('{\n  echo UNQUOTED_SECRET\n} >> notes.txt', 'UNQUOTED_SECRET');
    neither('cat <<EOF\nHEREDOC_SECRET\nEOF\necho "LINE_SECRET" | tee -a f', 'LINE_SECRET');
    neither("python3 \\\n  -c 'open(\"f\",\"w\").write(\"CONT_SECRET\")'", 'CONT_SECRET');
    // Nothing writes: lines stay as typed.
    expect(bashCommand('echo "building"\nnpm run build')).toBe('echo "building"\nnpm run build');
  });

  it('redacts echo/printf arguments after then, do, {, (, time, command and case labels (P2)', () => {
    for (const [cmd, secret] of [
      ['if true; then echo SECRET_A > f; fi', 'SECRET_A'],
      ['for i in 1; do echo SECRET_B >> f; done', 'SECRET_B'],
      ['{ echo SECRET57; } > f', 'SECRET57'],
      ['(echo SECRET58) > f', 'SECRET58'],
      ['time echo SECRET_I > f', 'SECRET_I'],
      ['command echo SECRET_J > f', 'SECRET_J'],
      ['case x in a) echo SECRETcc > f;; esac', 'SECRETcc'],
      ['if [ ! -f .env ]; then echo API_KEY=sk-123 > .env; fi', 'sk-123'],
      ['echo SECRET_K \\\n  MORE_SECRET > f', 'MORE_SECRET'],
    ] as const) {
      neither(cmd, secret);
    }
    expect(bashCommand('if true; then echo SECRET_A > f; fi')).toBe('if true; then echo … > f; fi');
    expect(bashCommand('(echo SECRET58) > f')).toBe('(echo …) > f');
  });

  it('treats &>, &>>, 1>, 1>> and a > glued to a word as file writes (P3)', () => {
    for (const cmd of ['echo SECRET32 &> f', 'echo SECRET32 &>> f', 'echo SECRET31 1> f', 'echo SECRET31 1>> f', 'echo SECRET33 >| f', 'echo SECRET34 >&out.log']) {
      neither(cmd, 'SECRET3');
    }
    neither('echo PORT=3000>.env', 'PORT=3000');
    neither('echo v1.2.3>VERSION', 'v1.2.3');
    expect(bashCommand('echo SECRET31 1> f')).toBe('echo … 1> f');
    // fd redirects and /dev/null are still not writes.
    expect(writesRedirect('ls > /dev/null 2>&1')).toBe(false);
    expect(writesRedirect('npm test 2>&1 | head')).toBe(false);
    expect(writesRedirect('cmd 2> err.log')).toBe(false);
    expect(writesRedirect('echo x >&2')).toBe(false);
    expect(writesRedirect('exec 3>&-')).toBe(false);
    expect(writesRedirect('echo 3000>.env')).toBe(false); // fd 3000, writes nothing
    expect(writesRedirect('cmd &>/dev/null')).toBe(false);
    expect(writesRedirect('cmd &> out.log')).toBe(true);
    expect(writesRedirect('cmd 1>out')).toBe(true);
    expect(writesRedirect('cmd >>out')).toBe(true);
  });

  it('knows more inline-code interpreters, flags in any case, and sponge / dd of= writers (P4)', () => {
    for (const [cmd, secret] of [
      [`php -r 'file_put_contents("f","SECRETd");'`, 'SECRETd'],
      ["perl -nE 'print \"SECRETf\"'", 'SECRETf'],
      [`Rscript -e 'writeLines("SECRETq","f")'`, 'SECRETq'],
      ["lua -e 'io.open(\"f\",\"w\"):write(\"SECRET1\")'", 'SECRET1'],
      ["swift -e 'print(\"SECRET2\")'", 'SECRET2'],
      ["julia -e 'write(\"f\", \"SECRET3\")'", 'SECRET3'],
      ['powershell -c "SECRET39 | Out-File f"', 'SECRET39'],
      ['pwsh -Command "Set-Content f SECRET38"', 'SECRET38'],
      ['pwsh -EncodedCommand "SECRET40"', 'SECRET40'],
      ['cmd /c "echo SECRET41 > f"', 'SECRET41'],
      ['printf SECRET24 | dd of=f', 'SECRET24'],
      ['echo -e "a\\nSECRET23" | sponge f', 'SECRET23'],
    ] as const) {
      neither(cmd, secret);
    }
  });

  it('redacts values that look like secrets in any command (P6)', () => {
    for (const [cmd, secret] of [
      ['curl -H "Authorization: Bearer abc123def" https://api.x.com', 'abc123def'],
      ['export GITHUB_TOKEN=ghp_secret123 && gh api user', 'ghp_secret123'],
      ['DB_PASSWORD="hunter2 x" npm run migrate', 'hunter2'],
      ['mysql --password=hunter3 -u root', 'hunter3'],
      ['npm publish --otp 123456 --auth-token tok_abcdef', 'tok_abcdef'],
      ['git clone https://user:hunter4pw@github.com/x.git', 'hunter4pw'],
      ['curl -u admin:pa55word https://x', 'pa55word'],
      ['curl "https://api.x.com/v1?api_key=QUERYSECRET"', 'QUERYSECRET'],
      ['gh secret set X --body ghp_ABCDEFGHIJKLMNOPQRSTUV', 'ghp_ABCDEFGHIJKLMNOPQRSTUV'],
      ['claude --model x sk-ant-api03-ABCDEFGHIJKLMNOP', 'sk-ant-api03-ABCDEFGHIJKLMNOP'],
    ] as const) {
      neither(cmd, secret);
    }
    expect(redactSecrets('export GITHUB_TOKEN=abc && ls')).toBe('export GITHUB_TOKEN=… && ls');
    // Names that only look close are kept.
    expect(bashCommand('git commit --author "Ada Lovelace" -m "fix"')).toBe('git commit --author "Ada Lovelace" -m "fix"');
    expect(bashCommand('git log --oneline -5')).toBe('git log --oneline -5');
  });

  it('redacts printer args after a redirect, escaped operators and path-prefixed commands (round 4 review)', () => {
    for (const cmd of [
      'echo > f MRKSEC',
      'echo >f MRKSEC',
      "printf '%s' >f MRKSEC",
      'echo 2>/dev/null MRKSEC > f',
      'echo a 2>&1 MRKSEC > f',
      'echo a <in MRKSEC > f',
      'echo $((1<<2)) MRKSEC > f',
      'echo a\\|MRKSEC > f',
      'echo a\\&MRKSEC > f',
      'echo a\\>MRKSEC > f',
      '/bin/echo MRKSEC > f',
      '/usr/bin/printf MRKSEC > f',
      '\\echo MRKSEC > f',
      'echo MRKSEC | /usr/bin/tee f',
      'echo MRKSEC | \\tee f',
      "/usr/bin/sed -i 's/x/MRKSEC/' f",
      "sed --in-place 's/x/MRKSEC/' f",
      "gsed -i 's/x/MRKSEC/' f",
      'exec 3>f\necho MRKSEC >&3',
      'echo $(echo MRKSEC) > f',
      'echo `echo MRKSEC` > f',
      'cat <(echo MRKSEC) > f',
    ]) {
      neither(cmd, 'MRKSEC');
    }
    expect(bashCommand('echo > f MRKSEC')).toBe('echo > f …');
    expect(bashCommand('echo a 2>&1 MRKSEC > f')).toBe('echo … 2>&1 … > f');
    expect(bashCommand('/bin/echo MRKSEC > f')).toBe('/bin/echo … > f');
    expect(writesRedirect('echo x >&3')).toBe(true);
    expect(writesRedirect('cmd 3> f')).toBe(false);
    expect(writesRedirect('exec 3>&-')).toBe(false);
  });

  it('redacts the data a command feeds to inline code, and more writers (round 4 review)', () => {
    for (const cmd of [
      `printf "%s" MRKSEC | python3 -c 'import sys;open("f","w").write(sys.stdin.read())'`,
      `python3 -c 'import sys;open(sys.argv[1],"w").write(sys.argv[2])' f MRKSEC`,
      `node -e 'require("fs").writeFileSync(process.argv[1], process.argv[2])' f MRKSEC`,
      `sh -c 'echo "$1" > f' _ MRKSEC`,
      `deno eval "Deno.writeTextFileSync('f','MRKSEC')"`,
      `echo 'open("f","w").write("MRKSEC")' | python3`,
      "printf 'a\\nMRKSEC\\n.\\nw\\n' | ed -s f",
      'echo MRKSEC | cp /dev/stdin f',
      'echo MRKSEC | install -m 644 /dev/stdin f',
      'cp <(printf MRKSEC) f',
      "vim -c 'normal iMRKSEC' -c wq f",
      "ex -sc 'normal iMRKSEC|x' f",
      "sd 'x' 'MRKSEC' f",
      'yes MRKSEC | head -1 > f',
      "awk -v s=MRKSEC 'BEGIN{print s}' > f",
    ]) {
      neither(cmd, 'MRKSEC');
    }
    expect(bashCommand(`python3 -c 'x' f MRKSEC`)).toBe("python3 -c '…' …");
    expect(bashCommand("awk -v s=MRKSEC 'BEGIN{print s}' > f")).toBe("awk -v s=… '…' > f");
    // Running a script file is not inline code: its arguments stay.
    expect(bashCommand('python3 scripts/gen.py --out x')).toBe('python3 scripts/gen.py --out x');
  });

  it('does not blank plain words that only look like secret syntax (round 4 review)', () => {
    expect(bashCommand('git commit -m "add basic validation"')).toBe('git commit -m "add basic validation"');
    expect(bashCommand('rg cookie: src/server')).toBe('rg cookie: src/server');
    expect(bashCommand('rg "Authorization: header handling" src')).toBe('rg "Authorization: header handling" src');
    expect(bashCommand('pg_dump --primary-key id')).toBe('pg_dump --primary-key id');
    // The real ones are still blanked.
    expect(bashCommand('curl -H "Cookie: s=abcdef" https://x')).toBe('curl -H "Cookie: …" https://x');
    expect(redactSecrets('grep "Bearer eyJhbGciOiJIUzI1NiJ9.x" log')).toBe('grep "Bearer …" log');
    expect(redactSecrets('tool --api-key abc --sort-key name')).toBe('tool --api-key … --sort-key name');
  });

  it('bashDetail honors \\\' inside $\'...\' (P7)', () => {
    neither("echo $'SECRET45\\'' > f", 'SECRET45');
    neither("printf $'a\\'b SECRET46' >> out.txt", 'SECRET46');
    expect(bashDetail("echo $'SECRET45\\'' > f")).toBe('echo … > f');
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
    for (const name of ['run1.jsonl', 'run3.jsonl', 'run-skill-mcp.jsonl']) {
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
