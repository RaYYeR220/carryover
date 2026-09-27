/**
 * The glyph ring: six segmented light strips around the LED screen, as SVG
 * path data for a w×h box. Order: top-left, top-right + corner, right,
 * bottom-right, bottom-left + corner, left.
 */
export type RingState = 'off' | 'on' | 'red' | 'dim';

export const RING_SEGMENTS = 6;

export function glyphRingPaths(w: number, h: number): string[] {
  if (w < 20 || h < 20) return [];
  const m = 4;
  const rr = 14;
  const L = m;
  const T = m;
  const R = w - m;
  const B = h - m;
  const gx = R - L;
  const gy = B - T;
  const n = (v: number) => Math.round(v * 100) / 100;
  return [
    `M ${n(L + rr + 10)} ${n(T)} H ${n(L + gx * 0.44)}`,
    `M ${n(L + gx * 0.44 + 14)} ${n(T)} H ${n(R - rr)} A ${rr} ${rr} 0 0 1 ${n(R)} ${n(T + rr)} V ${n(T + gy * 0.42)}`,
    `M ${n(R)} ${n(T + gy * 0.42 + 14)} V ${n(B - rr - 8)}`,
    `M ${n(R - rr - 8)} ${n(B)} H ${n(L + gx * 0.56)}`,
    `M ${n(L + gx * 0.56 - 14)} ${n(B)} H ${n(L + rr)} A ${rr} ${rr} 0 0 1 ${n(L)} ${n(B - rr)} V ${n(T + gy * 0.58)}`,
    `M ${n(L)} ${n(T + gy * 0.58 - 14)} V ${n(T + rr + 10)}`,
  ];
}
