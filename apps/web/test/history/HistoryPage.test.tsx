import type { CallSummary } from '@carryover/protocol';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import HistoryPage from '../../src/history/HistoryPage';
import { type HistoryEntry, history } from '../../src/lib/store';

const summary = (callId: string, startedAt: number): CallSummary => ({
  callId,
  startedAt,
  endedAt: startedAt + 90_000,
  targetLabel: 'Riverside Pharmacy',
  outcome: 'Refill ready Thursday',
  bullets: ['Ready after 2 pm'],
  commitments: [{ text: 'Pick up lisinopril', when: 'Thursday after 2 pm' }],
  transcript: [],
});

const entry = (callId: string, startedAt: number): HistoryEntry => ({
  ...summary(callId, startedAt),
  target: { kind: 'scenario', scenarioId: 'riverside-pharmacy' },
  mode: 'assist',
});

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/app/history', element: <HistoryPage /> },
      { path: '/app/history/:callId', element: <p>detail page</p> },
    ],
    { initialEntries: ['/app/history'] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  localStorage.clear();
});

describe('HistoryPage', () => {
  it('shows an empty state with a link to start a call', async () => {
    renderPage();
    expect(await screen.findByText('No calls yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start a call' })).toHaveAttribute('href', '/app/new');
  });

  it('lists calls newest first with target, date, outcome and commitment count', async () => {
    await history.save(entry('a', 1_760_000_000_000));
    await history.save({ ...entry('b', 1_760_000_100_000), outcome: 'Confirmed the hours' });
    renderPage();
    const list = await screen.findByRole('list');
    const rows = within(list).getAllByRole('link');
    // The row link's accessible name includes the target, subtitle, outcome and meta text.
    expect(rows[0]).toHaveTextContent('Confirmed the hours');
    expect(rows[0]).toHaveTextContent('Riverside Pharmacy');
    expect(rows[0]).toHaveTextContent('simulated line');
    expect(rows[0]).toHaveTextContent('1 commitment');
    expect(rows[1]).toHaveTextContent('Refill ready Thursday');
  });

  it('deletes a call from the list', async () => {
    const user = userEvent.setup();
    await history.save(entry('a', 1000));
    renderPage();
    await screen.findByText('Refill ready Thursday');
    await user.click(screen.getByRole('button', { name: /Delete the call with/ }));
    await waitFor(() => expect(screen.queryByText('Refill ready Thursday')).toBeNull());
    expect(await history.get('a')).toBeUndefined();
  });

  it('links each row to its detail page', async () => {
    await history.save(entry('call-xyz', 1000));
    const router = renderPage();
    const user = userEvent.setup();
    await screen.findByText('Refill ready Thursday');
    await user.click(screen.getByRole('link', { name: /Riverside Pharmacy/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/history/call-xyz'));
  });
});
