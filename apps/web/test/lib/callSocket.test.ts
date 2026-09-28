import type { AppEvent } from '@carryover/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallSocket, type CallSocketStatus } from '../../src/lib/callSocket';

class FakeSocket {
  static all: FakeSocket[] = [];
  static readonly OPEN = 1;
  readonly url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closedByClient = false;

  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closedByClient = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  message(data: unknown) {
    this.onmessage?.({
      data: typeof data === 'string' ? data : JSON.stringify(data),
    } as MessageEvent);
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: '', wasClean: false } as CloseEvent);
  }
}

const last = () => FakeSocket.all.at(-1) as FakeSocket;

function make() {
  const events: AppEvent[] = [];
  const statuses: CallSocketStatus[] = [];
  const sock = new CallSocket(
    'call-1',
    'tok en',
    { onEvent: (e) => events.push(e), onStatus: (s) => statuses.push(s) },
    {
      WebSocket: FakeSocket as unknown as typeof WebSocket,
      location: { protocol: 'https:', host: 'carryover.test' },
    },
  );
  return { sock, events, statuses };
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('CallSocket', () => {
  it('connects to /ws/app with the call id and token', () => {
    const { statuses } = make();
    expect(last().url).toBe('wss://carryover.test/ws/app?callId=call-1&token=tok+en');
    expect(statuses).toEqual(['connecting']);
    last().open();
    expect(statuses).toEqual(['connecting', 'open']);
  });

  it('uses ws:// on http pages', () => {
    new CallSocket(
      'c',
      't',
      { onEvent: () => {}, onStatus: () => {} },
      {
        WebSocket: FakeSocket as unknown as typeof WebSocket,
        location: { protocol: 'http:', host: 'localhost:5173' },
      },
    );
    expect(last().url).toBe('ws://localhost:5173/ws/app?callId=c&token=t');
  });

  it('forwards events and ignores garbage', () => {
    const { events } = make();
    last().open();
    last().message({ t: 'dtmf', digits: '2', at: 1 });
    last().message('not json');
    last().message({ nope: true });
    last().message([
      { t: 'error', message: 'x' },
      { t: 'relay.spoken', nonce: 'n', at: 2 },
    ]);
    expect(events).toEqual([
      { t: 'dtmf', digits: '2', at: 1 },
      { t: 'error', message: 'x' },
      { t: 'relay.spoken', nonce: 'n', at: 2 },
    ]);
  });

  it('sends commands as JSON, holding them until the socket is open', () => {
    const { sock } = make();
    sock.send({ t: 'say', text: 'Yes' });
    expect(last().sent).toEqual([]);
    last().open();
    sock.send({ t: 'hangup' });
    expect(last().sent).toEqual([
      JSON.stringify({ t: 'say', text: 'Yes' }),
      JSON.stringify({ t: 'hangup' }),
    ]);
  });

  it('reconnects after a drop with 0.5 s, 1.5 s and 4 s backoff, then gives up', () => {
    const { statuses } = make();
    last().open();
    last().drop();
    expect(statuses.at(-1)).toBe('retrying');
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(499);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);
    last().drop();
    vi.advanceTimersByTime(1499);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(3);
    last().drop();
    vi.advanceTimersByTime(3999);
    expect(FakeSocket.all).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(4);
    last().drop();
    expect(statuses.at(-1)).toBe('closed');
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(4);
  });

  it('starts the backoff over after a successful reconnect', () => {
    const { statuses } = make();
    last().open();
    last().drop();
    vi.advanceTimersByTime(500);
    last().open();
    expect(statuses.at(-1)).toBe('open');
    last().drop();
    vi.advanceTimersByTime(500);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it('treats close code 4401 as unauthorized and does not retry', () => {
    const { statuses } = make();
    last().drop(4401);
    expect(statuses.at(-1)).toBe('unauthorized');
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('close() stops for good', () => {
    const { sock, statuses } = make();
    last().open();
    sock.close();
    expect(last().closedByClient).toBe(true);
    expect(statuses.at(-1)).toBe('closed');
    last().drop(1000);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(statuses.filter((s) => s === 'closed')).toHaveLength(1);
  });
});
