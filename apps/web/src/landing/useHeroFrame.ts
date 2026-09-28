import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '../ui';
import { HERO_FROZEN_T } from './content';
import { type HeroFrame, heroFrame } from './heroFrame';

const TICK_MS = 150;

/**
 * Drives the hero's live-loop demo. Reduced motion (including `?still`)
 * freezes forever on one calm frame, matching Glyph Night: the pickup flash
 * is never reached, so nothing flashes.
 */
export function useHeroFrame(): { frame: HeroFrame; rippleKey: number } {
  const reducedMotion = useReducedMotion();
  const [frame, setFrame] = useState<HeroFrame>(() => heroFrame(reducedMotion ? HERO_FROZEN_T : 0));
  const [rippleKey, setRippleKey] = useState(0);
  const lastPhase = useRef(frame.phase);
  const start = useRef<number | null>(null);

  useEffect(() => {
    if (reducedMotion) {
      setFrame(heroFrame(HERO_FROZEN_T));
      return;
    }
    start.current = performance.now();
    const id = window.setInterval(() => {
      const t = (performance.now() - (start.current ?? 0)) / 1000;
      const next = heroFrame(t);
      if (next.phase === 'pickup' && lastPhase.current !== 'pickup') {
        setRippleKey((k) => k + 1);
      }
      lastPhase.current = next.phase;
      setFrame(next);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [reducedMotion]);

  return { frame, rippleKey };
}
