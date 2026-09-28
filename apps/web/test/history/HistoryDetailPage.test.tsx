import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HistoryDetailPage from '../../src/history/HistoryDetailPage';
import type { HistoryEntry } from '../../src/lib/store';
import { history } from '../../src/lib/store';

const ENTRY: HistoryEntry = {
  callId: 'call1',
  startedAt: 1_760_000_000_000,
  endedAt: 1_760_000_090_000,
  targetLabel: 'Riverside Pharmacy',
  outcome: 'Refill ready Thursday',
  bullets: ['Ready after 2 pm', 'Reference 4471'],
  commitments: [{ text: 'Pick up lisinopril', when: 'Thursday after 2 pm' }],
  transcript: [
    { at: 1_760_000_010_000, who: 'them', person: 1, text: 'Riverside Pharmacy, this is Dana.' },
    { at: 1_760_000_020_000, who: 'agent', text: 'Checking on a refill.', source: 'relay' },
    { at: 1_760_000_030_000, who: 'user-note', text: 'Dana put me on hold.' },
  ],
  target: { kind: 'line', code: 'ABC123' },
  mode: 'assist',
};

function renderPage(callId: string) {
  const router = createMemoryRouter(
    [
      { path: '/app/history', element: <p>history list</p> },
      { path: '/app/history/:callId', element: <HistoryDetailPage /> },
    ],
    { initialEntries: [`/app/history/${callId}`] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(async () => {
  localStorage.clear();
  await history.save(ENTRY);
});

describe('HistoryDetailPage', () => {
  it('shows the summary, bullets, commitments and transcript', async () => {
    renderPage('call1');
    expect(
      await screen.findByRole('heading', { name: 'Refill ready Thursday' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Ready after 2 pm')).toBeInTheDocument();
    expect(screen.getByText('Pick up lisinopril')).toBeInTheDocument();
    // "Checking on a refill." appears twice by design: once in "Everything
    // said for you" (agent lines only) and once in the full transcript.
    expect(screen.getAllByText('Checking on a refill.').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Dana put me on hold.')).toBeInTheDocument();
  });

  it('shows a not-found message for an unknown call id', async () => {
    renderPage('nope');
    expect(await screen.findByRole('heading', { name: 'Call not found' })).toBeInTheDocument();
  });

  it('deletes the call and returns to the list', async () => {
    const user = userEvent.setup();
    const router = renderPage('call1');
    await screen.findByRole('heading', { name: 'Refill ready Thursday' });
    await user.click(screen.getByRole('button', { name: 'Delete this call' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/history'));
    expect(await history.get('call1')).toBeUndefined();
  });

  describe('Add to calendar', () => {
    let createObjectURL: ReturnType<typeof vi.fn>;
    let revokeObjectURL: ReturnType<typeof vi.fn>;
    let clickSpy: ReturnType<typeof vi.spyOn>;
    let clicked: { download: string; href: string }[];

    beforeEach(() => {
      clicked = [];
      createObjectURL = vi.fn(() => 'blob:mock-url');
      revokeObjectURL = vi.fn();
      URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
      URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
      clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(function mockClick(this: HTMLAnchorElement) {
          clicked.push({ download: this.download, href: this.href });
        });
    });

    afterEach(() => {
      clickSpy.mockRestore();
    });

    it('downloads a .ics file built from a text/calendar blob', async () => {
      const user = userEvent.setup();
      renderPage('call1');
      await screen.findByRole('heading', { name: 'Refill ready Thursday' });

      await user.click(screen.getByRole('button', { name: 'Add to calendar' }));

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('text/calendar');

      expect(clicked).toHaveLength(1);
      expect(clicked[0]?.download).toBe('riverside-pharmacy.ics');
      expect(clicked[0]?.href).toBe('blob:mock-url');
    });
  });
});
