import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';

// The server side of a line page's WebSocket: records what the server sends and lets
// tests play what the page sends.
export class FakeSocket extends EventEmitter {
  readyState = 1; // OPEN
  bufferedAmount = 0;
  readonly sent: { data: Buffer | string; binary: boolean }[] = [];
  closed: { code?: number; reason?: string } | undefined;

  send(data: Buffer | string, opts?: { binary?: boolean }): void {
    this.sent.push({ data, binary: opts?.binary === true });
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closed = { code, reason };
    this.emit('close', code ?? 1005, Buffer.from(reason ?? ''));
  }

  // --- what the page does
  pageJson(msg: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(msg)), false);
  }

  pageText(text: string): void {
    this.emit('message', Buffer.from(text), false);
  }

  pageAudio(mu: Buffer): void {
    this.emit('message', mu, true);
  }

  pageGone(): void {
    this.close(1001, 'going away');
  }

  get json(): unknown[] {
    return this.sent.filter((s) => !s.binary).map((s) => JSON.parse(String(s.data)));
  }

  get audio(): Buffer[] {
    return this.sent.filter((s) => s.binary).map((s) => s.data as Buffer);
  }

  asWs(): WebSocket {
    return this as unknown as WebSocket;
  }
}
