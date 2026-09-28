import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { glyphRingPaths, RING_SEGMENTS, type RingState } from '../led/glyphRing';
import { Led, type LedScene, type LedSceneData } from '../led/led';
import s from './LedMatrix.module.css';
import { useReducedMotion } from './useReducedMotion';

export interface LedMatrixProps {
  scene: LedScene;
  data?: LedSceneData;
  /** Speaking level 0..1 for the live waveform. */
  level?: number;
  /** CSS px per dot. Default 6.5 (call screen); the landing hero uses 7. */
  pitch?: number;
  /** Pitch at or below `breakpoint` px viewport width. Default 5. */
  narrowPitch?: number;
  breakpoint?: number;
  /** Glyph ring around the screen: one state for all six segments, or one per segment. */
  ring?: RingState | readonly RingState[];
  /** Apply the call screen's ≤ 820 px mobile bar styling (tight inset, no ring). */
  responsive?: boolean;
  className?: string;
  style?: CSSProperties;
}

function ringStates(ring: RingState | readonly RingState[]): RingState[] {
  if (typeof ring === 'string') return new Array<RingState>(RING_SEGMENTS).fill(ring);
  return Array.from({ length: RING_SEGMENTS }, (_, i) => ring[i] ?? 'off');
}

/**
 * The dot-matrix LED screen. Size it with CSS (height); the matrix fits as many
 * dots as the pitch allows and redraws on resize. Decorative: describe the
 * call state in text next to it.
 */
export function LedMatrix({
  scene,
  data,
  level = 0,
  pitch = 6.5,
  narrowPitch = 5,
  breakpoint = 820,
  ring,
  responsive,
  className,
  style,
}: LedMatrixProps) {
  const screenRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ledRef = useRef<Led | null>(null);
  const reducedMotion = useReducedMotion();
  const [box, setBox] = useState({ w: 0, h: 0 });

  // Latest props for the mount effect.
  const latest = useRef({ scene, data, level, reducedMotion });
  latest.current = { scene, data, level, reducedMotion };

  useEffect(() => {
    const canvas = canvasRef.current;
    const screen = screenRef.current;
    if (!canvas || !screen) return;
    const size = () => {
      const b = canvas.getBoundingClientRect();
      const p = window.innerWidth <= breakpoint ? narrowPitch : pitch;
      return { cols: Math.floor(b.width / p), rows: Math.floor(b.height / p) };
    };
    const first = size();
    const led = new Led(canvas, { ...first, reducedMotion: latest.current.reducedMotion });
    led.setScene(latest.current.scene, latest.current.data);
    led.setLevel(latest.current.level);
    ledRef.current = led;
    let dims = first;

    const refit = () => {
      const next = size();
      if (next.cols !== dims.cols || next.rows !== dims.rows) {
        dims = next;
        led.resize(next.cols, next.rows);
      } else led.refit();
      const r = screen.getBoundingClientRect();
      setBox((old) =>
        old.w === r.width && old.h === r.height ? old : { w: r.width, h: r.height },
      );
    };
    const ro = new ResizeObserver(refit);
    ro.observe(screen);
    refit();
    return () => {
      ro.disconnect();
      led.destroy();
      ledRef.current = null;
    };
  }, [pitch, narrowPitch, breakpoint]);

  const dataKey = JSON.stringify(data ?? {});
  // biome-ignore lint/correctness/useExhaustiveDependencies: dataKey stands in for data's contents
  useEffect(() => {
    ledRef.current?.setScene(scene, data);
  }, [scene, dataKey]);

  useEffect(() => {
    ledRef.current?.setLevel(level);
  }, [level]);

  useEffect(() => {
    ledRef.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion]);

  const paths = ring != null ? glyphRingPaths(box.w, box.h) : [];
  const states = ring != null ? ringStates(ring) : [];

  return (
    <div
      ref={screenRef}
      className={[s.screen, responsive && s.responsive, className].filter(Boolean).join(' ')}
      style={style}
    >
      {ring != null && (
        <svg className={s.ring} aria-hidden="true" focusable="false">
          {paths.map((d, i) => (
            <path key={d} d={d} className={s.seg} data-s={states[i]} />
          ))}
        </svg>
      )}
      {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: a canvas without tabindex is not focusable; it is decorative */}
      <canvas ref={canvasRef} className={s.led} aria-hidden="true" />
    </div>
  );
}
