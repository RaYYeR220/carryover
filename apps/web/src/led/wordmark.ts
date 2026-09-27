/**
 * The "carryover." dot wordmark: a 5×6 lowercase dot font plus a red full stop.
 * Drawn once per ink colour at ≥2× resolution; the canvas keeps its aspect
 * ratio so CSS only needs to set a height.
 */
const LOWER: Readonly<Record<string, string>> = {
  c: '011101000010000100000111000000',
  a: '011100000101111100010111100000',
  r: '101101100110000100001000000000',
  y: '100011000110001011110000101110',
  o: '011101000110001100010111000000',
  v: '100011000110001010100010000000',
  e: '011101000111111100000111000000',
};

const WORD = 'carryover';
const ROWS = 6;
const PITCH = 6;
const RADIUS = 2.3;
export const WORDMARK_SIGNAL = '#E3242B';

/** Width / height of the wordmark. */
export const WORDMARK_ASPECT = ((WORD.length * 6 + 2) * PITCH) / (ROWS * PITCH);

export function drawWordmark(cv: HTMLCanvasElement, ink = '#000'): void {
  const dpr = Math.max(
    2,
    Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1),
  );
  const W = (WORD.length * 6 + 2) * PITCH;
  const H = ROWS * PITCH;
  cv.width = W * dpr;
  cv.height = H * dpr;
  cv.style.aspectRatio = `${W} / ${H}`;
  const x = cv.getContext('2d');
  if (!x) return;
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, W, H);
  x.fillStyle = ink;
  [...WORD].forEach((ch, k) => {
    const b = LOWER[ch] ?? '';
    for (let i = 0; i < 30; i++) {
      if (b[i] !== '1') continue;
      x.beginPath();
      x.arc(
        (k * 6 + (i % 5)) * PITCH + PITCH / 2,
        Math.floor(i / 5) * PITCH + PITCH / 2,
        RADIUS,
        0,
        Math.PI * 2,
      );
      x.fill();
    }
  });
  x.fillStyle = WORDMARK_SIGNAL;
  x.beginPath();
  x.arc((WORD.length * 6 + 0.5) * PITCH, 3 * PITCH + PITCH / 2, RADIUS + 0.6, 0, Math.PI * 2);
  x.fill();
}
