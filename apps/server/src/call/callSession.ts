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
import { rmsDbfs } from '../audio/level.js';
import { FrameAggregator } from '../audio/pacer.js';
import { createLedger, type ExtractedFact, type FactLedger } from '../brain/factGate.js';
import { type BrainCallView, RELAY_TOOLS } from '../brain/policy.js';
import type { Config } from '../config.js';
import { type DebugLog, debugLogFor } from '../debugLog.js';
import type { PhoneLeg } from '../legs/phoneLeg.js';
import type { LlmProvider } from '../llm/provider.js';
import { LineStateTracker, spokenName } from './lineState.js';
import { Outbound } from './outbound.js';
import { PoliteQueue } from './politeQueue.js';
import { SpeakerMap } from './speakers.js';
import { SUMMARY_TIMEOUT_MS, summarize } from './summary.js';

// One live call: the other party's phone leg ↔ an AssemblyAI Voice Agent session (ears
// and mouth; its LLM is our Relay Brain) plus a parallel Universal-3.5 Pro captions stream
// for the user. Exposes AppEvents / AppCommands to the user's app and a BrainCallView to
// the Brain.
//
// Known limits (documented, not handled):
// - Hold "ads" read by a different voice (a new speaker label during hold) can look like
//   a person picking up: false "human-picked-up" alerts and an early disclosure.
// - For an interrupted reply the transcript keeps AAI's trimmed transcript.agent text,
//   which can include words that were cut off before the other party heard them.

export type VoiceAgentLike = Pick<
  VoiceAgentSession,
  | 'sessionId'
  | 'resumable'
  | 'connect'
  | 'resume'
  | 'updateSession'
  | 'sendAudio'
  | 'replyCreate'
  | 'toolResult'
  | 'end'
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
  debug?: DebugLog; // timing lines; default: stderr when cfg.debug
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
const HISTORY_LIMIT = 200;
// Nobody watching (tab closed, SPA navigated away, the POST aborted while the line still
// rings) leaves a call holding one of the 3 global slots and its AAI sessions for nothing.
// The client's own reconnect backoff tops out around 6 s, so a page reload/flaky network
// still recovers comfortably inside this window.
const NO_VIEWER_END_MS = 45_000;
const PARTIAL_SPEAKING_MS = 700; // a caption partial this recent means they are talking
const WORDS_RECENT_MS = 1500; // captions words this recent mean loud audio is speech, not music
const VA_SPEECH_MAX_MS = 20_000; // input.speech.started without stopped is trusted this long
const REPLY_ACK_MS = 3000; // reply.create → reply.started, else the create was lost
const REPLY_STALL_MS = 20_000; // a reply silent for this long is treated as over
// AAI answers each turn of the other party with a reply of its own (the Brain makes it
// silent while typed text waits) and commits it ~1.3 s after their speech stops. A
// reply.create sent before that is merged into the turn's reply and cut off when AAI
// commits it (live: the disclosure was cut to half a second and the call stalled), so
// relays wait for that reply to finish: at most this long after it started or after
// their last speech event, in case reply.done never comes.
const TURN_SETTLE_MAX_MS = 3000;
const END_DRAIN_MAX_MS = 15_000; // end_call: longest wait for the goodbye to play out
// end_call in a reply the other party talked over ("okay, bye!"): the hang-up was decided
// and part of the goodbye was heard, so the call still ends, this long after the cut.
const END_AFTER_INTERRUPT_MS = 1500;
const DISCLOSURE_REARM_MS = 10_000; // human → voicemail this fast: the "person" was a recording
const REPEAT_PRESS_MS = 5000; // the same press_keys again this soon is a re-press, skipped
// A Voice Agent socket that drops mid-call is resumed (AAI keeps the session 30 s): one
// attempt after each delay, then the call ends. At most this many drops per call.
const VA_RESUME_DELAYS_MS = [500, 2000];
const VA_MAX_RESUMES = 3;
const VA_RECONNECTING_MESSAGE = 'Reconnecting voice…';
const VA_RECONNECTED_MESSAGE = 'Voice reconnected.';
// Turn-taking from the inbound level. Caption partials arrive ~1.3 s apart while someone
// talks and the Voice Agent's speech events trail the audio by 0.4-1.6 s (live run), so
// between them a talking person can look quiet. The level is live.
const SPEECH_DBFS = -40; // an inbound chunk louder than this is someone making sound
// Sound this recent means they are still talking. Together with the polite queue's 700 ms
// clear window a turn is over after 1.5 s of quiet: speakers pause ~1.2 s between two
// sentences of one turn (measured live), and must not be cut into there.
const SOUND_HANGOVER_MS = 800;
// The level is trusted when it heard their latest words: the last caption / Voice Agent
// speech event came at most this long after the last sound, and words were heard lately
// (steady noise without words is not speech). Otherwise the events decide, as before.
const SOUND_EVENT_LAG_MS = 2500;
const SOUND_WORDS_MS = 5000;
const THEM_AUDIO_OFF_MS = 300; // debug timeline: quiet this long is "audio off"
const MAX_FACTS = 40;
const MAX_KEYTERMS = 20;
const MAX_KEYTERM_CHARS = 50;
const MAX_FACT_WORDS = 6;
const MIN_GOAL_WORD = 5;
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

// Timing of one relayed utterance, for the debug timeline.
interface RelayTiming {
  kind: RelayKind;
  queuedAt: number;
  sentAt?: number;
  takenAt?: number;
  replyId?: string;
}

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
  private readonly debug: DebugLog;
  private readonly facts: Fact[];
  private readonly ledger: FactLedger;
  private readonly speakers = new SpeakerMap();
  private readonly humanPersons = new Set<number>();
  private readonly line: LineStateTracker;
  private readonly queue: PoliteQueue;
  private readonly inbound: FrameAggregator;
  private readonly view: BrainCallView;
  private readonly subscribers = new Set<(e: AppEvent) => void>();
  private noViewerTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly history: AppEvent[] = [];
  private readonly transcriptLog: TranscriptEntry[] = [];
  private readonly commitments: Commitment[] = [];
  private readonly asks = new Map<string, AskCard>();
  private readonly nonceKinds = new Map<string, RelayKind>();
  private readonly spokenRelays: { text: string; kind: RelayKind }[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  // Pending wait() calls; the call ending settles them at once.
  private readonly waits = new Set<() => void>();
  private readonly interruptedReplies = new Set<string>();
  private readonly relayTimings = new Map<string, RelayTiming>();
  private readonly repliesWithAudio = new Set<string>();
  private readonly replyAudioBytes = new Map<string, number>();
  private lastBlocker = '';
  private themLoudAt: number | undefined;
  private themQuietSince: number | undefined;
  private resolveFinished: (s: CallSummary) => void = () => undefined;

  private autonomyValue: Autonomy;
  private stateSince: number;
  private va: VoiceAgentLike | undefined;
  private captions: CaptionsLike | undefined;
  private out: Outbound | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private ending = false;
  private connectedAt: number | undefined;
  // Events from a Voice Agent / captions socket that never finished connecting are the
  // connect's failure, handled by start()'s catch, not a call-ending event.
  private vaConnected = false;
  private vaReconnecting = false;
  private vaResumes = 0;
  private captionsConnected = false;
  private disclosureQueued = false;
  private disclosureRearmed = false;
  private disclosureNonces: string[] = [];
  private humanSince = 0;

  // Turn-taking signals.
  private vaSpeechActive = false;
  private vaSpeechAt = 0;
  private lastPartialAt = Number.NEGATIVE_INFINITY;
  private lastThemAt = Number.NEGATIVE_INFINITY;
  private lastWordsAt = Number.NEGATIVE_INFINITY;
  private lastSoundAt = Number.NEGATIVE_INFINITY;
  private awaitingReplyUntil = 0;
  private replyInFlight: string | undefined;
  private replyHasAudio = false;
  private ownReplyId: string | undefined;
  private lastReplyEventAt = 0;
  private replyStartedAt = 0;
  private lastVaSpeechEventAt = 0;

  // Tool bookkeeping: results go out when reply.done is the latest reply event.
  private lastVaEvent: 'reply.started' | 'reply.done' | 'input.speech.started' = 'reply.done';
  private pendingTools: PendingToolResult[] = [];
  private pendingDtmf: { digits: string; replyId: string }[] = [];
  private endAfterReply: { replyId?: string; readyAt?: number; notBefore?: number } | undefined;
  private toolLoopDepth = 0;
  private lastPress: { digits: string; at: number } | undefined;
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
    this.debug = deps.debug ?? debugLogFor(deps.cfg);
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
        msSinceThemAudio: () => this.msSinceThemAudio(),
        ready: () => this.connectedAt !== undefined && !this.ending && !this.vaReconnecting,
        settling: () => this.turnSettling(),
      },
      (nonce, text) => this.speakRelay(nonce, text),
      (ev) => this.emit({ t: 'relay.queued', ...ev }),
      { now: this.now },
    );
    // Guarded so a throw can never leave the chunk in the aggregator to be re-sent.
    this.inbound = new FrameAggregator(
      this.guard('inbound chunk', (chunk: Buffer) => this.onInboundChunk(chunk)),
    );
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
    this.out = new Outbound(
      this.guard('leg send', (c: Buffer) => this.leg.sendAudio(c)),
      this.guard('dtmf start', (digits: string) =>
        this.emit({ t: 'dtmf', digits, at: this.now() }),
      ),
    );
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
      this.vaConnected = true;
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
      this.captionsConnected = true;
      if (this.ending) return;

      this.line.force('ringing');
      await this.leg.start();
      if (this.ending) return;

      this.connectedAt = this.now();
      this.debug('call.connected', { call: this.id.slice(0, 8), leg: this.leg.kind });
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
    // Anything awaiting a wait() (the resume backoff) resumes now and sees the call ending.
    for (const done of [...this.waits]) done();
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    this.out?.stop();
    this.out?.clear();
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
    this.clearNoViewerTimer();
    for (const e of [this.stateEvent(), ...this.history]) {
      try {
        fn(e);
      } catch (err) {
        this.log('subscriber failed during replay', err);
      }
    }
    return () => {
      this.subscribers.delete(fn);
      this.armNoViewerTimer();
    };
  }

  // Nobody is watching: end the call unless that's expected (still setting up AAI, or the
  // call already ended some other way). "Watching" starts once the phone is ringing --
  // before that a viewer dropping off during the brief AAI setup isn't a real abandonment.
  private armNoViewerTimer(): void {
    if (this.subscribers.size > 0 || this.ending) return;
    if (this.connectedAt === undefined && this.line.state !== 'ringing') return;
    this.clearNoViewerTimer();
    this.noViewerTimer = this.armTimer(() => void this.end('no-viewer'), NO_VIEWER_END_MS);
  }

  private clearNoViewerTimer(): void {
    if (!this.noViewerTimer) return;
    clearTimeout(this.noViewerTimer);
    this.timers.delete(this.noViewerTimer);
    this.noViewerTimer = undefined;
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
        this.trackRelay(nonces, 'relay');
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
    const nonces = this.queue.push(text, true);
    this.trackRelay(nonces, 'relay');
    if (nonces.length === 0) {
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
    this.awaitingReplyUntil = 0; // acknowledged: the reply in flight now is ours
    const kind = this.nonceKinds.get(nonce) ?? 'relay';
    this.nonceKinds.delete(nonce);
    if (this.replyInFlight !== undefined) this.ownReplyId = this.replyInFlight;
    const timing = this.relayTimings.get(nonce);
    if (timing) {
      timing.takenAt = this.now();
      timing.replyId = this.replyInFlight;
    }
    this.debug('relay.taken', { nonce, reply: this.replyInFlight });
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
    this.debugVaEvent(e, now);
    switch (e.type) {
      case 'session.ready':
        // Per-call routing: every Brain request carries this tag in messages[0].
        this.va?.updateSession({ system_prompt: `[[carryover-call:${this.id}]] relay session` });
        return;
      case 'reply.started': {
        const id = str(e.reply_id) ?? 'unknown';
        this.replyInFlight = id;
        this.replyHasAudio = false;
        // Probably the reply our reply.create asked for. The ack window stays open until the
        // Brain takes our nonce: AAI may start a reply of its own first (live: a post-tool
        // reply started 60 ms after our reply.create, took the ack, and the next urgent
        // utterance was sent over ours and cut it).
        if (now < this.awaitingReplyUntil) this.ownReplyId = id;
        this.lastReplyEventAt = now;
        this.replyStartedAt = now;
        this.lastVaEvent = 'reply.started';
        return;
      }
      case 'reply.audio': {
        const id = str(e.reply_id);
        if (id && this.interruptedReplies.has(id)) return;
        if (typeof e.data !== 'string') return;
        this.lastReplyEventAt = now;
        if (id === undefined || id === this.replyInFlight) this.replyHasAudio = true;
        this.out?.speech(Buffer.from(e.data, 'base64'), id ?? this.replyInFlight);
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
        this.lastVaSpeechEventAt = now;
        this.lastVaEvent = 'input.speech.started';
        return;
      case 'input.speech.stopped':
        this.vaSpeechActive = false;
        this.lastThemAt = now;
        this.lastVaSpeechEventAt = now;
        return;
      case 'transcript.user':
        // The Voice Agent's own transcript of the other party. Not evidence for the gate
        // (only final captions are: a second STT would widen what can be "confirmed"),
        // but it does mean they spoke, which ends a tool loop.
        this.vaSpeechActive = false;
        this.lastThemAt = now;
        this.lastVaSpeechEventAt = now;
        if (str(e.text)?.trim()) this.toolLoopDepth = 0;
        return;
      case 'session.error':
      case 'error':
        this.log('voice agent error', e);
        return;
      default:
        return;
    }
  }

  private onVaClose(code: number, reason: string): void {
    // Before connect() resolved, a close is the connect failing: start() rejects for it.
    // While resuming, a failed attempt's socket closing is that attempt's failure.
    if (this.ending || !this.vaConnected || this.vaReconnecting) return;
    this.log('voice agent socket closed', { code, reason });
    this.debug('va.closed', { code });
    // A clean close (1000) is the server ending the session; anything else is a drop.
    if (code !== 1000 && this.va?.resumable && this.vaResumes < VA_MAX_RESUMES) {
      void this.resumeVa();
      return;
    }
    void this.end('voice-agent-closed');
  }

  // The Voice Agent socket dropped: resume the same session on a new socket so the call
  // (and AAI's conversation context) carries on. Meanwhile the other party's audio is
  // dropped, not buffered (a burst of stale audio would confuse turn-taking), typed text
  // waits, and whatever reply was in flight is treated as over.
  private async resumeVa(): Promise<void> {
    const va = this.va;
    if (!va) return;
    this.vaResumes++;
    this.vaReconnecting = true;
    if (this.replyInFlight !== undefined) this.recoverStalledReply(this.now());
    this.awaitingReplyUntil = 0;
    this.emit({ t: 'alert', kind: 'voice', message: VA_RECONNECTING_MESSAGE, at: this.now() });
    for (const delay of VA_RESUME_DELAYS_MS) {
      await this.wait(delay);
      if (this.ending) return;
      const startedAt = this.now();
      try {
        await va.resume();
      } catch (err) {
        this.log('voice agent resume failed', err);
        this.debug('va.resume_failed', { ms: this.now() - startedAt });
        if (this.ending) return;
        continue;
      }
      if (this.ending) return;
      this.vaReconnecting = false;
      this.debug('va.resumed', { ms: this.now() - startedAt });
      this.emit({ t: 'alert', kind: 'voice', message: VA_RECONNECTED_MESSAGE, at: this.now() });
      // Typed text sent into the dead socket was never spoken: say it now.
      this.queue.requeueUnspoken();
      this.queue.tick(this.now());
      return;
    }
    this.vaReconnecting = false;
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
    if (!id || id === this.replyInFlight) {
      this.replyInFlight = undefined;
      this.replyHasAudio = false;
    }
    if (id === this.ownReplyId) this.ownReplyId = undefined;
    this.lastReplyEventAt = now;
    this.lastVaEvent = 'reply.done';

    if (interrupted) {
      if (id) this.rememberInterrupted(id);
      // Only this reply's unplayed speech: queued tones and other audio keep going.
      this.out?.dropReply(id);
      this.pendingTools = this.pendingTools.filter((t) => t.replyId !== id);
      // The hang-up stands: without it the call would sit open until the time limit.
      if (this.endAfterReply && this.endAfterReply.replyId === id) {
        this.endAfterReply = { readyAt: now, notBefore: now + END_AFTER_INTERRUPT_MS };
      }
    } else {
      this.out?.padToChunk(id);
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
        // After an interrupted reply its result is dropped and AAI says "Do what is
        // outstanding.": the model presses again. The menu already got the keys.
        const last = this.lastPress;
        if (last && last.digits === digits && now - last.at < REPEAT_PRESS_MS) {
          return ok({ status: 'already_pressed', digits });
        }
        this.lastPress = { digits, at: now };
        this.queueDtmf(digits);
        return ok({ status: 'pressed', digits });
      }
      case 'ask_user': {
        const question = str(args.question)?.trim();
        if (!question) return fail('question is required');
        const field = str(args.field)?.trim() || undefined;
        if (this.askAlreadyOpen(question, field)) return ok({ status: 'already_asked_user' });
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
        if (this.askAlreadyOpen(question, field)) return ok({ status: 'already_asked_user' });
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
      case 'end_call': {
        // After the goodbye in this reply has played out (see tick()). A repeated end_call
        // never pushes an end already on its way back: the earliest deadline wins (an
        // armed one -- e.g. the grace after an interrupted goodbye -- over a new reply's).
        const next = replyId !== undefined ? { replyId } : { readyAt: now };
        const cur = this.endAfterReply;
        if (!cur || (cur.readyAt === undefined && next.readyAt !== undefined)) {
          this.endAfterReply = next;
        }
        return ok({ status: 'ending' });
      }
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
  // Keys pressed while a reply is in flight wait for that reply to finish. The dtmf
  // AppEvent goes out when the tones start playing (Outbound's onDtmfStart).
  private queueDtmf(digits: string): void {
    if (this.replyInFlight !== undefined) {
      this.pendingDtmf.push({ digits, replyId: this.replyInFlight });
    } else {
      this.out?.dtmf(digits);
    }
  }

  private releaseDtmf(which: (d: { digits: string; replyId: string }) => boolean): void {
    const release = this.pendingDtmf.filter(which);
    if (release.length === 0) return;
    this.pendingDtmf = this.pendingDtmf.filter((d) => !which(d));
    for (const d of release) this.out?.dtmf(d.digits);
  }

  private outBusy(): boolean {
    return this.out?.busy ?? false;
  }

  // ------------------------------------------------------------------ inbound audio

  private onLegAudio(mu: Buffer): void {
    if (this.ending) return;
    this.inbound.push(mu);
  }

  // Each sink on its own: a failing captions socket must not starve the Voice Agent.
  private onInboundChunk(chunk: Buffer): void {
    const now = this.now();
    const level = rmsDbfs(chunk);
    try {
      if (!this.vaReconnecting) this.va?.sendAudio(chunk);
    } catch (err) {
      this.log('voice agent audio send failed', err);
    }
    try {
      this.captions?.sendAudio(chunk);
    } catch (err) {
      this.log('captions audio send failed', err);
    }
    try {
      this.line.onAudioLevel(level, now - this.lastWordsAt < WORDS_RECENT_MS, now);
    } catch (err) {
      this.log('audio level check failed', err);
    }
    if (level > SPEECH_DBFS) this.lastSoundAt = now;
    this.debugThemAudio(level, now);
  }

  // Debug timeline only: when the other side's audio goes loud / quiet, which is close to
  // the real start / end of their speech (AAI's own end-of-speech comes ~0.7 s later).
  private debugThemAudio(dbfs: number, now: number): void {
    if (dbfs > SPEECH_DBFS) {
      if (this.themLoudAt === undefined) {
        this.themLoudAt = now;
        this.debug('them.audio_on', { dbfs: Math.round(dbfs) });
      }
      this.themQuietSince = undefined;
      return;
    }
    if (this.themLoudAt === undefined) return;
    this.themQuietSince ??= now;
    if (now - this.themQuietSince < THEM_AUDIO_OFF_MS) return;
    this.debug('them.audio_off', {
      quiet_since: this.themQuietSince,
      loud_ms: this.themQuietSince - this.themLoudAt,
    });
    this.themLoudAt = undefined;
    this.themQuietSince = undefined;
  }

  // ------------------------------------------------------------------ captions

  private onCaptionTurn(turn: CaptionTurn): void {
    if (this.ending) return;
    const now = this.now();
    const text = turn.text.trim();
    this.lastThemAt = now;
    this.debug('cap.turn', { order: turn.turnOrder, final: turn.final, len: text.length });

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
    // The other party's words may be repeated back, but only whole numbers they said.
    this.ledger.add(text, 'other');
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
    this.debug('cap.speech_started');
  }

  private onCaptionsError(e: Error): void {
    if (this.ending) return;
    this.log('captions error', e);
    // A connect failure is reported once, by start().
    if (!this.captionsConnected) return;
    this.emit({ t: 'error', message: `Captions problem: ${e.message}` });
  }

  // ------------------------------------------------------------------ line state

  private onLineStateChange(from: LineState, to: LineState): void {
    const now = this.now();
    this.stateSince = now;
    this.debug('line.state', { from, to });
    this.emit(this.stateEvent());
    if (to === 'ended') return;
    if (
      to === 'human' &&
      (from === 'ivr' ||
        from === 'hold' ||
        from === 'voicemail' ||
        from === 'connecting' ||
        from === 'ringing')
    ) {
      const words = firstWords(this.lastFinalText);
      this.emit({
        t: 'alert',
        kind: 'human-picked-up',
        message: words ? `A person picked up — ${words}` : 'A person picked up',
        at: now,
      });
    }
    if (
      from === 'human' &&
      to === 'voicemail' &&
      this.disclosureQueued &&
      !this.disclosureRearmed &&
      now - this.humanSince <= DISCLOSURE_REARM_MS
    ) {
      this.rearmDisclosure();
    }
    if (to === 'voicemail') {
      this.emit({
        t: 'alert',
        kind: 'voicemail',
        message: 'Voicemail picked up — type the message to leave',
        at: now,
      });
    }
    if (to === 'human') {
      this.humanSince = now;
      this.queueDisclosure();
    }
  }

  private queueDisclosure(): void {
    if (this.disclosureQueued || this.ending || this.connectedAt === undefined) return;
    this.disclosureQueued = true;
    const nonces = this.queue.push(disclosureText(this.req.userName, this.req.userDescriptor));
    this.trackRelay(nonces, 'disclosure');
    this.disclosureNonces = nonces;
    for (const n of nonces) this.nonceKinds.set(n, 'disclosure');
  }

  // The "person" was a recording (a voicemail greeting soon after): withdraw the
  // disclosure if it has not been picked up yet and allow it once more for the next real
  // person, who would otherwise never hear it.
  private rearmDisclosure(): void {
    this.disclosureRearmed = true;
    this.disclosureQueued = false;
    for (const n of this.disclosureNonces) {
      this.queue.take(n);
      this.nonceKinds.delete(n);
    }
    this.disclosureNonces = [];
  }

  // ------------------------------------------------------------------ turn-taking

  private themSpeaking(): boolean {
    return this.themTalking(this.now()) !== undefined;
  }

  // Why the other party counts as talking right now (undefined: they are not).
  private themTalking(now: number): 'sound' | 'va-speech' | 'caption-partial' | undefined {
    if (this.soundTrusted(now)) {
      if (now - this.lastSoundAt < SOUND_HANGOVER_MS) return 'sound';
    } else if (this.vaSpeechActive && now - this.vaSpeechAt < VA_SPEECH_MAX_MS) {
      return 'va-speech';
    }
    return now - this.lastPartialAt < PARTIAL_SPEAKING_MS ? 'caption-partial' : undefined;
  }

  // How long they have been quiet. From the level when it is trusted (a final caption
  // arriving ~1 s after the words is not new speech), else from their last speech event.
  private msSinceThemAudio(): number {
    const now = this.now();
    if (this.soundTrusted(now)) return now - (this.lastSoundAt + SOUND_HANGOVER_MS);
    return now - this.lastThemAt;
  }

  // Hold music is sound too, but not speech.
  private soundTrusted(now: number): boolean {
    return (
      this.line.state !== 'hold' &&
      now - this.lastWordsAt < SOUND_WORDS_MS &&
      this.lastThemAt - this.lastSoundAt <= SOUND_EVENT_LAG_MS
    );
  }

  // The agent is audibly busy: our reply.create is on its way, our own reply is in flight,
  // a reply is producing audio, or audio is still playing out. A silent auto-reply (AAI
  // starts one after every turn of the other party; the Brain answers it with nothing)
  // does not count, or a chatty line would keep typed text waiting indefinitely.
  private agentSpeaking(): boolean {
    if (this.now() < this.awaitingReplyUntil) return true;
    const r = this.replyInFlight;
    if (r !== undefined && (r === this.ownReplyId || this.replyHasAudio)) return true;
    return this.outBusy();
  }

  // AAI is still on the other party's turn: its VAD still hears them (it trails the audio
  // by up to ~1.7 s, and when it catches up it commits the turn, ending whatever reply is
  // playing -- live: a disclosure sent 0.2 s before AAI's speech.stopped got 0 ms of
  // audio), or its reply to that turn (not ours, no sound) is still open.
  private turnSettling(): boolean {
    const now = this.now();
    if (this.vaSpeechActive && now - this.vaSpeechAt < VA_SPEECH_MAX_MS) return true;
    const r = this.replyInFlight;
    if (r === undefined || r === this.ownReplyId || this.replyHasAudio) return false;
    const since = Math.max(this.replyStartedAt, this.lastVaSpeechEventAt);
    return now - since < TURN_SETTLE_MAX_MS;
  }

  private speakRelay(nonce: string, _text: string): void {
    const now = this.now();
    this.awaitingReplyUntil = now + REPLY_ACK_MS;
    const timing = this.relayTimings.get(nonce);
    if (timing) timing.sentAt = now;
    this.debug('relay.sent', { nonce, reply_in_flight: this.replyInFlight });
    this.va?.replyCreate(`RELAY_UTTERANCE:${nonce}`);
  }

  private tick(): void {
    if (this.ending) return;
    const now = this.now();
    if (this.replyInFlight !== undefined && now - this.lastReplyEventAt > REPLY_STALL_MS) {
      this.recoverStalledReply(now);
    }
    this.debugQueueBlocker(now);
    this.queue.tick(now);
    const ending = this.endAfterReply;
    const readyAt = ending?.readyAt;
    if (
      readyAt !== undefined &&
      now >= (ending?.notBefore ?? readyAt) &&
      (!this.outBusy() || now - readyAt > END_DRAIN_MAX_MS)
    ) {
      void this.end('agent-ended');
    }
  }

  // A reply that went quiet without reply.done: treat it as over. Its tool results can no
  // longer be delivered at the right moment, so they are dropped (like an interrupted
  // reply's); keys it pressed still go out, and an end_call in it still ends the call.
  private recoverStalledReply(now: number): void {
    const stalled = this.replyInFlight;
    this.log('reply went quiet without reply.done; treating it as over', stalled);
    this.replyInFlight = undefined;
    this.replyHasAudio = false;
    if (stalled === this.ownReplyId) this.ownReplyId = undefined;
    if (this.lastVaEvent === 'reply.started') this.lastVaEvent = 'reply.done';
    this.pendingTools = this.pendingTools.filter((t) => t.replyId !== stalled);
    const ending = this.endAfterReply;
    if (ending && ending.replyId === stalled) ending.readyAt = now;
    this.releaseDtmf((d) => d.replyId === stalled);
    this.flushToolResults();
  }

  // ------------------------------------------------------------------ debug timeline

  private trackRelay(nonces: string[], kind: RelayKind): void {
    const now = this.now();
    for (const nonce of nonces) {
      if (this.relayTimings.has(nonce)) continue; // "speak now" for text already queued
      this.relayTimings.set(nonce, { kind, queuedAt: now });
      this.debug('relay.queued', { nonce, kind });
    }
    while (this.relayTimings.size > 50) {
      const oldest = this.relayTimings.keys().next().value;
      if (oldest === undefined) break;
      this.relayTimings.delete(oldest);
    }
  }

  private debugVaEvent(e: VAEvent, now: number): void {
    if (e.type === 'reply.audio') {
      const id = str(e.reply_id) ?? this.replyInFlight ?? '?';
      if (typeof e.data === 'string') {
        this.replyAudioBytes.set(id, (this.replyAudioBytes.get(id) ?? 0) + (e.data.length * 3) / 4);
        if (this.replyAudioBytes.size > 100) {
          const oldest = this.replyAudioBytes.keys().next().value;
          if (oldest !== undefined) this.replyAudioBytes.delete(oldest);
        }
      }
      if (this.repliesWithAudio.has(id)) return;
      this.repliesWithAudio.add(id);
      if (this.repliesWithAudio.size > 100) {
        const oldest = this.repliesWithAudio.values().next().value;
        if (oldest !== undefined) this.repliesWithAudio.delete(oldest);
      }
      this.debug('va.first_audio', { reply: id });
      for (const [nonce, r] of this.relayTimings) {
        if (r.takenAt === undefined || (r.replyId !== undefined && r.replyId !== id)) continue;
        this.relayTimings.delete(nonce);
        this.debug('relay.first_audio', {
          nonce,
          kind: r.kind,
          reply: id,
          queued_at: r.queuedAt,
          send_wait_ms: r.sentAt === undefined ? undefined : r.sentAt - r.queuedAt,
          take_ms: r.sentAt === undefined ? undefined : r.takenAt - r.sentAt,
          audio_after_send_ms: r.sentAt === undefined ? undefined : now - r.sentAt,
          total_ms: now - r.queuedAt,
        });
      }
      return;
    }
    if (e.type.endsWith('.delta')) return;
    const replyId = str(e.reply_id);
    this.debug(`va.${e.type}`, {
      // μ-law 8 kHz: 8 bytes per ms of speech received for this reply so far.
      audio_ms:
        e.type === 'reply.done' && replyId
          ? Math.round((this.replyAudioBytes.get(replyId) ?? 0) / 8)
          : undefined,
      reply: str(e.reply_id),
      status: str(e.status),
      name: str(e.name),
      code: str(e.code),
      len: typeof e.text === 'string' ? e.text.length : undefined,
      interrupted: e.interrupted === true ? true : undefined,
    });
  }

  // What is holding the head of the polite queue right now (logged on change).
  private debugQueueBlocker(now: number): void {
    if (this.queue.waiting === 0) {
      this.lastBlocker = '';
      return;
    }
    let why: string;
    const r = this.replyInFlight;
    if (this.connectedAt === undefined) why = 'not-connected';
    else if (now < this.awaitingReplyUntil) why = 'agent:ack';
    else if (r !== undefined && r === this.ownReplyId) why = 'agent:own-reply';
    else if (r !== undefined && this.replyHasAudio) why = 'agent:reply-audio';
    else if (this.outBusy()) why = 'agent:audio-playing';
    else if (this.turnSettling()) why = 'agent:turn-settling';
    else {
      const talking = this.themTalking(now);
      if (talking) why = `them:${talking}`;
      else if (this.msSinceThemAudio() < 700) why = 'them:clear-window';
      else why = 'clear';
    }
    if (why === this.lastBlocker) return;
    this.lastBlocker = why;
    this.debug('queue.blocker', { why, waiting: this.queue.waiting });
  }

  // ------------------------------------------------------------------ helpers

  // One question, one card. While the other party waits, the LLM tends to ask the same
  // thing again through the other tool (live: share_fact, then ask_user, then share_fact
  // for one "member ID, please?", three cards, and the answer spoken three times). An
  // open card for the same field or the same question already covers it.
  private askAlreadyOpen(question: string, field: string | undefined): boolean {
    const q = askKey(question);
    const f = field ? askKey(field) : undefined;
    for (const card of this.asks.values()) {
      if (askKey(card.question) === q) return true;
      if (f && card.field && askKey(card.field) === f) return true;
    }
    return false;
  }

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

  // Resolves after `ms`, or as soon as the call ends (then `ending` is true): an async
  // path awaiting it never hangs on a timer that finish() cleared.
  private wait(ms: number): Promise<void> {
    if (this.ending) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.waits.delete(done);
        resolve();
      };
      this.waits.add(done);
      this.armTimer(done, ms);
    });
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

function askKey(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
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
  if (reason === 'no-viewer') return 'Call ended: nobody was watching.';
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
