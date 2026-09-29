import { textWidth } from './font';
import {
  type Bitmap,
  type Box,
  fitLabel,
  type Layout,
  type LedFrame,
  labelAt,
  waveBox,
} from './frame';

/**
 * The LED scenes from Glyph Night, one function per call state. Each draws
 * one frame into `m`. Timing: `now` is absolute seconds (idle motion), `since`
 * is seconds since the scene (or key press) began. With reduced motion every
 * blink and flash holds steady.
 */
export interface SceneCtx {
  now: number;
  reducedMotion: boolean;
  hand(w: number, h: number, ang: number): Bitmap | null;
}

function drawHand(m: LedFrame, L: Layout, lifted: boolean, gain: number, ctx: SceneCtx): void {
  if (!L.icon) return;
  const b = L.icon;
  const lift = b.w < 34 ? false : lifted;
  const ratio = lift ? 2.55 : 3.3;
  const w = Math.min(b.w, Math.round(b.h * ratio));
  const h = Math.min(b.h, Math.round(w / ratio));
  const bm = ctx.hand(w, h, lift ? -0.16 : 0);
  if (!bm) return;
  m.blit(
    bm,
    b.x + Math.round((b.w - w) / 2),
    b.y + Math.round((b.h - h) / 2) - (lift ? 1 : 0),
    gain,
  );
}

/** Speech-like envelope used for voices on the line. */
export function speech(x: number, t: number, seed: number): number {
  const u = t * 7 + x * 0.35;
  return Math.max(0, Math.sin(u + seed) * Math.sin(u * 0.37 + seed * 2) + Math.sin(u * 1.9) * 0.35);
}

function redCorner(m: LedFrame): void {
  m.set(0, 0, 1, 1);
  m.set(1, 0, 1, 1);
  m.set(0, 1, 1, 1);
  m.set(1, 1, 1, 1);
}

const KEYS = '123456789*0#';

function keypad(m: LedFrame, box: Box, digits: string, pressed: boolean, since: number): void {
  const shown = digits.slice(-1);
  if (box.h >= 18) {
    const withD = box.w >= 31 && shown !== '';
    const tw = withD ? 13 + 6 + 10 : 13;
    const x0 = box.x + Math.floor((box.w - tw) / 2);
    const y0 = box.y + Math.floor((box.h - 18) / 2);
    for (let k = 0; k < 12; k++) {
      const kx = x0 + (k % 3) * 5;
      const ky = y0 + Math.floor(k / 3) * 5;
      const lit = pressed && digits.includes(KEYS[k] as string);
      const v = lit ? (since < 0.45 ? 1 : 0.92) : 0.2;
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m.set(kx + i, ky + j, v);
    }
    if (withD) m.text(shown, x0 + 19, y0 + 2, pressed ? 1 : 0.22, 0, 2);
  } else if (shown) {
    const sc = box.h >= 14 ? 2 : 1;
    m.text(
      shown,
      box.x + Math.floor((box.w - 5 * sc) / 2),
      box.y + Math.floor((box.h - 7 * sc) / 2),
      pressed ? 1 : 0.25,
      0,
      sc,
    );
  }
}

export interface MenuParams {
  key?: string;
  since: number;
  keySince: number;
}
export interface HoldParams {
  clock: string;
}
export interface LiveParams {
  who: string;
  level: number;
  seed: number;
}
export interface FlashParams {
  since: number;
  who: string;
  level: number;
}

export function dial(m: LedFrame, L: Layout, ctx: SceneCtx): void {
  const t = ctx.now;
  // "CALL", not "CALLING": at the call screen's and hero's tall-mode widths,
  // "CALLING" is one dot too wide and fitLabel chops it to "CALLIN".
  const lab = fitLabel(L, 'CALL');
  drawHand(m, L, true, 0.9, ctx);
  const W = waveBox(L, textWidth(lab));
  m.wave(W, (x) => (Math.sin(t * 6 - x * 0.5) > 0.6 ? W.amp * 0.5 : 0));
  labelAt(m, L, lab, ctx.reducedMotion || Math.floor(t * 2) % 2 === 0 ? 1 : 0.55);
}

export function menu(m: LedFrame, L: Layout, ctx: SceneCtx, p: MenuParams): void {
  const pressed = !!p.key;
  const since = p.keySince;
  // No space before the digit ("KEY2", not "KEY 2"): at the hero's narrow
  // wide-mode width, the space pushed "KEY 2" one dot over budget and
  // fitLabel dropped the digit, hiding which key was pressed.
  const lab = fitLabel(L, pressed ? `KEY${p.key}` : 'MENU');
  const digits = p.key ?? '';
  if (L.mode === 'tall') keypad(m, { x: 1, y: 1, w: L.C - 2, h: L.R - 11 }, digits, pressed, since);
  else if (L.mode === 'wide') keypad(m, L.icon, digits, pressed, since);
  if (L.mode !== 'tall') {
    const W = waveBox(L, textWidth(lab));
    const beep = pressed && since < 0.7;
    m.wave(W, (x) =>
      beep
        ? W.amp * (0.75 + 0.25 * Math.sin(x * 1.3))
        : !pressed
          ? speech(x, p.since, 1.3) * W.amp * 0.55
          : 0,
    );
  }
  const blink = pressed && since < 0.6 && !ctx.reducedMotion;
  labelAt(m, L, lab, blink && Math.floor(since * 6) % 2 === 1 ? 0.45 : 1);
}

export function hold(m: LedFrame, L: Layout, ctx: SceneCtx, p: HoldParams): void {
  const t = ctx.now;
  const alt = Math.floor(t / 2.4) % 2 === 1;
  // "HOLD", not "ON HOLD": at the hero's tall-mode width, "ON HOLD" is one
  // dot too wide and fitLabel chops it to "ON HOL".
  const onHold = fitLabel(L, 'HOLD');
  const lab = alt ? p.clock : onHold;
  const lw = Math.max(textWidth(onHold), textWidth(p.clock || '0:00'));
  drawHand(m, L, false, 0.85, ctx);
  const W = waveBox(L, lw);
  m.wave(
    W,
    (x) =>
      W.amp *
      (0.16 + (0.14 * (1 + Math.sin(t * 1.7 + x * 0.32))) / 2 + 0.1 * Math.sin(x * 0.9 + t)),
  );
  labelAt(m, L, lab, 0.92);
}

export function live(m: LedFrame, L: Layout, ctx: SceneCtx, p: LiveParams): void {
  const t = ctx.now;
  const lab = fitLabel(L, p.who || 'LIVE');
  drawHand(m, L, true, 0.95, ctx);
  const W = waveBox(L, textWidth(lab));
  const lv = Math.max(0, Math.min(1, p.level));
  m.wave(W, (x) => {
    const quiet = W.amp * 0.06;
    if (lv <= 0.001) return quiet;
    const loud =
      (1 + speech(x, t, p.seed) * 7.5 * (0.6 + 0.4 * Math.sin(t * 3 + x * 0.2))) * (W.amp / 8.5);
    return quiet + (loud - quiet) * lv;
  });
  labelAt(m, L, lab, 1);
  if (ctx.reducedMotion || Math.floor(t * 1.25) % 2 === 0) redCorner(m);
}

/** Pickup: the whole field flashes white 3× in 1.2 s (2.5 Hz), then shows live. None with reduced motion. */
export function flash(m: LedFrame, L: Layout, ctx: SceneCtx, p: FlashParams): void {
  const k = Math.floor(p.since / 0.2);
  if (!ctx.reducedMotion && k < 6 && k % 2 === 0) {
    m.fill(1, 0);
    return;
  }
  live(m, L, ctx, { who: p.who, level: p.level, seed: 1.7 });
}

export function ask(m: LedFrame, L: Layout, ctx: SceneCtx): void {
  const t = ctx.now;
  // "ASK", not "ASKING": at the hero's narrow wide-mode width, "ASKING" is
  // too wide and fitLabel chops it to "ASKI".
  const lab = fitLabel(L, 'ASK');
  const pulse = ctx.reducedMotion ? 1 : 0.55 + (0.45 * (1 + Math.sin(t * 2.6))) / 2;
  const box = L.mode === 'tall' ? { x: 1, y: 1, w: L.C - 2, h: L.R - 11 } : L.icon;
  if (box) {
    const sc = Math.max(1, Math.min(3, Math.floor(box.h / 8)));
    m.text(
      '?',
      box.x + Math.floor((box.w - 5 * sc) / 2),
      box.y + Math.floor((box.h - 7 * sc) / 2),
      pulse,
      0,
      sc,
    );
  }
  if (L.mode !== 'tall') m.wave(waveBox(L, textWidth(lab)), () => 0);
  labelAt(m, L, lab, 1);
  if (ctx.reducedMotion || Math.floor(t * 1.5) % 2 === 0) redCorner(m);
}

export function end(m: LedFrame, L: Layout, ctx: SceneCtx): void {
  // "END", not "ENDED": at the hero's narrow wide-mode width, "ENDED" is
  // too wide and fitLabel chops it to "ENDE".
  const lab = fitLabel(L, 'END');
  drawHand(m, L, false, 0.35, ctx);
  m.wave(waveBox(L, textWidth(lab)), () => 0);
  labelAt(m, L, lab, 0.6);
}

/** Before a call: the handset resting, a flat line, no label. */
export function idle(m: LedFrame, L: Layout, ctx: SceneCtx): void {
  drawHand(m, L, false, 0.5, ctx);
  m.wave(waveBox(L, 0), () => 0);
}
