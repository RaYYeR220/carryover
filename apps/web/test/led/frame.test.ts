import { describe, expect, it } from 'vitest';
import { fitLabel, LedFrame, labelAt, regions, waveBox } from '../../src/led/frame';

const lit = (m: LedFrame) => {
  const out: string[] = [];
  for (let y = 0; y < m.rows; y++) {
    let s = '';
    for (let x = 0; x < m.cols; x++) s += (m.v[y * m.cols + x] ?? 0) > 0 ? '1' : '0';
    out.push(s);
  }
  return out;
};

describe('LedFrame', () => {
  it('keeps the brightest value per dot and ignores out-of-range writes', () => {
    const m = new LedFrame(4, 3);
    m.set(1, 1, 0.5);
    m.set(1, 1, 0.3);
    m.set(1, 1, 0.9, 1);
    m.set(-1, 0, 1);
    m.set(4, 0, 1);
    m.set(0, 3, 1);
    expect(m.v[1 * 4 + 1]).toBeCloseTo(0.9);
    expect(m.c[1 * 4 + 1]).toBe(1);
    expect([...m.v].filter((v) => v > 0)).toHaveLength(1);
  });

  it('draws text from the 5x7 font with a 1-dot gap', () => {
    const m = new LedFrame(11, 7);
    m.text('I1', 0, 0);
    expect(lit(m)).toEqual([
      '01110000100',
      '00100001100',
      '00100000100',
      '00100000100',
      '00100000100',
      '00100000100',
      '01110001110',
    ]);
  });

  it('scales text', () => {
    const m = new LedFrame(10, 14);
    m.text('-', 0, 0, 1, 0, 2);
    const rows = lit(m);
    expect(rows[6]).toBe('1111111111');
    expect(rows[7]).toBe('1111111111');
    expect(rows[5]).toBe('0000000000');
  });

  it('clears and fills', () => {
    const m = new LedFrame(3, 2);
    m.fill(1, 1);
    expect([...m.v]).toEqual([1, 1, 1, 1, 1, 1]);
    m.clear();
    expect([...m.v]).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('layout regions', () => {
  it('uses a strip below 16 rows (mobile device bar)', () => {
    expect(regions(new LedFrame(60, 8)).mode).toBe('strip');
  });

  it('uses the wide layout at 1.6:1 or wider, with the icon on the left', () => {
    const L = regions(new LedFrame(64, 20));
    expect(L.mode).toBe('wide');
    expect(L.icon).toEqual({ x: 2, y: 1, w: Math.min(26, 47), h: 18 });
  });

  it('uses the tall layout otherwise (desktop call screen, hero)', () => {
    const L = regions(new LedFrame(45, 29));
    expect(L.mode).toBe('tall');
    expect(L.icon).toEqual({ x: 1, y: 1, w: 43, h: 12 });
  });

  it('centres labels at the bottom in tall mode and right-aligns them otherwise', () => {
    const tall = new LedFrame(45, 29);
    labelAt(tall, regions(tall), 'DANA');
    expect(tall.v[21 * 45 + 11]).toBe(1); // D's top-left dot: x=(45-23)/2=11, y=R-8=21
    const strip = new LedFrame(60, 8);
    labelAt(strip, regions(strip), 'LIVE');
    // right-aligned: x = C - tw - 2 = 60 - 23 - 2 = 35, y = round((8-7)/2) = 1 (L top-left dot)
    expect(strip.v[1 * 60 + 35]).toBe(1);
  });

  it('sizes the wave box beside the label', () => {
    const strip = new LedFrame(60, 8);
    expect(waveBox(regions(strip), 23)).toEqual({ x0: 1, x1: 32, cy: 4, amp: 2.5 });
  });

  it('shortens labels that would not fit', () => {
    const tall = new LedFrame(30, 29);
    expect(fitLabel(regions(tall), 'DANA')).toBe('DANA');
    expect(fitLabel(regions(tall), 'MARGARET')).toBe('MARG');
    // wide: never over the icon (64 - (2 + 26) - 8 = 28 dots)
    expect(fitLabel(regions(new LedFrame(64, 20)), 'CALLING')).toBe('CALL');
    // strip: the mobile bar keeps B's full labels
    expect(fitLabel(regions(new LedFrame(60, 8)), 'ON HOLD')).toBe('ON HOLD');
    expect(fitLabel(regions(new LedFrame(60, 8)), 'ASKING')).toBe('ASKING');
  });
});
