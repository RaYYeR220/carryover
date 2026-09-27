import { defaultSendDtmf, type PhoneLeg } from '../../src/legs/phoneLeg.js';

export interface FakeLegOptions {
  label?: string;
  kind?: PhoneLeg['kind'];
  start?: () => Promise<void>;
}

// A scripted other party: tests push inbound audio and hang up; everything the call sends
// to the line is recorded.
export class FakeLeg implements PhoneLeg {
  readonly label: string;
  readonly kind: PhoneLeg['kind'];
  readonly sent: Buffer[] = [];
  readonly dtmf: string[] = [];
  readonly hangups: string[] = [];
  startCalls = 0;
  private readonly startImpl: () => Promise<void>;
  private readonly audioCbs: ((mu: Buffer) => void)[] = [];
  private readonly endCbs: ((reason: string) => void)[] = [];

  constructor(opts: FakeLegOptions = {}) {
    this.label = opts.label ?? 'Riverside Pharmacy (simulated)';
    this.kind = opts.kind ?? 'scenario';
    this.startImpl = opts.start ?? (() => Promise.resolve());
  }

  start(): Promise<void> {
    this.startCalls++;
    return this.startImpl();
  }

  onAudio(cb: (mu: Buffer) => void): void {
    this.audioCbs.push(cb);
  }

  sendAudio(mu: Buffer): void {
    this.sent.push(Buffer.from(mu));
  }

  sendDtmf(digits: string): void {
    this.dtmf.push(digits);
    defaultSendDtmf(this, digits);
  }

  onEnded(cb: (reason: string) => void): void {
    this.endCbs.push(cb);
  }

  async hangup(reason: string): Promise<void> {
    this.hangups.push(reason);
  }

  // --- test controls
  emitAudio(mu: Buffer): void {
    for (const cb of this.audioCbs) cb(mu);
  }

  emitEnded(reason: string): void {
    for (const cb of this.endCbs) cb(reason);
  }

  get sentBytes(): Buffer {
    return Buffer.concat(this.sent);
  }
}
