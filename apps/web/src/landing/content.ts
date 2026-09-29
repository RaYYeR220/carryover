/**
 * Static copy and demo content for the landing page, ported verbatim from
 * Glyph Night's index.html (finalist B). Kept separate from the components so
 * the sections stay readable.
 */
import type { LedScene, LedSceneData } from '../led/led';
import type { CaptionItem } from './Captions';

export const DANA_WORDS =
  'Thanks for holding, this is Dana at Riverside Pharmacy. How can I help?'.split(' ');
export const DANA_TEXT = DANA_WORDS.join(' ');
export const INTRO_TEXT =
  'Hi, I’m Carryover, an automated relay calling for Maya, who is Deaf and reading along.';

/** Hero loop phases: [name, startSeconds, endSeconds). Total loop 19.6s. */
export const HERO_PHASES = [
  ['menu', 0, 3.4],
  ['hold', 3.4, 7.8],
  ['pickup', 7.8, 9.2],
  ['dana', 9.2, 14.2],
  ['you', 14.2, 19.6],
] as const;
export const HERO_LOOP = 19.6;
/** The frozen frame used for `?still` and reduced motion, matching B's own screenshots. */
export const HERO_FROZEN_T = 17.8;

export interface HowStep {
  key: 'menu' | 'hold' | 'speak' | 'ask';
  time: string;
  heading: string;
  shortLabel: string;
  body: string;
  pillLabel: string;
  pillState: 'menu' | 'hold' | 'live' | 'ask';
  who: string;
  deviceTime: string;
  caption: string;
  feed: CaptionItem[];
  ledScene: LedScene;
  ledData?: LedSceneData;
  ledLevel?: number;
}

export const HOW_STEPS: HowStep[] = [
  {
    key: 'menu',
    time: '0:08',
    heading: 'Phone menus, handled',
    shortLabel: 'Menus',
    body: '“For prescriptions, press 2.” Carryover listens to the recording and presses the key. Every key it presses shows up in your captions, so nothing happens out of sight.',
    pillLabel: 'MENU',
    pillState: 'menu',
    who: 'Phone menu',
    deviceTime: '0:08',
    caption: 'Phone menu. Carryover pressed 2 for prescriptions.',
    ledScene: 'menu',
    ledData: { key: '2' },
    feed: [
      { id: 'menu0', kind: 'ev', tag: 'CALL', text: 'Calling Riverside Pharmacy', time: '0:00' },
      {
        id: 'menu1',
        kind: 'menu',
        who: 'Phone menu · recording',
        text: 'Thanks for calling Riverside Pharmacy. For store hours, press 1. For prescriptions, press 2.',
      },
      {
        id: 'menu2',
        kind: 'ev',
        tag: 'KEY 2',
        text: 'Pressed 2 for prescriptions',
        time: '0:08',
      },
      {
        id: 'menu3',
        kind: 'menu',
        who: 'Phone menu · recording',
        text: 'Please hold for the next available pharmacist.',
      },
    ],
  },
  {
    key: 'hold',
    time: '4:42',
    heading: 'Hold, handled. Pickup, flashed.',
    shortLabel: 'Hold',
    body: 'Put the phone down while the music plays. When a person answers, the screen flashes, your phone buzzes and the tab title changes. Flashes stay under three a second.',
    pillLabel: 'HOLD',
    pillState: 'hold',
    who: 'On hold',
    deviceTime: '0:12',
    caption: 'On hold for four and a half minutes, then a person picked up.',
    ledScene: 'hold',
    ledData: { seconds: 12 },
    feed: [
      {
        id: 'hold0',
        kind: 'ev',
        tag: 'HOLD',
        text: 'On hold. Carryover is waiting for you.',
        time: '0:12',
      },
      {
        id: 'hold1',
        kind: 'ev',
        tag: 'TIP',
        text: 'Look away if you like. You’ll see the pickup.',
      },
      {
        id: 'hold2',
        kind: 'ev',
        tag: 'LIVE',
        sig: true,
        text: 'A person picked up',
        time: '4:42',
      },
      {
        id: 'hold3',
        kind: 'them',
        who: 'New person on the line',
        text: 'Riverside Pharmacy, this is Dana.',
      },
    ],
  },
  {
    key: 'speak',
    time: '4:43',
    heading: 'It speaks your words, exactly',
    shortLabel: 'Speaks',
    body: 'It introduces you, then says exactly what you type in a clear voice. If they’re still talking, it waits for a pause. You can always override that with Speak now.',
    pillLabel: 'LIVE',
    pillState: 'live',
    who: 'Speaking for you',
    deviceTime: '4:43',
    caption: 'Carryover introduces Maya and says what she typed.',
    ledScene: 'live',
    ledData: { name: 'YOU' },
    ledLevel: 1,
    feed: [
      { id: 'speak0', kind: 'you', who: 'Said for you · introduction', text: INTRO_TEXT },
      {
        id: 'speak1',
        kind: 'them',
        who: 'Dana · Riverside Pharmacy',
        text: 'Hi Maya. What can I do for you today?',
      },
      { id: 'speak2', kind: 'comp', text: 'I’m checking on my lisinopril refill.', caret: true },
    ],
  },
  {
    key: 'ask',
    time: '5:03',
    heading: 'It asks you. It never guesses.',
    shortLabel: 'Asks',
    body: 'When they ask for something only you know, Carryover says “One moment, please” and asks you. A fact you haven’t shared can’t be said. That rule lives in the code, not in a prompt.',
    pillLabel: 'ASK',
    pillState: 'ask',
    who: 'Waiting for you',
    deviceTime: '5:03',
    caption: 'Dana asks for a date of birth. Carryover says one moment, please, and asks Maya.',
    ledScene: 'ask',
    feed: [
      {
        id: 'ask0',
        kind: 'them',
        who: 'Dana · Riverside Pharmacy',
        text: [
          { text: 'Sure, let me pull up your' },
          { text: 'lisinopril', cls: 'lc' },
          { text: '. Can I get your date of birth, please?' },
        ],
      },
      { id: 'ask1', kind: 'you', who: 'Said for you · automatic', text: 'One moment, please.' },
      {
        id: 'ask2',
        kind: 'ask',
        text: 'Dana asks for your date of birth',
        share: 'Share “March 14, 1952”',
      },
    ],
  },
];

export interface AutonomyLevel {
  value: 'relay' | 'assist' | 'auto';
  label: string;
  level: number;
  heading: string;
  body: string;
  pillLabel: string;
  pillState: 'menu' | 'live';
  feed: CaptionItem[];
}

export const AUTONOMY_LEVELS: AutonomyLevel[] = [
  {
    value: 'relay',
    label: 'Relay',
    level: 1,
    heading: 'Only says what you type.',
    body: 'You lead the whole call. Carryover is your voice, word for word, and your captions. You press menu keys yourself from the keypad.',
    pillLabel: 'MENU',
    pillState: 'menu',
    feed: [
      { id: 'r0', kind: 'menu', who: 'Phone menu · recording', text: 'For appointments, press 1.' },
      { id: 'r1', kind: 'ev', tag: 'YOU', text: 'Waiting for you to press a key' },
      {
        id: 'r2',
        kind: 'them',
        who: 'Sam · Lakeview Dental',
        text: 'Lakeview Dental, this is Sam.',
      },
      {
        id: 'r3',
        kind: 'you',
        who: 'Said for you · typed',
        text: 'Hi Sam, I need to move my cleaning on the 12th.',
      },
    ],
  },
  {
    value: 'assist',
    label: 'Assist',
    level: 2,
    heading: 'Handles the waiting. You do the talking.',
    body: 'It presses menu keys, sits through hold and flashes when a person picks up. It answers routine questions only from facts you chose to share.',
    pillLabel: 'LIVE',
    pillState: 'live',
    feed: [
      { id: 'a0', kind: 'ev', tag: 'KEY 1', text: 'Pressed 1 for appointments', time: '0:06' },
      {
        id: 'a1',
        kind: 'ev',
        tag: 'LIVE',
        sig: true,
        text: 'A person picked up after 2:10',
        time: '2:16',
      },
      {
        id: 'a2',
        kind: 'them',
        who: 'Sam · Lakeview Dental',
        text: 'Can I have the patient’s name?',
      },
      {
        id: 'a3',
        kind: 'you',
        who: 'Said for you · from facts you shared',
        text: 'Maya Collins.',
      },
    ],
  },
  {
    value: 'auto',
    label: 'Auto',
    level: 3,
    heading: 'Works toward a goal you set.',
    body: 'Tell it what you want. It leads the conversation, stays inside your goal and checks with you before agreeing to anything else.',
    pillLabel: 'LIVE',
    pillState: 'live',
    feed: [
      { id: 'u0', kind: 'goal', text: 'Move my cleaning to next week, afternoons.' },
      {
        id: 'u1',
        kind: 'you',
        who: 'Said for you · toward your goal',
        text: 'Could we move Maya’s cleaning to an afternoon next week?',
      },
      { id: 'u2', kind: 'them', who: 'Sam · Lakeview Dental', text: 'I have Wednesday at 3:30.' },
      {
        id: 'u3',
        kind: 'you',
        who: 'Said for you · toward your goal',
        text: 'Wednesday at 3:30 works. Thank you.',
      },
      { id: 'u4', kind: 'ev', tag: 'DONE', text: 'Booked Wed, Oct 7, 3:30 pm' },
    ],
  },
];

export const CAPS_TABLE_ROWS: { label: string; on: [boolean, boolean, boolean] }[] = [
  { label: 'Says what you type', on: [true, true, true] },
  { label: 'Presses menu keys', on: [false, true, true] },
  { label: 'Waits on hold, flashes on pickup', on: [false, true, true] },
  { label: 'Answers from facts you shared', on: [false, true, true] },
  { label: 'Leads the call toward your goal', on: [false, false, true] },
];

export const PROMISES = [
  {
    heading: 'Your details stay on your device',
    body: 'Your name, birthday, address and member numbers live in a profile on this device. Nothing leaves it until you share it for a call.',
  },
  {
    heading: 'It only shares what you allow',
    body: 'Before each call you pick which facts Carryover may say, one chip at a time. You can add one mid-call from an ask card.',
  },
  {
    heading: 'It will not make things up',
    body: 'If the answer isn’t in what you shared, it pauses the call and asks. The agent physically can’t speak a fact about you that isn’t on the list; the check runs in code before any audio plays.',
  },
];

export const PRACTICE_STEPS = [
  'Scan the code with your phone’s camera.',
  'Answer the call and read the pharmacist’s lines out loud.',
  'Watch this screen: your words arrive as captions, the pickup flashes, and an ask card appears when you ask for a birthday.',
];

/** Illustrative only: the real code appears once a practice call is started. */
export const PRACTICE_QR_TEXT = 'https://carryover.app/practice/riverside';
export const PRACTICE_QR_LABEL =
  'Example QR code. Your real code appears when you start a practice call.';
