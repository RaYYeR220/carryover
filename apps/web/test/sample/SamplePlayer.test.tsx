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

  it('autoplays about 600 ms after mount, with no interaction', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    advance(600);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    advance(1_000);
    expect(Number(position().getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  });

  it('clicking Share on the ask card resolves "shared" and says the profile fact', () => {
    setup();
    play();
    // Just after the ask appears, well before its scripted resolution.
    advance(45_000);
    const shareBtn = screen.getByRole('button', { name: /Share/ });
    fireEvent.click(shareBtn);
    expect(screen.getByText('March 14, 1952.')).toBeInTheDocument();
    expect(transcript()).toMatch(/You shared/);
  });

  it('typing an answer on the ask card says exactly what was typed, and resolves "typed"', () => {
    setup();
    play();
    advance(45_000);
    fireEvent.click(screen.getByRole('button', { name: 'Type an answer' }));
    const box = screen.getByRole('textbox', { name: /what carryover should say/i });
    fireEvent.change(box, { target: { value: 'The 14th of March, 1952' } });
    fireEvent.submit(box.closest('form') as HTMLFormElement);
    expect(screen.getByText('The 14th of March, 1952')).toBeInTheDocument();
    expect(screen.queryByText('March 14, 1952.')).not.toBeInTheDocument();
  });

  it('declining says sorry, resolves "declined", and Dana offers another way', () => {
    setup();
    play();
    advance(45_000);
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(screen.getByText('Sorry, Maya would prefer not to share that.')).toBeInTheDocument();
    expect(transcript()).toMatch(/You declined/);
    // Past Dana's next line (D3), which opens with the alternate line B scripts for a decline.
    advance(5_000);
    expect(transcript()).toMatch(/No problem, I can use her phone number\./);
    expect(screen.queryByText('March 14, 1952.')).not.toBeInTheDocument();
  });

  it('replaying after declining goes back to the default share branch', () => {
    setup();
    play();
    advance(45_000);
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    // Still mid-call (not ended), so there's only one "Replay" button on screen.
    advance(5_000);
    replay();
    advance(70_000);
    // The caption log and the summary sheet's "said for you" list both show
    // it once the call ends; either way, the fresh play was share, not decline.
    expect(screen.getAllByText('March 14, 1952.').length).toBeGreaterThan(0);
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
