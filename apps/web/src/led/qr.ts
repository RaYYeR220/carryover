/**
 * A small QR encoder: byte mode, error-correction level L, versions 3–5
 * (single Reed-Solomon block, one alignment pattern, no version info).
 * Ported from the Glyph Night prototype, which fixed version 3; versions 4
 * and 5 are added so long tunnel URLs still fit. Returns matrix[row][col],
 * true = dark module.
 */

interface VersionSpec {
  version: number;
  size: number;
  dataCodewords: number;
  ecCodewords: number;
}

const VERSIONS: readonly VersionSpec[] = [
  { version: 3, size: 29, dataCodewords: 55, ecCodewords: 15 },
  { version: 4, size: 33, dataCodewords: 80, ecCodewords: 20 },
  { version: 5, size: 37, dataCodewords: 108, ecCodewords: 26 },
];

/** Byte-mode payload that fits: data codewords minus the 12-bit mode+length header. */
const capacity = (v: VersionSpec) => Math.floor((v.dataCodewords * 8 - 12) / 8);

export const QR_MAX_BYTES = capacity(VERSIONS[VERSIONS.length - 1] as VersionSpec);

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const dv: number[] = new Array(degree - 1).fill(0);
  dv.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < dv.length; j++) {
      dv[j] = gfMul(dv[j] as number, root);
      if (j + 1 < dv.length) dv[j] = (dv[j] as number) ^ (dv[j + 1] as number);
    }
    root = gfMul(root, 2);
  }
  return dv;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const rem: number[] = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (rem.shift() as number);
    rem.push(0);
    divisor.forEach((c, i) => {
      rem[i] = (rem[i] as number) ^ gfMul(c, factor);
    });
  }
  return rem;
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function encodeCodewords(bytes: Uint8Array, spec: VersionSpec): number[] {
  const DC = spec.dataCodewords;
  const bits: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(4, 4); // byte mode
  put(bytes.length, 8);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, DC * 8 - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] as number);
    data.push(b);
  }
  for (let pad = 0xec; data.length < DC; pad ^= 0xec ^ 0x11) data.push(pad);
  return data.concat(rsRemainder(data, rsDivisor(spec.ecCodewords)));
}

/** Encode `text` (UTF-8) as a QR matrix, version 3 or larger. Throws RangeError if it cannot fit. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const spec = VERSIONS.find((v) => bytes.length <= capacity(v));
  if (!spec) {
    throw new RangeError(`QR payload is ${bytes.length} bytes; the maximum is ${QR_MAX_BYTES}`);
  }
  const N = spec.size;
  const cw = encodeCodewords(bytes, spec);

  const M: boolean[][] = Array.from({ length: N }, () => new Array<boolean>(N).fill(false));
  const F: boolean[][] = Array.from({ length: N }, () => new Array<boolean>(N).fill(false));
  const row = (y: number) => M[y] as boolean[];
  const frow = (y: number) => F[y] as boolean[];
  const sf = (x: number, y: number, dark: boolean) => {
    row(y)[x] = dark;
    frow(y)[x] = true;
  };

  // Timing patterns (finders overwrite the ends).
  for (let i = 0; i < N; i++) {
    sf(6, i, i % 2 === 0);
    sf(i, 6, i % 2 === 0);
  }
  // Finder patterns with their light separators.
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= N || y >= N) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        sf(x, y, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3);
  finder(N - 4, 3);
  finder(3, N - 4);
  // The single alignment pattern of versions 2–6.
  const a = N - 7;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) sf(a + dx, a + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }

  // Format bits: EC level L (01) + mask, BCH(15,5), XOR mask 0x5412. Also sets the dark module.
  const formatBits = (mask: number) => {
    const d = (1 << 3) | mask;
    let r = d;
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const b = ((d << 10) | r) ^ 0x5412;
    const g = (i: number) => ((b >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) sf(8, i, g(i));
    sf(8, 7, g(6));
    sf(8, 8, g(7));
    sf(7, 8, g(8));
    for (let i = 9; i < 15; i++) sf(14 - i, 8, g(i));
    for (let i = 0; i < 8; i++) sf(N - 1 - i, 8, g(i));
    for (let i = 8; i < 15; i++) sf(8, N - 15 + i, g(i));
    sf(8, N - 8, true);
  };
  formatBits(0);

  // Data in the standard zigzag, two columns at a time, skipping the vertical timing column.
  let k = 0;
  const total = cw.length * 8;
  for (let right = N - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < N; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const up = ((right + 1) & 2) === 0;
        const y = up ? N - 1 - vert : vert;
        if (!frow(y)[x] && k < total) {
          row(y)[x] = (((cw[k >>> 3] as number) >>> (7 - (k & 7))) & 1) === 1;
          k++;
        }
      }
    }
  }

  const applyMask = (m: number) => {
    const fn = MASKS[m] as (x: number, y: number) => boolean;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) if (!frow(y)[x] && fn(x, y)) row(y)[x] = !row(y)[x];
    }
  };
  // Simplified penalty: runs, 2×2 blocks and dark balance (the prototype's scoring).
  const penalty = () => {
    let s = 0;
    let dark = 0;
    for (let axis = 0; axis < 2; axis++) {
      for (let i = 0; i < N; i++) {
        let run = 1;
        for (let j = 1; j < N; j++) {
          const c = axis ? row(j)[i] : row(i)[j];
          const pv = axis ? row(j - 1)[i] : row(i)[j - 1];
          if (c === pv) {
            run++;
            if (run === 5) s += 3;
            else if (run > 5) s++;
          } else run = 1;
        }
      }
    }
    for (let y = 0; y < N - 1; y++) {
      for (let x = 0; x < N - 1; x++) {
        const c = row(y)[x];
        if (c === row(y)[x + 1] && c === row(y + 1)[x] && c === row(y + 1)[x + 1]) s += 3;
      }
    }
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (row(y)[x]) dark++;
    return s + Math.floor(Math.abs(dark * 20 - N * N * 10) / (N * N)) * 10;
  };

  let best = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let m = 0; m < 8; m++) {
    applyMask(m);
    formatBits(m);
    const p = penalty();
    if (p < bestScore) {
      bestScore = p;
      best = m;
    }
    applyMask(m); // XOR again to undo
  }
  applyMask(best);
  formatBits(best);
  return M;
}
