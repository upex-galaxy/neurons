// Stopping a running viewer. The viewer removes its own hooks on SIGTERM, so a stop
// normally only signals and waits. Every signal is preceded by isNeuronsViewer(): a PID
// is signaled only while it is still the viewer that wrote the record (command line and
// start time).

import { isPidAlive } from '../install/settings.ts';
import { isNeuronsViewer, type ViewerIdentity } from './registry.ts';

export const STOP_TIMEOUT_MS = 8000;
const KILL_TIMEOUT_MS = 2000;

export type StopTarget = ViewerIdentity;

export type StopResult =
  /** Exited after SIGTERM. */
  | { status: 'stopped' }
  /** Still running after the wait (no --force). */
  | { status: 'timeout' }
  /** Did not exit after SIGTERM and was killed with SIGKILL (--force): its hooks are still installed. */
  | { status: 'killed' }
  /** The PID is not (or no longer) a Neurons viewer: nothing was signaled. */
  | { status: 'not-viewer' }
  /** The signal could not be sent (EPERM...). */
  | { status: 'error'; message: string };

export interface StopDeps {
  isViewer: (t: StopTarget) => boolean;
  isAlive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: StopDeps = {
  isViewer: isNeuronsViewer,
  isAlive: isPidAlive,
  kill: (pid, signal) => process.kill(pid, signal),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

async function waitExit(pid: number, ms: number, d: StopDeps): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!d.isAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await d.sleep(100);
  }
}

export async function stopViewer(
  t: StopTarget,
  o: { force?: boolean; timeoutMs?: number } = {},
  deps: Partial<StopDeps> = {},
): Promise<StopResult> {
  const d = { ...defaultDeps, ...deps };
  if (!d.isViewer(t)) return { status: 'not-viewer' };
  try {
    d.kill(t.pid, 'SIGTERM');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return { status: 'stopped' };
    return { status: 'error', message: (e as Error).message };
  }
  if (await waitExit(t.pid, o.timeoutMs ?? STOP_TIMEOUT_MS, d)) return { status: 'stopped' };
  if (!o.force) return { status: 'timeout' };
  // Check again right before the kill: the PID must still be the viewer.
  if (!d.isViewer(t)) return d.isAlive(t.pid) ? { status: 'not-viewer' } : { status: 'stopped' };
  try {
    d.kill(t.pid, 'SIGKILL');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') return { status: 'error', message: (e as Error).message };
  }
  await waitExit(t.pid, KILL_TIMEOUT_MS, d);
  return { status: 'killed' };
}
