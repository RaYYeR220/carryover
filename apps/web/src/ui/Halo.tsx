import { useEffect, useRef } from 'react';
import { type HaloAnchor, Halo as HaloEngine } from '../led/halo';
import s from './Halo.module.css';
import { useReducedMotion } from './useReducedMotion';

export type { HaloAnchor, HaloRect } from '../led/halo';

export interface HaloProps {
  /**
   * Where the light comes from, given the canvas box (which fills the stage).
   * Measure the anchored elements and return them relative to `box`.
   */
  anchor: (box: DOMRect) => HaloAnchor;
  /** Dot spacing in px. Default 13. */
  pitch?: number;
  /** Overall brightness. Default 0.8. */
  gain?: number;
  /** Extra brightness while someone speaks (about 0.08). */
  lift?: number;
  /** Change to send a red ripple across the field (pickup). */
  rippleKey?: number | string;
  /** Change to re-measure the anchor (content moved without a resize). */
  refitKey?: number | string;
  className?: string;
}

/**
 * The dot halo behind a dark stage. Place it as the first child of a
 * `position: relative; isolation: isolate` stage; it fills the stage.
 */
export function Halo({ anchor, pitch, gain, lift = 0, rippleKey, refitKey, className }: HaloProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const engine = useRef<HaloEngine | null>(null);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const reducedMotion = useReducedMotion();
  const rmRef = useRef(reducedMotion);
  rmRef.current = reducedMotion;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const halo = new HaloEngine(canvas, (b) => anchorRef.current(b), {
      pitch,
      gain,
      reducedMotion: rmRef.current,
    });
    engine.current = halo;
    let timer = 0;
    const refit = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => halo.refit(), 80);
    };
    const ro = new ResizeObserver(refit);
    ro.observe(canvas.parentElement ?? canvas);
    let alive = true;
    document.fonts?.ready.then(() => {
      if (alive) halo.refit();
    });
    return () => {
      alive = false;
      window.clearTimeout(timer);
      ro.disconnect();
      halo.destroy();
      engine.current = null;
    };
  }, [pitch, gain]);

  useEffect(() => {
    engine.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion]);

  useEffect(() => {
    engine.current?.setLift(lift);
  }, [lift]);

  const firstRipple = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: rippleKey is the trigger
  useEffect(() => {
    if (firstRipple.current) {
      firstRipple.current = false;
      return;
    }
    engine.current?.ripple();
  }, [rippleKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refitKey is the trigger
  useEffect(() => {
    engine.current?.refit();
  }, [refitKey]);

  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a canvas without tabindex is not focusable; it is decorative
    <canvas
      ref={ref}
      className={[s.halo, className].filter(Boolean).join(' ')}
      aria-hidden="true"
    />
  );
}
