import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { fmtClock } from '../lib/format';
import s from './CaptionLog.module.css';
import { CalendarIcon } from './icons';
import type { CallView, CaptionLine, EventRowItem, TimelineItem } from './state';

/** Below this confidence a word gets a dotted underline. */
export const LOW_CONFIDENCE = 0.6;
/** How many trailing words of a streaming line are still settling. */
const PARTIAL_TAIL = 2;
/** More new items than this in one update is a replay: they appear without the entrance. */
const BURST = 3;
/** Keep the transcript pinned to the bottom when the reader is this close to it. */
const STICK_PX = 140;

export interface CaptionLogProps {
  view: CallView;
  now: number;
  /** Call start, for the times on event rows. */
  startedAt: number;
  reducedMotion: boolean;
  /** Changing this re-pins the log to the bottom (caption size changed). */
  layoutKey?: unknown;
  /** Bumping this scrolls to the top and focuses the log (Open transcript). */
  focusTopKey?: number;
}

const keyOf = (x: TimelineItem) =>
  x.type === 'line' ? `l:${x.line.who}:${x.line.id}` : `e:${x.event.id}`;

/** Transcript + event rows: `role=log`, with a polite live mirror that only ever gets finals. */
export function CaptionLog({
  view,
  now,
  startedAt,
  reducedMotion,
  layoutKey,
  focusTopKey,
}: CaptionLogProps) {
  const streamRef = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [jump, setJump] = useState(false);

  // Which items animate in: decided once per item, when it first appears.
  const enter = useRef(new Map<string, boolean>());
  const known = enter.current;
  const unseen = view.timeline.filter((x) => !known.has(keyOf(x)));
  const animate = !reducedMotion && known.size > 0 && unseen.length <= BURST;
  for (const x of unseen) known.set(keyOf(x), animate);

  // Screen-reader mirror: finals only, the last few, never what was on screen before mount.
  const announced = useRef<Set<string> | null>(null);
  const [mirror, setMirror] = useState<{ key: string; text: string }[]>([]);
  useEffect(() => {
    const finals = view.timeline.filter((x) => x.type === 'event' || x.line.final);
    if (announced.current === null) {
      announced.current = new Set(finals.map(keyOf));
      return;
    }
    const seen = announced.current;
    const fresh = finals.filter((x) => !seen.has(keyOf(x)));
    if (!fresh.length) return;
    for (const x of fresh) seen.add(keyOf(x));
    setMirror((m) => [...m, ...fresh.map((x) => ({ key: keyOf(x), text: spoken(x) }))].slice(-6));
  }, [view.timeline]);

  // Follow new lines unless the reader scrolled up; then offer a jump.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin whenever the content or its size changes
  useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    if (stuck.current) el.scrollTop = el.scrollHeight;
    else setJump(true);
  }, [view.timeline, layoutKey]);

  useEffect(() => {
    if (!focusTopKey) return;
    const el = streamRef.current;
    if (!el) return;
    el.scrollTop = 0;
    stuck.current = false;
    el.focus({ preventScroll: true });
  }, [focusTopKey]);

  const onScroll = () => {
    const el = streamRef.current;
    if (!el) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
    if (stuck.current) setJump(false);
  };

  const toLatest = () => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stuck.current = true;
    setJump(false);
  };

  return (
    <div className={s.wrap}>
      <div
        ref={streamRef}
        className={s.stream}
        role="log"
        aria-label="Call transcript"
        aria-live="off"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the transcript scrolls; keyboard users need to reach it
        tabIndex={0}
        onScroll={onScroll}
      >
        <div className={s.streamIn}>
          {view.timeline.map((x, i) => {
            const k = keyOf(x);
            const cls = known.get(k) ? s.enter : undefined;
            if (x.type === 'line') {
              return <Caption key={k} line={x.line} target={view.targetLabel} className={cls} />;
            }
            if (x.event.kind === 'commitment') {
              return (
                <Note
                  key={k}
                  row={x.event}
                  from={speakerBefore(view.timeline, i)}
                  className={cls}
                />
              );
            }
            return (
              <EventRow
                key={k}
                row={x.event}
                time={fmtClock((x.event.at - startedAt) / 1000)}
                live={holdLive(view, x.event, now)}
                className={cls}
              />
            );
          })}
        </div>
      </div>
      {jump && (
        <button type="button" className={s.jump} onClick={toLatest}>
          Jump to latest
        </button>
      )}
      <div className="sr" aria-live="polite" aria-atomic="false" data-testid="caption-mirror">
        {mirror.map((m) => (
          <p key={m.key}>{m.text}</p>
        ))}
      </div>
    </div>
  );
}

/* ---------- caption line ---------- */

const VIA: Record<NonNullable<CaptionLine['source']>, string> = {
  relay: 'you typed',
  agent: 'automatic',
  disclosure: 'introduction, automatic',
};

export function viaLabel(line: Pick<CaptionLine, 'source' | 'interrupted'>): string {
  const via = VIA[line.source ?? 'agent'];
  return line.interrupted ? `${via}, cut off` : via;
}

function Caption({
  line,
  target,
  className,
}: {
  line: CaptionLine;
  target: string;
  className?: string;
}) {
  if (line.who === 'you') {
    return (
      <p className={cx(s.cap, s.you, className)}>
        <span className={s.by}>
          <i aria-hidden="true" />
          <b>Said for you</b>
          <em>· {viaLabel(line)}</em>
        </span>
        {line.text}
      </p>
    );
  }
  const ivr = line.who === 'ivr';
  return (
    <p className={cx(s.cap, ivr ? s.menu : s.them, className)}>
      <span className={s.by}>
        <i aria-hidden="true" />
        <b>{line.label}</b>
        <em>· {ivr ? 'recording' : target || 'on the line'}</em>
      </span>
      {captionWords(line)}
    </p>
  );
}

/** Words with low confidence dotted, and the unsettled tail of a streaming line in grey. */
function captionWords(line: CaptionLine): ReactNode[] {
  const n = line.words.length;
  const settled = line.final ? n : Math.max(0, n - PARTIAL_TAIL);
  const out: ReactNode[] = [];
  line.words.forEach((w, i) => {
    if (i > 0) out.push(' ');
    let word: ReactNode = w.text;
    if (w.confidence < LOW_CONFIDENCE) {
      const [core, punct] = splitPunct(w.text);
      word = (
        <>
          <span className={s.lc} title={`Low confidence: ${Math.round(w.confidence * 100)}%`}>
            {core}
          </span>
          {punct}
        </>
      );
    }
    out.push(
      // biome-ignore lint/suspicious/noArrayIndexKey: words of one line are positional
      <span key={i} className={i >= settled ? s.pt : undefined}>
        {word}
      </span>,
    );
  });
  return out;
}

function splitPunct(w: string): [string, string] {
  const m = /^(.*?)([.,!?;:…"”’)]*)$/.exec(w);
  return [m?.[1] ?? w, m?.[2] ?? ''];
}

/* ---------- event rows ---------- */

/** A hold row that is still open counts up with the clock. */
function holdLive(v: CallView, row: EventRowItem, now: number): string | undefined {
  if (row.tag !== 'HOLD') return undefined;
  if (row.until != null) return `On hold for ${fmtClock((row.until - row.at) / 1000)}`;
  if (v.lineState === 'hold' && !v.ended) return `On hold · ${fmtClock((now - row.at) / 1000)}`;
  return undefined;
}

function EventRow({
  row,
  time,
  live,
  className,
}: {
  row: EventRowItem;
  time: string;
  live?: string;
  className?: string;
}) {
  const open = live?.startsWith('On hold ·');
  const sub = open ? 'Carryover is waiting for you' : row.sub;
  return (
    <p
      className={cx(
        s.ev,
        row.tone === 'signal' && s.sig,
        row.tone === 'shared' && s.shared,
        className,
      )}
    >
      {row.tag && <span className={s.tag}>{row.tag}</span>}
      <span className={s.txt}>
        {live ?? row.text}
        {sub && <small>{sub}</small>}
      </span>
      <span className={s.lead} aria-hidden="true" />
      <time>{time}</time>
    </p>
  );
}

function Note({ row, from, className }: { row: EventRowItem; from?: string; className?: string }) {
  const when = row.sub && !row.text.toLowerCase().includes(row.sub.toLowerCase()) ? row.sub : '';
  return (
    <div className={cx(s.note, className)}>
      <span className={s.ico} aria-hidden="true">
        <CalendarIcon />
      </span>
      <span>
        <b>
          {row.text}
          {when && ` · ${when}`}
        </b>
        <span>
          {from ? `Noted from ${from}’s words.` : 'Noted from the call.'} It’s in your call summary.
        </span>
      </span>
    </div>
  );
}

function speakerBefore(tl: TimelineItem[], i: number): string | undefined {
  for (let k = i - 1; k >= 0; k--) {
    const x = tl[k] as TimelineItem;
    if (x.type === 'line' && x.line.who === 'them') return x.line.label;
  }
  return undefined;
}

/** What the live mirror reads out for a finished item. */
function spoken(x: TimelineItem): string {
  if (x.type === 'line') {
    if (x.line.who === 'you') return `Said for you: ${x.line.text}`;
    return `${x.line.label}: ${x.line.text}`;
  }
  const e = x.event;
  if (e.kind === 'commitment') return `Noted: ${e.text}${e.sub ? `, ${e.sub}` : ''}.`;
  return e.sub ? `${e.text}. ${e.sub}` : e.text;
}

function cx(...xs: (string | false | undefined)[]): string {
  return xs.filter(Boolean).join(' ');
}
