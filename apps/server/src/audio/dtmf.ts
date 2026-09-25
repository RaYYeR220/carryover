import { encodeMulaw } from './mulaw.js';

const SAMPLE_RATE = 8000;

export const DTMF_FREQS: Record<string, [number, number]> = {
  '1': [697, 1209],
  '2': [697, 1336],
  '3': [697, 1477],
  A: [697, 1633],
  '4': [770, 1209],
  '5': [770, 1336],
  '6': [770, 1477],
  B: [770, 1633],
  '7': [852, 1209],
  '8': [852, 1336],
  '9': [852, 1477],
  C: [852, 1633],
  '*': [941, 1209],
  '0': [941, 1336],
  '#': [941, 1477],
  D: [941, 1633],
};

export function dtmfMulaw(
  digits: string,
  opts?: { toneMs?: number; gapMs?: number; amplitude?: number },
): Buffer {
  const toneMs = opts?.toneMs ?? 120;
  const gapMs = opts?.gapMs ?? 80;
  const amplitude = opts?.amplitude ?? 0.3;
  const peak = amplitude * 32767;

  const toneSamples = Math.round((toneMs / 1000) * SAMPLE_RATE);
  const gapSamples = Math.round((gapMs / 1000) * SAMPLE_RATE);

  const samples: number[] = [];
  for (const digit of digits) {
    const freqs = DTMF_FREQS[digit];
    if (!freqs) continue;
    const [low, high] = freqs;
    for (let i = 0; i < toneSamples; i++) {
      const t = i / SAMPLE_RATE;
      const tone = 0.5 * (Math.sin(2 * Math.PI * low * t) + Math.sin(2 * Math.PI * high * t));
      samples.push(Math.round(peak * tone));
    }
    for (let i = 0; i < gapSamples; i++) samples.push(0);
  }
  return encodeMulaw(Int16Array.from(samples));
}
