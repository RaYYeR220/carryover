import { GLYPH_ADVANCE, GLYPH_H, GLYPH_W, glyphBits, textWidth } from './font';

/** A greyscale bitmap in dots, 0..1 per dot (0 = unlit). */
export interface Bitmap {
  w: number;
  h: number;
  d: Float32Array;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WaveBox {
  x0: number;
  x1: number;
  cy: number;
  amp: number;
}

/** Colour channel per dot: 0 = white, 1 = signal red. */
export type DotColour = 0 | 1;

/**
 * The target brightness of every dot for one frame. Scenes draw into it; the
 * renderer eases the visible dots towards it.
 */
export class LedFrame {
  readonly cols: number;
  readonly rows: number;
  readonly v: Float32Array;
  readonly c: Uint8Array;

  constructor(cols: number, rows: number) {
    this.cols = Math.max(0, Math.floor(cols));
    this.rows = Math.max(0, Math.floor(rows));
    this.v = new Float32Array(this.cols * this.rows);
    this.c = new Uint8Array(this.cols * this.rows);
  }

  clear(): void {
    this.v.fill(0);
    this.c.fill(0);
  }

  /** Light a dot; the brightest write in a frame wins. */
  set(x: number, y: number, v: number, c: DotColour = 0): void {
    const xi = x | 0;
    const yi = y | 0;
    if (xi < 0 || yi < 0 || xi >= this.cols || yi >= this.rows) return;
    const i = yi * this.cols + xi;
    if (v > (this.v[i] as number)) {
      this.v[i] = v;
      this.c[i] = c;
    }
  }

  fill(v = 1, c: DotColour = 0): void {
    this.v.fill(v);
    this.c.fill(c);
  }

  text(s: string, x0: number, y0: number, v = 1, c: DotColour = 0, sc = 1): void {
    let x = x0 | 0;
    for (const ch of s) {
      const g = glyphBits(ch);
      for (let i = 0; i < GLYPH_W * GLYPH_H; i++) {
        if (g.charCodeAt(i) !== 49) continue;
        const gx = x + (i % GLYPH_W) * sc;
        const gy = y0 + ((i / GLYPH_W) | 0) * sc;
        for (let a = 0; a < sc; a++) for (let b = 0; b < sc; b++) this.set(gx + a, gy + b, v, c);
      }
      x += GLYPH_ADVANCE * sc;
    }
  }

  blit(bm: Bitmap, x0: number, y0: number, gain = 1): void {
    for (let y = 0; y < bm.h; y++) {
      for (let x = 0; x < bm.w; x++) {
        const v = bm.d[y * bm.w + x] as number;
        if (v) this.set(x0 + x, y0 + y, v * gain);
      }
    }
  }

  /** A symmetric dotted waveform: `f(x)` is the half-height at column x. */
  wave(W: WaveBox, f: (x: number) => number, step = 2): void {
    for (let x = W.x0; x <= W.x1; x += step) {
      const edge = Math.min(1, (x - W.x0) / 5, (W.x1 - x) / 5);
      const a = Math.max(0, Math.min(W.amp, f(x) * edge));
      for (let y = Math.round(W.cy - a); y <= Math.round(W.cy + a); y++) {
        this.set(x, y, 1 - (Math.abs(y - W.cy) / (a + 2)) * 0.55);
      }
    }
  }
}

export type Layout =
  | { mode: 'strip'; C: number; R: number; icon?: undefined }
  | { mode: 'wide' | 'tall'; C: number; R: number; icon: Box };

/**
 * Split a matrix into an icon area, a wave and a label:
 * strip (< 16 rows, the mobile bar), wide (≥ 1.6:1, icon left) or tall (icon on top).
 */
export function regions(m: Pick<LedFrame, 'cols' | 'rows'>): Layout {
  const C = m.cols;
  const R = m.rows;
  if (R < 16) return { mode: 'strip', C, R };
  if (C / R >= 1.6) {
    const iw = Math.min(Math.round(C * 0.4), Math.round((R - 2) * 2.6));
    return { mode: 'wide', C, R, icon: { x: 2, y: 1, w: iw, h: R - 2 } };
  }
  const ih = Math.max(8, Math.round((R - 10) * 0.62));
  return { mode: 'tall', C, R, icon: { x: 1, y: 1, w: C - 2, h: ih } };
}

/** Drop trailing characters until the label fits its slot. */
export function fitLabel(L: Layout, s: string): string {
  const max =
    L.mode === 'tall' ? L.C - 2 : L.mode === 'wide' ? L.C - (L.icon.x + L.icon.w) - 8 : L.C - 14;
  let out = s;
  while (out.length > 1 && textWidth(out) > max) out = out.slice(0, -1);
  return out.trimEnd();
}

export function labelAt(m: LedFrame, L: Layout, s: string, v = 1, c: DotColour = 0): void {
  const w = textWidth(s);
  if (L.mode === 'tall') m.text(s, Math.round((L.C - w) / 2), L.R - 8, v, c);
  else m.text(s, L.C - w - 2, Math.round((L.R - 7) / 2), v, c);
}

/** Where the waveform goes, given the label width `lw`. */
export function waveBox(L: Layout, lw: number): WaveBox {
  if (L.mode === 'tall') {
    const top = L.icon.y + L.icon.h + 1;
    const bot = L.R - 10;
    return {
      x0: 2,
      x1: L.C - 3,
      cy: Math.round((top + bot) / 2),
      amp: Math.max(1, (bot - top) / 2),
    };
  }
  if (L.mode === 'wide') {
    return {
      x0: L.icon.x + L.icon.w + 4,
      x1: L.C - lw - 6,
      cy: Math.round((L.R - 1) / 2),
      amp: (L.R - 6) / 2,
    };
  }
  return { x0: 1, x1: L.C - lw - 5, cy: Math.round((L.R - 1) / 2), amp: (L.R - 3) / 2 };
}
