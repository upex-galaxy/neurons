// WebSocket client with exponential backoff reconnect.
import type { ServerMessage } from '../../src/shared/types.ts';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export interface WsHandlers {
  onMessage(msg: ServerMessage): void;
  onStatus(status: ConnectionStatus): void;
}

const MESSAGE_TYPES = new Set(['hello', 'event', 'tree', 'sessions']);
const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 8000;

export function defaultWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function isServerMessage(value: unknown): value is ServerMessage {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && MESSAGE_TYPES.has(type);
}

/** Connects and keeps reconnecting until the returned stop function is called. */
export function connect(url: string, handlers: WsHandlers): () => void {
  let socket: WebSocket | null = null;
  let delay = BACKOFF_START_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const schedule = (): void => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      open();
    }, delay);
    delay = Math.min(BACKOFF_MAX_MS, Math.round(delay * 1.7));
  };

  const open = (): void => {
    if (stopped) return;
    handlers.onStatus('connecting');
    try {
      socket = new WebSocket(url);
    } catch {
      handlers.onStatus('closed');
      schedule();
      return;
    }
    socket.addEventListener('open', () => {
      delay = BACKOFF_START_MS;
      handlers.onStatus('open');
    });
    socket.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (isServerMessage(parsed)) handlers.onMessage(parsed);
    });
    socket.addEventListener('close', () => {
      socket = null;
      handlers.onStatus('closed');
      schedule();
    });
    // 'error' is always followed by 'close'; nothing else to do here.
  };

  open();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    socket?.close();
  };
}
