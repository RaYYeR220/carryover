import type { LineClientMsg } from '@carryover/protocol';
import type { LineHandle } from './lineCodes.js';
import { defaultSendDtmf, type PhoneLeg } from './phoneLeg.js';

export const ANSWER_TIMEOUT_MS = 60_000;
// Pages send ~20 ms frames; anything past a second of audio in one frame is not a phone.
export const MAX_FRAME_BYTES = 8000;

// The practice line: the other party is a person on the /line/:code page (usually a phone
// that scanned the QR code). Rings the page, connects when they tap answer, then passes
// raw μ-law frames both ways.
export class BrowserLeg implements PhoneLeg {
  readonly label: string;
  readonly kind = 'line' as const;

  private readonly handle: LineHandle;
  private readonly callerLabel: string;
  private readonly audioCbs: ((mu: Buffer) => void)[] = [];
  private readonly endCbs: ((reason: string) => void)[] = [];
  private state: 'idle' | 'ringing' | 'connected' | 'ended' = 'idle';
  private answerTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingStart: { resolve: () => void; reject: (e: Error) => void } | undefined;

  constructor(handle: LineHandle, callerLabel: string) {
    this.handle = handle;
    this.callerLabel = callerLabel;
    this.label = `Practice line ${handle.code}`;
  }

  // Rings the line; resolves when the page answers, rejects if nobody answers within 60 s
  // (onEnded 'no-answer'), the page goes away, or the call is hung up first.
  start(): Promise<void> {
    if (this.state !== 'idle') return Promise.reject(new Error('this leg was already started'));
    if (this.handle.status !== 'waiting' || (this.handle.leg && this.handle.leg !== this)) {
      this.state = 'ended';
      return Promise.reject(new Error(`line ${this.handle.code} is not free`));
    }
    this.handle.leg = this;
    this.state = 'ringing';
    return new Promise((resolve, reject) => {
      this.pendingStart = { resolve, reject };
      this.answerTimer = setTimeout(() => this.finish('no-answer', true), ANSWER_TIMEOUT_MS);
      this.handle.setStatus('ringing', this.callerLabel);
    });
  }

  onAudio(cb: (mu: Buffer) => void): void {
    this.audioCbs.push(cb);
  }

  sendAudio(mu: Buffer): void {
    if (this.state === 'connected') this.handle.sendAudio(mu);
  }

  // Keypad tones are played down the line, like any phone.
  sendDtmf(digits: string): void {
    defaultSendDtmf(this, digits);
  }

  onEnded(cb: (reason: string) => void): void {
    this.endCbs.push(cb);
  }

  async hangup(reason: string): Promise<void> {
    this.finish(reason, false);
  }

  // ---------------------------------------------------------------- from the line page

  fromPage(msg: LineClientMsg): void {
    if (msg.t === 'line.answer') {
      if (this.state !== 'ringing') return;
      this.state = 'connected';
      this.clearAnswerTimer();
      this.handle.setStatus('connected', this.callerLabel);
      const p = this.pendingStart;
      this.pendingStart = undefined;
      p?.resolve();
      return;
    }
    if (msg.t === 'line.hangup') this.finish('line-hangup', true);
  }

  fromLine(mu: Buffer): void {
    if (this.state !== 'connected' || mu.length === 0 || mu.length > MAX_FRAME_BYTES) return;
    for (const cb of this.audioCbs) cb(mu);
  }

  // The page's socket closed (tab closed, phone locked, network gone) or the line expired.
  lineClosed(): void {
    if (this.state === 'ringing' || this.state === 'connected') this.finish('line-closed', true);
  }

  // ---------------------------------------------------------------- internals

  private finish(reason: string, notify: boolean): void {
    if (this.state === 'ended') return;
    this.state = 'ended';
    this.clearAnswerTimer();
    if (this.handle.leg === this) {
      this.handle.leg = undefined;
      if (this.handle.status !== 'ended') {
        this.handle.setStatus('ended');
        this.handle.setStatus('waiting'); // the line is free for the next call
      }
    }
    const p = this.pendingStart;
    this.pendingStart = undefined;
    p?.reject(new Error(reason === 'no-answer' ? 'no answer' : `call ended: ${reason}`));
    if (!notify) return;
    for (const cb of this.endCbs) {
      try {
        cb(reason);
      } catch {
        // one failing listener must not keep the others from hearing the hang-up
      }
    }
  }

  private clearAnswerTimer(): void {
    if (this.answerTimer) clearTimeout(this.answerTimer);
    this.answerTimer = undefined;
  }
}
