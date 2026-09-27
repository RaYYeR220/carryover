import type { Bitmap } from './frame';

/**
 * Rasterise a phone handset into a w×h dot bitmap: draw it 5× supersampled on
 * a scratch canvas, then average each 5×5 cell into one dot. `ang` tilts it
 * (lifted). Returns null where there is no 2D canvas (tests, very old browsers).
 */
export function handsetBitmap(w: number, h: number, ang: number): Bitmap | null {
  if (w < 1 || h < 1 || typeof document === 'undefined') return null;
  const k = 5;
  const W = w * k;
  const H = h * k;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const c = cv.getContext('2d', { willReadFrequently: true });
  if (!c) return null;

  const ca = Math.abs(Math.cos(ang));
  const sa = Math.abs(Math.sin(ang));
  const u = Math.min(W / (68 * ca + 20 * sa), H / (68 * sa + 20 * ca)) * 0.97;
  c.translate(W / 2, H / 2);
  c.rotate(ang);
  c.translate(0, -1 * u);
  const L = 25 * u;
  const g = c.createLinearGradient(0, -9 * u, 0, 11 * u);
  g.addColorStop(0, '#fff');
  g.addColorStop(0.5, '#c8c8c8');
  g.addColorStop(1, '#4a4a4a');
  c.fillStyle = g;
  c.beginPath();
  c.moveTo(-L, -1 * u);
  c.bezierCurveTo(-L * 0.5, -11 * u, L * 0.5, -11 * u, L, -1 * u);
  c.lineTo(L, 4.6 * u);
  c.bezierCurveTo(L * 0.5, -3.4 * u, -L * 0.5, -3.4 * u, -L, 4.6 * u);
  c.closePath();
  c.fill();
  for (const sx of [-1, 1]) {
    c.beginPath();
    c.ellipse(sx * L, 4 * u, 9 * u, 6.6 * u, 0, 0, Math.PI * 2);
    c.fill();
  }

  const d = c.getImageData(0, 0, W, H).data;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let cov = 0;
      for (let j = 0; j < k; j++) {
        for (let i = 0; i < k; i++) {
          const q = ((y * k + j) * W + (x * k + i)) * 4;
          const alpha = d[q + 3] as number;
          cov += alpha;
          s += ((d[q] as number) * alpha) / 255;
        }
      }
      const a = cov / (k * k * 255);
      if (a > 0.42) out[y * w + x] = Math.max(0.3, Math.min(1, s / Math.max(1, cov)));
    }
  }
  return { w, h, d: out };
}
