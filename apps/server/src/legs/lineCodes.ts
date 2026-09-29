import { randomInt } from 'node:crypto';
import { LineClientMsg, type LineServerMsg } from '@carryover/protocol';
import type WebSocket from 'ws';
import type { BrowserLeg } from './browserLeg.js';

// Practice lines: a short code the other party opens on their phone (/line/:code) to play
// the business. The line page talks over one WebSocket: JSON LineServerMsg / LineClientMsg
// plus binary frames of μ-law 8 kHz audio in both directions.
//
// Status: 'waiting' (free, ready to ring) → 'ringing' → 'connected' → back to 'waiting'
// when the call ends (the page is told 'ended' first), so one line can take several
// calls. 'ended' as a lasting status means the line itself expired.

export type LineStatus = 'waiting' | 'ringing' | 'connected' | 'ended';

export const LINE_TTL_MS = 30 * 60_000;
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const CODE_LENGTH = 6;
const MAX_LINES = 1000;
const MAX_BUFFERED_BYTES = 64 * 1024; // ~8 s of audio: past this the page is not keeping up
const WS_OPEN = 1;

export interface LineHandle {
  readonly code: string;
  readonly createdAt: number;
  readonly status: LineStatus;
  leg?: BrowserLeg;
  attachSocket(ws: WebSocket): void;
  // For the BrowserLeg on this line.
  setStatus(status: LineStatus, callerLabel?: string): void;
  sendAudio(mu: Buffer): void;
}

class PracticeLine implements LineHandle {
  readonly code: string;
  readonly createdAt: number;
  leg?: BrowserLeg;
  private _status: LineStatus = 'waiting';
  private callerLabel: string | undefined;
  private ws: WebSocket | undefined;
  // Set only when the line's time is up; a call that just ended leaves the line reusable.
  private expired = false;

  constructor(code: string, createdAt: number) {
    this.code = code;
    this.createdAt = createdAt;
  }

  get status(): LineStatus {
    return this._status;
  }

  attachSocket(ws: WebSocket): void {
    if (this.expired) {
      sendJson(ws, { t: 'line.status', status: 'ended' });
      ws.close(4410, 'line expired');
      return;
    }
    // A call already answered on this line must not be yanked out from under it by a
    // second tab/reload -- refuse the newcomer and leave the live socket alone. Before the
    // call connects (waiting/ringing), a reload or a second tab is still a normal takeover.
    if (this._status === 'connected') {
      ws.close(4409, 'line busy');
      return;
    }
    // A reload or a second tab takes the line over; the old socket is let go quietly.
    const old = this.ws;
    this.ws = ws;
    if (old && old !== ws) old.close(4000, 'replaced');

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (this.ws !== ws) return;
      try {
        if (isBinary) this.leg?.fromLine(rawToBuffer(data));
        else this.onJson(rawToBuffer(data).toString('utf8'));
      } catch {
        // a malformed frame from the page must not take the line down
      }
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.leg?.lineClosed();
    });
    ws.on('error', () => undefined); // 'close' follows
    this.sendStatus();
  }

  setStatus(status: LineStatus, callerLabel?: string): void {
    this._status = status;
    this.callerLabel = callerLabel;
    this.sendStatus();
  }

  sendAudio(mu: Buffer): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN || ws.bufferedAmount > MAX_BUFFERED_BYTES) return;
    ws.send(mu, { binary: true });
  }

  expire(): void {
    this.expired = true;
    this._status = 'ended';
    this.leg?.lineClosed();
    this.sendStatus();
    this.ws?.close(4410, 'line expired');
    this.ws = undefined;
  }

  private onJson(text: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const msg = LineClientMsg.safeParse(raw);
    if (msg.success) this.leg?.fromPage(msg.data);
  }

  private sendStatus(): void {
    if (!this.ws) return;
    sendJson(
      this.ws,
      this.callerLabel !== undefined
        ? { t: 'line.status', status: this._status, callerLabel: this.callerLabel }
        : { t: 'line.status', status: this._status },
    );
  }
}

export class LineCodes {
  private readonly lines = new Map<string, PracticeLine>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  create(): LineHandle {
    this.expireOlderThan(LINE_TTL_MS);
    if (this.lines.size >= MAX_LINES) this.evictOldestIdle();
    let code = newCode();
    while (this.lines.has(code)) code = newCode();
    const line = new PracticeLine(code, this.now());
    this.lines.set(code, line);
    return line;
  }

  get(code: string): LineHandle | undefined {
    this.expireOlderThan(LINE_TTL_MS);
    return this.lines.get(code.trim().toUpperCase());
  }

  // Lines older than ms are closed and forgotten, unless a call is on them right now.
  expireOlderThan(ms: number): void {
    const now = this.now();
    for (const [code, line] of this.lines) {
      if (now - line.createdAt > ms && !line.leg) {
        line.expire();
        this.lines.delete(code);
      }
    }
  }

  get size(): number {
    return this.lines.size;
  }

  private evictOldestIdle(): void {
    for (const [code, line] of this.lines) {
      if (!line.leg) {
        line.expire();
        this.lines.delete(code);
        return;
      }
    }
  }
}

function newCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

function sendJson(ws: WebSocket, msg: LineServerMsg): void {
  if (ws.readyState !== WS_OPEN) return;
  ws.send(JSON.stringify(msg));
}

function rawToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
