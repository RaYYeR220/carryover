import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SamplePlayer from '../../src/sample/SamplePlayer';

function setup() {
  return render(<SamplePlayer />, {
    wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter>,
  });
}

const play = () => fireEvent.click(screen.getByRole('button', { name: 'Play' }));
const pause = () => fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
const replay = () => fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const position = () => screen.getByRole('slider', { name: 'Sample call position' });
// Captions render one <span> per word, so a sentence is never one text node:
// read the whole log instead of matching text split across elements.
const transcript = () => screen.getByRole('log').textContent ?? '';

describe('SamplePlayer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts paused, at the start of the script', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(position()).toHaveAttribute('aria-valuenow', '0');
  });

  it('shows the "Sample call · scripted" banner', () => {
    setup();
    expect(
      screen.getByText(/scripted — hold time is shortened for this preview/),
    ).toBeInTheDocument();
  });

  it('play advances the clock and dispatches scripted events', () => {
    setup();
    play();
    advance(10_000);
    expect(transcript()).toMatch(/For prescriptions, press 2/);
    expect(Number(position().getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  });

  it('pause stops the clock', () => {
    setup();
    play();
    advance(10_000);
    const at = position().getAttribute('aria-valuenow');
    pause();
    advance(60_000);
    expect(position()).toHaveAttribute('aria-valuenow', at);
    expect(transcript()).not.toMatch(/Hi Maya, this is Dana/);
  });

  it('play resumes from where it paused', () => {
    setup();
    play();
    advance(10_000);
    pause();
    advance(60_000);
    play();
    advance(30_000);
    expect(transcript()).toMatch(/Hi Maya, this is Dana/);
  });

  it('replay starts the script over', () => {
    setup();
    play();
    advance(35_000);
    expect(transcript()).toMatch(/Hi Maya, this is Dana/);
    replay();
    expect(position()).toHaveAttribute('aria-valuenow', '0');
    expect(transcript()).not.toMatch(/Hi Maya, this is Dana/);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });

  it('plays through to the end and shows the summary', () => {
    setup();
    play();
    advance(70_000);
    expect(
      screen.getByRole('heading', { name: 'Your refill is ready Thursday.' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
  });

  it('clicking Share on the ask card advances the script past the wait', () => {
    setup();
    play();
    // Just after the ask appears, well before its scripted 4.85 s resolution.
    advance(45_000);
    const shareBtn = screen.getByRole('button', { name: /Share/ });
    fireEvent.click(shareBtn);
    expect(screen.getByText('March 14, 1952.')).toBeInTheDocument();
  });

  it('typing in the composer shows the text said for you after a short delay', () => {
    setup();
    play();
    // Well past pickup, so the composer is live and no ask is open.
    advance(34_500);
    const box = screen.getByRole('textbox', { name: /what carryover should say/i });
    fireEvent.change(box, { target: { value: 'One more thing.' } });
    fireEvent.submit(box.closest('form') as HTMLFormElement);
    expect(screen.queryByText('One more thing.')).not.toBeInTheDocument();
    advance(1_200);
    expect(screen.getByText('One more thing.')).toBeInTheDocument();
  });
});
