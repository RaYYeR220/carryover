import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from '../../src/call/Composer';
import { QUICK_REPLIES, QuickReplies } from '../../src/call/QuickReplies';

const box = () => screen.getByRole('textbox', { name: 'What Carryover should say for you' });

describe('Composer', () => {
  it('never sends empty or whitespace-only text', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    await user.click(screen.getByRole('button', { name: 'Speak this' }));
    await user.type(box(), ' {Enter}');
    await user.type(box(), '{Shift>}{Enter}{/Shift}\t {Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('sends on Enter, trimmed, and clears', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    await user.type(box(), '  Thursday works.  {Enter}');
    expect(onSend).toHaveBeenCalledExactlyOnceWith('Thursday works.');
    expect(box()).toHaveValue('');
  });

  it('keeps Shift+Enter as a new line', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    await user.type(box(), 'One{Shift>}{Enter}{/Shift}Two');
    expect(onSend).not.toHaveBeenCalled();
    expect(box()).toHaveValue('One\nTwo');
    await user.click(screen.getByRole('button', { name: 'Speak this' }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith('One\nTwo');
  });

  it('does not send while an IME is composing', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    fireEvent.change(box(), { target: { value: 'にほん' } });
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('lets a long paste through whole; the server splits it', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const long = `${'This is a long sentence that keeps going. '.repeat(20)}End.`;
    expect(long.length).toBeGreaterThan(500);
    await user.click(box());
    await user.paste(long);
    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledExactlyOnceWith(long.trim());
  });

  it('is disabled when the call cannot take text', () => {
    render(<Composer onSend={() => {}} disabled />);
    expect(box()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Speak this' })).toBeDisabled();
  });

  it('defaults to the say.text cap of 2000 characters', () => {
    render(<Composer onSend={() => {}} />);
    expect(box()).toHaveAttribute('maxLength', '2000');
  });

  it('clips to a lower maxLength, e.g. answer.text’s 500-char cap', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer onSend={onSend} maxLength={500} />);
    expect(box()).toHaveAttribute('maxLength', '500');
    await user.click(box());
    await user.paste('x'.repeat(600));
    expect((box() as HTMLTextAreaElement).value).toHaveLength(500);
    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledExactlyOnceWith('x'.repeat(500));
  });
});

describe('QuickReplies', () => {
  it('sends exactly each label', async () => {
    const user = userEvent.setup();
    const onSay = vi.fn();
    render(<QuickReplies onSay={onSay} />);
    for (const label of QUICK_REPLIES) {
      await user.click(screen.getByRole('button', { name: label }));
    }
    expect(onSay.mock.calls.map((c) => c[0])).toEqual([
      'Yes',
      'No',
      'Please repeat that',
      'One moment',
      'Please speak slower',
    ]);
  });
});
