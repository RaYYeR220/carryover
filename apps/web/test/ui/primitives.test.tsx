import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  Button,
  CAPTION_SIZES,
  LedMatrix,
  Pill,
  QrDots,
  Segmented,
  Sheet,
  Stepper,
  Toast,
} from '../../src/ui';

const MODES = [
  { value: 'relay', label: 'Relay', level: 1 },
  { value: 'assist', label: 'Assist', level: 2 },
  { value: 'auto', label: 'Auto', level: 3 },
] as const;

function Seg() {
  const [v, setV] = useState<'relay' | 'assist' | 'auto'>('assist');
  return <Segmented options={MODES} value={v} onChange={setV} label="How much Carryover does" />;
}

describe('Segmented', () => {
  it('is a radiogroup with one tab stop and arrow/Home/End keys', async () => {
    const user = userEvent.setup();
    render(<Seg />);
    const group = screen.getByRole('radiogroup', { name: 'How much Carryover does' });
    expect(group).toBeInTheDocument();
    const assist = screen.getByRole('radio', { name: 'Assist' });
    expect(assist).toHaveAttribute('aria-checked', 'true');
    expect(assist).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Relay' })).toHaveAttribute('tabindex', '-1');

    assist.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Auto' })).toHaveFocus();
    await user.keyboard('{ArrowRight}'); // wraps
    expect(screen.getByRole('radio', { name: 'Relay' })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{End}');
    expect(screen.getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{Home}');
    expect(screen.getByRole('radio', { name: 'Relay' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('radio', { name: 'Assist' }));
    expect(screen.getByRole('radio', { name: 'Assist' })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('Stepper', () => {
  function Size() {
    const [v, setV] = useState(28);
    return (
      <Stepper
        values={CAPTION_SIZES}
        value={v}
        onChange={setV}
        label="Caption size"
        decreaseLabel="Smaller captions"
        increaseLabel="Larger captions"
        prefix="Aa"
        unit=" pixel captions"
      />
    );
  }

  it('steps through the caption scale and disables at the ends', async () => {
    const user = userEvent.setup();
    render(<Size />);
    const group = screen.getByRole('group', { name: 'Caption size' });
    const up = screen.getByRole('button', { name: 'Larger captions' });
    const down = screen.getByRole('button', { name: 'Smaller captions' });
    expect(group).toHaveTextContent('28 pixel captions');
    await user.click(up);
    await user.click(up);
    expect(group).toHaveTextContent('48 pixel captions');
    expect(up).toBeDisabled();
    for (let i = 0; i < 4; i++) await user.click(down);
    expect(group).toHaveTextContent('20 pixel captions');
    expect(down).toBeDisabled();
  });
});

describe('Sheet', () => {
  function Host({ onClose = () => {} }: { onClose?: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <div id="root">
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
        </div>
        <Sheet
          open={open}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          title="New call"
          description="Carryover calls, you read along."
          footer={<Button>Call</Button>}
          inertSelector="#root"
        >
          <p>Body</p>
        </Sheet>
      </>
    );
  }

  it('opens as an aria-modal dialog, makes the app inert and closes on Esc', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(<Host onClose={onClose} />);
    const root = container.querySelector('#root') as HTMLElement;
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'New call' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('Carryover calls, you read along.');
    expect(root.inert).toBe(true);
    expect(dialog).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(root.inert).toBe(false);
    expect(opener).toHaveFocus();
  });

  it('closes from the close button and the scrim, not from clicks inside', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByText('Body'));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Open' }));
    const scrim = screen.getByRole('dialog').parentElement as HTMLElement;
    fireEvent.mouseDown(scrim);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('Toast', () => {
  it('announces politely and dismisses itself', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { rerender } = render(<Toast message="Copied." onDismiss={onDismiss} duration={1000} />);
    expect(screen.getByRole('status')).toHaveTextContent('Copied.');
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    rerender(<Toast message={null} onDismiss={onDismiss} />);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    vi.useRealTimers();
  });
});

describe('canvas primitives', () => {
  it('render without a 2D context (LED, QR) and stay decorative or labelled', () => {
    const { container, unmount } = render(
      <>
        <LedMatrix scene="live" data={{ name: 'Dana' }} level={1} ring="dim" />
        <QrDots text="https://x.y/line/ABC123" label="QR code for the practice line" />
      </>,
    );
    expect(screen.getByRole('img', { name: 'QR code for the practice line' })).toHaveAttribute(
      'data-qr',
      '29',
    );
    const led = container.querySelector('canvas[aria-hidden="true"]');
    expect(led).toBeInTheDocument();
    unmount();
  });

  it('pill shows its state and label', () => {
    render(<Pill state="hold">HOLD</Pill>);
    const label = screen.getByText('HOLD');
    expect(label.parentElement).toHaveAttribute('data-s', 'hold');
  });
});
