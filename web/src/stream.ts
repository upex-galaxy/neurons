// Floating "now" stream at the bottom left of the graph: a glassy stack of short lines like
// a live chat ("● Editing src/api/user.ts"), newest at the bottom. Hover pauses the fading,
// a click opens the event in the detail drawer.
import { ACTION_COLORS, EXTERNAL_COLOR, FAIL_COLOR, type VizEvent } from '../../src/shared/types.ts';
import { agentColor } from './agents.ts';
import { t } from './i18n.ts';
import { STREAM_ACTIONS } from './labels.ts';
import { sessionPalette } from './sessions.ts';
import type { StreamState } from './state.ts';
import { StreamQueue, type StreamLine } from './streamQueue.ts';

const TICK_MS = 250;
/** Matches the CSS leave transition. */
const LEAVE_MS = 450;

/**
 * What the line names: the skill or "server/tool" for those actions, else the repo path,
 * the outside path (a ~/.claude/CLAUDE.md) or, last, `detail`.
 */
export function streamTarget(event: Pick<VizEvent, 'action' | 'paths' | 'outsideRepo' | 'detail'>): string {
  if (event.action === 'skill' || event.action === 'mcp') return event.detail || event.paths[0] || event.outsideRepo?.[0] || '';
  return event.paths[0] || event.outsideRepo?.[0] || event.detail || '';
}

export function streamText(line: Pick<StreamLine, 'action' | 'target'>): string {
  return t('stream.line', { verb: t(`stream.verb.${line.action}`), target: line.target });
}

function dotColor(line: StreamLine): string {
  if (line.phase === 'fail') return FAIL_COLOR;
  if (line.external) return EXTERNAL_COLOR;
  return ACTION_COLORS[line.action];
}

export class LiveStream {
  private readonly queue = new StreamQueue();
  private readonly list: HTMLOListElement;
  private readonly rows = new Map<string, HTMLLIElement>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private enabled = true;

  constructor(
    private readonly root: HTMLElement,
    private readonly onOpen: (eventId: string) => void,
    private readonly onChange: (items: StreamState[]) => void,
  ) {
    this.list = document.createElement('ol');
    this.list.className = 'stream-list';
    root.append(this.list);
    root.addEventListener('mouseenter', () => this.queue.pause(performance.now()));
    root.addEventListener('mouseleave', () => this.queue.resume(performance.now()));
    root.addEventListener('focusin', () => this.queue.pause(performance.now()));
    root.addEventListener('focusout', () => this.queue.resume(performance.now()));
    this.list.addEventListener('click', (ev) => {
      const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-event]');
      if (row?.dataset.event) this.onOpen(row.dataset.event);
    });
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.root.hidden = !on;
    if (!on) this.clear();
  }

  /** Offers an event (already filtered); only file-touching actions make a line. */
  offer(event: VizEvent): void {
    if (!this.enabled || !STREAM_ACTIONS.has(event.action)) return;
    const target = streamTarget(event);
    if (!target) return;
    const line: Omit<StreamLine, 'expires'> = {
      id: event.id,
      key: event.toolUseId ? `${event.sessionId}:${event.toolUseId}` : event.id,
      action: event.action,
      phase: event.phase,
      target,
      sessionId: event.sessionId,
      ...(event.agentId ? { agentId: event.agentId } : {}),
      ...(event.external ? { external: true } : {}),
    };
    const change = this.queue.push(line, performance.now());
    for (const gone of change.removed) this.leave(gone.key);
    if (change.added) this.list.append(this.row(change.added));
    if (change.updated) this.fill(this.rows.get(change.updated.key), change.updated);
    this.publish();
    this.ensureTimer();
  }

  clear(): void {
    for (const gone of this.queue.clear()) this.leave(gone.key, true);
    this.publish();
  }

  /** Re-renders the text after a language change. */
  relabel(): void {
    for (const line of this.queue.items()) this.fill(this.rows.get(line.key), line);
    this.publish();
  }

  private ensureTimer(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      for (const gone of this.queue.expire(performance.now())) this.leave(gone.key);
      if (this.queue.size === 0 && this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
      this.publish();
    }, TICK_MS);
  }

  private publish(): void {
    this.onChange(
      this.queue.items().map((l) => ({ id: l.id, action: l.action, phase: l.phase, text: streamText(l) })),
    );
  }

  private row(line: StreamLine): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'stream-line';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'stream-btn';
    const dot = document.createElement('span');
    dot.className = 'stream-dot';
    dot.setAttribute('aria-hidden', 'true');
    const verb = document.createElement('span');
    verb.className = 'stream-verb';
    const target = document.createElement('span');
    target.className = 'stream-target';
    btn.append(dot, verb, target);
    li.append(btn);
    this.rows.set(line.key, li);
    this.fill(li, line);
    // The slide-in is a CSS keyframe animation (.stream-line), so it runs on insertion.
    return li;
  }

  private fill(li: HTMLLIElement | undefined, line: StreamLine): void {
    if (!li) return;
    const btn = li.firstElementChild as HTMLButtonElement;
    btn.dataset.event = line.id;
    btn.title = t('stream.open');
    btn.setAttribute('aria-label', `${streamText(line)}. ${t('stream.open')}`);
    li.style.setProperty('--c', dotColor(line));
    li.classList.toggle('phase-pre', line.phase === 'pre');
    li.classList.toggle('fail', line.phase === 'fail');
    li.classList.toggle('external', !!line.external);
    const agent = line.agentId && !line.external ? agentColor(line.agentId) : undefined;
    const session = line.external ? undefined : sessionPalette.peek(line.sessionId);
    li.classList.toggle('sub', !!agent);
    if (agent) li.style.setProperty('--a', agent);
    li.classList.toggle('tinted', !!session);
    if (session) li.style.setProperty('--s', session);
    const verb = btn.querySelector('.stream-verb')!;
    const target = btn.querySelector('.stream-target')!;
    verb.textContent = t(`stream.verb.${line.action}`);
    // rtl column: a long path loses its start, not its file name (LRM keeps slashes in place).
    target.textContent = `‎${line.target}‎`;
  }

  private leave(key: string, now = false): void {
    const li = this.rows.get(key);
    if (!li) return;
    this.rows.delete(key);
    if (now) {
      li.remove();
      return;
    }
    li.classList.add('leaving');
    setTimeout(() => li.remove(), LEAVE_MS);
  }
}
