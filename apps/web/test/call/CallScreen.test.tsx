import type { AppCommand, AppEvent, Fact } from '@carryover/protocol';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallScreen, type CallScreenProps } from '../../src/call/CallScreen';
import { type CallView, initialView, reduce } from '../../src/call/state';

const T0 = 1_760_000_000_000;
const VAULT: Fact[] = [
  { key: 'name', label: 'Name', value: 'Maya Collins' },
  { key: 'dob', label: 'Date of birth', value: 'March 14, 1952' },
];

const live = (extra: AppEvent[] = []): CallView =>
  [
    {
      t: 'call.state',
      lineState: 'human',
      autonomy: 'assist',
      since: T0 + 20_000,
      targetLabel: 'Riverside Pharmacy',
    } as AppEvent,
    {
      t: 'caption',
      id: 'c1',
      speaker: { role: 'them', label: 'Dana', person: 1 },
      text: 'Can I get your date of birth, please?',
      words: [],
      final: true,
      at: T0 + 30_000,
    } as AppEvent,
    ...extra,
  ].reduce(reduce, initialView);

const askEvent = (field?: string): AppEvent => ({
  t: 'ask',
  askId: 'a1',
  question: 'Can I get your date of birth, please?',
  ...(field ? { field } : {}),
  from: 'Dana',
  at: T0 + 31_000,
});

function setup(props: Partial<CallScreenProps> & { view: CallView }) {
  const onCommand = vi.fn<(cmd: AppCommand) => void>();
  const wrap = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;
  const utils = render(
    <CallScreen onCommand={onCommand} now={T0 + 32_000} startedAt={T0} vault={VAULT} {...props} />,
    { wrapper: wrap },
  );
  const commands = () => onCommand.mock.calls.map((c) => c[0]);
  return { ...utils, onCommand, commands };
}

afterEach(() => {
  document.title = '';
});

describe('CallScreen: ask card', () => {
  it('is an alertdialog naming who asks and what', () => {
    setup({ view: live([askEvent('dob')]) });
    const card = screen.getByRole('alertdialog', { name: 'Dana asks for your date of birth' });
    expect(card).toHaveTextContent('Can I get your date of birth, please?');
  });

  it('shares the matching profile fact for this call, then answers with it', async () => {
    const user = userEvent.setup();
    const { commands } = setup({ view: live([askEvent('dob')]) });
    await user.click(screen.getByRole('button', { name: /Share “March 14, 1952”/ }));
    expect(commands()).toEqual([
      { t: 'share', fact: VAULT[1] },
      { t: 'answer', askId: 'a1', shareFactKey: 'dob' },
    ]);
  });

  it('declines', async () => {
    const user = userEvent.setup();
    const { commands } = setup({ view: live([askEvent('dob')]) });
    await user.click(screen.getByRole('button', { name: 'Decline' }));
    expect(commands()).toEqual([{ t: 'answer', askId: 'a1', decline: true }]);
  });

  it('types an answer through the composer', async () => {
    const user = userEvent.setup();
    const { commands } = setup({ view: live([askEvent('dob')]) });
    await user.click(screen.getByRole('button', { name: 'Type an answer' }));
    const box = screen.getByRole('textbox', { name: 'What Carryover should say for you' });
    expect(box).toHaveFocus();
    expect(box).toHaveAttribute('placeholder', 'Type your answer for Dana…');
    await user.type(box, 'March 14th{Enter}');
    expect(commands()).toEqual([{ t: 'answer', askId: 'a1', text: 'March 14th' }]);
  });

  it('caps the composer at 500 chars while answering (the protocol’s answer.text limit)', async () => {
    const user = userEvent.setup();
    setup({ view: live([askEvent('dob')]) });
    // Before "Type an answer" is pressed, the composer is for `say` (2000 chars).
    expect(
      screen.getByRole('textbox', { name: 'What Carryover should say for you' }),
    ).toHaveAttribute('maxLength', '2000');
    await user.click(screen.getByRole('button', { name: 'Type an answer' }));
    expect(
      screen.getByRole('textbox', { name: 'What Carryover should say for you' }),
    ).toHaveAttribute('maxLength', '500');
  });

  it('answers with keys 1, 2 and 3', async () => {
    const user = userEvent.setup();
    const { commands } = setup({ view: live([askEvent('dob')]) });
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard('3');
    expect(commands()).toEqual([{ t: 'answer', askId: 'a1', decline: true }]);
  });

  it('does not take shortcut keys while typing', async () => {
    const user = userEvent.setup();
    const { commands } = setup({ view: live([askEvent('dob')]) });
    const box = screen.getByRole('textbox', { name: 'What Carryover should say for you' });
    await user.type(box, '3');
    expect(commands()).toEqual([]);
    expect(box).toHaveValue('3');
  });

  it('offers only type or decline when the profile has no matching fact', () => {
    setup({ view: live([askEvent('member_id')]) });
    expect(screen.queryByRole('button', { name: /Share/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Type an answer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toHaveAccessibleName('Dana asks for your member ID');
  });

  it('goes away once the ask is resolved', () => {
    const view = live([askEvent('dob'), { t: 'ask.resolved', askId: 'a1', how: 'shared' }]);
    setup({ view });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText('You shared your date of birth for this call')).toBeInTheDocument();
  });
});

describe('CallScreen: composer and quick replies', () => {
  it('ignores an empty or whitespace message', async () => {
    const user = userEvent.setup();
    const { commands } = setup({ view: live() });
    const box = screen.getByRole('textbox', { name: 'What Carryover should say for you' });
    await user.type(box, '   {Enter}');
    await user.click(screen.getByRole('button', { name: 'Speak this' }));
    expect(commands()).toEqual([]);
  });

  it('says typed text and clears the box', async () => {
    const user = userEvent.setup();
    const { commands } = setup({ view: live() });
    const box = screen.getByRole('textbox', { name: 'What Carryover should say for you' });
    await user.type(box, '  I’m checking on my refill.  {Enter}');
    expect(commands()).toEqual([{ t: 'say', text: 'I’m checking on my refill.' }]);
    expect(box).toHaveValue('');
  });

  it('sends a quick reply as exactly its label', async () => {
    const user = userEvent.setup();
    const { commands } = setup({ view: live() });
    const group = screen.getByRole('group', { name: 'Quick replies' });
    await user.click(within(group).getByRole('button', { name: 'Please repeat that' }));
    expect(commands()).toEqual([{ t: 'say', text: 'Please repeat that' }]);
  });

  it('re-sends a queued line as urgent from Speak now', async () => {
    const user = userEvent.setup();
    const view = live([
      { t: 'relay.queued', nonce: 'n1', text: 'Thursday works.', reason: 'waiting-for-pause' },
    ]);
    const { commands } = setup({ view });
    expect(screen.getByText('Waiting for Dana to finish…')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Speak now' }));
    expect(commands()).toEqual([{ t: 'say', text: 'Thursday works.', urgent: true }]);
  });
});

describe('CallScreen: top bar', () => {
  it('changes autonomy and hangs up', async () => {
    const user = userEvent.setup();
    const { commands } = setup({ view: live() });
    await user.click(screen.getByRole('radio', { name: 'Auto' }));
    await user.click(screen.getByRole('button', { name: 'End call' }));
    expect(commands()).toEqual([{ t: 'autonomy', value: 'auto' }, { t: 'hangup' }]);
  });

  it('steps the caption size and remembers it', async () => {
    const user = userEvent.setup();
    localStorage.removeItem('carryover.captionSize');
    const { unmount } = setup({ view: live() });
    await user.click(screen.getByRole('button', { name: 'Larger captions' }));
    expect(screen.getByRole('group', { name: 'Caption size' })).toHaveTextContent('36');
    expect(localStorage.getItem('carryover.captionSize')).toBe('36');
    unmount();
    setup({ view: live() });
    expect(screen.getByRole('group', { name: 'Caption size' })).toHaveTextContent('36');
    localStorage.removeItem('carryover.captionSize');
  });

  it('shows the callee, status and call time', () => {
    setup({ view: live() });
    const bar = screen.getByRole('banner');
    expect(bar).toHaveTextContent('Riverside Pharmacy');
    expect(bar).toHaveTextContent('LIVE');
    expect(bar).toHaveTextContent('0:32');
  });
});

describe('CallScreen: captions', () => {
  it('is a log whose live mirror gets finals only', () => {
    const view = live([
      {
        t: 'caption',
        id: 'c2',
        speaker: { role: 'them', label: 'Dana', person: 1 },
        text: 'Your lisinopril will',
        words: [],
        final: false,
        at: T0 + 33_000,
      },
    ]);
    const { container, rerender } = setup({ view });
    const log = screen.getByRole('log', { name: 'Call transcript' });
    expect(log).toHaveTextContent('Your lisinopril will');
    const mirror = container.ownerDocument.querySelector('[data-testid="caption-mirror"]');
    expect(mirror?.textContent ?? '').not.toContain('Your lisinopril will');

    const next = reduce(view, {
      t: 'caption',
      id: 'c2',
      speaker: { role: 'them', label: 'Dana', person: 1 },
      text: 'Your lisinopril will be ready Thursday.',
      words: [],
      final: true,
      at: T0 + 33_000,
    });
    rerender(
      <CallScreen
        onCommand={() => {}}
        now={T0 + 34_000}
        startedAt={T0}
        vault={VAULT}
        view={next}
      />,
    );
    expect(mirror).toHaveTextContent('Dana: Your lisinopril will be ready Thursday.');
  });

  it('marks low-confidence words with a dotted underline', () => {
    const view = live([
      {
        t: 'caption',
        id: 'c2',
        speaker: { role: 'them', label: 'Dana', person: 1 },
        text: 'your lisinopril',
        words: [
          { text: 'your', confidence: 0.97, start: 0, end: 1 },
          { text: 'lisinopril.', confidence: 0.41, start: 1, end: 2 },
        ],
        final: true,
        at: T0 + 33_000,
      },
    ]);
    setup({ view });
    const word = screen.getByTitle('Low confidence: 41%');
    expect(word).toHaveTextContent('lisinopril');
    expect(word.className).toMatch(/\blc\b/);
  });

  it('shows lines said for you with how they came about', () => {
    const view = live([
      {
        t: 'agent.said',
        id: 'r1',
        text: 'One moment, please.',
        source: 'agent',
        interrupted: false,
        at: T0 + 31_500,
      },
    ]);
    setup({ view });
    const said = screen.getByText('One moment, please.', { exact: false });
    expect(said.closest('p')).toHaveTextContent('Said for you· automatic');
  });
});

describe('CallScreen: pickup', () => {
  const pickup = (): CallView =>
    live([{ t: 'alert', kind: 'human-picked-up', message: 'A person picked up', at: T0 + 32_000 }]);

  it('flashes, buzzes and badges the title', () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate });
    setup({ view: pickup() });
    expect(screen.getByTestId('pickup-flash')).toBeInTheDocument();
    expect(vibrate).toHaveBeenCalledWith([200, 100, 200]);
    expect(document.title).toBe('● A person picked up · Carryover');
    expect(screen.getByRole('status', { name: 'A person picked up' })).toBeInTheDocument();
  });

  it('shows a steady frame and banner instead of flashing with reduced motion', () => {
    vi.mocked(window.matchMedia).mockImplementation(
      (q: string) =>
        ({
          matches: q.includes('reduce'),
          media: q,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as MediaQueryList,
    );
    setup({ view: pickup() });
    expect(screen.queryByTestId('pickup-flash')).toBeNull();
    expect(screen.getByTestId('pickup-frame')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'A person picked up' })).toBeInTheDocument();
  });

  it('does not flash for an old pickup replayed on reconnect', () => {
    const view = live([
      { t: 'alert', kind: 'human-picked-up', message: 'A person picked up', at: T0 + 20_000 },
    ]);
    setup({ view, now: T0 + 200_000 });
    expect(screen.queryByTestId('pickup-flash')).toBeNull();
  });
});

describe('CallScreen: ended and unauthorized', () => {
  it('renders the ended panel with links when the token is refused', () => {
    setup({ view: initialView, status: 'unauthorized' });
    expect(screen.getByRole('heading', { name: 'This call has ended' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start a new call' })).toHaveAttribute(
      'href',
      '/app/new',
    );
    expect(screen.getByRole('link', { name: 'Call history' })).toHaveAttribute(
      'href',
      '/app/history',
    );
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('keeps the transcript and swaps the composer for an ended panel', () => {
    const view = live([
      { t: 'alert', kind: 'call-ended', message: 'Call ended: you hung up.', at: T0 + 40_000 },
    ]);
    setup({ view });
    expect(screen.getByRole('log')).toHaveTextContent('Can I get your date of birth');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('This call has ended')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New call' })).toHaveAttribute('href', '/app/new');
  });

  it('says when the connection is lost and offers a retry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    setup({ view: live(), status: 'closed', onRetry });
    await user.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe('CallScreen: summary', () => {
  const summaryView = () =>
    live([
      { t: 'alert', kind: 'call-ended', message: 'Call ended.', at: T0 + 325_000 },
      {
        t: 'summary',
        summary: {
          callId: 'k1',
          startedAt: T0,
          endedAt: T0 + 325_000,
          targetLabel: 'Riverside Pharmacy',
          outcome: 'Your refill is ready Thursday.',
          bullets: ['Ready after 2 pm'],
          commitments: [{ text: 'Pick up lisinopril, ref 4471', when: 'Thursday after 2 pm' }],
          transcript: [
            { at: T0 + 283_000, who: 'agent', text: 'Hi, I’m Carryover.', source: 'disclosure' },
            { at: T0 + 290_000, who: 'them', person: 1, text: 'Hi Maya.' },
            { at: T0 + 294_000, who: 'agent', text: 'I’m checking on my refill.', source: 'relay' },
          ],
        },
      },
    ]);

  it('opens the summary sheet with commitments and everything said for you', () => {
    setup({ view: summaryView() });
    const sheet = screen.getByRole('dialog', { name: 'Your refill is ready Thursday.' });
    expect(sheet).toHaveTextContent('Pick up lisinopril, ref 4471');
    // Quote marks come from CSS (`q` quotes), so the text itself is unquoted.
    expect(sheet).toHaveTextContent('Hi, I’m Carryover.');
    expect(sheet).toHaveTextContent('Introduction, automatic');
    expect(sheet).toHaveTextContent('I’m checking on my refill.You typed');
    expect(sheet).not.toHaveTextContent('Hi Maya.');
  });

  it('downloads an .ics for a commitment', async () => {
    const user = userEvent.setup();
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    setup({ view: summaryView() });
    await user.click(screen.getByRole('button', { name: 'Add to calendar' }));
    expect(create).toHaveBeenCalledTimes(1);
    const blob = (create.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.type).toBe('text/calendar');
    expect(await blob.text()).toContain('SUMMARY:Pick up lisinopril\\, ref 4471');
    expect(click).toHaveBeenCalled();
  });

  it('closes with Esc and can be reopened', async () => {
    const user = userEvent.setup();
    setup({ view: summaryView() });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'View summary' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
