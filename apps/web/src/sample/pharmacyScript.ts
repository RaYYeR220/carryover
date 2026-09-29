import type {
  AppEvent,
  CallSummary,
  CaptionWord,
  Commitment,
  Fact,
  SpeakerRef,
} from '@carryover/protocol';
import type { CallDetails } from '../call/CallScreen';

/**
 * Glyph Night's scripted Riverside Pharmacy call (the owner-approved ~65 s
 * demo), reproduced as a timed `AppEvent` script for `SamplePlayer`.
 *
 * Every timestamp here (`t`, and each event's own `at`/`since`) is relative
 * to 0 = the moment the call is dialled. `rebase` shifts an event's internal
 * timestamps by a wall-clock base, so the same script replays at a fresh
 * `Date.now()` every time (needed for the pickup-freshness check in
 * `CallScreen`) while staying sorted and self-consistent. `rebase` also runs
 * every timestamp through `callDisplayMs`, B's `callT` mapping: the call
 * plays back compressed, but the displayed clock and every timestamp look
 * like a realistic ~5:25 call with a 4:30 hold.
 */

export interface ScriptEvent {
  /** ms after dial when this event fires; drives `SamplePlayer`'s clock. */
  t: number;
  /** The event, with internal timestamps also relative to 0. */
  event: AppEvent;
}

/** How the visitor answered Dana's date-of-birth question. */
export type AskAnswer = { kind: 'share' } | { kind: 'typed'; text: string } | { kind: 'declined' };

const TARGET = 'Riverside Pharmacy';
const menu: SpeakerRef = { role: 'ivr', label: 'Phone menu', person: 0 };
const dana: SpeakerRef = { role: 'them', label: 'Dana', person: 1 };

export const ASK_ID = 'a-dob';
const QUEUE_NONCE = 'u-close';

function words(text: string, low: Record<number, number> = {}): CaptionWord[] {
  return text.split(' ').map((w, i) => ({
    text: w,
    confidence: low[i] ?? 0.95,
    start: i * 320,
    end: i * 320 + 280,
  }));
}

function state(
  t: number,
  lineState: 'connecting' | 'ivr' | 'hold' | 'human' | 'ended',
): ScriptEvent {
  return {
    t,
    event: { t: 'call.state', lineState, autonomy: 'assist', since: t, targetLabel: TARGET },
  };
}

function cap(
  t: number,
  id: string,
  speaker: SpeakerRef,
  text: string,
  final: boolean,
  low: Record<number, number> = {},
): ScriptEvent {
  return { t, event: { t: 'caption', id, speaker, text, words: words(text, low), final, at: t } };
}

function said(
  t: number,
  id: string,
  text: string,
  source: 'relay' | 'agent' | 'disclosure',
): ScriptEvent {
  return { t, event: { t: 'agent.said', id, text, source, interrupted: false, at: t } };
}

/** Any other event: keeps the literal typed as its `AppEvent` member, not widened to `string`. */
function ev(t: number, event: AppEvent): ScriptEvent {
  return { t, event };
}

/* ---------- script text (the disclosure and the closing line are quoted verbatim) ---------- */

const MENU_1 =
  'Thanks for calling Riverside Pharmacy. For store hours, press 1. For prescriptions, press 2.';
const MENU_2 = 'Please hold for the next available pharmacist.';
const DISCLOSURE =
  "Hi, I'm Carryover, an automated relay calling for Maya, who is Deaf and reading along.";
const D1 = 'Hi Maya, this is Dana. What can I do for you today?';
const U1 = "I'm checking on my lisinopril refill.";
const D2 = 'Sure, let me pull up your lisinopril. Can I get your date of birth, please?';
const D2_PARTIAL = 'Sure, let me pull up your';
const MOMENT = 'One moment, please.';
const DOB = 'March 14, 1952.';
const SORRY_DECLINE = 'Sorry, Maya would prefer not to share that.';
const D3_REST =
  'Your lisinopril will be ready Thursday after 2 pm, reference 4471. Is there anything else I can help with?';
/** Shared by the share and typed branches: B's `d3text` default prefix. */
const D3_SHARE = `Thank you. ${D3_REST}`;
/** B's `d3text` alternate prefix when Maya declines: "No problem, I can use her phone number." */
const D3_DECLINED = `No problem, I can use her phone number. ${D3_REST}`;
const CLOSE = 'Thursday works. Thank you, Dana!';
const BYE = "You're welcome, Maya. Have a good day!";

/* ---------- timeline (ms from dial) ---------- */

const DIAL = 0;
const MENU_START = 2_200;
const KEY_2 = 8_600;
const MENU_HOLD_LINE = 9_400;
const HOLD_START = 12_200;
const PICKUP = 20_600;
const DISCLOSURE_AT = 21_800;
const DANA_GREET = 32_000;
const RELAY_CHECKING = 36_100;
const DOB_Q_PARTIAL = 39_200;
const DOB_Q_FINAL = 43_400;
const MOMENT_AT = 44_100;
const ASK_AT = 44_500;
const ASK_RESOLVE = 49_350;
/** Whatever Carryover says right after the ask resolves (the DOB, the typed text, or the decline). */
const ASK_ANSWER_AT = 49_700;
const D3_AT = 52_500;
const QUEUED_AT = 55_300;
const COMMIT_AT = 57_780;
const SPOKEN_AT = 60_100;
const CLOSE_SAID_AT = 60_500;
const DANA_BYE = 63_900;
const END_AT = 67_500;

/** SamplePlayer jumps here once the visitor answers the ask card, whatever they chose. */
export const ASK_JUMP_MS = ASK_ANSWER_AT;

/** The line said right after the ask resolves, and Dana's next line: both depend on the answer. */
function askTail(answer: AskAnswer): ScriptEvent[] {
  switch (answer.kind) {
    case 'share':
      return [
        ev(ASK_RESOLVE, { t: 'ask.resolved', askId: ASK_ID, how: 'shared' }),
        said(ASK_ANSWER_AT, 'r-dob-shared', DOB, 'relay'),
      ];
    case 'typed':
      return [
        ev(ASK_RESOLVE, { t: 'ask.resolved', askId: ASK_ID, how: 'typed' }),
        said(ASK_ANSWER_AT, 'r-dob-typed', answer.text, 'relay'),
      ];
    case 'declined':
      return [
        ev(ASK_RESOLVE, { t: 'ask.resolved', askId: ASK_ID, how: 'declined' }),
        said(ASK_ANSWER_AT, 'r-dob-declined', SORRY_DECLINE, 'agent'),
      ];
  }
}

const d3TextFor = (answer: AskAnswer): string =>
  answer.kind === 'declined' ? D3_DECLINED : D3_SHARE;

/** The full script for one way the visitor can answer Dana's date-of-birth question. */
export function buildPharmacyScript(answer: AskAnswer = { kind: 'share' }): ScriptEvent[] {
  return [
    state(DIAL, 'connecting'),

    state(MENU_START, 'ivr'),
    cap(MENU_START, 'c-menu1', menu, MENU_1, true),
    ev(KEY_2, { t: 'dtmf', digits: '2', at: KEY_2 }),
    cap(MENU_HOLD_LINE, 'c-menu2', menu, MENU_2, true),

    state(HOLD_START, 'hold'),

    state(PICKUP, 'human'),
    ev(PICKUP, {
      t: 'alert',
      kind: 'human-picked-up',
      message: 'A person picked up — New person on the line',
      at: PICKUP,
    }),

    said(DISCLOSURE_AT, 'r-intro', DISCLOSURE, 'disclosure'),
    cap(DANA_GREET, 'c-d1', dana, D1, true),
    said(RELAY_CHECKING, 'r-u1', U1, 'relay'),
    cap(DOB_Q_PARTIAL, 'c-d2', dana, D2_PARTIAL, false),
    cap(DOB_Q_FINAL, 'c-d2', dana, D2, true, { 6: 0.45 }),
    said(MOMENT_AT, 'r-moment', MOMENT, 'agent'),
    ev(ASK_AT, {
      t: 'ask',
      askId: ASK_ID,
      question: 'Can I get your date of birth, please?',
      field: 'dob',
      from: 'Dana',
      at: ASK_AT,
    }),
    ...askTail(answer),

    cap(D3_AT, 'c-d3', dana, d3TextFor(answer), true),
    ev(QUEUED_AT, {
      t: 'relay.queued',
      nonce: QUEUE_NONCE,
      text: CLOSE,
      reason: 'waiting-for-pause',
    }),
    ev(COMMIT_AT, {
      t: 'commitment',
      commitment: { text: 'Pick up Thursday after 2 pm · ref 4471', when: 'Thursday after 2 pm' },
      at: COMMIT_AT,
    }),
    ev(SPOKEN_AT, { t: 'relay.spoken', nonce: QUEUE_NONCE, at: SPOKEN_AT }),
    said(CLOSE_SAID_AT, 'r-close', CLOSE, 'relay'),
    cap(DANA_BYE, 'c-d4', dana, BYE, true),

    state(END_AT, 'ended'),
    ev(END_AT, {
      t: 'alert',
      kind: 'call-ended',
      message: 'Call ended: the conversation is finished.',
      at: END_AT,
    }),
    ev(END_AT, { t: 'summary', summary: summary(answer) }),
  ].sort((a, b) => a.t - b.t);
}

/** The default (share) branch: what plays if the visitor never touches the ask card. */
export const PHARMACY_SCRIPT: ScriptEvent[] = buildPharmacyScript({ kind: 'share' });

/** The last event's time: the sample call's total scripted length (~65 s), the same for every branch. */
export const SAMPLE_TOTAL_MS = Math.max(...PHARMACY_SCRIPT.map((se) => se.t));

function summary(answer: AskAnswer): CallSummary {
  const commitments: Commitment[] = [
    { text: 'Pick up Thursday after 2 pm · ref 4471', when: 'Thursday after 2 pm' },
  ];
  const dobBullet =
    answer.kind === 'share'
      ? 'Shared your date of birth once, after you approved it.'
      : answer.kind === 'typed'
        ? 'Typed your date of birth yourself, once.'
        : 'Declined to share your date of birth; Dana found another way to help.';
  const answerLine =
    answer.kind === 'declined'
      ? { at: ASK_ANSWER_AT, who: 'agent' as const, text: SORRY_DECLINE, source: 'agent' as const }
      : {
          at: ASK_ANSWER_AT,
          who: 'agent' as const,
          text: answer.kind === 'typed' ? answer.text : DOB,
          source: 'relay' as const,
        };
  return {
    callId: 'sample',
    startedAt: DIAL,
    endedAt: END_AT,
    targetLabel: TARGET,
    outcome: 'Your refill is ready Thursday.',
    bullets: [
      'Pressed 2 for prescriptions on the phone menu.',
      dobBullet,
      'Your lisinopril is ready Thursday after 2 pm, reference 4471.',
    ],
    commitments,
    transcript: [
      { at: DISCLOSURE_AT, who: 'agent', text: DISCLOSURE, source: 'disclosure' },
      { at: DANA_GREET, who: 'them', person: 1, text: D1 },
      { at: RELAY_CHECKING, who: 'agent', text: U1, source: 'relay' },
      { at: DOB_Q_FINAL, who: 'them', person: 1, text: D2 },
      { at: MOMENT_AT, who: 'agent', text: MOMENT, source: 'agent' },
      answerLine,
      { at: D3_AT, who: 'them', person: 1, text: d3TextFor(answer) },
      { at: CLOSE_SAID_AT, who: 'agent', text: CLOSE, source: 'relay' },
      { at: DANA_BYE, who: 'them', person: 1, text: BYE },
    ],
  };
}

/**
 * Hold, compressed to 8.4 s of playback (`HOLD_A`..`HOLD_B`), maps to a
 * realistic 4:30 wait: B's `callT`. Before hold, and after pickup, the
 * mapping is 1:1 (just offset), so every duration computed from mapped
 * timestamps — hold time, "waited" on the ask card, pickup freshness —
 * comes out the same as it would unmapped.
 */
const HOLD_A_MS = HOLD_START;
const HOLD_B_MS = PICKUP;
const HOLD_REAL_MS = 270_000;

export function callDisplayMs(t: number): number {
  if (t < HOLD_A_MS) return t;
  if (t < HOLD_B_MS) return HOLD_A_MS + (t - HOLD_A_MS) * (HOLD_REAL_MS / (HOLD_B_MS - HOLD_A_MS));
  return HOLD_A_MS + HOLD_REAL_MS + (t - HOLD_B_MS);
}

/** Shift an event's own timestamp fields by `base`, through `callDisplayMs`, so a relative script plays at a real (but realistic-looking) clock. */
export function rebase(event: AppEvent, base: number): AppEvent {
  const at = (raw: number) => base + callDisplayMs(raw);
  switch (event.t) {
    case 'call.state':
      return { ...event, since: at(event.since) };
    case 'caption':
    case 'agent.said':
    case 'relay.spoken':
    case 'ask':
    case 'alert':
    case 'dtmf':
    case 'gate.blocked':
    case 'commitment':
      return { ...event, at: at(event.at) };
    case 'summary':
      return {
        ...event,
        summary: {
          ...event.summary,
          startedAt: at(event.summary.startedAt),
          endedAt: at(event.summary.endedAt),
          transcript: event.summary.transcript.map((entry) => ({ ...entry, at: at(entry.at) })),
        },
      };
    case 'relay.queued':
    case 'ask.resolved':
    case 'error':
      return event;
    default:
      return event;
  }
}

export const PHARMACY_VAULT: Fact[] = [
  { key: 'name', label: 'Name', value: 'Maya Collins' },
  { key: 'dob', label: 'Date of birth', value: 'March 14, 1952' },
  { key: 'address', label: 'Address', value: '18 Alder St, Apt 3' },
  { key: 'member_id', label: 'Member ID', value: 'RX-20931' },
];

export const PHARMACY_DETAILS: CallDetails = {
  subtitle: '(555) 014-2230 · simulated line',
  goal: 'Check on my lisinopril refill',
  voice: 'Alba · warm, US',
  facts: PHARMACY_VAULT,
  shared: ['name'],
};
