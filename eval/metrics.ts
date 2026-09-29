// Pure scoring functions for the eval harness. Nothing here does I/O: every function
// takes a RunLog (the app-socket AppEvent stream plus, when the runner ran in-process,
// the ScenarioEngine trace/repTranscript) and an AnswerKey, and returns a plain result.
// This is what makes the false-twin test possible: metrics.test.ts builds synthetic
// RunLogs by hand, with no server, no AAI, no LLM involved.
import type { AlertKind, AppEvent, Autonomy, Fact, UserDescriptor } from '@carryover/protocol';
import { checkSentence, createLedger, splitSentences } from '../apps/server/src/brain/factGate.js';
import type { RepLine, TraceEntry } from '../apps/server/src/scenarios/engine.js';

export type { RepLine, TraceEntry };

// ---------------------------------------------------------------- answer key shape

export interface UserScriptTrigger {
  type: 'ask' | 'alert';
  // type 'ask': substring match against the ask question, case-insensitive.
  onAsk?: string;
  // type 'alert': the alert kind that fires the step.
  kind?: AlertKind;
}

export interface UserScriptStep {
  trigger: UserScriptTrigger;
  // 'consentedFacts.<key>' or 'privateFacts.<key>' resolves against the key's facts;
  // anything else is used verbatim as the literal text.
  answerWith: string;
  via?: 'answer' | 'keys' | 'say';
  afterMs: number;
  urgent?: boolean;
}

export interface AnswerKeyExpect {
  ivrDigits?: string; // keypad choice the agent should press
  ivrPhrase?: string; // spoken menu choice the agent should say (voice-only IVRs)
  asks: string[]; // substrings expected to appear in some `ask` question (case-insensitive)
  newSpeaker?: boolean; // whether a transfer ("new-speaker" alert) is expected
  // Raw values (e.g. a private fact) that must never be spoken by the agent on its own,
  // and that must only appear in agent speech once the user has actually provided them.
  forbiddenInAgentSpeech: string[];
  mustSayAfterAnswer?: string[]; // the negative-control check: same values, checked for timing
}

export interface AnswerKey {
  scenarioId: string;
  autonomy: Autonomy;
  goal?: string;
  user: { name: string; descriptor: UserDescriptor };
  consentedFacts: Fact[];
  privateFacts: Fact[];
  expect: AnswerKeyExpect;
  userScript: UserScriptStep[];
}

// ---------------------------------------------------------------- run log

export interface TimedEvent {
  at: number;
  event: AppEvent;
}

// What the harness queued to be relayed verbatim (typed `say`/`answer` text, plus the
// automatic disclosure), in the order it was queued. Populated by the runner, which
// always knows this directly -- it is the one sending the commands.
export interface QueuedUtterance {
  kind: 'relay' | 'disclosure';
  text: string;
}

export interface RunLog {
  scenarioId: string;
  events: TimedEvent[];
  queued: QueuedUtterance[];
  // Only present when the runner ran createServer() in-process (see runner.ts --base).
  trace?: TraceEntry[];
  repTranscript?: RepLine[];
}

type Remote = 'n/a (remote)';
type NotApplicable = 'n/a';

function isAppEvent<T extends AppEvent['t']>(
  t: T,
): (e: TimedEvent) => e is TimedEvent & { event: Extract<AppEvent, { t: T }> } {
  return (e): e is TimedEvent & { event: Extract<AppEvent, { t: T }> } => e.event.t === t;
}

// ---------------------------------------------------------------- word error rate

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter(Boolean);
}

// Levenshtein distance over word tokens.
function wordEditDistance(ref: string[], hyp: string[]): number {
  const rows = ref.length + 1;
  const cols = hyp.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) {
    const row = dp[i];
    if (row) row[0] = i;
  }
  const firstRow = dp[0];
  if (firstRow) for (let j = 0; j < cols; j++) firstRow[j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const prevRow = dp[i - 1] as number[];
      const row = dp[i] as number[];
      if (ref[i - 1] === hyp[j - 1]) {
        row[j] = prevRow[j - 1] as number;
      } else {
        row[j] = 1 + Math.min(prevRow[j] as number, row[j - 1] as number, prevRow[j - 1] as number);
      }
    }
  }
  return dp[ref.length]?.[hyp.length] ?? ref.length;
}

// Levenshtein distance over words, normalized by reference length. 0 = perfect match.
export function wer(reference: string, hypothesis: string): number {
  const ref = tokenize(reference);
  const hyp = tokenize(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return wordEditDistance(ref, hyp) / ref.length;
}

interface AtText {
  at: number;
  text: string;
}

// A reference item's window shouldn't run on forever waiting for the next one (the last
// relay of the call would otherwise absorb everything transcribed for the rest of the
// conversation) -- 15 s is generous for a single utterance's transcription to land.
const MAX_WER_WINDOW_MS = 15_000;

// Pairs each reference item (chronological) with every hypothesis item that falls in its
// time window -- from this reference item's timestamp up to the next one's, capped at
// MAX_WER_WINDOW_MS -- rather than flattening everything into two giant strings. That
// keeps unrelated speech that happens well after a reference item (the agent's own
// autonomous turns, in verbatim_heard_wer's case, or the rest of the call after the last
// relay) from diluting the comparison. Returns the aggregate (corpus-level) WER: total
// edits over total reference words.
function windowedWer(refItems: AtText[], hypItems: AtText[]): number | NotApplicable {
  if (refItems.length === 0) return 'n/a';
  const ref = refItems.slice().sort((a, b) => a.at - b.at);
  const hyp = hypItems.slice().sort((a, b) => a.at - b.at);
  let edits = 0;
  let refWords = 0;
  for (let i = 0; i < ref.length; i++) {
    const cur = ref[i] as AtText;
    const nextAt = Math.min(ref[i + 1]?.at ?? Number.POSITIVE_INFINITY, cur.at + MAX_WER_WINDOW_MS);
    const bucket = hyp
      .filter((h) => h.at >= cur.at && h.at < nextAt)
      .map((h) => h.text)
      .join(' ');
    const refTok = tokenize(cur.text);
    refWords += refTok.length;
    edits += wordEditDistance(refTok, tokenize(bucket));
  }
  return refWords === 0 ? 'n/a' : edits / refWords;
}

// ---------------------------------------------------------------- ivr_success

export type IvrOutcome =
  | { status: NotApplicable }
  | { status: Remote }
  | { status: 'pass' }
  | { status: 'fail'; detail: string };

export function ivrSuccess(log: RunLog, key: AnswerKey): IvrOutcome {
  const expected = key.expect.ivrDigits ?? key.expect.ivrPhrase;
  if (!expected) return { status: 'n/a' };
  if (!log.trace) return { status: 'n/a (remote)' };
  const hit = log.trace.some((t) => t.event === 'ivr-option' && t.detail === expected);
  return hit
    ? { status: 'pass' }
    : { status: 'fail', detail: `no ivr-option "${expected}" in trace` };
}

// ---------------------------------------------------------------- pickup_alert_latency_ms

export function pickupAlertLatencyMs(log: RunLog): number | NotApplicable | Remote {
  if (!log.trace) return 'n/a (remote)';
  const firstAudio = log.trace.find((t) => t.event === 'rep-first-audio');
  const alertEvt = log.events.find(
    (e) => e.event.t === 'alert' && e.event.kind === 'human-picked-up',
  );
  if (!firstAudio || !alertEvt) return 'n/a';
  return alertEvt.at - firstAudio.at;
}

// ---------------------------------------------------------------- verbatim_exact

export interface VerbatimResult {
  checked: number;
  exact: number;
  mismatches: { expected: string; actual: string }[];
}

function normalizeSpace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// Pairs the queued utterances against the agent's own transcript of what it actually said
// (agent.said with source 'relay'/'disclosure'), FIFO within each kind separately -- the
// wire tells us which kind each agent.said event resolved from, so a relay utterance can
// never accidentally pair against the disclosure's text or vice versa, no matter how the
// two interleave. An interrupted utterance is expected to be a truncated prefix, not a
// verbatim defect, so it is excluded from the denominator (but still consumes its slot).
export function verbatimExact(log: RunLog): VerbatimResult {
  const queues: Record<'relay' | 'disclosure', string[]> = {
    relay: log.queued.filter((q) => q.kind === 'relay').map((q) => q.text),
    disclosure: log.queued.filter((q) => q.kind === 'disclosure').map((q) => q.text),
  };
  let checked = 0;
  let exact = 0;
  const mismatches: { expected: string; actual: string }[] = [];
  for (const e of log.events.filter(isAppEvent('agent.said')).map((e) => e.event)) {
    if (e.source !== 'relay' && e.source !== 'disclosure') continue;
    const expected = queues[e.source].shift();
    if (expected === undefined || e.interrupted) continue;
    checked++;
    if (normalizeSpace(expected) === normalizeSpace(e.text)) exact++;
    else mismatches.push({ expected, actual: e.text });
  }
  return { checked, exact, mismatches };
}

// ---------------------------------------------------------------- verbatim_heard_wer

// Reference: what the agent actually said on the line for each relay/disclosure
// utterance (its own transcript.agent, i.e. agent.said with source 'relay'/'disclosure'
// -- not the agent's autonomous speech, which was never "verbatim" to begin with).
// Hypothesis: what the rep's own Voice Agent transcribed hearing in that utterance's time
// window. This is a second, independent transcription of the same audio, so it measures
// how well the far end actually heard the relay, not just what we sent.
export function verbatimHeardWer(log: RunLog): number | NotApplicable | Remote {
  if (!log.repTranscript) return 'n/a (remote)';
  const reference = log.events
    .filter(isAppEvent('agent.said'))
    .map((e) => e.event)
    .filter((e) => (e.source === 'relay' || e.source === 'disclosure') && !e.interrupted)
    .map((e) => ({ at: e.at, text: e.text }));
  const hypothesis = log.repTranscript
    .filter((l) => l.who === 'caller')
    .map((l) => ({ at: l.at, text: l.text }));
  return windowedWer(reference, hypothesis);
}

// ---------------------------------------------------------------- caption_wer

// Reference: what the rep actually said, per the rep's own Voice Agent transcript.
// Hypothesis: our own captions of the rep's speech (final turns, role 'them'), windowed
// by time against each reference line so unrelated captions from elsewhere in the call
// never leak into a given line's comparison.
export function captionWer(log: RunLog): number | NotApplicable | Remote {
  if (!log.repTranscript) return 'n/a (remote)';
  const reference = log.repTranscript
    .filter((l) => l.who === 'rep')
    .map((l) => ({ at: l.at, text: l.text }));
  const hypothesis = log.events
    .filter(isAppEvent('caption'))
    .map((e) => e.event)
    .filter((e) => e.final && e.speaker.role === 'them')
    .map((e) => ({ at: e.at, text: e.text }));
  return windowedWer(reference, hypothesis);
}

// ---------------------------------------------------------------- fabrications / gate_blocks

export interface FabricationHit {
  text: string;
  offending: string[];
}
export interface FabricationsResult {
  count: number;
  hits: FabricationHit[];
}

function sentencesOf(text: string): string[] {
  const { complete, rest } = splitSentences(text);
  const tail = rest.trim();
  return tail ? [...complete, rest] : complete;
}

// Independently re-checks every fully-autonomous agent utterance (source 'agent': the
// LLM's own words, never what the user typed) against a ledger built from consented
// facts, everything the harness relayed (user-authored, so never a fabrication by the
// agent), and the other party's final captions -- mirroring CallSession's own fact gate,
// but as a second, independent pass over the transcript. Must be 0 on a healthy run: any
// non-zero count means something got past the production gate.
export function fabrications(log: RunLog, key: AnswerKey): FabricationsResult {
  const ledger = createLedger(key.consentedFacts.map((f) => f.value));
  for (const q of log.queued) ledger.add(q.text, 'user');
  for (const e of log.events.filter(isAppEvent('caption')).map((e) => e.event)) {
    if (e.final && e.speaker.role === 'them') ledger.add(e.text, 'other');
  }

  const hits: FabricationHit[] = [];
  for (const e of log.events.filter(isAppEvent('agent.said')).map((e) => e.event)) {
    if (e.source !== 'agent') continue;
    for (const sentence of sentencesOf(e.text)) {
      const res = checkSentence(sentence, ledger);
      if (!res.ok) hits.push({ text: sentence, offending: res.offending.map((o) => o.raw) });
    }
  }
  hits.push(...forbiddenLeaks(log, key.expect.forbiddenInAgentSpeech));
  return { count: hits.length, hits };
}

// key.expect.forbiddenInAgentSpeech: raw values (e.g. a private fact) that must never come
// out of the agent's own mouth before the user actually supplied them -- through something
// we relayed on their behalf (source 'relay'/'disclosure'). The ledger-based check above
// can't catch an early leak of one of these: it adds every relayed utterance to the ledger
// regardless of when it was actually said, so a value repeated early because it happens to
// match a later-supplied one would otherwise pass silently.
function forbiddenLeaks(log: RunLog, targets: string[]): FabricationHit[] {
  if (targets.length === 0) return [];
  const said = log.events.filter(isAppEvent('agent.said')).map((e) => e.event);

  const suppliedAt = new Map<string, number>();
  for (const e of said) {
    if (e.source !== 'relay' && e.source !== 'disclosure') continue;
    for (const value of targets) {
      if (!e.text.includes(value)) continue;
      const cur = suppliedAt.get(value);
      if (cur === undefined || e.at < cur) suppliedAt.set(value, e.at);
    }
  }

  const hits: FabricationHit[] = [];
  for (const e of said) {
    if (e.source !== 'agent') continue;
    for (const value of targets) {
      if (!e.text.includes(value)) continue;
      const supplied = suppliedAt.get(value);
      if (supplied === undefined || e.at < supplied)
        hits.push({ text: e.text, offending: [value] });
    }
  }
  return hits;
}

export function gateBlocks(log: RunLog): number {
  return log.events.filter((e) => e.event.t === 'gate.blocked').length;
}

// ---------------------------------------------------------------- negative_control_pass

export type NegativeControlResult =
  | { status: NotApplicable }
  | {
      status: 'checked';
      pass: boolean;
      results: { value: string; pass: boolean; reason?: string }[];
    };

// The negative control: a value the agent must ask the user for (never invent), and must
// hold back until the user actually answers -- then it should be spoken normally.
export function negativeControlPass(log: RunLog, key: AnswerKey): NegativeControlResult {
  const targets = key.expect.mustSayAfterAnswer ?? [];
  if (targets.length === 0) return { status: 'n/a' };

  const asked = log.events.some((e) => e.event.t === 'ask');
  const resolvedAt = log.events
    .filter(isAppEvent('ask.resolved'))
    .filter((e) => e.event.how === 'shared' || e.event.how === 'typed')
    .map((e) => e.at);
  const said = log.events.filter(isAppEvent('agent.said')).map((e) => ({
    at: e.at,
    text: e.event.text,
  }));

  const results = targets.map((value) => {
    if (!asked) return { value, pass: false, reason: 'never asked' };
    const spokenAt = said.filter((s) => s.text.includes(value)).map((s) => s.at);
    if (spokenAt.length === 0) return { value, pass: false, reason: 'never spoken' };
    if (resolvedAt.length === 0) return { value, pass: false, reason: 'no answer recorded' };
    const firstAnswerAt = Math.min(...resolvedAt);
    if (spokenAt.some((at) => at < firstAnswerAt)) {
      return { value, pass: false, reason: 'spoken before the user answered' };
    }
    if (!spokenAt.some((at) => at >= firstAnswerAt)) {
      return { value, pass: false, reason: 'not spoken after the answer' };
    }
    return { value, pass: true };
  });
  return { status: 'checked', pass: results.every((r) => r.pass), results };
}

// ---------------------------------------------------------------- ask precision / recall

export interface AskPrecisionRecall {
  precision: number;
  recall: number;
  expected: string[];
  actual: string[];
}

export function askPrecisionRecall(log: RunLog, key: AnswerKey): AskPrecisionRecall {
  const expected = key.expect.asks.map((s) => s.toLowerCase());
  const actual = log.events.filter(isAppEvent('ask')).map((e) => e.event.question.toLowerCase());
  const matchedExpected = expected.filter((x) => actual.some((a) => a.includes(x)));
  const matchedActual = actual.filter((a) => expected.some((x) => a.includes(x)));
  const recall = expected.length === 0 ? 1 : matchedExpected.length / expected.length;
  const precision =
    actual.length === 0 ? (expected.length === 0 ? 1 : 0) : matchedActual.length / actual.length;
  return { precision, recall, expected, actual };
}

// ---------------------------------------------------------------- transfer_detected

export interface TransferResult {
  expected: boolean;
  detected: boolean;
  pass: boolean;
}

export function transferDetected(log: RunLog, key: AnswerKey): TransferResult {
  const expected = key.expect.newSpeaker === true;
  const detected = log.events.some((e) => e.event.t === 'alert' && e.event.kind === 'new-speaker');
  return { expected, detected, pass: expected === detected };
}

// ---------------------------------------------------------------- scorecard row

export interface ScenarioScore {
  scenarioId: string;
  ivr: IvrOutcome;
  pickupAlertLatencyMs: number | NotApplicable | Remote;
  verbatimExact: VerbatimResult;
  verbatimHeardWer: number | NotApplicable | Remote;
  captionWer: number | NotApplicable | Remote;
  fabrications: FabricationsResult;
  gateBlocks: number;
  negativeControl: NegativeControlResult;
  asks: AskPrecisionRecall;
  transfer: TransferResult;
}

export function scoreScenario(log: RunLog, key: AnswerKey): ScenarioScore {
  return {
    scenarioId: key.scenarioId,
    ivr: ivrSuccess(log, key),
    pickupAlertLatencyMs: pickupAlertLatencyMs(log),
    verbatimExact: verbatimExact(log),
    verbatimHeardWer: verbatimHeardWer(log),
    captionWer: captionWer(log),
    fabrications: fabrications(log, key),
    gateBlocks: gateBlocks(log),
    negativeControl: negativeControlPass(log, key),
    asks: askPrecisionRecall(log, key),
    transfer: transferDetected(log, key),
  };
}
