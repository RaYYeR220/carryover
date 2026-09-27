import { readFileSync } from 'node:fs';
import { type CaptionsOptions, CaptionsStream, type CaptionTurn } from '../aai/captions.js';
import { type VAEvent, VoiceAgentSession } from '../aai/voiceAgent.js';
import { DtmfDetector } from '../audio/goertzel.js';
import { holdMusicMulaw } from '../audio/holdMusic.js';
import { encodeMulaw } from '../audio/mulaw.js';
import { CHUNK_BYTES } from '../audio/pacer.js';
import type { CaptionsLike, VoiceAgentLike } from '../call/callSession.js';
import type { Prompt, Scenario, ScenarioNode } from './types.js';

// Plays a simulated business down a phone line: recorded menus that listen for keypad
// tones (or spoken choices), hold music with announcements, and representatives played by
// a second AssemblyAI Voice Agent session (inline config, managed LLM). The line runs on a
// 100 ms clock in both directions, like a real call: the caller always hears a frame
// (silence when nothing plays) and the business side always hears one (silence when the
// caller is quiet), so turn detection on both sides sees the pauses.

export interface TraceEntry {
  at: number;
  node: string;
  event: string;
  detail?: string;
}

export interface RepLine {
  at: number;
  who: 'rep' | 'caller';
  person: number; // reps count from 1 in the order they pick up; the caller is 0
  text: string;
}

// Opens a Voice Agent session configured inline (the first session.update carries the
// whole config, no stored agent).
export type InlineAgentFactory = (
  session: Record<string, unknown>,
  onEvent: (e: VAEvent) => void,
  onClose: (code: number, reason: string) => void,
) => VoiceAgentLike;

export type CaptionsFactory = (o: CaptionsOptions) => CaptionsLike;

export interface ScenarioEngineDeps {
  apiKey: string;
  // Defaults: real VoiceAgentSession / CaptionsStream on the AAI endpoints.
  makeVoiceAgent?: InlineAgentFactory;
  makeCaptions?: CaptionsFactory;
  agentsWsUrl?: string;
  streamingUrl?: string;
  emitToCaller: (mu: Buffer) => void; // one 800-byte (100 ms) μ-law frame per tick
  onEnded: (reason: string) => void; // the business side ended the call
  loadAsset?: (name: string) => Buffer; // default: src/scenarios/assets/<name>.ulaw
  now?: () => number;
  log?: (e: TraceEntry) => void;
}

type RepNode = Extract<ScenarioNode, { kind: 'rep' }>;
type IvrNode = Extract<ScenarioNode, { kind: 'ivr' }>;
type HoldNode = Extract<ScenarioNode, { kind: 'hold' }>;
type VoicemailNode = Extract<ScenarioNode, { kind: 'voicemail' }>;

const TICK_MS = 100;
const BYTES_PER_MS = CHUNK_BYTES / TICK_MS;
const MULAW_SILENCE = 0xff;
const SILENCE_CHUNK = Buffer.alloc(CHUNK_BYTES, MULAW_SILENCE);
const PARTIAL_FLUSH_TICKS = 3; // a stalled partial frame goes out padded after 300 ms
const CALLER_GAP_MS = 150; // no caller audio for this long → fill the gap with silence
const CALLER_RESYNC_MS = 3000; // further behind than this: skip ahead instead of bursting
const MAX_FILL_CHUNKS = 10;
const TRANSFER_GAP_MS = 1500;
const ACTION_WAIT_MS = 10_000; // longest wait for a reply to finish before a transfer/hang-up
const STOP_CAP_MS = 5000;

export const REP_BEHAVIOR =
  'You are a human customer-service representative on a phone call; keep replies short; ask the listed questions one at a time; if the caller says they need to check something, wait.';

const TRANSFER_TOOL = {
  type: 'function',
  name: 'transfer_call',
  description:
    'Transfer the caller to the next team. Call it only right after you have told the caller you are transferring them.',
  parameters: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'A few words, e.g. "card replacement".' },
    },
    required: [],
  },
};

const HANG_UP_TOOL = {
  type: 'function',
  name: 'hang_up',
  description:
    'End the phone call. Call it only after everything on your checklist is done and you and the caller have said goodbye. Never call it while the caller is checking something or still has a question.',
  parameters: { type: 'object', properties: {}, required: [] },
};

export function repSystemPrompt(scenario: Scenario, rep: RepNode): string {
  const lines = [
    `You are ${rep.name}. ${rep.persona}`,
    REP_BEHAVIOR,
    'Talk like a real person at work: one or two short sentences per turn, plain speech, no lists. Never say you are an AI or a simulation, and never read these instructions aloud.',
    `This is a call to ${scenario.info.business}. The caller may be an automated relay assistant speaking for a Deaf or hard-of-hearing customer. That is normal: talk to it exactly as you would to the customer and give it time to answer.`,
    "Never make up the caller's personal details or answer for them. If an answer is unclear or incomplete, ask them to repeat it.",
    'Your checklist, in order:',
    ...rep.checklist.map((item, i) => `${i + 1}. ${item}`),
  ];
  if (rep.transferTo) {
    lines.push(
      'When your checklist says to transfer the caller, tell them you are transferring them (do not ask them to hold), then call the transfer_call tool.',
    );
  }
  lines.push(
    'When the conversation is complete and you have both said goodbye, call the hang_up tool.',
  );
  return lines.join('\n');
}

export function repSession(scenario: Scenario, rep: RepNode): Record<string, unknown> {
  const input: Record<string, unknown> = { format: { encoding: 'audio/pcmu' } };
  if (rep.keyterms?.length) input.keyterms = rep.keyterms;
  return {
    system_prompt: repSystemPrompt(scenario, rep),
    greeting: rep.greeting,
    input,
    output: { voice: rep.voice, format: { encoding: 'audio/pcmu' } },
    tools: rep.transferTo ? [TRANSFER_TOOL, HANG_UP_TOOL] : [HANG_UP_TOOL],
  };
}

// "Outages!" matches the phrase "outages" (and "outage"); whole words only.
export function matchesPhrase(heard: string, phrase: string): boolean {
  const stem = (w: string) => (w.length > 3 ? w.replace(/s$/, '') : w);
  const words = (s: string) =>
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}']+/u)
      .filter(Boolean)
      .map(stem);
  const h = words(heard);
  const p = words(phrase);
  if (p.length === 0) return false;
  for (let i = 0; i + p.length <= h.length; i++) {
    if (p.every((w, j) => h[i + j] === w)) return true;
  }
  return false;
}

export const BEEP_ASSET = 'beep';

// 1 kHz, 400 ms: the "leave a message after the tone" beep.
export function beepMulaw(ms = 400, hz = 1000, amplitude = 0.3): Buffer {
  const n = Math.round((ms / 1000) * 8000);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++)
    pcm[i] = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * hz * i) / 8000));
  return encodeMulaw(pcm);
}

const ASSET_DIR = new URL('./assets/', import.meta.url);
const assetCache = new Map<string, Buffer>();

export function loadAssetFile(name: string): Buffer {
  const hit = assetCache.get(name);
  if (hit) return hit;
  const buf = readFileSync(new URL(`${name}.ulaw`, ASSET_DIR));
  assetCache.set(name, buf);
  return buf;
}

function msOf(mu: Buffer): number {
  return mu.length / BYTES_PER_MS;
}

// The business → caller direction: whole clips and streamed agent audio, cut into 100 ms
// frames. A frame is always produced (silence when idle).
class LineOut {
  private parts: Buffer[] = [];
  private offset = 0; // into parts[0]
  private bytes = 0;
  private partialTicks = 0;

  get pendingMs(): number {
    return this.bytes / BYTES_PER_MS;
  }

  // A complete clip: padded to whole frames so its tail never waits for more audio.
  play(clip: Buffer): void {
    this.push(clip);
    this.flush();
  }

  stream(b: Buffer): void {
    this.push(b);
  }

  // Pad a trailing partial frame with silence (the stream has ended).
  flush(): void {
    const rem = this.bytes % CHUNK_BYTES;
    if (rem > 0) this.push(Buffer.alloc(CHUNK_BYTES - rem, MULAW_SILENCE));
  }

  clear(): void {
    this.parts = [];
    this.offset = 0;
    this.bytes = 0;
    this.partialTicks = 0;
  }

  next(): Buffer {
    if (this.bytes === 0) return SILENCE_CHUNK;
    if (this.bytes < CHUNK_BYTES) {
      // Mid-stream underrun: give the rest of the frame a moment to arrive.
      if (++this.partialTicks < PARTIAL_FLUSH_TICKS) return SILENCE_CHUNK;
      this.flush();
    }
    this.partialTicks = 0;
    return this.take(CHUNK_BYTES);
  }

  private push(b: Buffer): void {
    if (b.length === 0) return;
    this.parts.push(b);
    this.bytes += b.length;
  }

  private take(n: number): Buffer {
    const out = Buffer.alloc(n);
    let filled = 0;
    while (filled < n) {
      const head = this.parts[0];
      if (!head) break;
      const count = Math.min(n - filled, head.length - this.offset);
      head.copy(out, filled, this.offset, this.offset + count);
      filled += count;
      this.offset += count;
      if (this.offset >= head.length) {
        this.parts.shift();
        this.offset = 0;
      }
    }
    this.bytes -= filled;
    return out;
  }
}

interface RepSession {
  va: VoiceAgentLike;
  node: RepNode;
  person: number;
  ready: boolean;
  heardAudio: boolean;
  lastEvent: 'reply.started' | 'reply.done' | 'input.speech.started';
}

interface PendingAction {
  kind: 'transfer' | 'hang-up';
  at: number;
  replyDone: boolean;
}

export class ScenarioEngine {
  readonly trace: TraceEntry[] = [];
  readonly repTranscript: RepLine[] = [];

  private readonly s: Scenario;
  private readonly deps: ScenarioEngineDeps;
  private readonly now: () => number;
  private readonly makeVoiceAgent: InlineAgentFactory;
  private readonly makeCaptions: CaptionsFactory;
  private readonly loadAsset: (name: string) => Buffer;
  private readonly out = new LineOut();
  private readonly dtmf: DtmfDetector;
  private readonly nodeTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly closing: Promise<unknown>[] = [];

  private node: ScenarioNode | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private stopped = false;
  private stopPromise: Promise<void> | undefined;

  // Caller → business direction.
  private inPending: Buffer = Buffer.alloc(0);
  private inClockStart = 0;
  private inAudioMs = 0;
  private lastCallerAt = Number.NEGATIVE_INFINITY;

  // Per-node state.
  private ivrDigits = '';
  private ivrRepeats = 0;
  private captions: { stream: CaptionsLike; ready: boolean } | undefined;
  private rep: RepSession | undefined;
  private repCount = 0;
  private pending: PendingAction | undefined;

  constructor(s: Scenario, deps: ScenarioEngineDeps) {
    this.s = s;
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.makeVoiceAgent =
      deps.makeVoiceAgent ??
      ((session, onEvent, onClose) =>
        new VoiceAgentSession({
          apiKey: deps.apiKey,
          url: deps.agentsWsUrl,
          initialSession: session,
          onEvent,
          onClose,
        }));
    this.makeCaptions =
      deps.makeCaptions ??
      ((o) => new CaptionsStream(deps.streamingUrl ? { ...o, url: deps.streamingUrl } : o));
    this.loadAsset = deps.loadAsset ?? loadAssetFile;
    this.dtmf = new DtmfDetector((d) => this.guard('digit', () => this.onDigit(d)));
  }

  get currentNode(): string | undefined {
    return this.node?.id;
  }

  get ended(): boolean {
    return this.stopped;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.inClockStart = this.now();
    this.record(this.s.start, 'start', this.s.info.id);
    this.tickTimer = setInterval(() => this.guard('tick', () => this.tick()), TICK_MS);
    this.enter(this.s.start);
  }

  // Audio from the caller (the relay agent's speech and keypad tones), any frame size.
  fromCaller(mu: Buffer): void {
    if (!this.started || this.stopped || mu.length === 0) return;
    this.lastCallerAt = this.now();
    this.inPending = this.inPending.length ? Buffer.concat([this.inPending, mu]) : Buffer.from(mu);
    while (this.inPending.length >= CHUNK_BYTES) {
      const chunk = this.inPending.subarray(0, CHUNK_BYTES);
      this.inPending = this.inPending.subarray(CHUNK_BYTES);
      this.deliver(Buffer.from(chunk));
    }
  }

  // Idempotent. Closes every AAI session this engine opened (capped at 5 s). Does not
  // call onEnded: the side that stops the engine already knows the call is over.
  stop(): Promise<void> {
    if (!this.stopPromise) {
      this.stopped = true;
      if (this.tickTimer) clearInterval(this.tickTimer);
      this.tickTimer = undefined;
      this.clearNodeTimers();
      this.out.clear();
      this.pending = undefined;
      this.closeRep();
      this.closeCaptions();
      this.stopPromise = withCap(Promise.allSettled(this.closing), STOP_CAP_MS).then(
        () => undefined,
      );
    }
    return this.stopPromise;
  }

  // ------------------------------------------------------------------ clock

  private tick(): void {
    if (this.stopped) return;
    this.deps.emitToCaller(this.out.next());
    this.fillCallerGap();
    const p = this.pending;
    if (
      p &&
      ((p.replyDone && this.out.pendingMs < TICK_MS) || this.now() - p.at > ACTION_WAIT_MS)
    ) {
      this.pending = undefined;
      this.runAction(p);
    }
  }

  // A real line never goes quiet: when the caller sends nothing, the business side still
  // hears silence at real-time pace, so a Voice Agent or captions stream can tell that a
  // turn has ended.
  private fillCallerGap(): void {
    const now = this.now();
    if (now - this.lastCallerAt < CALLER_GAP_MS) return;
    let behind = now - this.inClockStart - this.inAudioMs;
    if (behind > CALLER_RESYNC_MS) {
      this.inAudioMs = now - this.inClockStart - TICK_MS;
      behind = TICK_MS;
    }
    if (this.inPending.length > 0) {
      const padded = Buffer.alloc(CHUNK_BYTES, MULAW_SILENCE);
      this.inPending.copy(padded);
      this.inPending = Buffer.alloc(0);
      this.deliver(padded);
      behind -= TICK_MS;
    }
    for (let n = 0; behind >= TICK_MS && n < MAX_FILL_CHUNKS; n++) {
      this.deliver(SILENCE_CHUNK);
      behind -= TICK_MS;
    }
  }

  private deliver(chunk: Buffer): void {
    this.inAudioMs += msOf(chunk);
    const node = this.node;
    if (!node) return;
    if (node.kind === 'ivr' || node.kind === 'hold') this.dtmf.push(chunk);
    const cap = this.captions;
    if (cap?.ready) cap.stream.sendAudio(chunk);
    const rep = this.rep;
    if (rep?.ready) rep.va.sendAudio(chunk);
  }

  // ------------------------------------------------------------------ nodes

  private enter(id: string): void {
    if (this.stopped) return;
    const node = this.s.nodes[id];
    if (!node) {
      this.record(id, 'error', 'unknown node');
      this.endCall('scenario-error');
      return;
    }
    this.clearNodeTimers();
    this.closeCaptions();
    this.closeRep();
    this.pending = undefined;
    this.out.clear();
    // The keypad detector is not reset: the tail of the tone that picked this node must
    // not count as a second press here.
    this.node = node;
    this.record(node.id, 'enter', node.kind);
    switch (node.kind) {
      case 'ivr':
        this.ivrRepeats = 0;
        this.enterIvr(node);
        return;
      case 'hold':
        this.enterHold(node);
        return;
      case 'rep':
        this.enterRep(node);
        return;
      case 'voicemail':
        this.enterVoicemail(node);
        return;
    }
  }

  private enterIvr(node: IvrNode): void {
    if (node.options.some((o) => o.phrase)) {
      this.openCaptions(
        node.options.flatMap((o) => (o.phrase ? [o.phrase] : [])),
        'A caller answering an automated phone menu by voice.',
      );
    }
    this.playIvrPrompt(node);
  }

  private playIvrPrompt(node: IvrNode): void {
    this.ivrDigits = '';
    this.out.clear();
    const ms = this.playPrompt(node.id, node.prompt);
    this.clearNodeTimers();
    this.after(ms + node.repeatAfterMs, () => this.replayOrGiveUp(node, 'no choice'));
  }

  private replayOrGiveUp(node: IvrNode, why: string): void {
    if (this.node !== node) return;
    if (this.ivrRepeats >= node.maxRepeats) {
      this.record(node.id, 'ivr-timeout', why);
      if (node.onTimeout) this.enter(node.onTimeout);
      else this.endCall('ivr-timeout');
      return;
    }
    this.ivrRepeats++;
    this.record(node.id, 'ivr-repeat', String(this.ivrRepeats));
    this.playIvrPrompt(node);
  }

  private onDigit(d: string): void {
    const node = this.node;
    if (!node || this.stopped) return;
    this.record(node.id, 'digit', d);
    if (node.kind !== 'ivr') return;
    this.ivrDigits += d;
    const typed = this.ivrDigits;
    const hit = node.options.find((o) => o.digits === typed);
    if (hit) {
      this.record(node.id, 'ivr-option', typed);
      this.enter(hit.next);
      return;
    }
    if (node.options.some((o) => o.digits?.startsWith(typed))) return; // more keys coming
    this.record(node.id, 'ivr-invalid', typed);
    this.replayOrGiveUp(node, 'invalid choice');
  }

  private onHeard(turn: CaptionTurn): void {
    const node = this.node;
    const text = turn.text.trim();
    if (!node || this.stopped || !turn.final || !text) return;
    this.repTranscript.push({ at: this.now(), who: 'caller', person: 0, text });
    this.record(node.id, 'heard', text);
    if (node.kind !== 'ivr') return;
    const hit = node.options.find((o) => o.phrase && matchesPhrase(text, o.phrase));
    if (hit?.phrase) {
      this.record(node.id, 'ivr-option', hit.phrase);
      this.enter(hit.next);
      return;
    }
    this.record(node.id, 'ivr-invalid', text);
    this.replayOrGiveUp(node, 'invalid choice');
  }

  private enterHold(node: HoldNode): void {
    const total = Math.max(0, Math.round(node.durationMs * BYTES_PER_MS));
    const ann = node.announcement ? this.asset(node.announcement.asset) : undefined;
    const annBytes = ann ? padded(ann).length : 0;
    const music = holdMusicMulaw(node.durationMs / 1000);
    const parts: Buffer[] = [];
    let used = 0;
    let musicAt = 0;
    const takeMusic = (bytes: number) => {
      const n = Math.min(bytes, music.length - musicAt, total - used);
      if (n <= 0) return;
      parts.push(music.subarray(musicAt, musicAt + n));
      musicAt += n;
      used += n;
    };
    // Announcement first ("please hold"), music until the next one; an announcement that
    // would be cut off by the pickup is left out.
    while (used < total) {
      if (ann && node.announcement && used + annBytes <= total) {
        const at = used / BYTES_PER_MS;
        const text = node.announcement.text;
        this.after(at, () => this.record(node.id, 'play', text));
        parts.push(padded(ann));
        used += annBytes;
      }
      const before = used;
      takeMusic(Math.max(CHUNK_BYTES, Math.round(node.announceEveryMs * BYTES_PER_MS)));
      if (used === before) break;
    }
    if (used < total) parts.push(Buffer.alloc(total - used, MULAW_SILENCE));
    this.out.play(Buffer.concat(parts));
    this.after(node.durationMs, () => this.enter(node.next));
  }

  private enterVoicemail(node: VoicemailNode): void {
    const promptMs = this.playPrompt(node.id, node.prompt);
    const beep = this.asset(BEEP_ASSET, beepMulaw);
    this.out.play(beep);
    this.after(promptMs + msOf(padded(beep)), () => {
      this.record(node.id, 'recording', `${node.recordMs} ms`);
      this.openCaptions([], 'A caller leaving a voicemail message for a medical clinic.');
      this.after(node.recordMs, () => {
        this.record(node.id, 'voicemail-complete');
        this.endCall('voicemail-complete');
      });
    });
  }

  // ------------------------------------------------------------------ representative

  private enterRep(node: RepNode): void {
    const person = ++this.repCount;
    this.record(node.id, 'rep-connecting', node.name);
    let rep: RepSession | undefined;
    const va = this.makeVoiceAgent(
      repSession(this.s, node),
      (e) => this.guard('rep event', () => rep && this.onRepEvent(rep, e)),
      (code, reason) => this.guard('rep close', () => rep && this.onRepClose(rep, code, reason)),
    );
    rep = { va, node, person, ready: false, heardAudio: false, lastEvent: 'reply.done' };
    this.rep = rep;
    const current = rep;
    va.connect().then(
      () => {
        if (this.rep !== current || this.stopped) return;
        current.ready = true;
        this.record(node.id, 'rep-ready', va.sessionId);
      },
      (err: unknown) => {
        if (this.rep !== current || this.stopped) return;
        this.record(node.id, 'rep-error', errText(err));
        this.endCall('scenario-error');
      },
    );
  }

  private onRepEvent(rep: RepSession, e: VAEvent): void {
    if (this.rep !== rep || this.stopped) return;
    const id = rep.node.id;
    switch (e.type) {
      case 'reply.started':
        rep.lastEvent = 'reply.started';
        return;
      case 'input.speech.started':
        rep.lastEvent = 'input.speech.started';
        return;
      case 'reply.audio': {
        if (typeof e.data !== 'string') return;
        const mu = Buffer.from(e.data, 'base64');
        if (mu.length === 0) return;
        if (!rep.heardAudio) {
          rep.heardAudio = true;
          this.record(id, 'rep-first-audio', rep.node.name);
        }
        this.out.stream(mu);
        return;
      }
      case 'reply.done':
        rep.lastEvent = 'reply.done';
        if (e.status === 'interrupted') {
          this.record(id, 'rep-interrupted');
          this.out.clear();
        } else {
          this.out.flush();
        }
        if (this.pending) this.pending.replyDone = true;
        return;
      case 'transcript.agent': {
        const text = typeof e.text === 'string' ? e.text.trim() : '';
        if (!text) return;
        this.repTranscript.push({ at: this.now(), who: 'rep', person: rep.person, text });
        this.record(id, 'rep-said', text);
        return;
      }
      case 'transcript.user': {
        const text = typeof e.text === 'string' ? e.text.trim() : '';
        if (!text) return;
        this.repTranscript.push({ at: this.now(), who: 'caller', person: 0, text });
        this.record(id, 'caller-said', text);
        return;
      }
      case 'tool.call':
        this.onRepTool(rep, e);
        return;
      case 'session.error':
      case 'error':
        this.record(id, 'rep-error', String(e.code ?? e.message ?? e.type));
        return;
      default:
        return;
    }
  }

  private onRepTool(rep: RepSession, e: VAEvent): void {
    const name = typeof e.name === 'string' ? e.name : '';
    const kind =
      name === 'transfer_call' && rep.node.transferTo
        ? 'transfer'
        : name === 'hang_up'
          ? 'hang-up'
          : undefined;
    if (!kind) {
      this.record(rep.node.id, 'rep-tool-ignored', name);
      return;
    }
    if (this.pending) return; // already on its way out
    this.record(rep.node.id, kind === 'transfer' ? 'transfer-requested' : 'hang-up-requested');
    // The tool call rides on a reply (usually "I'm transferring you now"): let it finish
    // and play out before the line changes.
    this.pending = { kind, at: this.now(), replyDone: rep.lastEvent === 'reply.done' };
  }

  private runAction(p: PendingAction): void {
    const rep = this.rep;
    if (!rep || this.stopped) return;
    if (p.kind === 'hang-up') {
      this.record(rep.node.id, 'rep-hangup', rep.node.name);
      this.endCall('rep-hung-up');
      return;
    }
    const to = rep.node.transferTo;
    if (!to) return;
    this.record(rep.node.id, 'transfer', to);
    this.closeRep();
    this.out.clear();
    this.after(TRANSFER_GAP_MS, () => this.enter(to));
  }

  private onRepClose(rep: RepSession, code: number, reason: string): void {
    if (this.rep !== rep || this.stopped) return;
    this.record(rep.node.id, 'rep-closed', `${code} ${reason}`.trim());
    this.rep = undefined;
    this.endCall('rep-disconnected');
  }

  private closeRep(): void {
    const rep = this.rep;
    if (!rep) return;
    this.rep = undefined;
    this.closing.push(attempt(() => rep.va.end()));
  }

  // ------------------------------------------------------------------ captions

  // A small U3.5 Pro stream on the caller's audio: spoken menu choices and voicemail
  // messages.
  private openCaptions(keyterms: string[], prompt: string): void {
    this.closeCaptions();
    let entry: { stream: CaptionsLike; ready: boolean } | undefined;
    const stream = this.makeCaptions({
      apiKey: this.deps.apiKey,
      keyterms,
      prompt,
      onTurn: (t) =>
        this.guard('caption', () => entry && this.captions === entry && this.onHeard(t)),
      onSpeechStarted: () => undefined,
      onError: (err) =>
        this.guard('captions error', () => {
          if (entry && this.captions === entry && this.node) {
            this.record(this.node.id, 'captions-error', err.message);
          }
        }),
    });
    entry = { stream, ready: false };
    this.captions = entry;
    const current = entry;
    stream.connect().then(
      () => {
        if (this.captions === current && !this.stopped) current.ready = true;
      },
      (err: unknown) => {
        if (this.captions !== current || this.stopped || !this.node) return;
        this.record(this.node.id, 'captions-error', errText(err));
      },
    );
  }

  private closeCaptions(): void {
    const c = this.captions;
    if (!c) return;
    this.captions = undefined;
    this.closing.push(attempt(() => c.stream.close()));
  }

  // ------------------------------------------------------------------ helpers

  private playPrompt(node: string, prompt: Prompt): number {
    const clip = padded(this.asset(prompt.asset));
    this.out.play(clip);
    this.record(node, 'play', prompt.text);
    return msOf(clip);
  }

  private asset(name: string, fallback?: () => Buffer): Buffer {
    try {
      return this.loadAsset(name);
    } catch (err) {
      this.record(this.node?.id ?? '-', 'asset-missing', `${name}: ${errText(err)}`);
      return fallback ? fallback() : Buffer.alloc(2 * CHUNK_BYTES * 10, MULAW_SILENCE); // 2 s
    }
  }

  private endCall(reason: string): void {
    if (this.stopped) return;
    this.record(this.node?.id ?? '-', 'end', reason);
    void this.stop();
    try {
      this.deps.onEnded(reason);
    } catch {
      // the listener's problem, not the line's
    }
  }

  private after(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.nodeTimers.delete(t);
      if (!this.stopped) this.guard('timer', fn);
    }, ms);
    this.nodeTimers.add(t);
  }

  private clearNodeTimers(): void {
    for (const t of this.nodeTimers) clearTimeout(t);
    this.nodeTimers.clear();
  }

  private record(node: string, event: string, detail?: string): void {
    const e: TraceEntry =
      detail === undefined
        ? { at: this.now(), node, event }
        : { at: this.now(), node, event, detail };
    this.trace.push(e);
    try {
      this.deps.log?.(e);
    } catch {
      // logging must never break the line
    }
  }

  // One throwing handler must never take the line (and its billed sessions) down.
  private guard(name: string, fn: () => unknown): void {
    try {
      fn();
    } catch (err) {
      this.record(this.node?.id ?? '-', 'internal-error', `${name}: ${errText(err)}`);
    }
  }
}

function padded(clip: Buffer): Buffer {
  const rem = clip.length % CHUNK_BYTES;
  return rem === 0 ? clip : Buffer.concat([clip, Buffer.alloc(CHUNK_BYTES - rem, MULAW_SILENCE)]);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function attempt(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err);
  }
}

function withCap<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([p, cap]).finally(() => clearTimeout(timer));
}
