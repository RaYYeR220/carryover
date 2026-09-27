import { useEffect, useRef } from 'react';
import { drawWordmark, WORDMARK_ASPECT } from '../led/wordmark';

export interface DotWordmarkProps {
  /** Dot colour; the full stop is always signal red. */
  ink?: string;
  /** Height in px (19 nav, 18 footer, 15 call screen). */
  height?: number;
  className?: string;
}

/** The "carryover." dot wordmark. Decorative: wrap it in a labelled link. */
export function DotWordmark({ ink = '#000', height = 19, className }: DotWordmarkProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) drawWordmark(ref.current, ink);
  }, [ink]);
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a canvas without tabindex is not focusable; it is decorative
    <canvas
      ref={ref}
      className={className}
      style={{ height, width: 'auto', aspectRatio: String(WORDMARK_ASPECT) }}
      aria-hidden="true"
    />
  );
}
