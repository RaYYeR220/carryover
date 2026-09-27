import { describe, expect, it } from 'vitest';
import { fmtClock } from '../../src/lib/format';

describe('fmtClock', () => {
  it('formats seconds as m:ss', () => {
    expect(fmtClock(0)).toBe('0:00');
    expect(fmtClock(8.9)).toBe('0:08');
    expect(fmtClock(282)).toBe('4:42');
    expect(fmtClock(3725)).toBe('62:05');
  });

  it('clamps negative and non-finite input to 0:00', () => {
    expect(fmtClock(-3)).toBe('0:00');
    expect(fmtClock(Number.NaN)).toBe('0:00');
  });
});
