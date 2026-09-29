import { render, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { CallSocket } = vi.hoisted(() => ({
  CallSocket: vi.fn().mockImplementation(() => ({ send: vi.fn(), close: vi.fn() })),
}));
vi.mock('../../src/lib/callSocket', () => ({ CallSocket }));

vi.mock('../../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, getCall: vi.fn().mockRejectedValue(new Error('not exercised')) },
  };
});

import { loadCallToken, saveCallToken } from '../../src/lib/store';

const { default: CallPage } = await import('../../src/call/CallPage');

function renderCallPage(initialPath: string) {
  const router = createMemoryRouter([{ path: '/app/call/:callId', Component: CallPage }], {
    initialEntries: [initialPath],
  });
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe('CallPage: token arriving in the URL (the MCP watchUrl)', () => {
  it('saves the token from the query string, opens the socket with it, and strips it from the URL', async () => {
    const router = renderCallPage('/app/call/call123?token=secret-token');

    await waitFor(() =>
      expect(CallSocket).toHaveBeenCalledWith('call123', 'secret-token', expect.anything()),
    );
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(router.state.location.pathname).toBe('/app/call/call123');
    expect(loadCallToken('call123')).toBe('secret-token');
  });

  it('uses the token already in sessionStorage and leaves a plain URL alone', async () => {
    saveCallToken('call123', 'stored-token');
    const router = renderCallPage('/app/call/call123');

    await waitFor(() =>
      expect(CallSocket).toHaveBeenCalledWith('call123', 'stored-token', expect.anything()),
    );
    expect(router.state.location.search).toBe('');
  });
});
