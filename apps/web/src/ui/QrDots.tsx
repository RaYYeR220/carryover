import { type CSSProperties, useEffect, useMemo, useRef } from 'react';
import { qrMatrix } from '../led/qr';

export interface QrDotsProps {
  /** What the code opens, usually the practice-line URL. */
  text: string;
  /** Accessible description, e.g. "QR code that opens the practice line on your phone". */
  label: string;
  ink?: string;
  bg?: string;
  className?: string;
  style?: CSSProperties;
}

const QUIET = 2;
const PX = 10;

function roundRect(x: CanvasRenderingContext2D, X: number, Y: number, W: number, R: number) {
  x.beginPath();
  if (typeof x.roundRect === 'function') x.roundRect(X, Y, W, W, R);
  else x.rect(X, Y, W, W);
  x.fill();
}

/** A real, scannable QR code drawn in dots with rounded finder squares. */
export function QrDots({
  text,
  label,
  ink = '#000',
  bg = '#F4F4F4',
  className,
  style,
}: QrDotsProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const matrix = useMemo(() => {
    try {
      return qrMatrix(text);
    } catch {
      return null;
    }
  }, [text]);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !matrix) return;
    const N = matrix.length;
    const S = (N + QUIET * 2) * PX;
    const dpr = Math.max(2, Math.min(3, window.devicePixelRatio || 1));
    cv.width = S * dpr;
    cv.height = S * dpr;
    const x = cv.getContext('2d');
    if (!x) return;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.fillStyle = bg;
    x.fillRect(0, 0, S, S);
    const inFinder = (c: number, r: number) =>
      (c < 7 && r < 7) || (c >= N - 7 && r < 7) || (c < 7 && r >= N - 7);
    x.fillStyle = ink;
    matrix.forEach((row, r) => {
      row.forEach((dark, c) => {
        if (!dark || inFinder(c, r)) return;
        x.beginPath();
        x.arc((c + QUIET + 0.5) * PX, (r + QUIET + 0.5) * PX, PX * 0.54, 0, Math.PI * 2);
        x.fill();
      });
    });
    for (const [c, r] of [
      [0, 0],
      [N - 7, 0],
      [0, N - 7],
    ] as const) {
      const X = (c + QUIET) * PX;
      const Y = (r + QUIET) * PX;
      x.fillStyle = ink;
      roundRect(x, X, Y, 7 * PX, 2.2 * PX);
      x.fillStyle = bg;
      roundRect(x, X + PX, Y + PX, 5 * PX, 1.5 * PX);
      x.fillStyle = ink;
      roundRect(x, X + 2 * PX, Y + 2 * PX, 3 * PX, PX);
    }
  }, [matrix, ink, bg]);

  return (
    <canvas
      ref={ref}
      className={className}
      style={{ aspectRatio: '1', ...style }}
      role="img"
      aria-label={label}
      data-qr={matrix ? matrix.length : 0}
    />
  );
}
