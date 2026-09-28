import { describe, expect, it } from 'vitest';
import {
  decodeMulaw,
  encodeMulaw,
  linearToMulaw,
  mulawToLinear,
} from '../../../src/line/audio/mulaw';

// Vectors computed by running the server's own G.711 implementation
// (apps/server/src/audio/mulaw.ts) on the same inputs, so the browser codec
// stays bit-identical to what the server encodes/decodes.
const LINEAR_TO_MULAW_VECTORS: ReadonlyArray<readonly [number, number]> = [
  [0, 0xff],
  [1, 0xff],
  [-1, 0x7f],
  [32, 0xfb],
  [-32, 0x7b],
  [100, 0xf2],
  [-100, 0x72],
  [1000, 0xce],
  [-1000, 0x4e],
  [8000, 0xa0],
  [-8000, 0x20],
  [30000, 0x82],
  [-30000, 0x02],
  [32767, 0x80],
  [-32768, 0x00],
];

const MULAW_TO_LINEAR_VECTORS: ReadonlyArray<readonly [number, number]> = [
  [0x00, -32124],
  [0x0f, -16764],
  [0x7f, 0],
  [0x80, 32124],
  [0xff, 0],
  [0x55, -716],
  [0xd5, 716],
  [0x3c, -2364],
  [0xbc, 2364],
];

describe('linearToMulaw', () => {
  it('matches the server codec on known vectors', () => {
    for (const [sample, expected] of LINEAR_TO_MULAW_VECTORS) {
      expect(linearToMulaw(sample)).toBe(expected);
    }
  });
});

describe('mulawToLinear', () => {
  it('matches the server codec on known vectors', () => {
    for (const [byte, expected] of MULAW_TO_LINEAR_VECTORS) {
      // Math.abs also normalizes the -0 that 0x7f decodes to (silence's negative half-step).
      expect(Math.abs(mulawToLinear(byte) - expected)).toBe(0);
    }
  });
});

describe('roundtrip', () => {
  it('stays within G.711 quantization error', () => {
    for (const s of [0, 1, -1, 100, -100, 1000, -1000, 8000, -8000, 32000, -32000]) {
      const back = mulawToLinear(linearToMulaw(s));
      expect(Math.abs(back - s)).toBeLessThanOrEqual(Math.max(8, Math.abs(s) * 0.07));
    }
  });
});

describe('encodeMulaw / decodeMulaw', () => {
  it('encodes a known PCM buffer byte-for-byte like the server', () => {
    const samples = LINEAR_TO_MULAW_VECTORS.map(([s]) => s);
    const pcm = Int16Array.from(samples);
    const encoded = encodeMulaw(pcm);
    expect(Array.from(encoded)).toEqual(LINEAR_TO_MULAW_VECTORS.map(([, m]) => m));
  });

  it('round-trips a 20 ms (160-sample) frame without throwing and keeps length', () => {
    const pcm = Int16Array.from({ length: 160 }, (_, i) => Math.round(Math.sin(i / 5) * 10000));
    const encoded = encodeMulaw(pcm);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBe(160);
    const decoded = decodeMulaw(encoded);
    expect(decoded.length).toBe(160);
  });

  it('produces a Uint8Array (not a Node Buffer) so it is safe to send over WebSocket in the browser', () => {
    const encoded = encodeMulaw(Int16Array.from([0, 100, -100]));
    expect(encoded.constructor).toBe(Uint8Array);
  });
});
