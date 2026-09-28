import { describe, expect, it, vi } from 'vitest';
import { connectLineSocket, type LineSocketHandlers } from '../../src/line/lineSocket';

/** A minimal, controllable stand-in for the browser WebSocket. */
class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  readonly OPEN = FakeWebSocket.OPEN;
  readonly url: string;
  readyState = FakeWebSocket.OPEN;
  binaryType = 'blob';
  sent: (string | ArrayBuffer | Uint8Array)[] = [];
  closed: { code?: number; reason?: string } | undefined;
  private listeners: Record<string, ((ev: unknown) => void)[]> = {};

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, cb: (ev: unknown) => void): void {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(cb);
  }

  removeEventListener(type: string, cb: (ev: unknown) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== cb);
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', { code: code ?? 1000, wasClean: true });
  }

  emit(type: string, ev: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }

  emitMessage(data: unknown): void {
    this.emit('message', { data });
  }
}

/**
 * Wraps a constructor-style implementation as a `vi.fn` mock, for use as the
 * injectable `WS` constructor `connectLineSocket` takes. `impl` must stay a
 * real `function`, not an arrow: `connectLineSocket` calls `new WS(url)`,
 * and vitest's mock re-invokes a `new`-called mock's implementation via
 * `new` too, which throws "is not a constructor" on an arrow function.
 */
function mockWsCtor(impl: (url: string) => FakeWebSocket) {
  // biome-ignore lint/complexity/useArrowFunction: must be constructible via `new` (see comment above)
  const ctor = function (url: string) {
    return impl(url);
  };
  return vi.fn(ctor) as unknown as new (
    url: string,
  ) => WebSocket;
}

/** A WS constructor mock that always hands back the same fake socket. */
function ctorFor(ws: FakeWebSocket) {
  return mockWsCtor(() => ws);
}

function handlers(): LineSocketHandlers & {
  statuses: unknown[];
  hints: string[];
  audios: Uint8Array[];
  closes: unknown[];
} {
  const statuses: unknown[] = [];
  const hints: string[] = [];
  const audios: Uint8Array[] = [];
  const closes: unknown[] = [];
  return {
    statuses,
    hints,
    audios,
    closes,
    onStatus: (msg) => statuses.push(msg),
    onHint: (text) => hints.push(text),
    onAudio: (mu) => audios.push(mu),
    onClose: (ev) => closes.push(ev),
  };
}

describe('connectLineSocket', () => {
  it('connects to the given URL and sets binaryType to arraybuffer', () => {
    let created: FakeWebSocket | undefined;
    const Ctor = mockWsCtor((url) => {
      created = new FakeWebSocket(url);
      return created;
    });
    connectLineSocket('ws://x/ws/line/ABC123', handlers(), Ctor);
    expect(Ctor).toHaveBeenCalledWith('ws://x/ws/line/ABC123');
    expect(created?.binaryType).toBe('arraybuffer');
  });

  it('routes a line.status JSON message to onStatus', () => {
    const ws = new FakeWebSocket('ws://x');
    const h = handlers();
    connectLineSocket('ws://x', h, ctorFor(ws));
    ws.emitMessage(JSON.stringify({ t: 'line.status', status: 'ringing', callerLabel: 'You' }));
    expect(h.statuses).toEqual([{ t: 'line.status', status: 'ringing', callerLabel: 'You' }]);
  });

  it('routes a line.hint JSON message to onHint', () => {
    const ws = new FakeWebSocket('ws://x');
    const h = handlers();
    connectLineSocket('ws://x', h, ctorFor(ws));
    ws.emitMessage(JSON.stringify({ t: 'line.hint', text: 'Try saying "one moment"' }));
    expect(h.hints).toEqual(['Try saying "one moment"']);
  });

  it('ignores unparseable JSON without throwing', () => {
    const ws = new FakeWebSocket('ws://x');
    const h = handlers();
    connectLineSocket('ws://x', h, ctorFor(ws));
    expect(() => ws.emitMessage('not json')).not.toThrow();
    expect(h.statuses).toEqual([]);
    expect(h.hints).toEqual([]);
  });

  it('routes a binary frame to onAudio as a Uint8Array', () => {
    const ws = new FakeWebSocket('ws://x');
    const h = handlers();
    connectLineSocket('ws://x', h, ctorFor(ws));
    const bytes = new Uint8Array([1, 2, 3, 255]);
    ws.emitMessage(bytes.buffer);
    expect(h.audios).toHaveLength(1);
    expect(h.audios[0]).toBeInstanceOf(Uint8Array);
    expect(Array.from(h.audios[0] as Uint8Array)).toEqual([1, 2, 3, 255]);
  });

  it('sends line.answer as JSON on answer()', () => {
    const ws = new FakeWebSocket('ws://x');
    const socket = connectLineSocket('ws://x', handlers(), ctorFor(ws));
    socket.answer();
    expect(ws.sent).toEqual([JSON.stringify({ t: 'line.answer' })]);
  });

  it('sends line.hangup as JSON on hangup()', () => {
    const ws = new FakeWebSocket('ws://x');
    const socket = connectLineSocket('ws://x', handlers(), ctorFor(ws));
    socket.hangup();
    expect(ws.sent).toEqual([JSON.stringify({ t: 'line.hangup' })]);
  });

  it('sends audio frames as raw binary, not JSON', () => {
    const ws = new FakeWebSocket('ws://x');
    const socket = connectLineSocket('ws://x', handlers(), ctorFor(ws));
    const frame = new Uint8Array(160).fill(0xff);
    socket.sendAudio(frame);
    expect(ws.sent).toEqual([frame]);
  });

  it('does not send while the socket is not open', () => {
    const ws = new FakeWebSocket('ws://x');
    ws.readyState = FakeWebSocket.CONNECTING;
    const socket = connectLineSocket('ws://x', handlers(), ctorFor(ws));
    socket.answer();
    socket.sendAudio(new Uint8Array(160));
    expect(ws.sent).toEqual([]);
  });

  it('calls onClose with the close code and cleanliness', () => {
    const ws = new FakeWebSocket('ws://x');
    const h = handlers();
    connectLineSocket('ws://x', h, ctorFor(ws));
    ws.emit('close', { code: 4401, wasClean: false });
    expect(h.closes).toEqual([{ code: 4401, wasClean: false }]);
  });

  it('close() closes the underlying socket', () => {
    const ws = new FakeWebSocket('ws://x');
    const socket = connectLineSocket('ws://x', handlers(), ctorFor(ws));
    socket.close();
    expect(ws.closed).toBeDefined();
  });
});
