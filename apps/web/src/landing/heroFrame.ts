import type { RingState } from '../led/glyphRing';
import type { LedScene, LedSceneData } from '../led/led';
import { fmtClock } from '../lib/format';
import type { PillState } from '../ui';
import type { CaptionItem, CaptionWord } from './Captions';
import { DANA_TEXT, DANA_WORDS, HERO_LOOP, HERO_PHASES, INTRO_TEXT } from './content';

export type HeroPhase = (typeof HERO_PHASES)[number][0];

export interface HeroFrame {
  phase: HeroPhase;
  pillState: PillState;
  pillLabel: string;
  who: string;
  time: string;
  scene: LedScene;
  data: LedSceneData;
  level: number;
  ring: RingState[];
  caps: CaptionItem[];
  /** Extra halo brightness while someone is speaking. */
  haloLift: number;
}

function phaseAt(loopT: number): { name: HeroPhase; pt: number } {
  for (const [name, start, end] of HERO_PHASES) {
    if (loopT >= start && loopT < end) return { name, pt: loopT - start };
  }
  const first = HERO_PHASES[0] as (typeof HERO_PHASES)[number];
  return { name: first[0], pt: 0 };
}

const ring6 = (fn: (i: number) => RingState): RingState[] =>
  Array.from({ length: 6 }, (_, i) => fn(i));

function danaCaption(pt: number): CaptionItem {
  const n = Math.min(DANA_WORDS.length, Math.floor(pt * 3.2) + 1);
  const fin = Math.max(0, n - 2);
  const words: CaptionWord[] = DANA_WORDS.slice(0, fin).map((text) => ({ text }));
  if (n > fin && n < DANA_WORDS.length) {
    for (const text of DANA_WORDS.slice(fin, n)) words.push({ text, cls: 'pt' });
  } else if (n >= DANA_WORDS.length) {
    for (const text of DANA_WORDS.slice(fin)) words.push({ text });
  }
  return { id: 'dana', kind: 'them', who: 'Dana · Riverside Pharmacy', text: words };
}

/** One frame of the hero's live-loop demo: menu → hold → pickup → dana speaks → you speak. */
export function heroFrame(t: number): HeroFrame {
  const loopT = ((t % HERO_LOOP) + HERO_LOOP) % HERO_LOOP;
  const { name, pt } = phaseAt(loopT);

  if (name === 'menu') {
    const pressed = pt >= 1.5;
    const caps: CaptionItem[] = [
      {
        id: 'm1',
        kind: 'menu',
        who: 'Phone menu · recording',
        text: 'For store hours, press 1. For prescriptions, press 2.',
      },
    ];
    if (pressed)
      caps.push({ id: 'k2', kind: 'ev', tag: 'KEY 2', text: 'Pressed 2 for prescriptions' });
    return {
      phase: name,
      pillState: 'menu',
      pillLabel: 'MENU',
      who: 'Phone menu',
      time: fmtClock(6 + pt),
      scene: 'menu',
      data: pressed ? { key: '2' } : {},
      level: 0,
      ring: ring6((i) => (pt >= 1.5 && pt < 2.2 && (i === 0 || i === 3) ? 'on' : 'off')),
      caps,
      haloLift: 0,
    };
  }

  if (name === 'hold') {
    const elapsed = (pt / 4.4) * 270;
    return {
      phase: name,
      pillState: 'hold',
      pillLabel: 'HOLD',
      who: 'On hold',
      time: fmtClock(12 + elapsed),
      scene: 'hold',
      data: { seconds: elapsed },
      level: 0,
      ring: ring6((i) => (i <= Math.floor((pt / 4.4) * 6) ? 'on' : 'dim')),
      caps: [
        { id: 'h', kind: 'ev', tag: 'HOLD', text: 'On hold. Carryover is waiting for you.' },
        {
          id: 'tip',
          kind: 'ev',
          tag: 'TIP',
          text: 'Look away if you like. The screen flashes when someone answers.',
        },
      ],
      haloLift: 0,
    };
  }

  if (name === 'pickup') {
    const k = Math.floor(pt / 0.2);
    return {
      phase: name,
      pillState: 'live',
      pillLabel: 'LIVE',
      who: 'A person picked up',
      time: fmtClock(282 + pt),
      scene: 'flash',
      data: { name: 'LIVE' },
      level: 0,
      ring: ring6(() => (k < 6 ? (k % 2 === 0 ? 'red' : 'off') : 'dim')),
      caps: [{ id: 'live', kind: 'ev', tag: 'LIVE', sig: true, text: 'A person picked up' }],
      haloLift: 0,
    };
  }

  if (name === 'dana') {
    return {
      phase: name,
      pillState: 'live',
      pillLabel: 'LIVE',
      who: 'Dana is speaking',
      time: fmtClock(283 + pt),
      scene: 'live',
      data: { name: 'DANA' },
      level: pt < 4.2 ? 1 : 0,
      ring: ring6(() => 'dim'),
      caps: [
        { id: 'live', kind: 'ev', tag: 'LIVE', sig: true, text: 'A person picked up' },
        danaCaption(pt),
      ],
      haloLift: 0.08,
    };
  }

  // 'you'
  return {
    phase: name,
    pillState: 'live',
    pillLabel: 'LIVE',
    who: 'Speaking for you',
    time: fmtClock(288 + pt),
    scene: 'live',
    data: { name: 'YOU' },
    level: pt < 4.6 ? 1 : 0,
    ring: ring6(() => 'dim'),
    caps: [
      { id: 'dana', kind: 'them', who: 'Dana · Riverside Pharmacy', text: DANA_TEXT },
      { id: 'you', kind: 'you', who: 'Said for you · introduction', text: INTRO_TEXT },
    ],
    haloLift: 0.08,
  };
}
