import { mulawToLinear } from './mulaw.js';

const SAMPLE_RATE = 8000;
const BLOCK_SIZE = 205;

const ROWS = [697, 770, 852, 941];
const COLS = [1209, 1336, 1477, 1633];
const KEYS = [
  ['1', '2', '3', 'A'],
  ['4', '5', '6', 'B'],
  ['7', '8', '9', 'C'],
  ['*', '0', '#', 'D'],
];

function power(x: Float64Array, f: number): number {
  const k = 2 * Math.cos((2 * Math.PI * f) / SAMPLE_RATE);
  let s1 = 0;
  let s2 = 0;
  for (const v of x) {
    const s0 = v + k * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - k * s1 * s2;
}

interface Peak {
  index: number;
  value: number;
  runnerUp: number;
}

// Bounds-checked element access for arrays whose length is guaranteed by
// construction (fixed lookup tables), so callers don't need `!`.
function at<T>(arr: readonly T[], index: number): T {
  const v = arr[index];
  if (v === undefined) throw new RangeError(`index ${index} out of range`);
  return v;
}

function findPeak(values: number[]): Peak {
  let index = 0;
  let value = -Infinity;
  values.forEach((v, i) => {
    if (v > value) {
      value = v;
      index = i;
    }
  });
  let runnerUp = -Infinity;
  values.forEach((v, i) => {
    if (i !== index && v > runnerUp) runnerUp = v;
  });
  return { index, value, runnerUp };
}

// Classifies a BLOCK_SIZE-sample block as a DTMF digit, or null if it is not
// a clean, single-digit tone (silence, speech, music, two overlapping keys...).
function classifyBlock(block: Float64Array): string | null {
  let energy = 0;
  for (const v of block) energy += v * v;
  if (energy <= 0) return null;

  const rowPower = ROWS.map((f) => power(block, f));
  const colPower = COLS.map((f) => power(block, f));
  const row = findPeak(rowPower);
  const col = findPeak(colPower);

  if (row.runnerUp > 0 && row.value <= 4 * row.runnerUp) return null;
  if (col.runnerUp > 0 && col.value <= 4 * col.runnerUp) return null;

  const concentration = 0.4 * energy * (BLOCK_SIZE / 2);
  if (row.value + col.value <= concentration) return null;

  const twist = Math.abs(10 * Math.log10(row.value / col.value));
  if (twist >= 8) return null;

  return at(at(KEYS, row.index), col.index);
}

export class DtmfDetector {
  private readonly onDigit: (d: string) => void;
  private samples: number[] = [];
  private candidate: string | null = null;
  private held: string | null = null;

  constructor(onDigit: (d: string) => void) {
    this.onDigit = onDigit;
  }

  push(mu: Buffer): void {
    for (const byte of mu) {
      this.samples.push(mulawToLinear(byte));
      if (this.samples.length >= BLOCK_SIZE) {
        const block = Float64Array.from(this.samples.splice(0, BLOCK_SIZE));
        this.processBlock(block);
      }
    }
  }

  reset(): void {
    this.samples = [];
    this.candidate = null;
    this.held = null;
  }

  private processBlock(block: Float64Array): void {
    const digit = classifyBlock(block);
    if (digit === null) {
      this.candidate = null;
      this.held = null;
      return;
    }
    if (digit === this.candidate) {
      if (digit !== this.held) {
        this.held = digit;
        this.onDigit(digit);
      }
    } else {
      this.candidate = digit;
    }
  }
}
