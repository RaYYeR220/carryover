import type { AppCommand, AppEvent } from '@carryover/protocol';
import { appSocketUrl } from './api';

export type CallSocketStatus = 'connecting' | 'open' | 'retrying' | 'closed' | 'unauthorized';

export interface CallSocketHandlers {
  onEvent(e: AppEvent): void;
  onStatus(s: CallSocketStatus): void;
}

export interface CallSocketOptions {
  /** WebSocket constructor (tests). Default: the global one. */
  WebSocket?: typeof WebSocket;
  /** Where the page is served from. Default: window.location. */
  location?: Pick<Location, 'protocol' | 'host'>;
}

/** Waits before each reconnect attempt after a drop. */
const BACKOFF_MS = [500, 1500, 4000] as const;
/** Commands typed while reconnecting are kept (up to this many) and sent on reconnect. */
const MAX_PENDING = 20;
const UNAUTHORIZED = 4401;

/**
 * The app's socket for one call: AppEvents in, AppCommands out.
 *
 * After a drop it reconnects up to three times (0.5 s, 1.5 s, 4 s); the server
 * then replays the call state and its recent events, which the reducer applies
 * idempotently. Close code 4401 (bad token or unknown call) is final.
 */
export class CallSocket {
  private readonly url: string;
  private readonly h: CallSocketHandlers;
  private readonly WS: typeof WebSocket;
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: string[] = [];
  private done = false;

  constructor(callId: string, token: string, h: CallSocketHandlers, opts: CallSocketOptions = {}) {
    this.url = appSocketUrl(callId, token, opts.location ?? window.location);
    this.h = h;
    this.WS = opts.WebSocket ?? WebSocket;
    this.connect('connecting');
  }

  send(cmd: AppCommand): void {
    if (this.done) return;
    const data = JSON.stringify(cmd);
    const ws = this.ws;
    if (ws && ws.readyState === 1) {
      ws.send(data);
      return;
    }
    this.pending.push(data);
    if (this.pending.length > MAX_PENDING) this.pending.shift();
  }

  close(): void {
    if (this.done) return;
    this.finish('closed');
  }

  private connect(status: CallSocketStatus): void {
    if (this.done) return;
    this.h.onStatus(status);
    let ws: WebSocket;
    try {
      ws = new this.WS(this.url);
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws || this.done) return;
      this.attempt = 0;
      this.h.onStatus('open');
      const queued = this.pending;
      this.pending = [];
      for (const data of queued) ws.send(data);
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws || this.done) return;
      for (const e of parse(ev.data)) this.h.onEvent(e);
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws || this.done) return;
      this.ws = null;
      if (ev.code === UNAUTHORIZED) this.finish('unauthorized');
      else if (ev.code >= 4000 && ev.code < 5000) this.finish('closed');
      else this.retry();
    };
    // An error is always followed by close; the close handler decides.
    ws.onerror = () => {};
  }

  private retry(): void {
    const wait = BACKOFF_MS[this.attempt];
    if (wait === undefined) {
      this.finish('closed');
      return;
    }
    this.attempt += 1;
    this.h.onStatus('retrying');
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect('retrying');
    }, wait);
  }

  private finish(status: 'closed' | 'unauthorized'): void {
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    this.pending = [];
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
    this.h.onStatus(status);
  }
}

function parse(data: unknown): AppEvent[] {
  if (typeof data !== 'string') return [];
  let v: unknown;
  try {
    v = JSON.parse(data);
  } catch {
    return [];
  }
  const list = Array.isArray(v) ? v : [v];
  return list.filter(
    (x): x is AppEvent =>
      !!x && typeof x === 'object' && typeof (x as { t?: unknown }).t === 'string',
  );
}
