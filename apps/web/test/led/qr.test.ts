import { describe, expect, it } from 'vitest';
import { QR_MAX_BYTES, qrMatrix } from '../../src/led/qr';

/* ---------- an independent reader, written from the QR spec ---------- */

const EC_L: Record<number, { data: number; ec: number }> = {
  1: { data: 19, ec: 7 },
  2: { data: 34, ec: 10 },
  3: { data: 55, ec: 15 },
  4: { data: 80, ec: 20 },
  5: { data: 108, ec: 26 },
};

function gfMul(a: number, b: number): number {
  let r = 0;
  let x = a;
  let y = b;
  while (y) {
    if (y & 1) r ^= x;
    y >>= 1;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  return r;
}

function isFunctionModule(n: number, x: number, y: number): boolean {
  const inBox = (x0: number, y0: number, w: number, h: number) =>
    x >= x0 && x < x0 + w && y >= y0 && y < y0 + h;
  if (inBox(0, 0, 9, 9) || inBox(n - 8, 0, 8, 9) || inBox(0, n - 8, 9, 8)) return true; // finders, separators, format
  if (x === 6 || y === 6) return true; // timing
  if (n > 21 && inBox(n - 9, n - 9, 5, 5)) return true; // alignment (v2..v6)
  return false;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function bchFormat(data5: number): number {
  let r = data5 << 10;
  for (let i = 14; i >= 10; i--) if ((r >> i) & 1) r ^= 0x537 << (i - 10);
  return ((data5 << 10) | r) ^ 0x5412;
}

function readFormat(m: boolean[][]): { copy1: number; copy2: number } {
  const n = m.length;
  const at = (x: number, y: number) => (m[y]?.[x] ? 1 : 0);
  let copy1 = 0;
  let copy2 = 0;
  const c1: [number, number][] = [];
  for (let i = 0; i <= 5; i++) c1.push([8, i]);
  c1.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) c1.push([14 - i, 8]);
  const c2: [number, number][] = [];
  for (let i = 0; i < 8; i++) c2.push([n - 1 - i, 8]);
  for (let i = 8; i < 15; i++) c2.push([8, n - 15 + i]);
  c1.forEach(([x, y], i) => {
    copy1 |= at(x, y) << i;
  });
  c2.forEach(([x, y], i) => {
    copy2 |= at(x, y) << i;
  });
  return { copy1, copy2 };
}

function decode(m: boolean[][]): { text: string; mask: number; syndromesZero: boolean } {
  const n = m.length;
  const version = (n - 17) / 4;
  const spec = EC_L[version];
  if (!spec) throw new Error(`unexpected size ${n}`);
  const { copy1 } = readFormat(m);
  const data5 = (copy1 ^ 0x5412) >> 10;
  const mask = data5 & 7;
  const maskFn = MASKS[mask];
  if (!maskFn) throw new Error('bad mask');
  const bits: number[] = [];
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? n - 1 - vert : vert;
        if (isFunctionModule(n, x, y) || (x === 8 && y === n - 8)) continue;
        const v = (m[y]?.[x] ?? false) !== maskFn(x, y);
        bits.push(v ? 1 : 0);
      }
    }
  }
  const total = spec.data + spec.ec;
  const cw: number[] = [];
  for (let i = 0; i < total; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i * 8 + j] ?? 0);
    cw.push(b);
  }
  // Syndromes at alpha^0..alpha^(ec-1) must all be zero.
  let syndromesZero = true;
  let alpha = 1;
  for (let i = 0; i < spec.ec; i++) {
    let s = 0;
    for (const c of cw) s = gfMul(s, alpha) ^ c;
    if (s !== 0) syndromesZero = false;
    alpha = gfMul(alpha, 2);
  }
  // Byte mode payload.
  let pos = 0;
  const take = (k: number) => {
    let v = 0;
    for (let i = 0; i < k; i++) {
      const byte = cw[(pos + i) >> 3] ?? 0;
      v = (v << 1) | ((byte >> (7 - ((pos + i) & 7))) & 1);
    }
    pos += k;
    return v;
  };
  const mode = take(4);
  if (mode !== 4) throw new Error(`mode ${mode}`);
  const len = take(8);
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = take(8);
  return { text: new TextDecoder().decode(bytes), mask, syndromesZero };
}

function isFinderAt(m: boolean[][], x0: number, y0: number): boolean {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      const want = ring !== 2;
      if (m[y0 + dy]?.[x0 + dx] !== want) return false;
    }
  }
  return true;
}

/* ---------- tests ---------- */

const URL_SHORT = 'https://x.y/line/ABC123';

describe('qrMatrix (byte mode, EC level L)', () => {
  it('encodes a practice-line URL as a 29x29 matrix (version 3)', () => {
    const m = qrMatrix(URL_SHORT);
    expect(m).toHaveLength(29);
    for (const row of m) {
      expect(row).toHaveLength(29);
      for (const v of row) expect(typeof v).toBe('boolean');
    }
  });

  it('has finder patterns at the three corners and none at the bottom right', () => {
    const m = qrMatrix(URL_SHORT);
    expect(isFinderAt(m, 0, 0)).toBe(true);
    expect(isFinderAt(m, 22, 0)).toBe(true);
    expect(isFinderAt(m, 0, 22)).toBe(true);
    expect(isFinderAt(m, 22, 22)).toBe(false);
    // Separators are light.
    for (let i = 0; i < 8; i++) {
      expect(m[7]?.[i]).toBe(false);
      expect(m[i]?.[7]).toBe(false);
      expect(m[7]?.[28 - i]).toBe(false);
      expect(m[28 - i]?.[7]).toBe(false);
    }
  });

  it('draws timing patterns, the alignment pattern and the dark module', () => {
    const m = qrMatrix(URL_SHORT);
    for (let i = 8; i <= 20; i++) {
      expect(m[6]?.[i]).toBe(i % 2 === 0);
      expect(m[i]?.[6]).toBe(i % 2 === 0);
    }
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        expect(m[22 + dy]?.[22 + dx]).toBe(ring !== 1);
      }
    }
    expect(m[21]?.[8]).toBe(true);
  });

  it('writes matching, BCH-valid format info for level L', () => {
    const m = qrMatrix(URL_SHORT);
    const { copy1, copy2 } = readFormat(m);
    expect(copy1).toBe(copy2);
    const data5 = (copy1 ^ 0x5412) >> 10;
    expect(bchFormat(data5)).toBe(copy1);
    expect(data5 >> 3).toBe(0b01); // EC level L
  });

  it('round-trips through an independent reader with valid Reed-Solomon codewords', () => {
    const { text, syndromesZero } = decode(qrMatrix(URL_SHORT));
    expect(text).toBe(URL_SHORT);
    expect(syndromesZero).toBe(true);
  });

  it('round-trips UTF-8 text', () => {
    const s = 'Café · ☎ line';
    expect(decode(qrMatrix(s)).text).toBe(s);
  });

  it('grows past version 3 for long tunnel URLs', () => {
    const long = 'https://silly-purple-otter-banana.trycloudflare.com/line/ABC123';
    expect(new TextEncoder().encode(long).length).toBeGreaterThan(53);
    const m = qrMatrix(long);
    expect(m).toHaveLength(33);
    const r = decode(m);
    expect(r.text).toBe(long);
    expect(r.syndromesZero).toBe(true);
    expect(isFinderAt(m, 26, 0)).toBe(true);
    expect(isFinderAt(m, 0, 26)).toBe(true);
  });

  it('never goes below version 3', () => {
    expect(qrMatrix('A')).toHaveLength(29);
    expect(decode(qrMatrix('')).text).toBe('');
  });

  it('is deterministic', () => {
    expect(qrMatrix(URL_SHORT)).toEqual(qrMatrix(URL_SHORT));
  });

  it('rejects text longer than the largest supported version', () => {
    expect(QR_MAX_BYTES).toBe(106);
    expect(() => qrMatrix('x'.repeat(QR_MAX_BYTES))).not.toThrow();
    expect(() => qrMatrix('x'.repeat(QR_MAX_BYTES + 1))).toThrow(RangeError);
  });
});
