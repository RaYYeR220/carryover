import type { VAEvent } from '../../src/aai/voiceAgent.js';
import type { VoiceAgentLike } from '../../src/call/callSession.js';

export type ConnectBehavior = 'ready' | 'reject' | 'hang';
export type ResumeOutcome = 'ready' | 'reject' | 'hang';

// Stands in for VoiceAgentSession: records everything the call sends to AAI and lets tests
// play server events (reply.*, tool.call, input.speech.*, transcript.*) back into it.
export class FakeVoiceAgent implements VoiceAgentLike {
  readonly agentId: string;
  readonly updates: Record<string, unknown>[] = [];
  readonly audio: Buffer[] = [];
  readonly replyCreates: string[] = [];
  readonly toolResults: { callId: string; result: unknown; isError: boolean }[] = [];
  endCalls = 0;
  resumeCalls = 0;
  // One outcome per resume() call, in order; 'ready' once they run out.
  resumeOutcomes: ResumeOutcome[] = [];
  serverEnded = false;
  connectBehavior: ConnectBehavior = 'ready';
  endBehavior: 'resolve' | 'hang' = 'resolve';
  sendAudioThrows = false;
  private abortConnect: (() => void) | undefined;
  private readonly onEvent: (e: VAEvent) => void;
  private readonly onClose: (code: number, reason: string) => void;

  constructor(
    agentId: string,
    onEvent: (e: VAEvent) => void,
    onClose: (code: number, reason: string) => void,
  ) {
    this.agentId = agentId;
    this.onEvent = onEvent;
    this.onClose = onClose;
  }

  get sessionId(): string | undefined {
    return 'sess_fake';
  }

  get resumable(): boolean {
    return this.endCalls === 0 && !this.serverEnded;
  }

  resume(): Promise<void> {
    this.resumeCalls++;
    const outcome = this.resumeOutcomes.shift() ?? 'ready';
    if (outcome === 'reject') {
      // Like the real session: the refused socket closes (1008) and resume() rejects.
      const failed = Promise.reject(new Error('session_not_found'));
      this.onClose(1008, 'session_not_found');
      return failed;
    }
    if (outcome === 'hang') {
      return new Promise((_resolve, reject) => {
        this.abortConnect = () => reject(new Error('socket closed while connecting'));
      });
    }
    this.onEvent({ type: 'session.ready', session_id: 'sess_fake' });
    return Promise.resolve();
  }

  connect(): Promise<void> {
    if (this.connectBehavior === 'reject') {
      // Like a real ws: 'error' rejects connect(), then 'close' fires synchronously,
      // before any awaiting caller has run.
      const failed = Promise.reject(new Error('va connect failed'));
      this.onClose(1006, '');
      return failed;
    }
    if (this.connectBehavior === 'hang') {
      // Like the real session: end() on a socket still connecting terminates it, and the
      // pending connect() rejects.
      return new Promise((_resolve, reject) => {
        this.abortConnect = () => reject(new Error('socket closed while connecting'));
      });
    }
    this.onEvent({ type: 'session.ready', session_id: 'sess_fake' });
    return Promise.resolve();
  }

  updateSession(session: Record<string, unknown>): void {
    this.updates.push(session);
  }

  sendAudio(mu: Buffer): void {
    this.audio.push(Buffer.from(mu));
    if (this.sendAudioThrows) throw new Error('socket write failed');
  }

  replyCreate(instructions: string): void {
    this.replyCreates.push(instructions);
  }

  toolResult(callId: string, result: unknown, isError = false): void {
    this.toolResults.push({ callId, result, isError });
  }

  end(): Promise<void> {
    this.endCalls++;
    this.abortConnect?.();
    if (this.endBehavior === 'hang') return new Promise(() => undefined);
    return Promise.resolve();
  }

  // --- test controls
  emit(ev: VAEvent): void {
    this.onEvent(ev);
  }

  close(code = 1006, reason = 'gone'): void {
    this.onClose(code, reason);
  }

  // Nonces of every reply.create sent so far, in order.
  get nonces(): string[] {
    return this.replyCreates.map((s) => /RELAY_UTTERANCE:([a-z0-9]{8,32})/.exec(s)?.[1] ?? '');
  }
}

export function fakeVoiceAgentFactory(
  behavior: Partial<Pick<FakeVoiceAgent, 'connectBehavior' | 'endBehavior'>> = {},
) {
  const created: FakeVoiceAgent[] = [];
  const make = (
    agentId: string,
    onEvent: (e: VAEvent) => void,
    onClose: (code: number, reason: string) => void,
  ): FakeVoiceAgent => {
    const va = new FakeVoiceAgent(agentId, onEvent, onClose);
    if (behavior.connectBehavior) va.connectBehavior = behavior.connectBehavior;
    if (behavior.endBehavior) va.endBehavior = behavior.endBehavior;
    created.push(va);
    return va;
  };
  return {
    make,
    created,
    get last(): FakeVoiceAgent {
      const va = created.at(-1);
      if (!va) throw new Error('no voice agent was created');
      return va;
    },
  };
}
