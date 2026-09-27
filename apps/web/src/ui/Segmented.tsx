import { type CSSProperties, type KeyboardEvent, useRef } from 'react';
import s from './Segmented.module.css';

export interface SegmentedOption<V extends string> {
  value: V;
  label: string;
  /** Lit level dots (of 3), e.g. Relay 1, Assist 2, Auto 3. */
  level?: number;
}

export interface SegmentedProps<V extends string> {
  options: readonly SegmentedOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Accessible name of the radiogroup (or use `labelledBy`). */
  label?: string;
  labelledBy?: string;
  /** night = call screen, light = start sheet, fader = landing. */
  tone?: 'night' | 'light' | 'fader';
  className?: string;
}

const KEY_STEP: Record<string, number> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/**
 * A radiogroup with a sliding thumb. Arrow keys move and select (wrapping),
 * Home/End jump to the ends; only the checked option is in the tab order.
 */
export function Segmented<V extends string>({
  options,
  value,
  onChange,
  label,
  labelledBy,
  tone = 'night',
  className,
}: SegmentedProps<V>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const pick = (i: number) => {
    const o = options[i];
    if (!o) return;
    refs.current[i]?.focus();
    if (o.value !== value) onChange(o.value);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = options.length;
    const step = KEY_STEP[e.key];
    if (step) {
      e.preventDefault();
      pick((index + step + n) % n);
    } else if (e.key === 'Home') {
      e.preventDefault();
      pick(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      pick(n - 1);
    }
  };
  const style = { '--i': index, '--n': options.length } as CSSProperties;
  return (
    <div
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      className={[s.seg, s[tone], className].filter(Boolean).join(' ')}
      style={style}
      onKeyDown={onKeyDown}
    >
      <span className={s.thumb} aria-hidden="true" />
      {options.map((o, i) => {
        const checked = i === index;
        return (
          // biome-ignore lint/a11y/useSemanticElements: buttons with role=radio give the roving-tabindex radiogroup of the design
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className={s.opt}
            onClick={() => pick(i)}
          >
            {o.level != null && (
              <span className={s.lv} aria-hidden="true">
                {[0, 1, 2].map((k) => (
                  <i key={k} className={k < (o.level ?? 0) ? s.l : undefined} />
                ))}
              </span>
            )}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
