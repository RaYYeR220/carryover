import type { AppEvent, CaptionWord, Fact, SpeakerRef } from '@carryover/protocol';

/**
 * Canned AppEvents that reproduce Glyph Night's scripted Riverside Pharmacy
 * call, frozen at the moments B's reference screenshots were taken. Dev only.
 */

export const FIXTURE_T0 = 1_760_000_000_000;
const at = (seconds: number) => FIXTURE_T0 + Math.round(seconds * 1000);

export const FIXTURE_VAULT: Fact[] = [
  { key: 'name', label: 'Name', value: 'Maya Collins' },
  { key: 'dob', label: 'Date of birth', value: 'March 14, 1952' },
  { key: 'address', label: 'Address', value: '18 Alder St, Apt 3' },
  { key: 'member_id', label: 'Member ID', value: 'RX-20931' },
];

export const FIXTURE_DETAILS = {
  subtitle: '(555) 014-2230 · simulated line',
  goal: 'Check on my lisinopril refill',
  voice: 'Harper · calm, steady pace',
  facts: FIXTURE_VAULT,
  shared: ['name'],
};

const TARGET = 'Riverside Pharmacy';
const menu: SpeakerRef = { role: 'ivr', label: 'Phone menu', person: 0 };
const dana: SpeakerRef = { role: 'them', label: 'Dana', person: 1 };

function words(text: string, low: Record<number, number> = {}): CaptionWord[] {
  return text.split(' ').map((w, i) => ({
    text: w,
    confidence: low[i] ?? 0.95,
    start: i * 350,
    end: i * 350 + 300,
  }));
}

const state = (
  lineState: 'connecting' | 'ivr' | 'hold' | 'human' | 'ended',
  seconds: number,
): AppEvent => ({
  t: 'call.state',
  lineState,
  autonomy: 'assist',
  since: at(seconds),
  targetLabel: TARGET,
});

const cap = (
  id: string,
  speaker: SpeakerRef,
  text: string,
  seconds: number,
  final = true,
  low: Record<number, number> = {},
): AppEvent => ({
  t: 'caption',
  id,
  speaker,
  text,
  words: words(text, low),
  final,
  at: at(seconds),
});

const said = (
  id: string,
  text: string,
  seconds: number,
  source: 'relay' | 'agent' | 'disclosure',
): AppEvent => ({ t: 'agent.said', id, text, source, interrupted: false, at: at(seconds) });

const HOLD_START = 12.2;
const PICKUP = 282.2;

const MENU_1 =
  'Thanks for calling Riverside Pharmacy. For store hours, press 1. For prescriptions, press 2.';
const D2 = 'Sure, let me pull up your lisinopril. Can I get your date of birth, please?';
const D3 =
  'Thank you. Your lisinopril will be ready Thursday after 2 pm, reference 4471. Is there anything else I can help with?';

const dial = [state('connecting', 0)];
const toMenu = [
  ...dial,
  state('ivr', 2.2),
  cap('m1', menu, MENU_1, 2.2),
  { t: 'dtmf', digits: '2', at: at(8.6) } as AppEvent,
];
const toHold = [
  ...toMenu,
  cap('m2', menu, 'Please hold for the next available pharmacist.', 9.4),
  state('hold', HOLD_START),
];
const toPickup = [
  ...toHold,
  state('human', PICKUP),
  {
    t: 'alert',
    kind: 'human-picked-up',
    message: 'A person picked up',
    at: at(PICKUP),
  } as AppEvent,
];
const toAsk = [
  ...toPickup,
  said(
    'r1',
    'Hi, I’m Carryover, an automated relay calling for Maya, who is Deaf and reading along.',
    283.4,
    'disclosure',
  ),
  cap('c1', dana, 'Hi Maya, this is Dana. What can I do for you today?', 290),
  said('r2', 'I’m checking on my lisinopril refill.', 294.1, 'relay'),
  cap('c2', dana, D2, 297.2, true, { 6: 0.41 }),
  said('r3', 'One moment, please.', 302.8, 'agent'),
  {
    t: 'ask',
    askId: 'a1',
    question: 'Can I get your date of birth, please?',
    field: 'dob',
    from: 'Dana',
    at: at(303.2),
  } as AppEvent,
  {
    t: 'alert',
    kind: 'ask',
    message: 'Dana asks for your date of birth',
    at: at(303.2),
  } as AppEvent,
];
const toCaptions = [
  ...toAsk,
  { t: 'ask.resolved', askId: 'a1', how: 'shared' } as AppEvent,
  said('r4', 'March 14, 1952.', 308.4, 'relay'),
  cap('c3', dana, D3.split(' ').slice(0, 15).join(' '), 309.2, false),
  {
    t: 'commitment',
    commitment: { text: 'Pick up Thursday after 2 pm · ref 4471', when: 'Thursday after 2 pm' },
    at: at(314.5),
  } as AppEvent,
  {
    t: 'relay.queued',
    nonce: 'u2',
    text: 'Thursday works. Thank you, Dana!',
    reason: 'waiting-for-pause',
  } as AppEvent,
];
const toSummary = [
  ...toCaptions.filter((e) => !(e.t === 'caption' && e.id === 'c3')),
  cap('c3', dana, D3, 309.2),
  { t: 'relay.spoken', nonce: 'u2', at: at(318) } as AppEvent,
  said('r5', 'Thursday works. Thank you, Dana!', 318.4, 'relay'),
  cap('c4', dana, 'You’re welcome, Maya. Have a good day!', 321.5),
  state('ended', 325),
  {
    t: 'alert',
    kind: 'call-ended',
    message: 'Call ended: the conversation is finished.',
    at: at(325),
  } as AppEvent,
  {
    t: 'summary',
    summary: {
      callId: 'fixture',
      startedAt: FIXTURE_T0,
      endedAt: at(325),
      targetLabel: TARGET,
      outcome: 'Your refill is ready Thursday.',
      bullets: [],
      commitments: [
        { text: 'Pick up Thursday after 2 pm · ref 4471', when: 'Thursday after 2 pm' },
      ],
      transcript: [
        {
          at: at(283.4),
          who: 'agent',
          text: 'Hi, I’m Carryover, an automated relay calling for Maya, who is Deaf and reading along.',
          source: 'disclosure',
        },
        {
          at: at(294.1),
          who: 'agent',
          text: 'I’m checking on my lisinopril refill.',
          source: 'relay',
        },
        { at: at(302.8), who: 'agent', text: 'One moment, please.', source: 'agent' },
        { at: at(308.4), who: 'agent', text: 'March 14, 1952.', source: 'relay' },
        { at: at(318.4), who: 'agent', text: 'Thursday works. Thank you, Dana!', source: 'relay' },
      ],
    },
  } as AppEvent,
];

export type FixtureState = 'dial' | 'menu' | 'hold' | 'pickup' | 'ask' | 'captions' | 'summary';

/** Events so far and the frozen clock for each reference state. */
export const FIXTURES: Record<FixtureState, { events: AppEvent[]; now: number }> = {
  dial: { events: dial, now: at(1.2) },
  menu: { events: toMenu, now: at(9.2) },
  hold: { events: toHold, now: at(166) },
  pickup: { events: toPickup, now: at(PICKUP) },
  ask: { events: toAsk, now: at(305.2) },
  captions: { events: toCaptions, now: at(317) },
  summary: { events: toSummary, now: at(326.5) },
};
