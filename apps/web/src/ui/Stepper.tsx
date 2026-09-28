import type { ReactNode } from 'react';
import s from './Stepper.module.css';

/** Caption sizes in px: 28 default on desktop, 24 on mobile. */
export const CAPTION_SIZES = [20, 24, 28, 36, 48] as const;

export interface StepperProps {
  values: readonly number[];
  value: number;
  onChange: (value: number) => void;
  /** Group name, e.g. "Caption size". */
  label: string;
  decreaseLabel?: string;
  increaseLabel?: string;
  /** Visual prefix before the number (hidden on mobile), e.g. "Aa". */
  prefix?: ReactNode;
  /** Screen-reader suffix after the number, e.g. " pixel captions". */
  unit?: string;
  className?: string;
}

/** A − value + stepper over a fixed list of values; the value is announced politely. */
export function Stepper({
  values,
  value,
  onChange,
  label,
  decreaseLabel = 'Smaller',
  increaseLabel = 'Larger',
  prefix,
  unit,
  className,
}: StepperProps) {
  const found = values.indexOf(value);
  const i = found === -1 ? 0 : found;
  const go = (d: number) => {
    const next = values[Math.max(0, Math.min(values.length - 1, i + d))];
    if (next != null && next !== value) onChange(next);
  };
  return (
    <fieldset className={[s.size, className].filter(Boolean).join(' ')} aria-label={label}>
      <button
        type="button"
        className={s.btn}
        aria-label={decreaseLabel}
        disabled={i <= 0}
        onClick={() => go(-1)}
      >
        −
      </button>
      <span className={s.value} aria-live="polite">
        {prefix != null && <b aria-hidden="true">{prefix}</b>}
        {values[i]}
        {unit && <span className="sr">{unit}</span>}
      </span>
      <button
        type="button"
        className={s.btn}
        aria-label={increaseLabel}
        disabled={i >= values.length - 1}
        onClick={() => go(1)}
      >
        +
      </button>
    </fieldset>
  );
}
