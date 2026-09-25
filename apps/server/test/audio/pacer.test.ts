import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_BYTES, FrameAggregator, RealtimePacer } from '../../src/audio/pacer.js';

describe('FrameAggregator', () => {
  it('turns 5x160-byte frames into one 800-byte chunk', () => {
    const chunks: Buffer[] = [];
    const agg = new FrameAggregator((c) => chunks.push(c));
    for (let i = 0; i < 5; i++) agg.push(Buffer.alloc(160, i));
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.length).toBe(CHUNK_BYTES);
  });

  it('carries a partial frame across pushes until a full chunk is ready', () => {
    const chunks: Buffer[] = [];
    const agg = new FrameAggregator((c) => chunks.push(c));
    agg.push(Buffer.alloc(500, 1));
    expect(chunks.length).toBe(0);
    agg.push(Buffer.alloc(500, 2));
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.length).toBe(CHUNK_BYTES);
  });

  it('flush emits a partial trailing chunk and clears the buffer', () => {
    const chunks: Buffer[] = [];
    const agg = new FrameAggregator((c) => chunks.push(c));
    agg.push(Buffer.alloc(160, 1));
    agg.flush();
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.length).toBe(160);
    agg.flush();
    expect(chunks.length).toBe(1);
  });
});

describe('RealtimePacer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits one chunk per 100ms and pads nothing when the queue runs dry', () => {
    const chunks: Buffer[] = [];
    const pacer = new RealtimePacer((c) => chunks.push(c));
    pacer.enqueue(Buffer.alloc(CHUNK_BYTES * 3));

    vi.advanceTimersByTime(100);
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.length).toBe(CHUNK_BYTES);

    vi.advanceTimersByTime(100);
    expect(chunks.length).toBe(2);

    vi.advanceTimersByTime(100);
    expect(chunks.length).toBe(3);

    vi.advanceTimersByTime(100);
    expect(chunks.length).toBe(3);

    pacer.stop();
  });

  it('clear() drops pending audio without emitting it', () => {
    const chunks: Buffer[] = [];
    const pacer = new RealtimePacer((c) => chunks.push(c));
    pacer.enqueue(Buffer.alloc(CHUNK_BYTES));
    pacer.clear();
    vi.advanceTimersByTime(100);
    expect(chunks.length).toBe(0);
    pacer.stop();
  });

  it('pendingMs reflects the queued audio duration', () => {
    const pacer = new RealtimePacer(() => {});
    expect(pacer.pendingMs).toBe(0);
    pacer.enqueue(Buffer.alloc(400));
    expect(pacer.pendingMs).toBe(50);
    pacer.enqueue(Buffer.alloc(400));
    expect(pacer.pendingMs).toBe(100);
    pacer.stop();
  });

  it('stop() halts further emission', () => {
    const chunks: Buffer[] = [];
    const pacer = new RealtimePacer((c) => chunks.push(c));
    pacer.enqueue(Buffer.alloc(CHUNK_BYTES * 2));
    pacer.stop();
    vi.advanceTimersByTime(300);
    expect(chunks.length).toBe(0);
  });
});
