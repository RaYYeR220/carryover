import { describe, expect, it } from 'vitest';
import { decodeMulaw, encodeMulaw, linearToMulaw, mulawToLinear } from '../../src/audio/mulaw.js';

describe('mulaw', () => {
  it('roundtrips within G.711 quantization error', () => {
    for (const s of [0, 1, -1, 100, -100, 1000, -1000, 8000, -8000, 32000, -32000]) {
      const back = mulawToLinear(linearToMulaw(s));
      expect(Math.abs(back - s)).toBeLessThanOrEqual(Math.max(8, Math.abs(s) * 0.07));
    }
  });
  it('encodes silence as 0xFF', () => {
    expect(linearToMulaw(0)).toBe(0xff);
  });
  it('buffer helpers keep length', () => {
    const pcm = Int16Array.from({ length: 800 }, (_, i) => Math.round(Math.sin(i / 5) * 10000));
    expect(decodeMulaw(encodeMulaw(pcm)).length).toBe(800);
  });
});
