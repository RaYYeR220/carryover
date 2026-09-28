import type { RingState } from '../led/glyphRing';
import type { LedScene, LedSceneData } from '../led/led';
import { fmtClock } from '../lib/format';
import type { PillState } from '../ui/Pill';
import {
  type AskItem,
  type CallView,
  type CaptionLine,
  type EventRowItem,
  fieldPhrase,
  type TimelineItem,
} from './state';

/**
 * What the call screen shows around the transcript, derived from the view and
 * a clock: the status pill, the LED scene and glyph ring, and the two lines of
 * line status under the LED. All pure.
 */

/** How long the pickup moment lasts: flash (1.2 s) then the banner. */
export const PICKUP_FLASH_MS = 1200;
export const PICKUP_BANNER_MS = 7400;
/** Reading pace for lines said for you, to estimate when speech ends. */
const WORDS_PER_SECOND = 2.6;

export interface Speaking {
  who: 'them' | 'ivr' | 'you' | null;
  /** LED label: DANA, YOU, LIVE… */
  name: string;
  level: number;
  /** The line said for you is Carryover's own (not typed by the user). */
  auto?: boolean;
  line?: CaptionLine;
}

export const lines = (v: CallView): CaptionLine[] =>
  v.timeline.flatMap((x) => (x.type === 'line' ? [x.line] : []));

export function lastLine(v: CallView): CaptionLine | undefined {
  for (let i = v.timeline.length - 1; i >= 0; i--) {
    const x = v.timeline[i] as TimelineItem;
    if (x.type === 'line') return x.line;
  }
  return undefined;
}

/** Label of the last person (not recording) on the line: "Dana", "Person 1". */
export function lastThemLabel(v: CallView): string | undefined {
  for (let i = v.timeline.length - 1; i >= 0; i--) {
    const x = v.timeline[i] as TimelineItem;
    if (x.type === 'line' && x.line.who === 'them') return x.line.label;
  }
  return undefined;
}

/** "Dana" → DANA; generic labels ("Person 2") → THEM. */
export function ledName(label: string | undefined): string {
  if (!label || /^person\b/i.test(label) || /^the other/i.test(label)) return 'THEM';
  return (label.split(/\s+/)[0] ?? label).toUpperCase().slice(0, 8);
}

/** Who is audible now: a streaming caption, or a line just said for you. */
export function speaking(v: CallView, now: number): Speaking {
  const last = lastLine(v);
  if (last && last.who !== 'you' && !last.final) {
    return {
      who: last.who,
      name: last.who === 'ivr' ? 'MENU' : ledName(last.label),
      level: 1,
      line: last,
    };
  }
  if (last && last.who === 'you') {
    const ms = Math.max(1200, (last.words.length / WORDS_PER_SECOND) * 1000);
    if (now >= last.at - 2000 && now - last.at < ms) {
      return { who: 'you', name: 'YOU', level: 1, auto: last.source !== 'relay', line: last };
    }
  }
  return { who: null, name: 'LIVE', level: 0 };
}

/** The oldest question still waiting for the user. */
export function openAsk(v: CallView): AskItem | undefined {
  return v.ended ? undefined : v.asks.find((a) => !a.resolved);
}

/** The last keys pressed since the line entered its current state. */
export function lastKeys(v: CallView): { digits: string; at: number } | undefined {
  for (let i = v.timeline.length - 1; i >= 0; i--) {
    const x = v.timeline[i] as TimelineItem;
    if (x.type !== 'event' || x.event.kind !== 'dtmf') continue;
    if (x.event.at < v.since) return undefined;
    const digits = /^Pressed (.+)$/.exec(x.event.text)?.[1];
    return digits ? { digits, at: x.event.at } : undefined;
  }
  return undefined;
}

export function pillFor(v: CallView): { state: PillState; label: string } {
  if (v.ended || v.lineState === 'ended') return { state: 'ended', label: 'ENDED' };
  switch (v.lineState) {
    case 'connecting':
    case 'ringing':
      return { state: 'dial', label: 'DIALING' };
    case 'ivr':
      return { state: 'menu', label: 'MENU' };
    case 'hold':
      return { state: 'hold', label: 'HOLD' };
    case 'voicemail':
      return { state: 'live', label: 'VOICEMAIL' };
    default:
      return { state: openAsk(v) ? 'ask' : 'live', label: 'LIVE' };
  }
}

export interface LedState {
  scene: LedScene;
  data: LedSceneData;
  level: number;
  ring: RingState | RingState[];
}

export interface Moment {
  now: number;
  /** When the pickup was first seen on this screen (same clock as `now`), if any. */
  pickupAt?: number;
  reducedMotion?: boolean;
}

export function pickupPhase(m: Moment): 'flash' | 'banner' | null {
  if (m.pickupAt == null) return null;
  const d = m.now - m.pickupAt;
  if (d < 0) return null;
  if (d < PICKUP_FLASH_MS) return 'flash';
  if (d < PICKUP_BANNER_MS) return 'banner';
  return null;
}

/** The paper takeover is up for 3 × 200 ms in the first 1.2 s (2.5 Hz). Never with reduced motion. */
export function flashOn(m: Moment): boolean {
  if (m.reducedMotion || m.pickupAt == null) return false;
  const k = Math.floor((m.now - m.pickupAt) / 200);
  return k >= 0 && k < 6 && k % 2 === 0;
}

export function holdSeconds(v: CallView, now: number): number {
  return Math.max(0, (now - v.since) / 1000);
}

export function ledFor(v: CallView, m: Moment): LedState {
  const off: RingState = 'off';
  if (v.ended || v.lineState === 'ended') return { scene: 'end', data: {}, level: 0, ring: off };
  switch (v.lineState) {
    case 'connecting':
    case 'ringing':
      return { scene: 'dial', data: {}, level: 0, ring: off };
    case 'ivr': {
      const keys = lastKeys(v);
      const fresh = keys != null && m.now - keys.at >= 0 && m.now - keys.at < 700;
      return {
        scene: 'menu',
        data: keys ? { key: keys.digits } : {},
        level: 0,
        ring: fresh ? ['on', 'off', 'off', 'on', 'off', 'off'] : off,
      };
    }
    case 'hold': {
      const secs = holdSeconds(v, m.now);
      const lit = Math.floor(secs / 8) % 6;
      return {
        scene: 'hold',
        data: { seconds: secs },
        level: 0,
        ring: Array.from({ length: 6 }, (_, i): RingState => (i <= lit ? 'on' : 'dim')),
      };
    }
    default: {
      const sp = speaking(v, m.now);
      if (v.lineState === 'voicemail') {
        return { scene: 'live', data: { name: 'REC' }, level: sp.level, ring: 'dim' };
      }
      if (openAsk(v)) return { scene: 'ask', data: {}, level: 0, ring: 'red' };
      const phase = pickupPhase(m);
      if (phase) {
        const k = Math.floor((m.now - (m.pickupAt ?? 0)) / 200);
        const ring: RingState = m.reducedMotion || (k < 6 && k % 2 === 0) ? 'red' : 'dim';
        return {
          scene: 'flash',
          data: { name: sp.who ? sp.name : 'LIVE' },
          level: sp.level,
          ring: phase === 'flash' ? ring : 'dim',
        };
      }
      return { scene: 'live', data: { name: sp.name }, level: sp.level, ring: 'dim' };
    }
  }
}

export interface LineStatus {
  title: string;
  sub: string;
}

export function lineStatus(v: CallView, m: Moment): LineStatus {
  const target = v.targetLabel || 'the other side';
  if (v.ended || v.lineState === 'ended') {
    const end = endTime(v);
    const started = startTime(v);
    const dur = end != null && started != null ? ` · ${fmtClock((end - started) / 1000)}` : '';
    return {
      title: `Call ended${dur}`,
      sub: v.summary ? 'Your summary is ready.' : 'Writing your summary…',
    };
  }
  switch (v.lineState) {
    case 'connecting':
      return { title: `Calling ${target}`, sub: 'Connecting the call.' };
    case 'ringing':
      return { title: `Calling ${target}`, sub: 'Ringing.' };
    case 'ivr': {
      const keys = lastKeys(v);
      return keys
        ? { title: `Pressed ${keys.digits}`, sub: 'Waiting for the menu to finish.' }
        : { title: 'Phone menu', sub: 'Listening for the right option.' };
    }
    case 'hold':
      return {
        title: `On hold · ${fmtClock(holdSeconds(v, m.now))}`,
        sub: 'Carryover is waiting. Look away if you like: the screen flashes and your phone buzzes when a person answers.',
      };
    case 'voicemail':
      return {
        title: 'Voicemail',
        sub: 'Type the message to leave. Carryover says it for you.',
      };
    default:
      break;
  }
  const ask = openAsk(v);
  if (ask) {
    const what = ask.field ? `for your ${fieldPhrase(ask.field)}` : 'you something';
    return {
      title: 'Waiting for you',
      sub: `${ask.from} asked ${what}. The line is holding; choose on the card.`,
    };
  }
  if (pickupPhase(m)) return { title: 'A person picked up', sub: `You’re live with ${target}.` };
  const who = lastThemLabel(v);
  if (v.queued.length) {
    return {
      title: who ? `Waiting for ${who} to finish` : 'Waiting for a pause',
      sub: 'Queued next. Speak now cuts in.',
    };
  }
  const sp = speaking(v, m.now);
  if (sp.who === 'them') {
    return {
      title: `${sp.line?.label ?? 'The other side'} is speaking`,
      sub: 'Dotted words are ones the captions aren’t sure about.',
    };
  }
  if (sp.who === 'you') {
    return {
      title: 'Speaking for you',
      sub: sp.auto
        ? 'Automatic line; it never includes facts you didn’t share.'
        : 'Saying your words exactly as written.',
    };
  }
  return {
    title: who ? `Live with ${who}` : `Live with ${target}`,
    sub: 'Your turn. Type, or tap a quick reply.',
  };
}

/** What the waiting bar says about the first queued line. */
export function waitingTitle(v: CallView): string {
  const first = v.queued[0];
  if (!first) return '';
  if (first.reason === 'agent-speaking') return 'Waiting for Carryover to finish…';
  if (v.lineState === 'connecting' || v.lineState === 'ringing') {
    return 'Waiting for the call to connect…';
  }
  const who = lastThemLabel(v);
  return who ? `Waiting for ${who} to finish…` : 'Waiting for a pause…';
}

/** Earliest time the view knows about: the call start, near enough. */
export function startTime(v: CallView): number | undefined {
  if (v.summary) return v.summary.startedAt;
  let min: number | undefined;
  for (const x of v.timeline) {
    const at = x.type === 'line' ? x.line.at : x.event.at;
    if (at > 0 && (min === undefined || at < min)) min = at;
  }
  if (v.since > 0 && (min === undefined || v.since < min)) min = v.since;
  return min;
}

export function endTime(v: CallView): number | undefined {
  if (v.summary) return v.summary.endedAt;
  const end = v.timeline.find(
    (x): x is { type: 'event'; event: EventRowItem } => x.type === 'event' && x.event.id === 'end',
  );
  return end?.event.at ?? (v.ended ? v.since : undefined);
}

/** Tab title: badges the pickup and questions, like B. */
export function titleFor(v: CallView, m: Moment): string {
  if (v.ended || v.lineState === 'ended') return 'Call ended · Carryover';
  const ask = openAsk(v);
  if (ask) return `● ${ask.from} asks you something · Carryover`;
  if (pickupPhase(m)) return '● A person picked up · Carryover';
  return v.targetLabel ? `Carryover · ${v.targetLabel}` : 'Carryover · Call';
}
