import { dtmfMulaw } from '../audio/dtmf.js';
import { CHUNK_BYTES, RealtimePacer } from '../audio/pacer.js';

const CHUNK_MS = 100;
const MULAW_SILENCE = 0xff;

type Kind = 'speech' | 'pad' | 'dtmf';

interface Segment {
  kind: Kind;
  replyId: string | undefined;
  digits: string | undefined;
  buf: Buffer;
  sent: number; // bytes of buf already played out
}

// Everything the call sends to the other party, paced in real time by one RealtimePacer,
// so agent speech and DTMF tones never overlap. A mirror of what is still queued lets an
// interrupted reply's speech be dropped without losing tones queued around it, and tells
// when a tone actually starts playing.
export class Outbound {
  private readonly pacer: RealtimePacer;
  private readonly onDtmfStart: (digits: string) => void;
  private segs: Segment[] = [];

  constructor(send: (chunk: Buffer) => void, onDtmfStart: (digits: string) => void) {
    this.onDtmfStart = onDtmfStart;
    this.pacer = new RealtimePacer((chunk) => {
      this.consume(chunk.length);
      send(chunk);
    });
  }

  speech(buf: Buffer, replyId: string | undefined): void {
    this.push('speech', buf, replyId, undefined);
  }

  // Tones start on a chunk boundary, after everything queued before them.
  dtmf(digits: string): void {
    this.padToChunk(undefined);
    this.push('dtmf', dtmfMulaw(digits), undefined, digits);
  }

  // The pacer only emits whole 100 ms chunks: pad a reply's tail with μ-law silence so its
  // last syllable plays now instead of waiting for the next audio.
  padToChunk(replyId: string | undefined): void {
    const rem = this.pendingBytes() % CHUNK_BYTES;
    if (rem > 0)
      this.push('pad', Buffer.alloc(CHUNK_BYTES - rem, MULAW_SILENCE), replyId, undefined);
  }

  // Drops what is left of one reply's speech; tones and other replies keep playing.
  dropReply(replyId: string | undefined): void {
    const keep = this.segs.filter((s) => s.kind === 'dtmf' || s.replyId !== replyId);
    if (keep.length === this.segs.length) return;
    this.segs = keep;
    this.pacer.clear();
    for (const s of keep) this.pacer.enqueue(s.buf.subarray(s.sent));
    this.padToChunk(undefined);
  }

  get pendingMs(): number {
    return this.pacer.pendingMs;
  }

  // At least one whole chunk still to play.
  get busy(): boolean {
    return this.pacer.pendingMs >= CHUNK_MS;
  }

  clear(): void {
    this.segs = [];
    this.pacer.clear();
  }

  stop(): void {
    this.pacer.stop();
  }

  private push(kind: Kind, buf: Buffer, replyId: string | undefined, digits: string | undefined) {
    if (buf.length === 0) return;
    this.segs.push({ kind, replyId, digits, buf, sent: 0 });
    this.pacer.enqueue(buf);
  }

  private pendingBytes(): number {
    let n = 0;
    for (const s of this.segs) n += s.buf.length - s.sent;
    return n;
  }

  private consume(n: number): void {
    let left = n;
    while (left > 0) {
      const s = this.segs[0];
      if (!s) return;
      const take = Math.min(left, s.buf.length - s.sent);
      if (s.sent === 0 && s.kind === 'dtmf' && s.digits) this.onDtmfStart(s.digits);
      s.sent += take;
      left -= take;
      if (s.sent >= s.buf.length) this.segs.shift();
    }
  }
}
