import type { Fact } from '@carryover/protocol';
import { useEffect, useId, useRef } from 'react';
import { fmtClock } from '../lib/format';
import { buttonClass, LiveDot } from '../ui';
import s from './AskCard.module.css';
import { type AskItem, fieldPhrase } from './state';

export interface AskCardProps {
  ask: AskItem;
  /** The profile fact whose key matches the ask's field, if any. */
  fact?: Fact;
  /** The fact is already shared for this call. */
  alreadyShared?: boolean;
  /** What Carryover said while it asks you ("One moment, please."), if anything. */
  holdingLine?: string;
  /** Seconds the other side has been waiting. */
  waited: number;
  /** A button was pressed and the answer is on its way. */
  busy?: boolean;
  /** More questions waiting behind this one. */
  more?: number;
  onShare: (fact: Fact) => void;
  onType: () => void;
  onDecline: () => void;
}

/** True when a key press is typing, not a shortcut. */
function typingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || !!t.closest('input, textarea, select, [contenteditable="true"]');
}

/**
 * The question only you can answer, as an `alertdialog` on paper. 1 shares
 * the matching profile fact, 2 types an answer, 3 declines.
 */
export function AskCard({
  ask,
  fact,
  alreadyShared,
  holdingLine,
  waited,
  busy,
  more = 0,
  onShare,
  onType,
  onDecline,
}: AskCardProps) {
  const headId = useId();
  const questionId = useId();
  const firstRef = useRef<HTMLButtonElement>(null);
  const what = fact ? fact.label.toLowerCase() : ask.field ? fieldPhrase(ask.field) : '';
  const heading = what ? `${ask.from} asks for your ${what}` : `${ask.from} asks you something`;

  const act = useRef({ fact, busy, onShare, onType, onDecline });
  act.current = { fact, busy, onShare, onType, onDecline };

  // Offer the first choice to the keyboard, unless the user is typing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per question
  useEffect(() => {
    if (typingTarget(document.activeElement)) return;
    firstRef.current?.focus({ preventScroll: true });
  }, [ask.askId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (typingTarget(e.target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const a = act.current;
      if (a.busy) return;
      if (e.key === '1' && a.fact) a.onShare(a.fact);
      else if (e.key === '2') a.onType();
      else if (e.key === '3') a.onDecline();
      else return;
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const said = holdingLine?.trim();
  const note = said
    ? `Carryover said “${said}”${/[.!?…]$/.test(said) ? '' : '.'} The line is holding for you.`
    : 'The line is holding for you.';

  let src: string;
  if (fact && alreadyShared) src = `Your ${what} is shared for this call.`;
  else if (fact) {
    src = `Your ${what} is in your profile but wasn’t shared for this call. Sharing adds it for this call only.`;
  } else if (ask.field) {
    src = `Your ${what} isn’t in your profile. Type it, or decline and Carryover says you’d rather not share it.`;
  } else src = 'Type your answer, or decline and Carryover says you’d rather not share it.';

  return (
    <section
      className={s.ask}
      role="alertdialog"
      aria-labelledby={headId}
      aria-describedby={questionId}
    >
      <div className={s.head}>
        <LiveDot breathe />
        <span id={headId}>{heading}</span>
        <small>
          <span className={s.w}>Waiting </span>
          {fmtClock(waited)}
        </small>
      </div>
      <q id={questionId}>{ask.question}</q>
      <p className={s.note}>{note}</p>
      <div className={[s.acts, !fact && s.two].filter(Boolean).join(' ')}>
        {fact && (
          <button
            ref={firstRef}
            type="button"
            className={buttonClass({ variant: 'ink', size: 'lg', className: s.share })}
            aria-keyshortcuts="1"
            disabled={busy}
            onClick={() => onShare(fact)}
          >
            <span>Share “{fact.value}”</span>
            <small>from profile</small>
          </button>
        )}
        <button
          ref={fact ? undefined : firstRef}
          type="button"
          className={buttonClass({ variant: 'soft', size: 'lg' })}
          aria-keyshortcuts="2"
          disabled={busy}
          onClick={onType}
        >
          Type an answer
        </button>
        <button
          type="button"
          className={buttonClass({ variant: 'soft', size: 'lg' })}
          aria-keyshortcuts="3"
          disabled={busy}
          onClick={onDecline}
        >
          Decline
        </button>
      </div>
      <p className={s.src}>
        {src}
        {more > 0 && ` ${more === 1 ? 'One more question' : `${more} more questions`} after this.`}
      </p>
    </section>
  );
}
