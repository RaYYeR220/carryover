import { describe, expect, it } from 'vitest';
import { GLYPH_H, GLYPH_W, glyphRows, hasGlyph, textWidth } from '../../src/led/font';

const REQUIRED = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', ':', ' '];

describe('5x7 LED font', () => {
  it('is 5 columns by 7 rows', () => {
    expect(GLYPH_W).toBe(5);
    expect(GLYPH_H).toBe(7);
  });

  it.each(REQUIRED)('returns 7 rows of 5 bits for %j', (ch) => {
    expect(hasGlyph(ch)).toBe(true);
    const rows = glyphRows(ch);
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(row).toHaveLength(5);
      for (const bit of row) expect(bit === 0 || bit === 1).toBe(true);
    }
  });

  it('draws letters and digits with at least one lit dot, and space with none', () => {
    for (const ch of REQUIRED) {
      const lit = glyphRows(ch)
        .flat()
        .reduce<number>((a, b) => a + b, 0);
      if (ch === ' ') expect(lit).toBe(0);
      else expect(lit).toBeGreaterThan(0);
    }
  });

  it('keeps the design bitmaps (A, 2 and colon)', () => {
    expect(glyphRows('A').map((r) => r.join(''))).toEqual([
      '01110',
      '10001',
      '10001',
      '11111',
      '10001',
      '10001',
      '10001',
    ]);
    expect(glyphRows('2').map((r) => r.join(''))).toEqual([
      '01110',
      '10001',
      '00001',
      '00010',
      '00100',
      '01000',
      '11111',
    ]);
    expect(glyphRows(':').map((r) => r.join(''))).toEqual([
      '00000',
      '01100',
      '01100',
      '00000',
      '01100',
      '01100',
      '00000',
    ]);
  });

  it('maps lowercase to uppercase and unknown characters to space', () => {
    expect(glyphRows('a')).toEqual(glyphRows('A'));
    expect(glyphRows('€')).toEqual(glyphRows(' '));
    expect(hasGlyph('€')).toBe(false);
  });

  it('measures text as 6 dots per character minus the trailing gap', () => {
    expect(textWidth('DANA')).toBe(23);
    expect(textWidth('ON HOLD', 2)).toBe(82);
    expect(textWidth('')).toBe(0);
  });
});
