import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, createLine: vi.fn(), getLine: vi.fn() },
  };
});

import { ApiError, api } from '../../src/lib/api';
import { usePracticeLine } from '../../src/start/usePracticeLine';

const LINE = {
  code: 'ABC123',
  url: 'https://carryover.app/line/ABC123',
  qrSvg: '<svg><rect/></svg>',
  status: 'waiting' as const,
};

beforeEach(() => {
  vi.mocked(api.createLine).mockResolvedValue(LINE);
  vi.mocked(api.getLine).mockResolvedValue(LINE);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('usePracticeLine', () => {
  it('polls GET /api/lines/:code every 2 s and reflects its status', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => usePracticeLine(true));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.code).toBe('ABC123');

    vi.mocked(api.getLine).mockResolvedValue({ ...LINE, status: 'ringing' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.status).toBe('ringing');
  });

  it('stops polling and shows an expired message on a 404, instead of polling forever', async () => {
    vi.useFakeTimers();
    vi.mocked(api.getLine).mockRejectedValue(new ApiError(404, 'Line not found.'));
    const { result } = renderHook(() => usePracticeLine(true));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.code).toBe('ABC123');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.error).toBe('This practice line expired — create a new one.');
    const callsAfterExpiry = vi.mocked(api.getLine).mock.calls.length;
    expect(callsAfterExpiry).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(vi.mocked(api.getLine).mock.calls.length).toBe(callsAfterExpiry);
  });

  it('a transient network error is not fatal: the next tick tries again', async () => {
    vi.useFakeTimers();
    vi.mocked(api.getLine).mockRejectedValueOnce(new ApiError(0, 'network down'));
    const { result } = renderHook(() => usePracticeLine(true));
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.error).toBeUndefined();
    expect(result.current.status).toBe('waiting');

    vi.mocked(api.getLine).mockResolvedValue({ ...LINE, status: 'connected' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.status).toBe('connected');
  });
});
