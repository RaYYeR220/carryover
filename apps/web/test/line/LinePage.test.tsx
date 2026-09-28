import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LineSocketHandlers } from '../../src/line/lineSocket';

const { connectLineSocket } = vi.hoisted(() => ({ connectLineSocket: vi.fn() }));
vi.mock('../../src/line/lineSocket', () => ({ connectLineSocket }));

const { createLineAudioContext, startLineAudio } = vi.hoisted(() => ({
  createLineAudioContext: vi.fn(),
  startLineAudio: vi.fn(),
}));
vi.mock('../../src/line/audio/lineAudio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/line/audio/lineAudio')>();
  return { ...actual, createLineAudioContext, startLineAudio };
});

const { AudioEngineLoadError } = await import('../../src/line/audio/lineAudio');
const { default: LinePage } = await import('../../src/line/LinePage');

interface FakeSocket {
  answer: ReturnType<typeof vi.fn>;
  hangup: ReturnType<typeof vi.fn>;
  sendAudio: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

/** Wires `connectLineSocket` to a controllable fake and exposes the handlers LinePage registered. */
function mockSocket(): { socket: FakeSocket; handlers: () => LineSocketHandlers } {
  const socket: FakeSocket = {
    answer: vi.fn(),
    hangup: vi.fn(),
    sendAudio: vi.fn(),
    close: vi.fn(),
  };
  let handlers: LineSocketHandlers | undefined;
  vi.mocked(connectLineSocket).mockImplementation((_url: string, h: LineSocketHandlers) => {
    handlers = h;
    return socket;
  });
  return {
    socket,
    handlers: () => {
      if (!handlers) throw new Error('connectLineSocket has not been called yet');
      return handlers;
    },
  };
}

interface FakeLineAudio {
  playFrame: ReturnType<typeof vi.fn>;
  setMuted: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function fakeLineAudio(): FakeLineAudio {
  return { playFrame: vi.fn(), setMuted: vi.fn(), stop: vi.fn() };
}

function renderLinePage(code = 'ABC123') {
  const router = createMemoryRouter([{ path: '/line/:code', Component: LinePage }], {
    initialEntries: [`/line/${code}`],
  });
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  vi.mocked(createLineAudioContext).mockReturnValue({ close: vi.fn() } as unknown as AudioContext);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LinePage phase transitions', () => {
  it('starts on "connecting" before any status arrives', () => {
    mockSocket();
    renderLinePage();
    expect(screen.getByRole('heading', { name: /connecting/i })).toBeInTheDocument();
  });

  it('goes waiting -> ringing -> answer -> connected -> ended', async () => {
    const { socket, handlers } = mockSocket();
    const audio = fakeLineAudio();
    vi.mocked(startLineAudio).mockResolvedValue(audio);
    renderLinePage();

    act(() => handlers().onStatus({ t: 'line.status', status: 'waiting' }));
    expect(screen.getByRole('heading', { name: /you are the business/i })).toBeInTheDocument();

    act(() =>
      handlers().onStatus({
        t: 'line.status',
        status: 'ringing',
        callerLabel: 'Riverside Pharmacy',
      }),
    );
    expect(
      screen.getByRole('heading', { name: /riverside pharmacy is calling/i }),
    ).toBeInTheDocument();
    const answerBtn = screen.getByRole('button', { name: /answer/i });

    fireEvent.click(answerBtn);
    await waitFor(() => expect(createLineAudioContext).toHaveBeenCalled());
    await waitFor(() => expect(socket.answer).toHaveBeenCalled());
    // Answering only sends the WS command; the phase itself only moves to
    // "connected" once the server confirms it over the socket.
    act(() => handlers().onStatus({ t: 'line.status', status: 'connected' }));
    expect(screen.getByRole('heading', { name: /you.re on the call/i })).toBeInTheDocument();

    act(() => handlers().onStatus({ t: 'line.status', status: 'ended' }));
    expect(screen.getByRole('heading', { name: /call ended/i })).toBeInTheDocument();
    expect(audio.stop).toHaveBeenCalled();
  });

  it('mic denied: shows a clear message, sends line.hangup, and never answers', async () => {
    const { socket, handlers } = mockSocket();
    vi.mocked(startLineAudio).mockRejectedValue(new DOMException('blocked', 'NotAllowedError'));
    renderLinePage();
    act(() => handlers().onStatus({ t: 'line.status', status: 'ringing' }));

    fireEvent.click(screen.getByRole('button', { name: /answer/i }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /microphone blocked/i })).toBeInTheDocument(),
    );
    expect(screen.getByText(/microphone access is blocked/i)).toBeInTheDocument();
    expect(socket.hangup).toHaveBeenCalled();
    expect(socket.answer).not.toHaveBeenCalled();
  });

  it('addModule failure gets its own message, distinct from the mic message', async () => {
    const { handlers } = mockSocket();
    vi.mocked(startLineAudio).mockRejectedValue(new AudioEngineLoadError(new Error('boom')));
    renderLinePage();
    act(() => handlers().onStatus({ t: 'line.status', status: 'ringing' }));

    fireEvent.click(screen.getByRole('button', { name: /answer/i }));
    await waitFor(() =>
      expect(screen.getByText(/audio engine failed to load/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/microphone access is blocked/i)).not.toBeInTheDocument();
  });

  it('aborts the answer if the call moved on while the mic was still loading', async () => {
    const { socket, handlers } = mockSocket();
    let resolveAudio!: (audio: FakeLineAudio) => void;
    vi.mocked(startLineAudio).mockImplementation(
      () => new Promise((resolve) => (resolveAudio = resolve)),
    );
    renderLinePage();
    act(() => handlers().onStatus({ t: 'line.status', status: 'ringing' }));

    fireEvent.click(screen.getByRole('button', { name: /answer/i }));
    await waitFor(() => expect(startLineAudio).toHaveBeenCalled());

    // The caller hangs up (or the 60 s ring times out) while we're still
    // waiting on the mic permission prompt.
    act(() => handlers().onStatus({ t: 'line.status', status: 'ended' }));

    const audio = fakeLineAudio();
    await act(async () => resolveAudio(audio));

    expect(audio.stop).toHaveBeenCalled();
    expect(socket.answer).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: /call ended/i })).toBeInTheDocument();
  });
});

describe('LinePage close codes', () => {
  it('4000: shows "opened on another device" with no reconnect button', () => {
    const { handlers } = mockSocket();
    renderLinePage();
    act(() => handlers().onClose({ code: 4000, wasClean: true }));
    expect(screen.getByText(/this line was opened on another device/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reconnect/i })).not.toBeInTheDocument();
  });

  it('4410: shows "practice line expired" with no reconnect button', () => {
    const { handlers } = mockSocket();
    renderLinePage();
    act(() => handlers().onClose({ code: 4410, wasClean: true }));
    expect(screen.getByText(/this practice line expired/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reconnect/i })).not.toBeInTheDocument();
  });

  it('1000 after ended: no error shown', () => {
    const { handlers } = mockSocket();
    renderLinePage();
    act(() => handlers().onStatus({ t: 'line.status', status: 'ended' }));
    act(() => handlers().onClose({ code: 1000, wasClean: true }));
    expect(screen.getByRole('heading', { name: /call ended/i })).toBeInTheDocument();
    expect(screen.queryByText(/connection lost/i)).not.toBeInTheDocument();
  });

  it('1000 while not ended is still treated as abnormal', () => {
    const { handlers } = mockSocket();
    renderLinePage();
    act(() => handlers().onStatus({ t: 'line.status', status: 'waiting' }));
    act(() => handlers().onClose({ code: 1000, wasClean: true }));
    expect(screen.getByText(/connection lost/i)).toBeInTheDocument();
  });

  it('any other abnormal code: "Connection lost." with a working reconnect button', () => {
    const { handlers } = mockSocket();
    renderLinePage();
    act(() => handlers().onClose({ code: 1006, wasClean: false }));
    expect(screen.getByText(/connection lost/i)).toBeInTheDocument();
    const reconnectBtn = screen.getByRole('button', { name: /reconnect/i });

    const callsBefore = vi.mocked(connectLineSocket).mock.calls.length;
    fireEvent.click(reconnectBtn);
    expect(vi.mocked(connectLineSocket).mock.calls.length).toBeGreaterThan(callsBefore);
    expect(screen.queryByText(/connection lost/i)).not.toBeInTheDocument();
  });
});

describe('LinePage page-hide handling', () => {
  it('pagehide hangs up immediately: stops the mic and tells the server', async () => {
    const { socket, handlers } = mockSocket();
    const audio = fakeLineAudio();
    vi.mocked(startLineAudio).mockResolvedValue(audio);
    renderLinePage();
    act(() => handlers().onStatus({ t: 'line.status', status: 'ringing' }));
    fireEvent.click(screen.getByRole('button', { name: /answer/i }));
    await waitFor(() => expect(socket.answer).toHaveBeenCalled());

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(audio.stop).toHaveBeenCalled();
    expect(socket.hangup).toHaveBeenCalled();
  });

  it('backgrounding for 20s while connected hangs up', async () => {
    vi.useFakeTimers();
    const { socket, handlers } = mockSocket();
    const audio = fakeLineAudio();
    vi.mocked(startLineAudio).mockResolvedValue(audio);
    renderLinePage();
    act(() => handlers().onStatus({ t: 'line.status', status: 'ringing' }));
    fireEvent.click(screen.getByRole('button', { name: /answer/i }));
    await vi.waitFor(() => expect(socket.answer).toHaveBeenCalled());
    act(() => handlers().onStatus({ t: 'line.status', status: 'connected' }));

    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    act(() => document.dispatchEvent(new Event('visibilitychange')));

    act(() => vi.advanceTimersByTime(19_999));
    expect(audio.stop).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(2));
    expect(audio.stop).toHaveBeenCalled();
    expect(socket.hangup).toHaveBeenCalled();
  });

  it('coming back visible before 20s cancels the hang-up', async () => {
    vi.useFakeTimers();
    const { socket, handlers } = mockSocket();
    const audio = fakeLineAudio();
    vi.mocked(startLineAudio).mockResolvedValue(audio);
    renderLinePage();
    act(() => handlers().onStatus({ t: 'line.status', status: 'ringing' }));
    fireEvent.click(screen.getByRole('button', { name: /answer/i }));
    await vi.waitFor(() => expect(socket.answer).toHaveBeenCalled());
    act(() => handlers().onStatus({ t: 'line.status', status: 'connected' }));

    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    act(() => vi.advanceTimersByTime(5_000));

    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    act(() => document.dispatchEvent(new Event('visibilitychange')));

    act(() => vi.advanceTimersByTime(30_000));
    expect(audio.stop).not.toHaveBeenCalled();
    expect(socket.hangup).not.toHaveBeenCalled();
  });

  it('backgrounding while only ringing (not connected) does not start the timer', () => {
    vi.useFakeTimers();
    const { socket, handlers } = mockSocket();
    renderLinePage();
    act(() => handlers().onStatus({ t: 'line.status', status: 'ringing' }));

    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    act(() => vi.advanceTimersByTime(30_000));

    expect(socket.hangup).not.toHaveBeenCalled();
  });
});
