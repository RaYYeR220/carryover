import { fmtClock } from '../lib/format';
import { type Bitmap, LedFrame, regions } from './frame';
import { handsetBitmap } from './handset';
import * as scenes from './scenes';

export type LedScene = 'dial' | 'menu' | 'hold' | 'flash' | 'live' | 'ask' | 'end' | 'idle';

export interface LedSceneData {
  /** Label for live/flash, e.g. "DANA" or "YOU". Uppercased; default "LIVE". */
  name?: string;
  /** Menu: the key(s) just pressed. Absent = still listening to the menu. */
  key?: string;
  /** Hold: seconds on hold so far; the LED keeps counting from here. */
  seconds?: number;
  /** Live: speaking level 0..1 (same as setLevel). */
  level?: number;
}

export interface LedOptions {
  /** Matrix size in dots; the dot pitch is fitted to the canvas' CSS size. */
  cols: number;
  rows: number;
  reducedMotion: boolean;
  /** Lit dot radius as a fraction of the pitch. Default 0.36. */
  dotRadius?: number;
  /** Unlit dot colour. Default #1A1A1A (`--led-off`). */
  offColor?: string;
}

type Sprites = [HTMLCanvasElement[], HTMLCanvasElement[]];

const RISE = 0.62;
const FALL = 0.3;
const LEVELS = 16;

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const DPR = () => Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, w);
  cv.height = Math.max(1, h);
  return cv;
}

/**
 * The LED dot-matrix screen. Owns its animation loop: set a scene and a level,
 * and it draws itself until `destroy()`. Dots rise fast (0.62/frame) and fall
 * slower (0.3/frame) like PWM persistence; reduced motion draws instantly and
 * never flashes.
 */
export class Led {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly opts: Required<Omit<LedOptions, 'cols' | 'rows' | 'reducedMotion'>>;
  private reducedMotion: boolean;

  private frame: LedFrame;
  private shown = new Float32Array(0);
  private shownColour = new Uint8Array(0);
  private sprites: Sprites | null = null;
  private spriteSize = 0;
  private base: HTMLCanvasElement | null = null;
  private pitch = 0;
  private ox = 0;
  private oy = 0;
  private dpr = 1;
  private ok = false;
  private readonly handCache = new Map<string, Bitmap | null>();

  private scene: LedScene = 'idle';
  private sceneAt = nowMs();
  private key: string | undefined;
  private keyAt = nowMs();
  private name: string | undefined;
  private holdBase = 0;
  private holdAt = nowMs();
  private level = 0;
  private levelShown = 0;

  private raf = 0;
  private visible = true;
  private destroyed = false;
  private io: IntersectionObserver | null = null;

  constructor(canvas: HTMLCanvasElement, opts: LedOptions) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = { dotRadius: opts.dotRadius ?? 0.36, offColor: opts.offColor ?? '#1A1A1A' };
    this.reducedMotion = opts.reducedMotion;
    this.frame = new LedFrame(opts.cols, opts.rows);
    this.refit();
    if (typeof IntersectionObserver !== 'undefined') {
      this.io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) this.visible = e.isIntersecting;
        },
        { rootMargin: '80px' },
      );
      this.io.observe(canvas);
    }
    if (this.ctx && typeof requestAnimationFrame !== 'undefined') {
      this.raf = requestAnimationFrame(this.loop);
    }
  }

  setScene(s: LedScene, data: LedSceneData = {}): void {
    const t = nowMs();
    const changed = s !== this.scene;
    if (changed) {
      this.scene = s;
      this.sceneAt = t;
    }
    this.name = data.name?.toUpperCase();
    if (s === 'menu') {
      if (data.key !== this.key || changed) this.keyAt = t;
      this.key = data.key || undefined;
    } else {
      this.key = undefined;
    }
    if (s === 'hold') {
      this.holdBase = Math.max(0, data.seconds ?? (changed ? 0 : this.holdSeconds(t)));
      this.holdAt = t;
    }
    if (data.level != null) this.setLevel(data.level);
    if (this.reducedMotion) this.render(t, true);
  }

  /** Speaking level 0..1 for the live waveform. */
  setLevel(level: number): void {
    this.level = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
  }

  setReducedMotion(rm: boolean): void {
    this.reducedMotion = rm;
  }

  /** Change the matrix size (e.g. the screen was resized), keeping the scene. */
  resize(cols: number, rows: number): void {
    this.frame = new LedFrame(cols, rows);
    this.refit();
  }

  /** Re-measure the canvas and rebuild the dot sprites. Call after layout changes. */
  refit(): void {
    const b = this.canvas.getBoundingClientRect();
    const { cols, rows } = this.frame;
    const n = cols * rows;
    this.shown = new Float32Array(n);
    this.shownColour = new Uint8Array(n);
    this.handCache.clear();
    if (!this.ctx || b.width < 8 || b.height < 8 || cols < 1 || rows < 1) {
      this.ok = false;
      return;
    }
    this.dpr = DPR();
    this.pitch = Math.min(b.width / cols, b.height / rows);
    this.ox = (b.width - cols * this.pitch) / 2;
    this.oy = (b.height - rows * this.pitch) / 2;
    this.canvas.width = Math.round(b.width * this.dpr);
    this.canvas.height = Math.round(b.height * this.dpr);
    this.buildSprites();
    this.buildBase();
    this.ok = true;
    this.render(nowMs(), true);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.raf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.io?.disconnect();
    this.io = null;
    this.sprites = null;
    this.base = null;
    this.handCache.clear();
  }

  /* ---------- internals ---------- */

  private holdSeconds(t: number): number {
    return this.holdBase + (t - this.holdAt) / 1000;
  }

  private hand = (w: number, h: number, ang: number): Bitmap | null => {
    const k = `${w}x${h}@${ang}`;
    if (!this.handCache.has(k)) this.handCache.set(k, handsetBitmap(w, h, ang));
    return this.handCache.get(k) ?? null;
  };

  private buildSprites(): void {
    const p = this.pitch * this.dpr;
    const r = p * this.opts.dotRadius;
    const S = Math.ceil(p * 2.4);
    this.spriteSize = S;
    const sprites: Sprites = [[], []];
    for (let col = 0; col < 2; col++) {
      for (let l = 0; l <= LEVELS; l++) {
        const b = l / LEVELS;
        const cv = makeCanvas(S, S);
        const x = cv.getContext('2d');
        if (x) {
          const m = S / 2;
          if (b > 0.55) {
            const gr = x.createRadialGradient(m, m, r * 0.5, m, m, S / 2);
            const a = (b - 0.55) * 0.5;
            gr.addColorStop(0, col ? `rgba(255,50,56,${a})` : `rgba(255,255,255,${a})`);
            gr.addColorStop(1, 'rgba(0,0,0,0)');
            x.fillStyle = gr;
            x.fillRect(0, 0, S, S);
          }
          const rgb = col
            ? [40 + b * 215, 24 + b * 26, 28 + b * 30]
            : [34 + b * 221, 34 + b * 221, 34 + b * 221];
          x.fillStyle = `rgb(${rgb.map(Math.round).join(',')})`;
          x.beginPath();
          x.arc(m, m, r, 0, Math.PI * 2);
          x.fill();
        }
        sprites[col]?.push(cv);
      }
    }
    this.sprites = sprites;
  }

  private buildBase(): void {
    const cv = makeCanvas(this.canvas.width, this.canvas.height);
    const x = cv.getContext('2d');
    if (x) {
      const p = this.pitch * this.dpr;
      const r = p * this.opts.dotRadius * 0.86;
      const ox = this.ox * this.dpr;
      const oy = this.oy * this.dpr;
      x.fillStyle = this.opts.offColor;
      for (let y = 0; y < this.frame.rows; y++) {
        for (let i = 0; i < this.frame.cols; i++) {
          x.beginPath();
          x.arc(ox + (i + 0.5) * p, oy + (y + 0.5) * p, r, 0, Math.PI * 2);
          x.fill();
        }
      }
    }
    this.base = cv;
  }

  private loop = (t: number): void => {
    if (this.destroyed) return;
    if (this.visible) this.render(t, this.reducedMotion);
    this.raf = requestAnimationFrame(this.loop);
  };

  private compose(t: number): void {
    const m = this.frame;
    m.clear();
    const L = regions(m);
    const rm = this.reducedMotion;
    // Ease the waveform level so speech starts and stops smoothly.
    const target = this.level;
    this.levelShown += (target - this.levelShown) * (target > this.levelShown ? 0.35 : 0.08);
    const ctx: scenes.SceneCtx = { now: t / 1000, reducedMotion: rm, hand: this.hand };
    const since = (t - this.sceneAt) / 1000;
    const who = this.name || 'LIVE';
    switch (this.scene) {
      case 'dial':
        scenes.dial(m, L, ctx);
        break;
      case 'menu':
        scenes.menu(m, L, ctx, { key: this.key, since, keySince: (t - this.keyAt) / 1000 });
        break;
      case 'hold':
        scenes.hold(m, L, ctx, { clock: fmtClock(this.holdSeconds(t)) });
        break;
      case 'flash':
        scenes.flash(m, L, ctx, { since, who, level: this.levelShown });
        break;
      case 'live':
        scenes.live(m, L, ctx, {
          who,
          level: this.levelShown,
          seed: who === 'YOU' ? 3.1 : 1.7,
        });
        break;
      case 'ask':
        scenes.ask(m, L, ctx);
        break;
      case 'end':
        scenes.end(m, L, ctx);
        break;
      default:
        scenes.idle(m, L, ctx);
    }
  }

  private render(t: number, instant: boolean): void {
    const x = this.ctx;
    if (!this.ok || !x || !this.sprites || !this.base) return;
    this.compose(t);
    const { v, c, cols } = this.frame;
    const p = this.pitch * this.dpr;
    const ox = this.ox * this.dpr;
    const oy = this.oy * this.dpr;
    const half = this.spriteSize / 2;
    x.clearRect(0, 0, this.canvas.width, this.canvas.height);
    x.drawImage(this.base, 0, 0);
    for (let i = 0; i < v.length; i++) {
      const target = v[i] as number;
      const cur = this.shown[i] as number;
      const b = instant ? target : cur + (target - cur) * (target > cur ? RISE : FALL);
      if (target >= cur) this.shownColour[i] = c[i] as number;
      this.shown[i] = b;
      if (b < 0.03) continue;
      const spr =
        this.sprites[this.shownColour[i] ? 1 : 0][Math.min(LEVELS, Math.round(b * LEVELS))];
      if (!spr) continue;
      x.drawImage(
        spr,
        ox + ((i % cols) + 0.5) * p - half,
        oy + (((i / cols) | 0) + 0.5) * p - half,
      );
    }
  }
}
