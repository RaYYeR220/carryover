/**
 * The dot halo: a field of dots behind a dark stage that glows around an
 * anchor rectangle (the device card), with an optional dome, a text-safe fade
 * above `safeY`, quiet zones around links, a 9 s breath, ±8% twinkle, and a
 * red ripple on pickup. Reduced motion draws one still frame and never ripples.
 */

export interface HaloRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HaloAnchor {
  /** Where the light comes from, relative to the canvas box. Dots inside it are hidden. */
  rect: HaloRect;
  /** Falloff distance in px. Default 120. */
  lambda?: number;
  /** Ripple origin y; default the top of `rect`. */
  cy?: number;
  /** Dots fade out above this y (keeps headlines readable). */
  safeY?: number;
  /** Rectangles kept dim (around text links). */
  quiet?: HaloRect[];
  /** An extra elliptical dome of light. */
  ell?: { cx: number; cy: number; rx: number; ry: number; p?: number; k?: number };
}

export interface HaloOptions {
  /** Dot spacing in CSS px. Default 13. */
  pitch?: number;
  /** Overall brightness. Default 0.8. */
  gain?: number;
  reducedMotion: boolean;
}

type Sprites = [HTMLCanvasElement[], HTMLCanvasElement[]];

const RIPPLE_MS = 2600;
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const DPR = () => Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);

export class Halo {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly anchor: (box: DOMRect) => HaloAnchor;
  private readonly pitch: number;
  private readonly gain: number;
  private reducedMotion: boolean;

  private dpr = 1;
  private cols = 0;
  private rows = 0;
  private ox = 0;
  private oy = 0;
  private st = new Float32Array(0);
  private dd = new Float32Array(0);
  private ph = new Float32Array(0);
  private hide = new Uint8Array(0);
  private sf = new Float32Array(0);
  private maxD = 0;
  private sprites: Sprites | null = null;
  private base: HTMLCanvasElement | null = null;

  private rippleAt = -1e9;
  private lift = 0;
  private raf = 0;
  private visible = true;
  private destroyed = false;
  private io: IntersectionObserver | null = null;

  constructor(canvas: HTMLCanvasElement, anchor: (box: DOMRect) => HaloAnchor, opts: HaloOptions) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.anchor = anchor;
    this.pitch = opts.pitch ?? 13;
    this.gain = opts.gain ?? 0.8;
    this.reducedMotion = opts.reducedMotion;
    if (typeof IntersectionObserver !== 'undefined') {
      this.io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) this.visible = e.isIntersecting;
        },
        { rootMargin: '80px' },
      );
      this.io.observe(canvas);
    }
    this.refit();
    this.schedule();
  }

  /** Recompute the field from the canvas size and the anchor. Call after layout changes. */
  refit(): void {
    const b = this.canvas.getBoundingClientRect();
    if (!this.ctx || b.width < 8 || b.height < 8) return;
    const dpr = DPR();
    const p = this.pitch;
    this.dpr = dpr;
    this.canvas.width = Math.round(b.width * dpr);
    this.canvas.height = Math.round(b.height * dpr);
    this.cols = Math.ceil(b.width / p) + 1;
    this.rows = Math.ceil(b.height / p) + 1;
    this.ox = (b.width - (this.cols - 1) * p) / 2;
    this.oy = (b.height - (this.rows - 1) * p) / 2;

    const A = this.anchor(b);
    const n = this.cols * this.rows;
    const Rc = A.rect;
    const lam = A.lambda || 120;
    const cx = Rc.x + Rc.w / 2;
    const cy = A.cy ?? Rc.y;
    this.st = new Float32Array(n);
    this.dd = new Float32Array(n);
    this.ph = new Float32Array(n);
    this.hide = new Uint8Array(n);
    this.sf = new Float32Array(n).fill(1);
    let maxD = 0;
    const smooth = (a: number, b2: number, v: number) => {
      const t = Math.max(0, Math.min(1, (v - a) / (b2 - a)));
      return t * t * (3 - 2 * t);
    };
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const i = y * this.cols + x;
        const px = this.ox + x * p;
        const py = this.oy + y * p;
        const dx = Math.max(Rc.x - px, 0, px - (Rc.x + Rc.w));
        const dy = Math.max(Rc.y - py, 0, py - (Rc.y + Rc.h));
        const d = Math.hypot(dx, dy);
        if (d === 0 && px > Rc.x + 8 && px < Rc.x + Rc.w - 8 && py > Rc.y + 8) {
          this.hide[i] = 1;
          continue;
        }
        const lat = Math.min(1, Math.abs(px - cx) / (Rc.w * 0.62 + lam));
        const cw = 1 - 0.6 * lat * lat;
        let v =
          Math.exp(-d / lam) * cw * (py < Rc.y ? 1 : 0.7 * Math.exp(-(py - Rc.y) / (lam * 1.6)));
        if (A.ell) {
          const E = A.ell;
          const ex = (px - E.cx) / E.rx;
          const ey = (py - E.cy) / E.ry;
          const de = Math.sqrt(ex * ex + ey * ey);
          v = Math.max(v, Math.max(0, 1 - de) ** (E.p || 1.6) * (E.k || 0.9));
        }
        if (A.safeY != null) {
          this.sf[i] = smooth(A.safeY - 40, A.safeY + 70, py);
          v *= this.sf[i] as number;
        }
        for (const q of A.quiet ?? []) {
          const qx = Math.max(q.x - px, 0, px - (q.x + q.w));
          const qy = Math.max(q.y - py, 0, py - (q.y + q.h));
          const qd = Math.hypot(qx, qy);
          if (qd < 28) {
            const f = 0.12 + (0.88 * qd) / 28;
            v *= f;
            this.sf[i] = (this.sf[i] as number) * f;
          }
        }
        this.st[i] = v * this.gain;
        this.dd[i] = Math.hypot(px - cx, py - cy);
        maxD = Math.max(maxD, this.dd[i] as number);
        this.ph[i] = (((x * 73856093) ^ (y * 19349663)) % 628) / 100;
      }
    }
    this.maxD = maxD;
    this.buildSprites();
    this.buildBase();
    this.draw(nowMs());
  }

  /** Send a red ripple across the field (the pickup moment). Ignored with reduced motion. */
  ripple(): void {
    if (this.reducedMotion) return;
    this.rippleAt = nowMs();
  }

  /** Extra brightness while someone is speaking (0..~0.1). */
  setLift(lift: number): void {
    this.lift = lift;
    if (this.reducedMotion) this.draw(nowMs());
  }

  setReducedMotion(rm: boolean): void {
    if (rm === this.reducedMotion) return;
    this.reducedMotion = rm;
    this.rippleAt = -1e9;
    this.schedule();
    this.draw(nowMs());
  }

  destroy(): void {
    this.destroyed = true;
    if (this.raf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.io?.disconnect();
    this.io = null;
    this.sprites = null;
    this.base = null;
  }

  /** Draw one frame at `now` (ms). */
  draw(now: number): void {
    const x = this.ctx;
    if (!x || !this.sprites || !this.base) return;
    const p = this.pitch;
    const dpr = this.dpr;
    const C = this.cols;
    const n = this.st.length;
    const still = this.reducedMotion;
    x.clearRect(0, 0, this.canvas.width, this.canvas.height);
    x.drawImage(this.base, 0, 0);
    const t = now / 1000;
    const breath = still ? 1 : 0.86 + 0.14 * Math.sin((t * 2 * Math.PI) / 9);
    const rp = (now - this.rippleAt) / RIPPLE_MS;
    const rip = !still && rp >= 0 && rp < 1;
    const R = rp * this.maxD * 0.9;
    const RW = p * 2.4;
    for (let i = 0; i < n; i++) {
      if (this.hide[i]) continue;
      let b = (this.st[i] as number) * (breath + this.lift);
      let col: 0 | 1 = 0;
      if (b > 0.01 && !still) b *= 0.92 + 0.08 * Math.sin(t * 1.3 + (this.ph[i] as number));
      if (rip) {
        const d = (this.dd[i] as number) - R;
        if (d > -RW * 3 && d < RW * 3) {
          const s = Math.exp(-(d * d) / (2 * RW * RW)) * (1 - rp) ** 1.1 * (this.sf[i] as number);
          if (s > 0.12) {
            b = Math.max(b, s * 0.95);
            col = 1;
          }
        }
      }
      if (b < 0.045) continue;
      const spr = this.sprites[col][Math.min(16, Math.round(b * 16))];
      if (!spr) continue;
      x.drawImage(
        spr,
        (this.ox + (i % C) * p) * dpr - spr.width / 2,
        (this.oy + ((i / C) | 0) * p) * dpr - spr.height / 2,
      );
    }
  }

  /* ---------- internals ---------- */

  private schedule(): void {
    if (this.destroyed || !this.ctx || typeof requestAnimationFrame === 'undefined') return;
    if (this.reducedMotion) {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      return;
    }
    if (!this.raf) this.raf = requestAnimationFrame(this.loop);
  }

  private loop = (now: number): void => {
    this.raf = 0;
    if (this.destroyed || this.reducedMotion) return;
    if (this.visible) this.draw(now);
    this.raf = requestAnimationFrame(this.loop);
  };

  private buildSprites(): void {
    const dpr = this.dpr;
    const sprites: Sprites = [[], []];
    for (let col = 0; col < 2; col++) {
      for (let l = 0; l <= 16; l++) {
        const bb = l / 16;
        const r = (1.05 + bb * 1.75) * dpr;
        const S = Math.ceil(r * 2 + 6 * dpr);
        const cv = document.createElement('canvas');
        cv.width = S;
        cv.height = S;
        const x = cv.getContext('2d');
        if (x) {
          const m = S / 2;
          if (bb > 0.5) {
            const gr = x.createRadialGradient(m, m, r * 0.6, m, m, S / 2);
            gr.addColorStop(
              0,
              col
                ? `rgba(255,40,48,${(bb - 0.5) * 0.5})`
                : `rgba(255,255,255,${(bb - 0.5) * 0.35})`,
            );
            gr.addColorStop(1, 'rgba(0,0,0,0)');
            x.fillStyle = gr;
            x.fillRect(0, 0, S, S);
          }
          const v = Math.round(24 + bb * 200);
          x.fillStyle = col
            ? `rgb(${Math.round(40 + bb * 215)},${Math.round(22 + bb * 20)},${Math.round(26 + bb * 24)})`
            : `rgb(${v},${v},${v})`;
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
    const base = document.createElement('canvas');
    base.width = this.canvas.width;
    base.height = this.canvas.height;
    const bx = base.getContext('2d');
    if (bx) {
      const p = this.pitch;
      const dpr = this.dpr;
      bx.fillStyle = '#151515';
      for (let y = 0; y < this.rows; y++) {
        for (let x = 0; x < this.cols; x++) {
          bx.beginPath();
          bx.arc((this.ox + x * p) * dpr, (this.oy + y * p) * dpr, 1.05 * dpr, 0, Math.PI * 2);
          bx.fill();
        }
      }
    }
    this.base = base;
  }
}
