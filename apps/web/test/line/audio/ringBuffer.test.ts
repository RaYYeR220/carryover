import { describe, expect, it } from 'vitest';
import { RingBuffer } from '../../../src/line/audio/ringBuffer';

describe('RingBuffer', () => {
  it('round-trips pushed samples in order', () => {
    const rb = new RingBuffer(10);
    rb.push(Float32Array.from([1, 2, 3]));
    expect(rb.length).toBe(3);
    const out = new Float32Array(3);
    rb.read(out);
    expect(Array.from(out)).toEqual([1, 2, 3]);
    expect(rb.length).toBe(0);
  });

  it('pads the tail with silence on underrun and still consumes what was there', () => {
    const rb = new RingBuffer(10);
    rb.push(Float32Array.from([1, 2]));
    const out = new Float32Array(5);
    rb.read(out);
    expect(Array.from(out)).toEqual([1, 2, 0, 0, 0]);
    expect(rb.length).toBe(0);
  });

  it('reads all silence from an empty buffer', () => {
    const rb = new RingBuffer(4);
    const out = new Float32Array(4).fill(-1);
    rb.read(out);
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
  });

  it('drops the oldest samples on overflow, keeping the newest up to capacity', () => {
    const rb = new RingBuffer(4);
    rb.push(Float32Array.from([1, 2, 3, 4]));
    rb.push(Float32Array.from([5, 6])); // should drop 1, 2
    expect(rb.length).toBe(4);
    const out = new Float32Array(4);
    rb.read(out);
    expect(Array.from(out)).toEqual([3, 4, 5, 6]);
  });

  it('drops the oldest even when a single push exceeds capacity', () => {
    const rb = new RingBuffer(3);
    rb.push(Float32Array.from([1, 2, 3, 4, 5]));
    expect(rb.length).toBe(3);
    const out = new Float32Array(3);
    rb.read(out);
    expect(Array.from(out)).toEqual([3, 4, 5]);
  });

  it('supports interleaved push/read like a FIFO', () => {
    const rb = new RingBuffer(4);
    rb.push(Float32Array.from([1, 2]));
    const a = new Float32Array(1);
    rb.read(a);
    expect(Array.from(a)).toEqual([1]);
    rb.push(Float32Array.from([3, 4]));
    expect(rb.length).toBe(3); // 2 left over + 2 pushed - 1 read = 3
    const b = new Float32Array(3);
    rb.read(b);
    expect(Array.from(b)).toEqual([2, 3, 4]);
  });

  it('reading more than available drains the buffer to empty, not negative length', () => {
    const rb = new RingBuffer(5);
    rb.push(Float32Array.from([1, 2]));
    const out = new Float32Array(10);
    rb.read(out);
    expect(rb.length).toBe(0);
    rb.push(Float32Array.from([9]));
    expect(rb.length).toBe(1);
  });

  it('clear() empties the buffer', () => {
    const rb = new RingBuffer(4);
    rb.push(Float32Array.from([1, 2, 3]));
    rb.clear();
    expect(rb.length).toBe(0);
    const out = new Float32Array(3);
    rb.read(out);
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });
});
