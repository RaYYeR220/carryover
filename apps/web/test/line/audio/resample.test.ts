import { describe, expect, it } from 'vitest';
import {
  createDownsampleState,
  createUpsampleState,
  downsampleTo8k,
  upsampleFrom8k,
} from '../../../src/line/audio/resample';

/** A 1 kHz sine sampled at `rate`, `seconds` long, amplitude in [0,1]. */
function sine1k(rate: number, seconds: number, amplitude = 0.8): Float32Array {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * 1000 * i) / rate);
  return out;
}

/** Counts zero crossings (sign changes) in a numeric signal. */
function zeroCrossings(sig: ArrayLike<number>): number {
  let count = 0;
  for (let i = 1; i < sig.length; i++) {
    const prev = sig[i - 1] as number;
    const cur = sig[i] as number;
    if ((prev < 0 && cur >= 0) || (prev > 0 && cur <= 0)) count++;
  }
  return count;
}

function peakAmplitudeInt16(sig: Int16Array): number {
  let peak = 0;
  for (const v of sig) peak = Math.max(peak, Math.abs(v));
  return peak / 32768;
}

function peakAmplitudeFloat(sig: Float32Array): number {
  let peak = 0;
  for (const v of sig) peak = Math.max(peak, Math.abs(v));
  return peak;
}

describe('downsampleTo8k', () => {
  it('keeps the frequency of a 1 kHz sine (48k -> 8k)', () => {
    const seconds = 0.2;
    const input = sine1k(48000, seconds);
    const { output } = downsampleTo8k(input, 48000);
    // 1 kHz over 0.2 s = 200 cycles = 400 zero crossings, +-1 for edge effects.
    const crossings = zeroCrossings(output);
    const expected = 2 * 1000 * seconds;
    expect(Math.abs(crossings - expected)).toBeLessThanOrEqual(4);
  });

  it('keeps amplitude within 10% (48k -> 8k)', () => {
    const input = sine1k(48000, 0.2, 0.8);
    const { output } = downsampleTo8k(input, 48000);
    const peak = peakAmplitudeInt16(output);
    expect(peak).toBeGreaterThan(0.8 * 0.9);
    expect(peak).toBeLessThanOrEqual(0.8 * 1.1);
  });

  it('produces 8 kHz-rate-worth of samples', () => {
    const input = sine1k(48000, 0.1);
    const { output } = downsampleTo8k(input, 48000);
    expect(output.length).toBeGreaterThanOrEqual(790);
    expect(output.length).toBeLessThanOrEqual(810);
  });

  it('is stateful and continuous across chunk boundaries (no clicks)', () => {
    const seconds = 0.2;
    const input = sine1k(48000, seconds);

    const { output: whole } = downsampleTo8k(input, 48000);

    // Split into ragged 7ms-ish chunks (not a clean divisor of the frame size).
    const chunkLen = 337;
    let state = createDownsampleState();
    const parts: Int16Array[] = [];
    for (let i = 0; i < input.length; i += chunkLen) {
      const chunk = input.subarray(i, Math.min(i + chunkLen, input.length));
      const r = downsampleTo8k(chunk, 48000, state);
      state = r.state;
      parts.push(r.output);
    }
    const chunked = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) {
      chunked.set(p, off);
      off += p.length;
    }

    // Chunked processing must match single-shot processing sample-for-sample:
    // that is the definition of "no clicks at chunk boundaries" for a
    // deterministic, stateful resampler.
    expect(chunked.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) {
      expect(Math.abs((chunked[i] as number) - (whole[i] as number))).toBeLessThanOrEqual(1);
    }
  });

  it('passes through unchanged when input is already 8 kHz', () => {
    const input = sine1k(8000, 0.05, 0.5);
    const { output } = downsampleTo8k(input, 8000);
    expect(output.length).toBe(input.length);
    const peak = peakAmplitudeInt16(output);
    expect(peak).toBeGreaterThan(0.5 * 0.9);
    expect(peak).toBeLessThanOrEqual(0.5 * 1.05);
  });
});

describe('upsampleFrom8k', () => {
  it('keeps the frequency of a 1 kHz sine (8k -> 48k)', () => {
    const seconds = 0.2;
    const rate = 8000;
    const n = Math.round(rate * seconds);
    const pcm = Int16Array.from({ length: n }, (_, i) =>
      Math.round(0.8 * 32767 * Math.sin((2 * Math.PI * 1000 * i) / rate)),
    );
    const { output } = upsampleFrom8k(pcm, 48000);
    const crossings = zeroCrossings(output);
    const expected = 2 * 1000 * seconds;
    expect(Math.abs(crossings - expected)).toBeLessThanOrEqual(4);
  });

  it('keeps amplitude within 10% (8k -> 48k)', () => {
    const rate = 8000;
    const n = Math.round(rate * 0.2);
    const pcm = Int16Array.from({ length: n }, (_, i) =>
      Math.round(0.8 * 32767 * Math.sin((2 * Math.PI * 1000 * i) / rate)),
    );
    const { output } = upsampleFrom8k(pcm, 48000);
    const peak = peakAmplitudeFloat(output);
    expect(peak).toBeGreaterThan(0.8 * 0.9);
    expect(peak).toBeLessThanOrEqual(0.8 * 1.1);
  });

  it('produces roughly ratio-times as many samples', () => {
    const pcm = Int16Array.from({ length: 160 }, () => 0);
    const { output } = upsampleFrom8k(pcm, 48000);
    expect(output.length).toBeGreaterThanOrEqual(950);
    expect(output.length).toBeLessThanOrEqual(970);
  });

  it('is stateful and continuous across chunk boundaries (no clicks)', () => {
    const rate = 8000;
    const n = Math.round(rate * 0.2);
    const pcm = Int16Array.from({ length: n }, (_, i) =>
      Math.round(0.8 * 32767 * Math.sin((2 * Math.PI * 1000 * i) / rate)),
    );

    const { output: whole } = upsampleFrom8k(pcm, 48000);

    const chunkLen = 37; // ragged, not a divisor of 160
    let state = createUpsampleState();
    const parts: Float32Array[] = [];
    for (let i = 0; i < pcm.length; i += chunkLen) {
      const chunk = pcm.subarray(i, Math.min(i + chunkLen, pcm.length));
      const r = upsampleFrom8k(chunk, 48000, state);
      state = r.state;
      parts.push(r.output);
    }
    const chunked = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
    let off = 0;
    for (const p of parts) {
      chunked.set(p, off);
      off += p.length;
    }

    expect(chunked.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) {
      expect(Math.abs((chunked[i] as number) - (whole[i] as number))).toBeLessThan(1e-6);
    }
  });

  it('does not click at the seam: consecutive samples never jump more than one input step would allow', () => {
    // Two chunks of silence then a chunk that jumps to full-scale: the
    // interpolated ramp across the worklet-frame boundary must be smooth,
    // not a single-sample discontinuity larger than what linear interpolation
    // between the two nearest input samples would produce.
    const silence = new Int16Array(160);
    const loud = Int16Array.from({ length: 160 }, () => 20000);
    let state = createUpsampleState();
    const a = upsampleFrom8k(silence, 48000, state);
    state = a.state;
    const b = upsampleFrom8k(loud, 48000, state);
    const seam = [...a.output.slice(-3), ...b.output.slice(0, 3)];
    for (let i = 1; i < seam.length; i++) {
      const step = Math.abs((seam[i] as number) - (seam[i - 1] as number));
      // Max per-output-sample delta if interpolating linearly from 0 to
      // 20000/32768 over a 6x upsample is (20000/32768)/6 ~= 0.1017; allow slack.
      expect(step).toBeLessThan(0.15);
    }
  });
});
