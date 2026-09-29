import type {
  AlertKind,
  AppEvent,
  Autonomy,
  CallSummary,
  CaptionWord,
  LineState,
} from '@carryover/protocol';

/**
 * The live call as a pure reducer over the server's AppEvents. The same view
 * renders a live call (from /ws/app) and the scripted sample call.
 *
 * The server replays `call.state` plus its last 200 events whenever a socket
 * subscribes, so every event is applied idempotently: captions and lines said
 * for you upsert by id, asks by askId, queued text by nonce, and event rows by
 * a stable id built from the event (kind + time).
 */

export interface CaptionLine {
  id: string;
  who: 'them' | 'ivr' | 'you';
  person?: number;
  label: string;
  text: string;
  words: CaptionWord[];
  final: boolean;
  at: number;
  source?: 'relay' | 'agent' | 'disclosure';
  interrupted?: boolean;
}

export interface EventRowItem {
  id: string;
  kind: 'dtmf' | 'state' | 'new-speaker' | 'gate' | 'commitment' | 'queued' | 'ask';
  text: string;
  at: number;
  /** Short Doto tag on the row: CALL, KEY 2, HOLD, LIVE, SHARED, END… */
  tag?: string;
  /** Second line under the text. */
  sub?: string;
  /** signal = red tag (pickup), shared = white tag (a fact you shared). */
  tone?: 'signal' | 'shared';
  /** Hold rows: when the line left hold. */
  until?: number;
}

export interface AskItem {
  askId: string;
  question: string;
  field?: string;
  from: string;
  at: number;
  resolved?: 'typed' | 'shared' | 'declined' | 'expired';
}

export type TimelineItem =
  | { type: 'line'; line: CaptionLine }
  | { type: 'event'; event: EventRowItem };

export interface QueuedItem {
  nonce: string;
  text: string;
  reason: string;
}

export interface CallView {
  lineState: LineState;
  autonomy: Autonomy;
  since: number;
  targetLabel: string;
  timeline: TimelineItem[];
  asks: AskItem[];
  queued: QueuedItem[];
  lastAlert?: { kind: AlertKind; message: string; at: number };
  summary?: CallSummary;
  ended: boolean;
  error?: string;
}

export const initialView: CallView = {
  lineState: 'connecting',
  autonomy: 'assist',
  since: 0,
  targetLabel: '',
  timeline: [],
  asks: [],
  queued: [],
  ended: false,
};

/* ---------- field names ---------- */

const FIELD_PHRASES: Record<string, string> = {
  dob: 'date of birth',
  date_of_birth: 'date of birth',
  birthday: 'date of birth',
  member_id: 'member ID',
  memberid: 'member ID',
  member: 'member ID',
  addr: 'address',
  phone: 'phone number',
  zip: 'ZIP code',
  ssn: 'Social Security number',
};

/** "dob" → "date of birth", "member_id" → "member ID", "policy_number" → "policy number". */
export function fieldPhrase(field: string): string {
  const k = field.trim().toLowerCase();
  return (
    FIELD_PHRASES[k] ??
    k
      .replace(/[_-]+/g, ' ')
      .replace(/\bid\b/g, 'ID')
      .trim()
  );
}

/* ---------- timeline helpers ---------- */

const itemAt = (x: TimelineItem): number => (x.type === 'line' ? x.line.at : x.event.at);

/** Insert by time, after everything at the same time, so arrival order breaks ties. */
function insertByTime(tl: TimelineItem[], item: TimelineItem): TimelineItem[] {
  const at = itemAt(item);
  let i = tl.length;
  while (i > 0 && itemAt(tl[i - 1] as TimelineItem) > at) i--;
  return [...tl.slice(0, i), item, ...tl.slice(i)];
}

const lineIndex = (tl: TimelineItem[], id: string, you: boolean): number =>
  tl.findIndex((x) => x.type === 'line' && x.line.id === id && (x.line.who === 'you') === you);

const rowIndex = (tl: TimelineItem[], id: string): number =>
  tl.findIndex((x) => x.type === 'event' && x.event.id === id);

function replaceAt(tl: TimelineItem[], i: number, item: TimelineItem): TimelineItem[] {
  const next = tl.slice();
  next[i] = item;
  return next;
}

/** Add a row once; a row with the same id is left as it is. */
function addRow(v: CallView, row: EventRowItem): CallView {
  if (rowIndex(v.timeline, row.id) >= 0) return v;
  return { ...v, timeline: insertByTime(v.timeline, { type: 'event', event: row }) };
}

/** Add a row, or merge fields into the row with the same id (keeping its place). */
function upsertRow(v: CallView, row: EventRowItem): CallView {
  const i = rowIndex(v.timeline, row.id);
  if (i < 0) return addRow(v, row);
  const cur = v.timeline[i] as { type: 'event'; event: EventRowItem };
  const merged = { ...cur.event, ...row, at: cur.event.at };
  if (sameRow(cur.event, merged)) return v;
  return { ...v, timeline: replaceAt(v.timeline, i, { type: 'event', event: merged }) };
}

function sameRow(a: EventRowItem, b: EventRowItem): boolean {
  return (
    a.text === b.text &&
    a.sub === b.sub &&
    a.tag === b.tag &&
    a.tone === b.tone &&
    a.until === b.until &&
    a.kind === b.kind
  );
}

function upsertLine(v: CallView, line: CaptionLine): CallView {
  const you = line.who === 'you';
  const i = lineIndex(v.timeline, line.id, you);
  if (i < 0) {
    if (!line.text.trim()) return v;
    return { ...v, timeline: insertByTime(v.timeline, { type: 'line', line }) };
  }
  const cur = (v.timeline[i] as { type: 'line'; line: CaptionLine }).line;
  // A final is never replaced by a late partial of the same turn.
  if (cur.final && !line.final) return v;
  if (!line.text.trim()) {
    return { ...v, timeline: v.timeline.filter((_, k) => k !== i) };
  }
  // Keep the first time seen, so the line never moves.
  const next: CaptionLine = { ...line, at: cur.at };
  if (sameLine(cur, next)) return v;
  return { ...v, timeline: replaceAt(v.timeline, i, { type: 'line', line: next }) };
}

function sameLine(a: CaptionLine, b: CaptionLine): boolean {
  return (
    a.text === b.text &&
    a.final === b.final &&
    a.label === b.label &&
    a.who === b.who &&
    a.person === b.person &&
    a.source === b.source &&
    a.interrupted === b.interrupted &&
    a.words.length === b.words.length &&
    a.words.every((w, i) => {
      const o = b.words[i];
      return !!o && o.text === w.text && o.confidence === w.confidence;
    })
  );
}

/** Words for a line that came without word timings (what Carryover said). */
function plainWords(text: string): CaptionWord[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ({ text: w, confidence: 1, start: 0, end: 0 }));
}

const latestLineAt = (tl: TimelineItem[]): number => {
  for (let i = tl.length - 1; i >= 0; i--) {
    const x = tl[i] as TimelineItem;
    if (x.type === 'line') return x.line.at;
  }
  return 0;
};

/* ---------- event handlers ---------- */

function onState(v: CallView, e: Extract<AppEvent, { t: 'call.state' }>): CallView {
  let next: CallView = {
    ...v,
    lineState: e.lineState,
    autonomy: e.autonomy,
    since: e.since,
    targetLabel: e.targetLabel,
    ended: v.ended || e.lineState === 'ended',
  };
  // Leaving hold: close the open hold row.
  if (v.lineState === 'hold' && e.lineState !== 'hold') {
    const i = findLastIndex(next.timeline, (x) => x.type === 'event' && x.event.tag === 'HOLD');
    const row = i >= 0 ? (next.timeline[i] as { type: 'event'; event: EventRowItem }).event : null;
    if (row && row.until == null && e.since >= row.at) {
      next = {
        ...next,
        timeline: replaceAt(next.timeline, i, { type: 'event', event: { ...row, until: e.since } }),
      };
    }
  }
  switch (e.lineState) {
    case 'connecting':
    case 'ringing':
      return addRow(next, {
        id: 'state:call',
        kind: 'state',
        tag: 'CALL',
        text: e.targetLabel ? `Calling ${e.targetLabel}` : 'Calling',
        at: e.since,
      });
    case 'hold':
      return addRow(next, {
        id: `state:hold:${e.since}`,
        kind: 'state',
        tag: 'HOLD',
        text: 'On hold',
        at: e.since,
      });
    case 'ended':
      return addRow(next, {
        id: 'end',
        kind: 'state',
        tag: 'END',
        text: 'Call ended',
        at: e.since,
      });
    default:
      return next;
  }
}

function onAlert(v: CallView, e: Extract<AppEvent, { t: 'alert' }>): CallView {
  let next = v;
  if (!v.lastAlert || e.at >= v.lastAlert.at) {
    const same =
      v.lastAlert?.at === e.at && v.lastAlert.kind === e.kind && v.lastAlert.message === e.message;
    if (!same) next = { ...next, lastAlert: { kind: e.kind, message: e.message, at: e.at } };
  }
  switch (e.kind) {
    case 'human-picked-up': {
      const rest = afterDash(e.message);
      return addRow(next, {
        id: `alert:pickup:${e.at}`,
        kind: 'state',
        tag: 'LIVE',
        tone: 'signal',
        text: 'A person picked up',
        ...(rest ? { sub: rest } : {}),
        at: e.at,
      });
    }
    case 'new-speaker':
      return addRow(next, {
        id: `alert:speaker:${e.at}`,
        kind: 'new-speaker',
        tag: 'LIVE',
        tone: 'signal',
        text: 'New person on the line',
        at: e.at,
      });
    case 'voicemail':
      return addRow(next, {
        id: `alert:voicemail:${e.at}`,
        kind: 'state',
        tag: 'VOICEMAIL',
        tone: 'signal',
        text: 'Voicemail picked up',
        sub: 'Type the message to leave',
        at: e.at,
      });
    case 'call-ended': {
      const reason = e.message.replace(/^call ended[:.]?\s*/i, '');
      const sub = reason ? reason.charAt(0).toUpperCase() + reason.slice(1) : undefined;
      next = next.ended ? next : { ...next, ended: true };
      return upsertRow(next, {
        id: 'end',
        kind: 'state',
        tag: 'END',
        text: 'Call ended',
        ...(sub ? { sub } : {}),
        at: e.at,
      });
    }
    case 'voice':
      // "Reconnecting voice…" / "Voice reconnected.": a neutral banner only (via
      // view.lastAlert, already updated above), never a timeline row or the pickup flash.
      return next;
    default:
      return next;
  }
}

function afterDash(message: string): string {
  const m = /\s[—–-]\s(.+)$/.exec(message);
  return m?.[1]?.trim() ?? '';
}

function onAskResolved(v: CallView, e: Extract<AppEvent, { t: 'ask.resolved' }>): CallView {
  const i = v.asks.findIndex((a) => a.askId === e.askId);
  if (i < 0) return v;
  const ask = v.asks[i] as AskItem;
  let next = v;
  if (ask.resolved !== e.how) {
    const asks = v.asks.slice();
    asks[i] = { ...ask, resolved: e.how };
    next = { ...v, asks };
  }
  const what = ask.field ? `your ${fieldPhrase(ask.field)}` : 'that';
  const at = Math.max(ask.at, latestLineAt(next.timeline));
  if (e.how === 'shared') {
    return addRow(next, {
      id: `ask:${ask.askId}`,
      kind: 'ask',
      tag: 'SHARED',
      tone: 'shared',
      text: `You shared ${what} for this call`,
      at,
    });
  }
  if (e.how === 'declined') {
    return addRow(next, {
      id: `ask:${ask.askId}`,
      kind: 'ask',
      tag: 'NO',
      text: `You declined to share ${what}`,
      at,
    });
  }
  if (e.how === 'expired') {
    return addRow(next, {
      id: `ask:${ask.askId}`,
      kind: 'ask',
      tag: 'ASK',
      text: 'The question closed without an answer',
      at,
    });
  }
  return next;
}

function findLastIndex<T>(xs: readonly T[], fn: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i--) if (fn(xs[i] as T)) return i;
  return -1;
}

/** Apply one AppEvent. Pure, and idempotent on replayed events. */
export function reduce(v: CallView, e: AppEvent): CallView {
  switch (e.t) {
    case 'call.state':
      return onState(v, e);

    case 'caption':
      return upsertLine(v, {
        id: e.id,
        who: e.speaker.role === 'ivr' ? 'ivr' : 'them',
        person: e.speaker.person,
        label: e.speaker.label,
        text: e.text,
        words: e.words.length ? e.words : plainWords(e.text),
        final: e.final,
        at: e.at,
      });

    case 'agent.said':
      return upsertLine(v, {
        id: e.id,
        who: 'you',
        label: 'Said for you',
        text: e.text,
        words: plainWords(e.text),
        final: true,
        at: e.at,
        source: e.source,
        interrupted: e.interrupted,
      });

    case 'relay.queued': {
      const i = v.queued.findIndex((q) => q.nonce === e.nonce);
      const item: QueuedItem = { nonce: e.nonce, text: e.text, reason: e.reason };
      if (i < 0) return { ...v, queued: [...v.queued, item] };
      const cur = v.queued[i] as QueuedItem;
      if (cur.text === item.text && cur.reason === item.reason) return v;
      const queued = v.queued.slice();
      queued[i] = item;
      return { ...v, queued };
    }

    case 'relay.spoken':
      return v.queued.some((q) => q.nonce === e.nonce)
        ? { ...v, queued: v.queued.filter((q) => q.nonce !== e.nonce) }
        : v;

    case 'ask':
      if (v.asks.some((a) => a.askId === e.askId)) return v;
      return {
        ...v,
        asks: [
          ...v.asks,
          {
            askId: e.askId,
            question: e.question,
            ...(e.field ? { field: e.field } : {}),
            from: e.from,
            at: e.at,
          },
        ],
      };

    case 'ask.resolved':
      return onAskResolved(v, e);

    case 'alert':
      return onAlert(v, e);

    case 'dtmf':
      return addRow(v, {
        id: `dtmf:${e.at}:${e.digits}`,
        kind: 'dtmf',
        tag: e.digits.length <= 2 ? `KEY ${e.digits}` : 'KEYS',
        text: `Pressed ${e.digits}`,
        at: e.at,
      });

    case 'gate.blocked':
      return addRow(v, {
        id: `gate:${e.at}`,
        kind: 'gate',
        tag: 'HELD',
        text: 'Held back something you haven’t shared',
        sub: e.reason,
        at: e.at,
      });

    case 'commitment':
      return addRow(v, {
        id: `commit:${e.at}:${e.commitment.text}`,
        kind: 'commitment',
        text: e.commitment.text,
        ...(e.commitment.when ? { sub: e.commitment.when } : {}),
        at: e.at,
      });

    case 'summary':
      if (v.summary === e.summary && v.ended) return v;
      return { ...v, summary: e.summary, ended: true };

    case 'error':
      return v.error === e.message ? v : { ...v, error: e.message };

    default:
      return v;
  }
}
