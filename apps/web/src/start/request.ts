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

export const DEFAULT_AUTONOMY: Autonomy = 'assist';

/** Fact keys pre-toggled to share the first time the start page is opened. */
export const DEFAULT_SHARED_KEYS: ReadonlySet<string> = new Set(['name', 'dob']);

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
 * user's selections on the start page: only the toggled facts go out, and an
 * empty goal is left off rather than sent as `""`.
 */
export function buildStartCallRequest(sel: StartSelection): StartCallRequest {
  const goal = sel.goal.trim();
  return {
    target: sel.target,
    userName: sel.userName.trim(),
    userDescriptor: sel.userDescriptor,
    autonomy: sel.autonomy,
    ...(goal ? { goal } : {}),
    facts: sel.facts.filter((f) => sel.sharedKeys.has(f.key)),
    voice: sel.voice,
  };
}
