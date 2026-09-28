// Pure, stateful sample-rate conversion between the browser's AudioContext
// rate (44.1k/48k, whatever the device gives us) and the 8 kHz mono PCM that
// mu-law carries. No Web Audio APIs here so this runs identically on the
// main thread, inside an AudioWorkletProcessor, and under vitest.

const OUT_RATE = 8000; // the line's fixed rate, in both directions
/** Fraction of each output sample's slot that the downsampler's box average spans. */
const WINDOW_FRACTION = 0.7;

function sampleAt(buf: Float32Array, i: number): number {
  if (buf.length === 0) return 0;
  const clamped = i < 0 ? 0 : i >= buf.length ? buf.length - 1 : i;
  return buf[clamped] ?? 0;
}

/** Linear interpolation of `buf` at fractional position `t`. */
function interpAt(buf: Float32Array, t: number): number {
  const i0 = Math.floor(t);
  const frac = t - i0;
  if (frac === 0) return sampleAt(buf, i0);
  return sampleAt(buf, i0) + (sampleAt(buf, i0 + 1) - sampleAt(buf, i0)) * frac;
}

/**
 * Exact average of the piecewise-linear signal through `buf` over [a, b),
 * via trapezoid areas -- a true box-filter (rectangular window) average,
 * as opposed to a Riemann-sum approximation of one.
 */
function windowAverage(buf: Float32Array, a: number, b: number): number {
  let area = 0;
  let t = a;
  let k = Math.floor(a);
  while (t < b) {
    const next = Math.min(b, k + 1);
    area += ((interpAt(buf, t) + interpAt(buf, next)) / 2) * (next - t);
    t = next;
    k += 1;
  }
  return area / (b - a);
}

function concatFloat32(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function floatToInt16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return Math.round(clamped * 32767);
}

export interface DownsampleState {
  /** Unconsumed input samples (in input-sample units) carried into the next call. */
  readonly tail: Float32Array;
  /** Fractional offset, in input samples, into `tail` at which the next output window starts. */
  readonly pos: number;
}

export function createDownsampleState(): DownsampleState {
  return { tail: new Float32Array(0), pos: 0 };
}

/**
 * Downsamples `input` (captured at `inRate`) to 8 kHz mono int16 PCM.
 *
 * Each output sample is a box-filter average of a few linearly-interpolated
 * points spread across its input-time window -- a simple anti-aliased
 * decimation. `state` carries the fractional window position and any input
 * samples not yet consumed, so calling this repeatedly on consecutive chunks
 * of one stream gives the same result as calling it once on the whole thing
 * (no clicks at chunk boundaries).
 */
export function downsampleTo8k(
  input: Float32Array,
  inRate: number,
  state: DownsampleState = createDownsampleState(),
): { output: Int16Array; state: DownsampleState } {
  if (input.length === 0) return { output: new Int16Array(0), state };

  if (inRate === OUT_RATE) {
    const buf = concatFloat32(state.tail, input);
    const out = new Int16Array(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = floatToInt16(buf[i] ?? 0);
    return { output: out, state: createDownsampleState() };
  }

  const ratio = inRate / OUT_RATE;
  const buf = concatFloat32(state.tail, input);

  const samplesOut: number[] = [];
  let pos = state.pos;
  // Each window's right edge needs one more sample of lookahead than the
  // window itself (to know the signal's value/slope right at the edge), so
  // hold back the last window until the next chunk can supply it -- that is
  // what keeps chunked and single-shot processing identical (no clicks).
  while (Math.ceil(pos + ratio) <= buf.length - 1) {
    // Average a window centered on this output sample's slot, sized to a
    // fraction of the slot rather than the full slot: a full-width box (the
    // textbook single-stage decimation filter) has passband droop that peaks
    // near 10% right around 1 kHz at an 8 kHz output rate, purely from the
    // window grid's fixed phase against the input; narrowing it trades a bit
    // of anti-alias rejection for a flatter passband, while still smoothing
    // enough to matter for real (broadband) voice content.
    const center = pos + ratio / 2;
    const half = (WINDOW_FRACTION * ratio) / 2;
    samplesOut.push(floatToInt16(windowAverage(buf, center - half, center + half)));
    pos += ratio;
  }

  const consumed = Math.floor(pos);
  return {
    output: Int16Array.from(samplesOut),
    state: { tail: buf.slice(consumed), pos: pos - consumed },
  };
}

export interface UpsampleState {
  /** The last sample of the previous chunk (normalized -1..1), for interpolating the seam. */
  readonly prevNorm: number;
  /** Fractional position, in input (8 kHz) samples, of the next output sample. */
  readonly pos: number;
}

export function createUpsampleState(): UpsampleState {
  return { prevNorm: 0, pos: 0 };
}

/**
 * Upsamples 8 kHz mono int16 PCM to `outRate` (float, -1..1), via linear
 * interpolation. `state` carries the last input sample and fractional phase
 * across calls so consecutive chunks of one stream interpolate smoothly
 * through the seam instead of clicking.
 */
export function upsampleFrom8k(
  pcm: Int16Array,
  outRate: number,
  state: UpsampleState = createUpsampleState(),
): { output: Float32Array; state: UpsampleState } {
  if (pcm.length === 0) return { output: new Float32Array(0), state };

  const n = pcm.length;
  if (outRate === OUT_RATE) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = (pcm[i] ?? 0) / 32768;
    return { output: out, state: { prevNorm: (pcm[n - 1] ?? 0) / 32768, pos: 0 } };
  }

  const ratio = outRate / OUT_RATE;
  const step = 1 / ratio;

  // buf[0] is the previous chunk's last sample; buf[k+1] is pcm[k]. This lets
  // the seam between chunks interpolate exactly like any other input pair.
  const buf = new Float32Array(n + 1);
  buf[0] = state.prevNorm;
  for (let i = 0; i < n; i++) buf[i + 1] = (pcm[i] ?? 0) / 32768;

  const samplesOut: number[] = [];
  let t = state.pos;
  while (t < n) {
    const i0 = Math.floor(t);
    const frac = t - i0;
    const a = buf[i0] ?? 0;
    const b = buf[i0 + 1] ?? a;
    samplesOut.push(a + (b - a) * frac);
    t += step;
  }

  return {
    output: Float32Array.from(samplesOut),
    state: { prevNorm: buf[n] ?? 0, pos: t - n },
  };
}
