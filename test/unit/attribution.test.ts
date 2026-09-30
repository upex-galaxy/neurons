import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Attributor, type DiskChange, type DiskChangeType } from '../../src/server/attribution.ts';
import type { HookPayload } from '../../src/server/normalize.ts';
import { createPathResolver } from '../../src/server/paths.ts';

const tmpDirs: string[] = [];
let repo: string;

beforeAll(() => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-cfg-'));
  tmpDirs.push(cfg);
  process.env.CLAUDE_CONFIG_DIR = cfg;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-attr-'));
  tmpDirs.push(repo);
});

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

let t = 0;
let attr: Attributor;

beforeEach(() => {
  t = 1_000_000;
  attr = new Attributor({ now: () => t, resolver: createPathResolver(repo) });
});

function hook(event: string, fields: Record<string, unknown> = {}): HookPayload {
  return { hook_event_name: event, session_id: 'S1', cwd: repo, ...fields };
}

function bashPre(id: string, extra: Record<string, unknown> = {}): HookPayload {
  return hook('PreToolUse', { tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'rm x' }, ...extra });
}

function change(p: string, type: DiskChangeType = 'unlink'): DiskChange {
  return { type, path: p, ts: t };
}

describe('Bash windows', () => {
  it('attributes nothing without a window (external)', () => {
    expect(attr.classify(change('a.ts'))).toEqual({ attributed: false, suppressed: false });
    expect(attr.openWindows()).toBe(0);
  });

  it('attributes a change inside an open Bash window to its session, agent, tool use and prompt', () => {
    attr.onHook(bashPre('tu1', { agent_id: 'ag1', prompt_id: 'p1' }));
    expect(attr.openWindows()).toBe(1);
    expect(attr.classify(change('a.ts'))).toEqual({
      attributed: true,
      suppressed: false,
      sessionId: 'S1',
      agentId: 'ag1',
      toolUseId: 'tu1',
      promptId: 'p1',
    });
  });

  it('keeps the window open for the grace period after PostToolUse, then closes it', () => {
    attr.onHook(bashPre('tu1'));
    t += 100;
    attr.onHook(hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu1' }));
    t += 599;
    expect(attr.classify(change('a.ts')).attributed).toBe(true);
    t += 2;
    expect(attr.classify(change('a.ts')).attributed).toBe(false);
    expect(attr.openWindows()).toBe(0);
  });

  it.each(['PostToolUseFailure', 'PermissionDenied'])('%s closes the window after grace', (ev) => {
    attr.onHook(bashPre('tu1'));
    attr.onHook(hook(ev, { tool_name: 'Bash', tool_use_id: 'tu1' }));
    t += 601;
    expect(attr.openWindows()).toBe(0);
  });

  it.each(['Stop', 'StopFailure', 'SessionEnd', 'UserPromptSubmit'])(
    '%s closes every window of that session only',
    (ev) => {
      attr.onHook(bashPre('tu1'));
      attr.onHook(bashPre('tu2'));
      attr.onHook({ ...bashPre('tu3'), session_id: 'S2' });
      attr.onHook(hook(ev));
      t += 601;
      expect(attr.openWindows()).toBe(1);
      expect(attr.classify(change('a.ts')).sessionId).toBe('S2');
    },
  );

  it('expires a window whose Post never arrives after the TTL', () => {
    attr = new Attributor({ now: () => t, ttlMs: 10_000 });
    attr.onHook(bashPre('tu1'));
    t += 10_000;
    expect(attr.openWindows()).toBe(1);
    t += 1;
    expect(attr.openWindows()).toBe(0);
    expect(attr.classify(change('a.ts')).attributed).toBe(false);
  });

  it('with overlapping windows, attributes to the most recently opened one', () => {
    attr.onHook(bashPre('tu1', { agent_id: 'ag1' }));
    t += 5;
    attr.onHook(bashPre('tu2', { agent_id: 'ag2' }));
    expect(attr.classify(change('a.ts'))).toMatchObject({ toolUseId: 'tu2', agentId: 'ag2' });
    attr.onHook(hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu2' }));
    t += 700;
    expect(attr.classify(change('a.ts'))).toMatchObject({ toolUseId: 'tu1', agentId: 'ag1' });
  });

  it('a Post for another tool does not close a Bash window', () => {
    attr.onHook(bashPre('tu1'));
    attr.onHook(hook('PostToolUse', { tool_name: 'Read', tool_use_id: 'other' }));
    t += 5000;
    expect(attr.openWindows()).toBe(1);
  });

  it('respects a custom grace period', () => {
    attr = new Attributor({ now: () => t, graceMs: 50 });
    attr.onHook(bashPre('tu1'));
    attr.onHook(hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu1' }));
    t += 51;
    expect(attr.openWindows()).toBe(0);
  });
});

describe('in-flight edits', () => {
  const abs = (rel: string) => path.join(repo, rel);

  it.each(['Edit', 'Write', 'MultiEdit'])('%s Pre suppresses watcher changes on its path until Post + grace', (tool) => {
    attr.onHook(hook('PreToolUse', { tool_name: tool, tool_use_id: 'e1', tool_input: { file_path: abs('src/a.ts') } }));
    expect(attr.classify(change('src/a.ts', 'change'))).toEqual({
      attributed: true,
      suppressed: true,
      sessionId: 'S1',
      toolUseId: 'e1',
    });
    // Other paths are not suppressed, and with no Bash window they are external.
    expect(attr.classify(change('src/b.ts', 'change'))).toEqual({ attributed: false, suppressed: false });
    attr.onHook(hook('PostToolUse', { tool_name: tool, tool_use_id: 'e1', tool_input: { file_path: abs('src/a.ts') } }));
    t += 600;
    expect(attr.classify(change('src/a.ts', 'change')).suppressed).toBe(true);
    t += 1;
    expect(attr.classify(change('src/a.ts', 'change'))).toEqual({ attributed: false, suppressed: false });
  });

  it('NotebookEdit uses notebook_path', () => {
    attr.onHook(
      hook('PreToolUse', { tool_name: 'NotebookEdit', tool_use_id: 'n1', tool_input: { notebook_path: abs('nb.ipynb') } }),
    );
    expect(attr.classify(change('nb.ipynb', 'change')).suppressed).toBe(true);
  });

  it('PostToolUseFailure also ends the in-flight mark', () => {
    attr.onHook(hook('PreToolUse', { tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: abs('a.ts') } }));
    attr.onHook(hook('PostToolUseFailure', { tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: abs('a.ts') } }));
    t += 601;
    expect(attr.classify(change('a.ts', 'change')).suppressed).toBe(false);
  });

  it('suppresses the creation of a new parent dir for an in-flight Write', () => {
    attr.onHook(hook('PreToolUse', { tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: abs('new/dir/x.ts') } }));
    expect(attr.classify(change('new', 'addDir')).suppressed).toBe(true);
    expect(attr.classify(change('new/dir', 'addDir')).suppressed).toBe(true);
    expect(attr.classify(change('new/dir/x.ts', 'add')).suppressed).toBe(true);
    // A file change on a sibling path is not covered.
    expect(attr.classify(change('new/other.ts', 'add')).suppressed).toBe(false);
  });

  it('ignores paths outside the repo', () => {
    attr.onHook(hook('PreToolUse', { tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: '/elsewhere/x.ts' } }));
    expect(attr.classify(change('x.ts', 'add')).suppressed).toBe(false);
  });

  it('without a resolver, tracks relative inputs only', () => {
    attr = new Attributor({ now: () => t });
    attr.onHook(hook('PreToolUse', { tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: './src/a.ts' } }));
    expect(attr.classify(change('src/a.ts', 'change')).suppressed).toBe(true);
  });

  it('an in-flight edit inside a Bash window stays suppressed', () => {
    attr.onHook(bashPre('b1'));
    attr.onHook(hook('PreToolUse', { tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: abs('a.ts') } }));
    expect(attr.classify(change('a.ts', 'change'))).toMatchObject({ suppressed: true, toolUseId: 'e1' });
    expect(attr.classify(change('b.ts', 'change'))).toMatchObject({ suppressed: false, toolUseId: 'b1' });
  });
});

describe('noteReported (dedupe)', () => {
  it('suppresses watcher changes on reported paths for dedupeMs', () => {
    attr.noteReported(['docs/old.md'], { sessionId: 'S9', toolUseId: 'tu9' });
    expect(attr.classify(change('docs/old.md'))).toEqual({
      attributed: true,
      suppressed: true,
      sessionId: 'S9',
      toolUseId: 'tu9',
    });
    t += 2000;
    expect(attr.classify(change('docs/old.md')).suppressed).toBe(true);
    t += 1;
    expect(attr.classify(change('docs/old.md'))).toEqual({ attributed: false, suppressed: false });
  });

  it('without an owner, borrows the open Bash window for attribution', () => {
    attr.onHook(bashPre('tu1'));
    attr.noteReported(['a.ts']);
    expect(attr.classify(change('a.ts'))).toMatchObject({ attributed: true, suppressed: true, toolUseId: 'tu1' });
  });

  it('covers a removed dir when a file beneath it was reported (rm -r)', () => {
    attr.noteReported(['old/a.ts', 'old/b.ts']);
    expect(attr.classify(change('old', 'unlinkDir')).suppressed).toBe(true);
    expect(attr.classify(change('older', 'unlinkDir')).suppressed).toBe(false);
    // A plain file change is matched exactly, not by prefix.
    expect(attr.classify(change('old', 'unlink')).suppressed).toBe(false);
  });

  it('honours a custom dedupe window', () => {
    attr = new Attributor({ now: () => t, dedupeMs: 100 });
    attr.noteReported(['a.ts']);
    t += 101;
    expect(attr.classify(change('a.ts')).suppressed).toBe(false);
  });
});

describe('noteEmitted / wasEmitted', () => {
  it('without a window, remembers watcher emissions for dedupeMs', () => {
    attr.noteEmitted(['a.ts'], t);
    expect(attr.wasEmitted('a.ts')).toBe(true);
    expect(attr.wasEmitted('b.ts')).toBe(false);
    t += 2001;
    expect(attr.wasEmitted('a.ts')).toBe(false);
  });

  // Regression (F1): `echo hi > new.txt && sleep 3` lit new.txt twice, because the record
  // expired after 2 s while the Bash command was still running.
  it('keeps an emission on record for the whole Bash window it fell in', () => {
    attr.onHook(bashPre('b1'));
    t += 100;
    attr.noteEmitted(['new.txt'], t);
    t += 2600;
    attr.onHook(hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'b1' }));
    expect(attr.wasEmitted('new.txt', 'b1')).toBe(true);
    expect(attr.wasEmitted('new.txt')).toBe(false); // no window given: dedupeMs only
  });

  it('does not count an emission made before the window opened', () => {
    attr.noteEmitted(['a.ts'], t);
    t += 10;
    attr.onHook(bashPre('b1'));
    expect(attr.wasEmitted('a.ts', 'b1')).toBe(false);
  });

  it('covers paths beneath a dir emitted as a subtree (rm -r dir, then per-file deletes)', () => {
    attr.onHook(bashPre('b1'));
    attr.noteEmitted(['dir'], t, { present: false, subtree: true });
    attr.noteEmitted(['file'], t, { present: false });
    expect(attr.wasEmitted('dir/a.txt', 'b1', false)).toBe(true);
    expect(attr.wasEmitted('dir/sub/b.txt', 'b1', false)).toBe(true);
    expect(attr.wasEmitted('dir/a.txt', 'b1', true)).toBe(false);
    expect(attr.wasEmitted('file/x', 'b1', false)).toBe(false);
    expect(attr.wasEmitted('dirt/a.txt', 'b1', false)).toBe(false);
  });

  // Regression: a file the watcher lit as created (or edited) and that the same command
  // then deleted counted as "already shown", so the delete was never shown.
  it('only counts an emission that showed the same state (present or gone)', () => {
    attr.onHook(bashPre('b1'));
    attr.noteEmitted(['tmp.txt'], t);
    expect(attr.wasEmitted('tmp.txt', 'b1', true)).toBe(true);
    expect(attr.wasEmitted('tmp.txt', 'b1', false)).toBe(false);
    t += 10;
    attr.noteEmitted(['tmp.txt'], t, { present: false });
    expect(attr.wasEmitted('tmp.txt', 'b1', false)).toBe(true);
    expect(attr.wasEmitted('tmp.txt', 'b1', true)).toBe(false);
  });

  // Regression: a new dir covered files created in it later, so their creates were lost.
  it('a dir emitted as present without subtree does not cover later files inside it', () => {
    attr.onHook(bashPre('b1'));
    attr.noteEmitted(['out'], t);
    attr.noteEmitted(['out/a'], t);
    expect(attr.wasEmitted('out/a', 'b1')).toBe(true);
    expect(attr.wasEmitted('out/b', 'b1')).toBe(false);
  });

  it('the latest record wins between a file and a subtree record above it', () => {
    attr.onHook(bashPre('b1'));
    attr.noteEmitted(['d/a.txt'], t);
    t += 10;
    attr.noteEmitted(['d'], t, { present: false, subtree: true });
    expect(attr.wasEmitted('d/a.txt', 'b1', false)).toBe(true);
    expect(attr.wasEmitted('d/a.txt', 'b1', true)).toBe(false);
  });
});

describe('windows by the time the change was seen (DiskChange.ts)', () => {
  // Regression (F6): classify used the processing time, not c.ts.
  it('an external change seen just before a PreToolUse(Bash) stays external when flushed late', () => {
    const seenAt = t;
    t += 30;
    attr.onHook(bashPre('b1'));
    t += 10;
    expect(attr.classify({ type: 'change', path: 'a.ts', ts: seenAt })).toEqual({ attributed: false, suppressed: false });
    expect(attr.classify({ type: 'change', path: 'a.ts', ts: t })).toMatchObject({ attributed: true, toolUseId: 'b1' });
  });

  it('a change seen inside a window is attributed to it even when classified after the grace', () => {
    attr.onHook(bashPre('b1'));
    t += 400;
    const seenAt = t;
    t += 100;
    attr.onHook(hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'b1' }));
    t += 700; // past Post + 600 ms
    expect(attr.openWindows()).toBe(0);
    expect(attr.classify({ type: 'add', path: 'out.txt', ts: seenAt })).toMatchObject({ attributed: true, toolUseId: 'b1' });
    expect(attr.classify({ type: 'add', path: 'out.txt', ts: t })).toEqual({ attributed: false, suppressed: false });
  });
});

describe('noteReported subtree and moves', () => {
  it('a subtree report covers changes beneath it (heuristic rm -r dir)', () => {
    attr.noteReported(['dir'], { sessionId: 'S1', toolUseId: 'b1' }, { subtree: true });
    expect(attr.classify(change('dir/a.txt')).suppressed).toBe(true);
    expect(attr.classify(change('dir', 'unlinkDir')).suppressed).toBe(true);
    expect(attr.classify(change('dirt/a.txt')).suppressed).toBe(false);
  });

  it('a watcher move is covered when either end was reported', () => {
    attr.noteReported(['x.txt'], { sessionId: 'S1', toolUseId: 'b1' });
    expect(attr.classify({ type: 'move', path: 'y.txt', from: 'x.txt', ts: t }).suppressed).toBe(true);
    expect(attr.classify({ type: 'move', path: 'z.txt', from: 'w.txt', ts: t }).suppressed).toBe(false);
  });

  it('honours a custom suppression time', () => {
    attr.noteReported(['.claude/settings.local.json'], undefined, { ms: 10_000 });
    t += 9000;
    expect(attr.classify(change('.claude', 'addDir')).suppressed).toBe(true);
    expect(attr.classify(change('.claude/settings.local.json', 'add')).suppressed).toBe(true);
    t += 1001;
    expect(attr.classify(change('.claude/settings.local.json', 'change')).suppressed).toBe(false);
  });
});
