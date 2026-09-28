import type {
  Autonomy,
  CallTarget,
  Fact,
  ScenarioInfo,
  StartCallRequest,
  UserDescriptor,
} from '@carryover/protocol';

/** AssemblyAI voices offered on the start sheet. Alba is the default. */
export const VOICES = [
  'alba',
  'jane',
  'mary',
  'eve',
  'jean',
  'michael',
  'george',
  'anna',
  'vera',
] as const;
export type Voice = (typeof VOICES)[number];
export const DEFAULT_VOICE: Voice = 'alba';

/**
 * "Name · short, honest descriptor", matching B's voice-picker style. Region
 * is AssemblyAI's documented accent for each English voice (US, except
 * anna/charles/paul/vera, which are UK). The adjective is a neutral tone
 * word, nothing invented beyond that.
 */
export const VOICE_LABELS: Record<Voice, string> = {
  alba: 'Alba · warm, US',
  jane: 'Jane · clear, US',
  mary: 'Mary · calm, US',
  eve: 'Eve · bright, US',
  jean: 'Jean · steady, US',
  michael: 'Michael · warm, US',
  george: 'George · even, US',
  anna: 'Anna · calm, UK',
  vera: 'Vera · crisp, UK',
};

export const DEFAULT_AUTONOMY: Autonomy = 'assist';

/** Fact keys pre-toggled to share the first time the start page is opened. */
export const DEFAULT_SHARED_KEYS: ReadonlySet<string> = new Set(['name', 'dob']);

/** Mirrors the protocol's `StartCallRequest.facts` cap: the vault (and the profile UI) shouldn't grow past this either. */
export const MAX_FACTS = 20;
/** Mirrors the protocol's `StartCallRequest.userName` cap. */
const MAX_USER_NAME = 40;
/** Mirrors the protocol's `Fact.value` cap. */
const MAX_FACT_VALUE = 200;

/** Vault keys the start page notes are "not shared by default", even though they're in the vault. */
export function factNote(key: string): string | undefined {
  return key === 'member_id' ? 'Not shared by default.' : undefined;
}

/** A destination: the practice line, or one of the scenarios from `GET /api/scenarios`. */
export type Destination = { kind: 'practice' } | { kind: 'scenario'; scenario: ScenarioInfo };

export function destinationId(d: Destination): string {
  return d.kind === 'practice' ? 'practice' : d.scenario.id;
}

/** The `CallTarget` a destination places, once a practice line exists (its code). */
export function targetFor(d: Destination, practiceCode: string | undefined): CallTarget | null {
  if (d.kind === 'practice') return practiceCode ? { kind: 'line', code: practiceCode } : null;
  return { kind: 'scenario', scenarioId: d.scenario.id };
}

/** Label for the Call button and the practice/scenario list. */
export function destinationLabel(d: Destination): string {
  return d.kind === 'practice' ? 'Practice line' : d.scenario.label;
}

export interface StartSelection {
  target: CallTarget;
  userName: string;
  userDescriptor: UserDescriptor;
  autonomy: Autonomy;
  /** Untrimmed; sent only when non-empty after trimming. */
  goal: string;
  /** Every fact in the vault. */
  facts: readonly Fact[];
  /** Keys of the facts the user chose to share for this call. */
  sharedKeys: ReadonlySet<string>;
  voice: string;
}

/**
 * Assembles the exact `StartCallRequest` body the server expects from the
 * user's selections on the start page: only the toggled facts go out, an
 * empty goal is left off rather than sent as `""`, and everything is clamped
 * to the protocol's own limits so the result always passes
 * `StartCallRequest.safeParse` — even if the vault somehow grew past 20
 * facts (the profile page caps it, but this is the last line of defence
 * before the request goes out).
 */
export function buildStartCallRequest(sel: StartSelection): StartCallRequest {
  const goal = sel.goal.trim();
  const facts = sel.facts
    .filter((f) => sel.sharedKeys.has(f.key))
    .slice(0, MAX_FACTS)
    .map((f) =>
      f.value.length > MAX_FACT_VALUE ? { ...f, value: f.value.slice(0, MAX_FACT_VALUE) } : f,
    );
  return {
    target: sel.target,
    userName: sel.userName.trim().slice(0, MAX_USER_NAME),
    userDescriptor: sel.userDescriptor,
    autonomy: sel.autonomy,
    ...(goal ? { goal } : {}),
    facts,
    voice: sel.voice,
  };
}
