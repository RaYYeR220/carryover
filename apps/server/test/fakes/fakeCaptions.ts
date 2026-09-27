import type { CaptionsOptions, CaptionTurn, CaptionWord } from '../../src/aai/captions.js';
import type { CaptionsLike } from '../../src/call/callSession.js';

// Stands in for CaptionsStream: records audio / context updates and lets tests play
// U3.5 Pro turns (partials and finals) into the call.
export class FakeCaptions implements CaptionsLike {
  readonly opts: CaptionsOptions;
  readonly audio: Buffer[] = [];
  readonly contexts: string[] = [];
  readonly keytermUpdates: string[][] = [];
  closeCalls = 0;
  sendAudioThrows = false;
  connectBehavior: 'ready' | 'reject' = 'ready';

  constructor(opts: CaptionsOptions) {
    this.opts = opts;
  }

  connect(): Promise<void> {
    if (this.connectBehavior === 'reject') {
      // Like a real ws: the socket 'error' reaches onError and rejects connect().
      const err = new Error('captions connect failed');
      this.opts.onError(err);
      return Promise.reject(err);
    }
    return Promise.resolve();
  }

  sendAudio(mu800: Buffer): void {
    this.audio.push(Buffer.from(mu800));
    if (this.sendAudioThrows) throw new Error('socket write failed');
  }

  setAgentContext(text: string): void {
    this.contexts.push(text);
  }

  setKeyterms(terms: string[]): void {
    this.keytermUpdates.push(terms);
  }

  close(): Promise<void> {
    this.closeCalls++;
    return Promise.resolve();
  }

  // --- test controls
  turn(t: CaptionTurn): void {
    this.opts.onTurn(t);
  }

  partial(turnOrder: number, text: string, speaker?: string): void {
    this.turn({ turnOrder, text, final: false, speaker, words: words(text, 0.9) });
  }

  final(turnOrder: number, text: string, speaker?: string): void {
    this.turn({ turnOrder, text, final: true, speaker, words: words(text, 0.95, speaker) });
  }

  speechStarted(ts = 0): void {
    this.opts.onSpeechStarted(ts);
  }

  error(e: Error): void {
    this.opts.onError(e);
  }
}

function words(text: string, confidence: number, speaker?: string): CaptionWord[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => ({ text: w, confidence, start: i * 300, end: i * 300 + 250, speaker }));
}

export function fakeCaptionsFactory(behavior: { connectBehavior?: 'ready' | 'reject' } = {}) {
  const created: FakeCaptions[] = [];
  const make = (o: CaptionsOptions): FakeCaptions => {
    const c = new FakeCaptions(o);
    if (behavior.connectBehavior) c.connectBehavior = behavior.connectBehavior;
    created.push(c);
    return c;
  };
  return {
    make,
    created,
    get last(): FakeCaptions {
      const c = created.at(-1);
      if (!c) throw new Error('no captions stream was created');
      return c;
    },
  };
}
