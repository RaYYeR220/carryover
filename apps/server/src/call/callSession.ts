import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  type AppCommand,
  type AppEvent,
  type Autonomy,
  type CallSummary,
  type Commitment,
  type Fact,
  type LineState,
  MAX_CALL_MS,
  type SpeakerRef,
  type StartCallRequest,
  type TranscriptEntry,
  type UserDescriptor,
} from '@carryover/protocol';
import type { AgentRegistry } from '../aai/agentRegistry.js';
import type { CaptionsOptions, CaptionsStream, CaptionTurn } from '../aai/captions.js';
import type { VAEvent, VoiceAgentSession } from '../aai/voiceAgent.js';
import { dtmfMulaw } from '../audio/dtmf.js';
import { rmsDbfs } from '../audio/level.js';
import { CHUNK_BYTES, FrameAggregator, RealtimePacer } from '../audio/pacer.js';
import { createLedger, type ExtractedFact, type FactLedger } from '../brain/factGate.js';
import { type BrainCallView, RELAY_TOOLS } from '../brain/policy.js';
import type { Config } from '../config.js';
import type { PhoneLeg } from '../legs/phoneLeg.js';
import type { LlmProvider } from '../llm/provider.js';
import { LineStateTracker, spokenName } from './lineState.js';
import { PoliteQueue } from './politeQueue.js';
import { SpeakerMap } from './speakers.js';
import { summarize } from './summary.js';

// One live call: the other party's phone leg ↔ an AssemblyAI Voice Agent session (ears
// and mouth; its LLM is our Relay Brain) plus a parallel Universal-3.5 Pro captions stream
// for the user. Exposes AppEvents / AppCommands to the user's app and a BrainCallView to
// the Brain.

export type VoiceAgentLike = Pick<
  VoiceAgentSession,
  'sessionId' | 'connect' | 'updateSession' | 'sendAudio' | 'replyCreate' | 'toolResult' | 'end'
>;
export type CaptionsLike = Pick<
  CaptionsStream,
  'connect' | 'sendAudio' | 'setAgentContext' | 'setKeyterms' | 'close'
>;

export interface CallDeps {
  cfg: Config;
  provider: LlmProvider;
  agents: Pick<AgentRegistry, 'ensureRelayAgent'>;
  makeVoiceAgent: (
    agentId: string,
    onEvent: (e: VAEvent) => void,
    onClose: (c: number, r: string) => void,
  ) => VoiceAgentLike;
  makeCaptions: (o: CaptionsOptions) => CaptionsLike;
  now?: () => number;
  log?: (msg: string, detail?: unknown) => void;
}

export interface OpenAsk {
  askId: string;
  question: string;
  field?: string;
  from: string;
  at: number;
}

const TICK_MS = 100;
const ASK_TTL_MS = 90_000;
const LINE_DISCLOSURE_DELAY_MS = 2500;
const CLOSE_CAP_MS = 5000;
const SUMMARY_TIMEOUT_MS = 15_000;
const HISTORY_LIMIT = 200;
const PARTIAL_SPEAKING_MS = 700; // a caption partial this recent means they are talking
const WORDS_RECENT_MS = 1500; // captions words this recent mean loud audio is speech, not music
const VA_SPEECH_MAX_MS = 20_000; // input.speech.started without stopped is trusted this long
const REPLY_ACK_MS = 3000; // reply.create → reply.started, else the create was lost
const REPLY_STALL_MS = 20_000; // a reply silent for this long is treated as over
const END_DRAIN_MAX_MS = 15_000; // end_call: longest wait for the goodbye to play out
const MAX_FACTS = 40;
const MAX_KEYTERMS = 20;
const MAX_KEYTERM_CHARS = 50;
const MAX_FACT_WORDS = 6;
const MIN_GOAL_WORD = 5;
const CHUNK_MS = 100;
const MULAW_SILENCE = 0xff;
const LINE_STATES_FOR_TOOL = new Set<LineState>(['ivr', 'hold', 'human', 'voicemail']);
const AUTOMATED_STATES = new Set<LineState>(['ivr', 'hold', 'voicemail']);

const DESCRIPTOR_PHRASE: Record<UserDescriptor, string> = {
  deaf: 'Deaf',
  'hard-of-hearing': 'hard of hearing',
  'speech-disabled': 'unable to speak on the phone',
  'prefers-text': 'using text',
};

export function disclosureText(userName: string, descriptor: UserDescriptor): string {
  return `Hi, this is Carryover, an automated relay calling for ${userName}, who is ${DESCRIPTOR_PHRASE[descriptor]} and reading along. Please speak normally — I'll pass on everything you say.`;
}

interface AskCard extends OpenAsk {
  timer: ReturnType<typeof setTimeout>;
}

interface PendingToolResult {
  callId: string;
  result: unknown;
  isError: boolean;
  replyId: string | undefined;
}

type RelayKind = 'relay' | 'disclosure';

export class CallSession {
  readonly id: string;
  readonly appToken: string;
  readonly leg: PhoneLeg;
  readonly startedAt: number;
  // Resolves with the summary once the call has fully ended (never rejects).
  readonly finished: Promise<CallSummary>;

  private readonly req: StartCallRequest;
  private readonly deps: CallDeps;
  private readonly now: () => number;
  private readonly log: (msg: string, detail?: unknown) => void;
  private readonly facts: Fact[];
  private readonly ledger: FactLedger;
  private readonly speakers = new SpeakerMap();
  private readonly humanPersons = new Set<number>();
  private readonly line: LineStateTracker;
  private readonly queue: PoliteQueue;
  private readonly inbound: FrameAggregator;
  private readonly view: BrainCallView;
  private readonly subscribers = new Set<(e: AppEvent) => void>();
  private readonly history: AppEvent[] = [];
  private readonly transcriptLog: TranscriptEntry[] = [];
  private readonly commitments: Commitment[] = [];
  private readonly asks = new Map<string, AskCard>();
  private readonly nonceKinds = new Map<string, RelayKind>();
  private readonly spokenRelays: { text: string; kind: RelayKind }[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly interruptedReplies = new Set<string>();
  private resolveFinished: (s: CallSummary) => void = () => undefined;

  private autonomyValue: Autonomy;
  private stateSince: number;
  private va: VoiceAgentLike | undefined;
  private captions: CaptionsLike | undefined;
  private pacer: RealtimePacer | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private ending = false;
  private connectedAt: number | undefined;
  private disclosureQueued = false;

  // Turn-taking signals.
  private vaSpeechActive = false;
  private vaSpeechAt = 0;
  private lastPartialAt = Number.NEGATIVE_INFINITY;
  private lastThemAt = Number.NEGATIVE_INFINITY;
  private lastWordsAt = Number.NEGATIVE_INFINITY;
  private awaitingReplyUntil = 0;
  private replyInFlight: string | undefined;
  private lastReplyEventAt = 0;

  // Tool bookkeeping: results go out when reply.done is the latest reply event.
  private lastVaEvent: 'reply.started' | 'reply.done' | 'input.speech.started' = 'reply.done';
  private pendingTools: PendingToolResult[] = [];
  private pendingDtmf: { digits: string; replyId: string }[] = [];
  private endAfterReply: { replyId?: string; readyAt?: number } | undefined;
  private toolLoopDepth = 0;
  private lastThemPerson: number | undefined;
  private lastFinalText = '';

  constructor(req: StartCallRequest, leg: PhoneLeg, deps: CallDeps) {
    this.id = randomUUID();
    this.appToken = randomBytes(24).toString('base64url');
    this.leg = leg;
    this.req = req;
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.log =
      deps.log ?? ((msg, detail) => console.warn(`[call ${this.id}] ${msg}`, detail ?? ''));
    this.startedAt = this.now();
    this.stateSince = this.startedAt;
    this.autonomyValue = req.autonomy;
    this.facts = req.facts.map((f) => ({ ...f }));
    // Evidence the fabrication gate accepts: consented facts now; typed text, shared facts
    // and the other party's final words as the call goes.
    this.ledger = createLedger(this.facts.map((f) => f.value));
    this.finished = new Promise((resolve) => {
      this.resolveFinished = resolve;
    });
    this.line = new LineStateTracker('connecting', (from, to) => this.onLineStateChange(from, to));
    this.queue = new PoliteQueue(
      {
        themSpeaking: () => this.themSpeaking(),
        agentSpeaking: () => this.agentSpeaking(),
        msSinceThemAudio: () => this.now() - this.lastThemAt,
        ready: () => this.connectedAt !== undefined && !this.ending,
      },
      (nonce, text) => this.speakRelay(nonce, text),
      (ev) => this.emit({ t: 'relay.queued', ...ev }),
      { now: this.now },
    );
    this.inbound = new FrameAggregator((chunk) => this.onInboundChunk(chunk));
    this.view = this.makeView();

    leg.onAudio(this.guard('leg audio', (mu: Buffer) => this.onLegAudio(mu)));
    leg.onEnded(
      this.guard('leg ended', (reason: string) => {
        void this.end(`leg-ended:${reason}`);
      }),
    );
  }

  // ------------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    if (this.started) throw new Error('CallSession.start() called twice');
    this.started = true;
    if (this.ending) return;
    this.armTimer(() => void this.end('max-duration'), MAX_CALL_MS);
    this.pacer = new RealtimePacer(this.guard('leg send', (c: Buffer) => this.leg.sendAudio(c)));
    this.tickTimer = setInterval(
      this.guard('tick', () => this.tick()),
      TICK_MS,
    );

    try {
      const agentId = await this.deps.agents.ensureRelayAgent(this.req.voice, RELAY_TOOLS);
      if (this.ending) return;

      const va = this.deps.makeVoiceAgent(
        agentId,
        this.guard('voice agent event', (e: VAEvent) => this.onVaEvent(e)),
        this.guard('voice agent close', (code: number, reason: string) =>
          this.onVaClose(code, reason),
        ),
      );
      this.va = va;
      await va.connect();
      if (this.ending) return;

      const captions = this.deps.makeCaptions({
        apiKey: this.deps.cfg.aaiKey,
        url: this.deps.cfg.aaiStreamingUrl,
        keyterms: this.keyterms(),
        prompt: `Phone call to ${this.leg.label}. Automated phone menus, hold messages and customer service representatives.`,
        onTurn: this.guard('caption turn', (t: CaptionTurn) => this.onCaptionTurn(t)),
        onSpeechStarted: this.guard('caption speech', () => this.onCaptionSpeechStarted()),
        onError: this.guard('captions error', (e: Error) => this.onCaptionsError(e)),
      });
      this.captions = captions;
      await captions.connect();
      if (this.ending) return;

      this.line.force('ringing');
      await this.leg.start();
      if (this.ending) return;

      this.connectedAt = this.now();
      this.line.force('connecting');
      if (this.leg.kind === 'line') {
        // The practice line is always a person; don't wait for a pickup heuristic.
        this.armTimer(() => this.queueDisclosure(), LINE_DISCLOSURE_DELAY_MS);
      }
      this.queue.tick(this.now());
    } catch (err) {
      // Already ending (hangup, leg gone, time limit): a connect cut short by the
      // shutdown is not a start failure.
      if (this.ending) return;
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ t: 'error', message: `Could not start the call: ${message}` });
      await this.end('start-failed');
      throw err;
    }
  }

  // Idempotent. Closes the Voice Agent, captions and leg at once (capped at 5 s), then
  // writes the summary.
  end(reason: string): Promise<CallSummary> {
    if (!this.ending) {
      this.ending = true;
      this.finish(reason).then(this.resolveFinished, (err: unknown) => {
        this.log('end failed', err);
        this.resolveFinished(this.buildSummary(this.now(), 'Call ended', [], this.commitments));
      });
    }
    return this.finished;
  }

  get ended(): boolean {
    return this.ending;
  }

  private async finish(reason: string): Promise<CallSummary> {
    // First, and synchronously: nothing (a timer, a throw in the bookkeeping below) may
    // stand between a dead call and closing the billed AAI sessions.
    const closing = Promise.allSettled([
      attempt(() => this.va?.end()),
      attempt(() => this.captions?.close()),
      attempt(() => this.leg.hangup(reason)),
    ]);

    const endedAt = this.now();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    this.pacer?.stop();
    this.pacer?.clear();
    this.queue.clear();
    this.pendingTools = [];
    this.pendingDtmf = [];
    this.endAfterReply = undefined;

    this.line.force('ended');
    for (const card of this.asks.values()) {
      clearTimeout(card.timer);
      this.emit({ t: 'ask.resolved', askId: card.askId, how: 'expired' });
    }
    this.asks.clear();
    this.emit({ t: 'alert', kind: 'call-ended', message: endMessage(reason), at: this.now() });

    const settled = await withTimeout(closing, CLOSE_CAP_MS);
    if (settled === undefined) this.log('closing sessions took over 5 s; moving on', reason);

    const s = await withTimeout(
      summarize(this.deps.provider, this.transcriptLog, {
        userName: this.req.userName,
        targetLabel: this.leg.label,
        goal: this.req.goal,
        commitments: this.commitments,
      }),
      SUMMARY_TIMEOUT_MS,
    );
    const summary = s
      ? this.buildSummary(endedAt, s.outcome, s.bullets, s.commitments)
      : this.buildSummary(endedAt, 'Call ended', [], this.commitments);
    this.emit({ t: 'summary', summary });
    return summary;
  }

  private buildSummary(
    endedAt: number,
    outcome: string,
    bullets: string[],
    commitments: Commitment[],
  ): CallSummary {
    return {
      callId: this.id,
      startedAt: this.startedAt,
      endedAt,
      targetLabel: this.leg.label,
      outcome,
      bullets: [...bullets],
      commitments: commitments.map((c) => ({ ...c })),
      transcript: this.transcriptLog.map((e) => ({ ...e })),
    };
  }

  // ------------------------------------------------------------------ app side

  subscribe(fn: (e: AppEvent) => void): () => void {
    this.subscribers.add(fn);
    for (const e of [this.stateEvent(), ...this.history]) {
      try {
        fn(e);
      } catch (err) {
        this.log('subscriber failed during replay', err);
      }
    }
    return () => {
      this.subscribers.delete(fn);
    };
  }

  handleCommand(cmd: AppCommand): void {
    try {
      this.runCommand(cmd);
    } catch (err) {
      this.log(`command ${cmd.t} failed`, err);
      this.emit({ t: 'error', message: 'That did not work. Please try again.' });
    }
  }

  get lineState(): LineState {
    return this.line.state;
  }

  get autonomy(): Autonomy {
    return this.autonomyValue;
  }

  get targetLabel(): string {
    return this.leg.label;
  }

  get transcript(): readonly TranscriptEntry[] {
    return this.transcriptLog;
  }

  openAsks(): OpenAsk[] {
    return [...this.asks.values()].map(({ timer: _timer, ...ask }) => ({ ...ask }));
  }

  verifyToken(token: string): boolean {
    const a = Buffer.from(token);
    const b = Buffer.from(this.appToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  brainView(): BrainCallView {
    return this.view;
  }

  private runCommand(cmd: AppCommand): void {
    if (this.ending) {
      this.emit({ t: 'error', message: 'The call has ended.' });
      return;
    }
    switch (cmd.t) {
      case 'say': {
        const nonces = this.queue.push(cmd.text, cmd.urgent === true);
        if (nonces.length === 0) {
          this.emit({ t: 'error', message: 'Nothing to say: the message is empty.' });
          return;
        }
        this.ledger.add(cmd.text);
        return;
      }
      case 'answer':
        this.answer(cmd);
        return;
      case 'autonomy':
        this.autonomyValue = cmd.value;
        this.emit(this.stateEvent());
        return;
      case 'keys':
        this.queueDtmf(cmd.digits);
        return;
      case 'share': {
        const i = this.facts.findIndex((f) => f.key === cmd.fact.key);
        if (i < 0 && this.facts.length >= MAX_FACTS) {
          this.emit({ t: 'error', message: 'Too many shared details for one call.' });
          return;
        }
        if (i >= 0) this.facts[i] = { ...cmd.fact };
        else this.facts.push({ ...cmd.fact });
        this.ledger.add(cmd.fact.value);
        return;
      }
      case 'hangup':
        void this.end('user-hangup');
        return;
    }
  }

  private answer(cmd: Extract<AppCommand, { t: 'answer' }>): void {
    let text: string;
    let how: 'typed' | 'shared' | 'declined';
    if (cmd.decline) {
      text = `Sorry, ${this.req.userName} would prefer not to share that.`;
      how = 'declined';
    } else if (cmd.text?.trim()) {
      text = cmd.text;
      how = 'typed';
    } else if (cmd.shareFactKey) {
      const fact = this.facts.find((f) => f.key === cmd.shareFactKey);
      if (!fact) {
        this.emit({ t: 'error', message: 'That detail is not shared for this call.' });
        return;
      }
      text = factSentence(fact);
      how = 'shared';
    } else {
      this.emit({ t: 'error', message: 'Type an answer, share a detail, or decline.' });
      return;
    }
    // The other party is waiting for this answer: it does not wait for a pause.
    if (this.queue.push(text, true).length === 0) {
      this.emit({ t: 'error', message: 'Nothing to say: the answer is empty.' });
      return;
    }
    if (how !== 'declined') this.ledger.add(text);
    this.resolveAsk(cmd.askId, how);
  }

  // ------------------------------------------------------------------ Brain side

  private makeView(): BrainCallView {
    const s = this;
    return {
      get callId() {
        return s.id;
      },
      get autonomy() {
        return s.autonomyValue;
      },
      get lineState() {
        return s.line.state;
      },
      get userName() {
        return s.req.userName;
      },
      get userDescriptor() {
        return s.req.userDescriptor;
      },
      get goal() {
        return s.req.goal;
      },
      get facts() {
        return s.facts.map((f) => ({ ...f }));
      },
      get relayPending() {
        return s.queue.pending;
      },
      get ledger() {
        return s.ledger;
      },
      takeNonce: (nonce: string) => s.takeNonce(nonce),
      onToolLoopDepth: () => s.toolLoopDepth,
      onGateBlocked: (sentence: string, offending: ExtractedFact[]) =>
        s.onGateBlocked(sentence, offending),
    };
  }

  private takeNonce(nonce: string): string | undefined {
    const text = this.queue.take(nonce);
    if (text === undefined) return undefined;
    const kind = this.nonceKinds.get(nonce) ?? 'relay';
    this.nonceKinds.delete(nonce);
    this.spokenRelays.push({ text, kind });
    if (this.spokenRelays.length > 10) this.spokenRelays.shift();
    this.emit({ t: 'relay.spoken', nonce, at: this.now() });
    return text;
  }

  private onGateBlocked(sentence: string, offending: ExtractedFact[]): void {
    if (this.ending) return;
    const raws = offending.map((o) => o.raw).join(', ');
    this.emit({
      t: 'gate.blocked',
      sentence,
      reason: `Not in what ${this.req.userName} shared: ${raws}`,
      at: this.now(),
    });
    const what = [...new Set(offending.map((o) => KIND_PHRASE[o.kind]))].join(' and ');
    const keyed = /^press_keys (\S+)$/.exec(sentence);
    const held = keyed ? `keying in ${keyed[1]}` : `"${sentence}"`;
    this.createAsk(
      `They may need ${what}. The agent held back ${held} because you haven't shared it.`,
      undefined,
      `They may need ${what}.`,
    );
  }

  // ------------------------------------------------------------------ Voice Agent

  private onVaEvent(e: VAEvent): void {
    if (this.ending) return;
    const now = this.now();
    switch (e.type) {
      case 'session.ready':
        // Per-call routing: every Brain request carries this tag in messages[0].
        this.va?.updateSession({ system_prompt: `[[carryover-call:${this.id}]] relay session` });
        return;
      case 'reply.started':
        this.replyInFlight = str(e.reply_id) ?? 'unknown';
        this.lastReplyEventAt = now;
        this.awaitingReplyUntil = 0;
        this.lastVaEvent = 'reply.started';
        return;
      case 'reply.audio': {
        const id = str(e.reply_id);
        if (id && this.interruptedReplies.has(id)) return;
        if (typeof e.data !== 'string') return;
        this.lastReplyEventAt = now;
        this.pacer?.enqueue(Buffer.from(e.data, 'base64'));
        return;
      }
      case 'transcript.agent':
        this.onAgentTranscript(e, now);
        return;
      case 'reply.done':
        this.onReplyDone(e, now);
        return;
      case 'tool.call':
        this.onToolCall(e, now);
        return;
      case 'input.speech.started':
        this.vaSpeechActive = true;
        this.vaSpeechAt = now;
        this.lastThemAt = now;
        this.lastVaEvent = 'input.speech.started';
        return;
      case 'input.speech.stopped':
        this.vaSpeechActive = false;
        this.lastThemAt = now;
        return;
      case 'transcript.user': {
        // The Voice Agent's own transcript of the other party: also evidence, since that
        // is the text the Brain's LLM sees.
        this.vaSpeechActive = false;
        this.lastThemAt = now;
        const text = str(e.text);
        if (text) {
          this.ledger.add(text);
          this.toolLoopDepth = 0;
        }
        return;
      }
      case 'session.error':
      case 'error':
        this.log('voice agent error', e);
        return;
      default:
        return;
    }
  }

  private onVaClose(code: number, reason: string): void {
    if (this.ending) return;
    this.log('voice agent socket closed', { code, reason });
    void this.end('voice-agent-closed');
  }

  private onAgentTranscript(e: VAEvent, now: number): void {
    if (typeof e.text !== 'string') return;
    const text = e.text.trim();
    if (!text) return; // a whitespace completion is silence
    const interrupted = e.interrupted === true;
    const source = this.matchRelay(text, interrupted);
    const id = str(e.reply_id) ?? str(e.item_id) ?? `a-${randomUUID()}`;
    this.emit({ t: 'agent.said', id, text, source, interrupted, at: now });
    this.transcriptLog.push({ at: now, who: 'agent', text, source });
    // Agent speech is context for the captions model, never evidence for the gate.
    this.captions?.setAgentContext(text);
  }

  private matchRelay(text: string, interrupted: boolean): 'relay' | 'agent' | 'disclosure' {
    const said = norm(text);
    for (let i = this.spokenRelays.length - 1; i >= 0; i--) {
      const r = this.spokenRelays[i];
      if (!r) continue;
      const relay = norm(r.text);
      if (relay === said || (interrupted && relay.startsWith(said))) {
        this.spokenRelays.splice(i, 1);
        return r.kind;
      }
    }
    return 'agent';
  }

  private onReplyDone(e: VAEvent, now: number): void {
    const id = str(e.reply_id) ?? this.replyInFlight;
    const interrupted = e.status === 'interrupted';
    if (!id || id === this.replyInFlight) this.replyInFlight = undefined;
    this.lastReplyEventAt = now;
    this.lastVaEvent = 'reply.done';

    if (interrupted) {
      if (id) this.rememberInterrupted(id);
      this.pacer?.clear();
      this.pendingTools = this.pendingTools.filter((t) => t.replyId !== id);
      if (this.endAfterReply?.replyId === id) this.endAfterReply = undefined;
    } else {
      this.padPacer();
      if (this.endAfterReply && this.endAfterReply.replyId === id) this.endAfterReply.readyAt = now;
    }
    // Keys pressed in this reply go out after its speech, even if it was cut short: the
    // menu choice was made.
    this.releaseDtmf((d) => d.replyId === id);
    this.flushToolResults();
  }

  private onToolCall(e: VAEvent, now: number): void {
    const callId = str(e.call_id) ?? `call_${randomUUID()}`;
    const name = str(e.name) ?? '';
    const args = toolArgs(e.arguments);
    const replyId = this.replyInFlight;
    this.toolLoopDepth++;
    let outcome: { result: unknown; isError: boolean };
    try {
      outcome = this.runTool(name, args, replyId, now);
    } catch (err) {
      this.log(`tool ${name} failed`, err);
      outcome = { result: { status: 'error', error: 'tool failed' }, isError: true };
    }
    this.pendingTools.push({ callId, replyId, ...outcome });
    this.flushToolResults();
  }

  private runTool(
    name: string,
    args: Record<string, unknown>,
    replyId: string | undefined,
    now: number,
  ): { result: unknown; isError: boolean } {
    const ok = (result: unknown) => ({ result, isError: false });
    const fail = (error: string) => ({ result: { status: 'error', error }, isError: true });
    switch (name) {
      case 'press_keys': {
        const digits = String(args.digits ?? '')
          .replace(/[^0-9*#]/g, '')
          .slice(0, 32);
        if (!digits) return fail('no valid keys: use 0-9, * and #');
        this.queueDtmf(digits);
        return ok({ status: 'pressed', digits });
      }
      case 'ask_user': {
        const question = str(args.question)?.trim();
        if (!question) return fail('question is required');
        const field = str(args.field)?.trim() || undefined;
        const from = this.lastThemLabel();
        this.createAsk(question, field, `${from} asks: ${question}`);
        return ok({ status: 'asked_user' });
      }
      case 'share_fact': {
        const field = str(args.field)?.trim();
        if (!field) return fail('field is required');
        const fact = this.facts.find((f) => f.key === field);
        if (fact) return ok({ value: fact.value });
        const question = `They're asking for your ${humanizeKey(field)}.`;
        this.createAsk(question, field, question);
        return ok({ status: 'not_shared_asking_user' });
      }
      case 'note_commitment': {
        const text = str(args.text)?.trim();
        if (!text) return fail('text is required');
        const when = str(args.when)?.trim();
        const commitment: Commitment = when ? { text, when } : { text };
        this.commitments.push(commitment);
        this.emit({ t: 'commitment', commitment, at: now });
        return ok({ status: 'noted' });
      }
      case 'set_line_state': {
        const state = args.state as LineState;
        if (!LINE_STATES_FOR_TOOL.has(state))
          return fail('state must be ivr, hold, human or voicemail');
        this.line.force(state);
        return ok({ status: 'ok', state });
      }
      case 'end_call':
        // After the goodbye in this reply has played out (see tick()).
        this.endAfterReply = replyId !== undefined ? { replyId } : { readyAt: now };
        return ok({ status: 'ending' });
      default:
        return fail(`unknown tool ${name}`);
    }
  }

  private flushToolResults(): void {
    if (this.lastVaEvent !== 'reply.done' || !this.va || this.pendingTools.length === 0) return;
    const results = this.pendingTools;
    this.pendingTools = [];
    for (const r of results) this.va.toolResult(r.callId, r.result, r.isError);
  }

  private rememberInterrupted(id: string): void {
    this.interruptedReplies.add(id);
    if (this.interruptedReplies.size > 50) {
      const oldest = this.interruptedReplies.values().next().value;
      if (oldest !== undefined) this.interruptedReplies.delete(oldest);
    }
  }

  // ------------------------------------------------------------------ outbound audio

  // DTMF shares the paced outbound path with agent speech, so tones never overlap it.
  // Keys pressed while a reply is in flight wait for that reply to finish.
  private queueDtmf(digits: string): void {
    if (this.replyInFlight !== undefined) {
      this.pendingDtmf.push({ digits, replyId: this.replyInFlight });
    } else {
      this.padPacer();
      this.pacer?.enqueue(dtmfMulaw(digits));
    }
    this.emit({ t: 'dtmf', digits, at: this.now() });
  }

  private releaseDtmf(which: (d: { digits: string; replyId: string }) => boolean): void {
    const release = this.pendingDtmf.filter(which);
    if (release.length === 0) return;
    this.pendingDtmf = this.pendingDtmf.filter((d) => !which(d));
    this.padPacer();
    for (const d of release) this.pacer?.enqueue(dtmfMulaw(d.digits));
  }

  // The pacer only emits whole 100 ms chunks; pad a reply's tail with μ-law silence so
  // its last syllable plays now instead of waiting for the next reply.
  private padPacer(): void {
    const p = this.pacer;
    if (!p) return;
    const bytes = Math.round((p.pendingMs * CHUNK_BYTES) / CHUNK_MS);
    const rem = bytes % CHUNK_BYTES;
    if (rem > 0) p.enqueue(Buffer.alloc(CHUNK_BYTES - rem, MULAW_SILENCE));
  }

  private pacerBusy(): boolean {
    return (this.pacer?.pendingMs ?? 0) >= CHUNK_MS;
  }

  // ------------------------------------------------------------------ inbound audio

  private onLegAudio(mu: Buffer): void {
    if (this.ending) return;
    this.inbound.push(mu);
  }

  private onInboundChunk(chunk: Buffer): void {
    const now = this.now();
    this.va?.sendAudio(chunk);
    this.captions?.sendAudio(chunk);
    this.line.onAudioLevel(rmsDbfs(chunk), now - this.lastWordsAt < WORDS_RECENT_MS, now);
  }

  // ------------------------------------------------------------------ captions

  private onCaptionTurn(turn: CaptionTurn): void {
    if (this.ending) return;
    const now = this.now();
    const text = turn.text.trim();
    this.lastThemAt = now;

    if (!turn.final) {
      this.lastPartialAt = now;
      if (text) this.lastWordsAt = now;
      this.emitCaption(turn, text, this.speakers.peek(turn.speaker).person, false, now);
      return;
    }
    if (!text) return;

    this.lastWordsAt = now;
    const before = this.line.state;
    const { person, isNew } = this.speakers.assign(turn.speaker);
    this.lastThemPerson = person;
    this.lastFinalText = text;
    this.toolLoopDepth = 0;
    this.ledger.add(text); // the other party's words may be repeated back
    this.transcriptLog.push({ at: now, who: 'them', person, text });

    this.line.onFinalTurn(text, isNew);
    const after = this.line.state;
    if (after === 'human') {
      this.humanPersons.add(person);
      const name = spokenName(text);
      if (name && !this.speakers.nameOf(person)) this.speakers.setName(person, name);
      if (isNew && before === 'human') {
        this.emit({ t: 'alert', kind: 'new-speaker', message: 'New person on the line', at: now });
      }
    }
    this.emitCaption(turn, text, person, true, now);
  }

  private emitCaption(
    turn: CaptionTurn,
    text: string,
    person: number,
    final: boolean,
    at: number,
  ): void {
    const automated = AUTOMATED_STATES.has(this.line.state) && !this.humanPersons.has(person);
    const speaker: SpeakerRef = automated
      ? { role: 'ivr', label: 'Automated line', person }
      : { role: 'them', label: this.personLabel(person), person };
    const words = turn.words.map((w) => ({
      text: w.text,
      confidence: w.confidence,
      start: w.start,
      end: w.end,
    }));
    this.emit({ t: 'caption', id: `c${turn.turnOrder}`, speaker, text, words, final, at });
  }

  private onCaptionSpeechStarted(): void {
    if (this.ending) return;
    const now = this.now();
    this.lastPartialAt = now;
    this.lastThemAt = now;
  }

  private onCaptionsError(e: Error): void {
    if (this.ending) return;
    this.log('captions error', e);
    this.emit({ t: 'error', message: `Captions problem: ${e.message}` });
  }

  // ------------------------------------------------------------------ line state

  private onLineStateChange(from: LineState, to: LineState): void {
    const now = this.now();
    this.stateSince = now;
    this.emit(this.stateEvent());
    if (to === 'ended') return;
    if (
      to === 'human' &&
      (from === 'ivr' || from === 'hold' || from === 'connecting' || from === 'ringing')
    ) {
      const words = firstWords(this.lastFinalText);
      this.emit({
        t: 'alert',
        kind: 'human-picked-up',
        message: words ? `A person picked up — ${words}` : 'A person picked up',
        at: now,
      });
    }
    if (to === 'voicemail') {
      this.emit({
        t: 'alert',
        kind: 'voicemail',
        message: 'Voicemail picked up — type the message to leave',
        at: now,
      });
    }
    if (to === 'human') this.queueDisclosure();
  }

  private queueDisclosure(): void {
    if (this.disclosureQueued || this.ending || this.connectedAt === undefined) return;
    this.disclosureQueued = true;
    const nonces = this.queue.push(disclosureText(this.req.userName, this.req.userDescriptor));
    for (const n of nonces) this.nonceKinds.set(n, 'disclosure');
  }

  // ------------------------------------------------------------------ turn-taking

  private themSpeaking(): boolean {
    const now = this.now();
    if (this.vaSpeechActive && now - this.vaSpeechAt < VA_SPEECH_MAX_MS) return true;
    return now - this.lastPartialAt < PARTIAL_SPEAKING_MS;
  }

  // From reply.create (or reply.started) until the reply is done and its audio has
  // played out.
  private agentSpeaking(): boolean {
    return (
      this.now() < this.awaitingReplyUntil || this.replyInFlight !== undefined || this.pacerBusy()
    );
  }

  private speakRelay(nonce: string, _text: string): void {
    this.awaitingReplyUntil = this.now() + REPLY_ACK_MS;
    this.va?.replyCreate(`RELAY_UTTERANCE:${nonce}`);
  }

  private tick(): void {
    if (this.ending) return;
    const now = this.now();
    if (this.replyInFlight !== undefined && now - this.lastReplyEventAt > REPLY_STALL_MS) {
      this.log('reply went quiet without reply.done; treating it as over', this.replyInFlight);
      const stalled = this.replyInFlight;
      this.replyInFlight = undefined;
      this.releaseDtmf((d) => d.replyId === stalled);
    }
    this.queue.tick(now);
    const readyAt = this.endAfterReply?.readyAt;
    if (readyAt !== undefined && (!this.pacerBusy() || now - readyAt > END_DRAIN_MAX_MS)) {
      void this.end('agent-ended');
    }
  }

  // ------------------------------------------------------------------ helpers

  private createAsk(question: string, field: string | undefined, alertMessage: string): void {
    const now = this.now();
    const askId = randomUUID();
    const from = this.lastThemLabel();
    const timer = this.armTimer(() => this.resolveAsk(askId, 'expired'), ASK_TTL_MS);
    this.asks.set(askId, { askId, question, ...(field ? { field } : {}), from, at: now, timer });
    this.emit({ t: 'ask', askId, question, ...(field ? { field } : {}), from, at: now });
    this.emit({ t: 'alert', kind: 'ask', message: alertMessage, at: now });
  }

  private resolveAsk(askId: string, how: 'typed' | 'shared' | 'declined' | 'expired'): void {
    const card = this.asks.get(askId);
    if (!card) return;
    clearTimeout(card.timer);
    this.timers.delete(card.timer);
    this.asks.delete(askId);
    this.emit({ t: 'ask.resolved', askId, how });
  }

  private lastThemLabel(): string {
    return this.lastThemPerson !== undefined
      ? this.personLabel(this.lastThemPerson)
      : 'The other party';
  }

  private personLabel(person: number): string {
    return this.speakers.nameOf(person) ?? `Person ${person}`;
  }

  private stateEvent(): Extract<AppEvent, { t: 'call.state' }> {
    return {
      t: 'call.state',
      lineState: this.line.state,
      autonomy: this.autonomyValue,
      since: this.stateSince,
      targetLabel: this.leg.label,
    };
  }

  private emit(e: AppEvent): void {
    this.record(e);
    for (const fn of [...this.subscribers]) {
      try {
        fn(e);
      } catch (err) {
        this.log('subscriber failed', err);
      }
    }
  }

  // History for late subscribers: the current call.state is sent fresh on subscribe, and
  // a caption replaces its earlier partials.
  private record(e: AppEvent): void {
    if (e.t === 'call.state') return;
    if (e.t === 'caption') {
      const i = this.history.findLastIndex((h) => h.t === 'caption' && h.id === e.id);
      if (i >= 0) this.history.splice(i, 1);
    }
    this.history.push(e);
    if (this.history.length > HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - HISTORY_LIMIT);
    }
  }

  private keyterms(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (term: string) => {
      const t = term.trim();
      if (!t || t.length > MAX_KEYTERM_CHARS) return;
      const k = t.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      out.push(t);
    };
    add(this.req.userName);
    for (const f of this.facts) {
      if (f.value.trim().split(/\s+/).length <= MAX_FACT_WORDS) add(f.value);
    }
    for (const w of (this.req.goal ?? '').split(/[^\p{L}\p{N}]+/u)) {
      if (w.length >= MIN_GOAL_WORD) add(w);
    }
    return out.slice(0, MAX_KEYTERMS);
  }

  private armTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.guard('timer', fn)();
    }, ms);
    this.timers.add(t);
    return t;
  }

  // One throwing handler must never take the call (and its billed sessions) down.
  private guard<A extends unknown[]>(name: string, fn: (...args: A) => void): (...args: A) => void {
    return (...args: A) => {
      try {
        fn(...args);
      } catch (err) {
        this.log(`${name} handler failed`, err);
      }
    };
  }
}

const KIND_PHRASE: Record<ExtractedFact['kind'], string> = {
  digits: 'a number',
  date: 'a date',
  email: 'an email address',
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function toolArgs(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function humanizeKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/\bid\b/gi, 'ID')
    .trim();
}

function factSentence(fact: Fact): string {
  const value = fact.value.trim();
  return `${fact.label}: ${value}${/[.!?]$/.test(value) ? '' : '.'}`;
}

function firstWords(text: string, n = 12): string {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length > n ? `${words.slice(0, n).join(' ')}…` : words.join(' ');
}

function endMessage(reason: string): string {
  if (reason === 'user-hangup') return 'Call ended: you hung up.';
  if (reason === 'agent-ended') return 'Call ended: the conversation is finished.';
  if (reason === 'max-duration') return 'Call ended: the 5-minute demo limit was reached.';
  if (reason === 'voice-agent-closed') return 'Call ended: the voice connection dropped.';
  if (reason === 'start-failed') return 'Call ended: it could not be started.';
  if (reason === 'leg-ended:no-answer') return 'Call ended: no answer.';
  if (reason.startsWith('leg-ended:')) return 'Call ended: the other side hung up.';
  return 'Call ended.';
}

function attempt(fn: () => Promise<unknown> | undefined): Promise<unknown> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([p, cap]).finally(() => clearTimeout(timer));
}
