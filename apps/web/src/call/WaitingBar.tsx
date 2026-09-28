import { Button } from '../ui';
import type { QueuedItem } from './state';
import s from './WaitingBar.module.css';

export interface WaitingBarProps {
  items: readonly QueuedItem[];
  /** "Waiting for Dana to finish…" */
  title: string;
  onSpeakNow: (item: QueuedItem) => void;
}

/** Typed text waiting for a pause, with "Speak now" to cut in. */
export function WaitingBar({ items, title, onSpeakNow }: WaitingBarProps) {
  const first = items[0];
  if (!first) return null;
  const more = items.length - 1;
  return (
    <section className={s.wait} aria-label="Waiting to speak">
      <span className={s.dots} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <div className={s.text} aria-live="polite">
        <b>{title}</b>
        <p>
          “{first.text}”{more > 0 && <span className={s.more}> +{more} more</span>}
        </p>
      </div>
      <Button variant="white" className={s.btn} onClick={() => onSpeakNow(first)}>
        Speak now
      </Button>
    </section>
  );
}
