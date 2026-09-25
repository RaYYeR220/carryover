// 100 ms of G.711 mu-law audio at 8 kHz mono = 800 bytes (1 byte per sample).
export const CHUNK_BYTES = 800;
const CHUNK_MS = 100;
const BYTES_PER_MS = CHUNK_BYTES / CHUNK_MS;

export class FrameAggregator {
  private pending: Buffer = Buffer.alloc(0);
  private readonly onChunk: (c: Buffer) => void;

  constructor(onChunk: (c: Buffer) => void) {
    this.onChunk = onChunk;
  }

  push(b: Buffer): void {
    this.pending = Buffer.concat([this.pending, b]);
    while (this.pending.length >= CHUNK_BYTES) {
      this.onChunk(Buffer.from(this.pending.subarray(0, CHUNK_BYTES)));
      this.pending = Buffer.from(this.pending.subarray(CHUNK_BYTES));
    }
  }

  flush(): void {
    if (this.pending.length > 0) {
      this.onChunk(this.pending);
      this.pending = Buffer.alloc(0);
    }
  }
}

// Emits exactly CHUNK_BYTES every 100 ms, at real-time pace, never padding a
// short queue with silence -- a tick with less than a full chunk queued emits nothing.
export class RealtimePacer {
  private pending: Buffer = Buffer.alloc(0);
  private readonly onChunk: (c: Buffer) => void;
  private timer: ReturnType<typeof setInterval> | null;

  constructor(onChunk: (c: Buffer) => void) {
    this.onChunk = onChunk;
    this.timer = setInterval(() => this.tick(), CHUNK_MS);
  }

  enqueue(b: Buffer): void {
    this.pending = Buffer.concat([this.pending, b]);
  }

  clear(): void {
    this.pending = Buffer.alloc(0);
  }

  get pendingMs(): number {
    return this.pending.length / BYTES_PER_MS;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    if (this.pending.length < CHUNK_BYTES) return;
    const chunk = Buffer.from(this.pending.subarray(0, CHUNK_BYTES));
    this.pending = Buffer.from(this.pending.subarray(CHUNK_BYTES));
    this.onChunk(chunk);
  }
}
