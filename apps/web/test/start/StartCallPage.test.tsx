import type { ScenarioInfo } from '@carryover/protocol';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api')>();
  return {
    ...actual,
    api: {
      health: vi.fn(),
      scenarios: vi.fn(),
      createLine: vi.fn(),
      getLine: vi.fn(),
      startCall: vi.fn(),
      getCall: vi.fn(),
    },
  };
});

import { ApiError, api } from '../../src/lib/api';
import { vault } from '../../src/lib/store';
import { resetSeedState } from '../../src/profile/seed';
import StartCallPage from '../../src/start/StartCallPage';

const SCENARIO: ScenarioInfo = {
  id: 'riverside-pharmacy',
  label: 'Riverside Pharmacy',
  business: 'Pharmacy',
  description: 'A pharmacy that answers after a short hold.',
  suggestedGoal: 'Check on my lisinopril refill',
  suggestedAutonomy: 'assist',
};

const LINE = {
  code: 'ABC123',
  url: 'https://carryover.app/line/ABC123',
  qrSvg: '<svg><rect/></svg>',
  status: 'waiting' as const,
};

function renderPage(initialPath = '/app/new') {
  const router = createMemoryRouter(
    [
      { path: '/app/new', element: <StartCallPage /> },
      { path: '/app/call/:callId', element: <p>on call screen</p> },
    ],
    { initialEntries: [initialPath] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  resetSeedState();
  vi.mocked(api.scenarios).mockResolvedValue([SCENARIO]);
  vi.mocked(api.createLine).mockResolvedValue(LINE);
  vi.mocked(api.getLine).mockResolvedValue(LINE);
  vi.mocked(api.startCall).mockResolvedValue({ callId: 'call1', appToken: 'tok1' });
  await vault.save({ key: 'name', label: 'Name', value: 'Maya Chen' });
  await vault.save({ key: 'dob', label: 'Date of birth', value: 'March 14, 1952' });
  await vault.save({ key: 'member_id', label: 'Member ID', value: '40718233' });
});

describe('StartCallPage: destinations', () => {
  it('defaults to the first scenario, with name and dob pre-shared', async () => {
    renderPage();
    expect(await screen.findByRole('radio', { name: /Riverside Pharmacy/ })).toBeChecked();
    expect(screen.getByRole('button', { name: /^Name/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^Date of birth/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: /^Member ID/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('?to=practice preselects the practice line and shows its code and status', async () => {
    renderPage('/app/new?to=practice');
    expect(await screen.findByRole('radio', { name: /Practice line/ })).toBeChecked();
    expect(await screen.findByText('ABC123')).toBeInTheDocument();
    expect(await screen.findByText(/WAITING FOR PHONE/)).toBeInTheDocument();
  });
});

describe('StartCallPage: starting a call', () => {
  it('builds the request exactly from the selections and navigates to the call', async () => {
    const user = userEvent.setup();
    const router = renderPage();
    await screen.findByRole('radio', { name: /Riverside Pharmacy/ });

    await user.click(screen.getByRole('button', { name: 'Call Riverside Pharmacy' }));

    await waitFor(() => expect(api.startCall).toHaveBeenCalled());
    expect(api.startCall).toHaveBeenCalledWith({
      target: { kind: 'scenario', scenarioId: 'riverside-pharmacy' },
      userName: 'Maya Chen',
      userDescriptor: 'deaf',
      autonomy: 'assist',
      goal: 'Check on my lisinopril refill',
      facts: [
        { key: 'name', label: 'Name', value: 'Maya Chen' },
        { key: 'dob', label: 'Date of birth', value: 'March 14, 1952' },
      ],
      voice: 'alba',
    });

    await waitFor(() => expect(router.state.location.pathname).toBe('/app/call/call1'));
    expect(sessionStorage.getItem('carryover.token.call1')).toBe('tok1');
    const meta = JSON.parse(sessionStorage.getItem('carryover.call.call1') ?? '{}');
    expect(meta).toMatchObject({
      target: { kind: 'scenario', scenarioId: 'riverside-pharmacy' },
      autonomy: 'assist',
      shared: ['name', 'dob'],
    });
  });

  it('sends only the facts toggled on', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('radio', { name: /Riverside Pharmacy/ });

    await user.click(screen.getByRole('button', { name: /^Date of birth/ }));
    await user.click(screen.getByRole('button', { name: /^Member ID/ }));
    await user.click(screen.getByRole('button', { name: 'Call Riverside Pharmacy' }));

    await waitFor(() => expect(api.startCall).toHaveBeenCalled());
    const req = vi.mocked(api.startCall).mock.calls[0]?.[0];
    expect(req?.facts.map((f) => f.key)).toEqual(['name', 'member_id']);
  });

  it('places the practice call at the line once a code exists', async () => {
    const user = userEvent.setup();
    const router = renderPage('/app/new?to=practice');
    await screen.findByText('ABC123');

    await user.click(screen.getByRole('button', { name: 'Call Practice line' }));

    await waitFor(() => expect(api.startCall).toHaveBeenCalled());
    expect(api.startCall).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: 'line', code: 'ABC123' } }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/call/call1'));
  });

  it('shows a 429 error inline and does not navigate', async () => {
    const user = userEvent.setup();
    vi.mocked(api.startCall).mockRejectedValue(
      new ApiError(429, 'Too many calls from this address'),
    );
    const router = renderPage();
    await screen.findByRole('radio', { name: /Riverside Pharmacy/ });

    await user.click(screen.getByRole('button', { name: 'Call Riverside Pharmacy' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many calls from this address');
    expect(router.state.location.pathname).toBe('/app/new');
  });
});
