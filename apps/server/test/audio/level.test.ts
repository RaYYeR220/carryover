import { describe, expect, it } from 'vitest';
import { rmsDbfs } from '../../src/audio/level.js';
import { encodeMulaw } from '../../src/audio/mulaw.js';

describe('rmsDbfs', () => {
  it('reports digital silence far below 0 dBFS', () => {
    const silence = encodeMulaw(new Int16Array(800));
    expect(rmsDbfs(silence)).toBeLessThan(-40);
  });

  it('reports a full-scale wave close to 0 dBFS', () => {
    const pcm = Int16Array.from({ length: 800 }, (_, i) => (i % 2 === 0 ? 32000 : -32000));
    expect(rmsDbfs(encodeMulaw(pcm))).toBeGreaterThan(-3);
  });

  it('is monotonic with amplitude', () => {
    const quiet = encodeMulaw(
      Int16Array.from({ length: 800 }, (_, i) => Math.round(Math.sin(i / 5) * 1000)),
    );
    const loud = encodeMulaw(
      Int16Array.from({ length: 800 }, (_, i) => Math.round(Math.sin(i / 5) * 10000)),
    );
    expect(rmsDbfs(loud)).toBeGreaterThan(rmsDbfs(quiet));
  });
});
