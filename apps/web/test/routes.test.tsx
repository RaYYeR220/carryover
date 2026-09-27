import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, matchRoutes, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '../src/routes';

const leaf = (path: string) => matchRoutes(routes, path)?.at(-1)?.route.path;

describe('routes', () => {
  it('maps every page route', () => {
    expect(leaf('/')).toBe('/');
    expect(leaf('/app/new')).toBe('/app/new');
    expect(leaf('/app/call/abc')).toBe('/app/call/:callId');
    expect(leaf('/app/sample')).toBe('/app/sample');
    expect(leaf('/app/history')).toBe('/app/history');
    expect(leaf('/app/history/abc')).toBe('/app/history/:callId');
    expect(leaf('/app/profile')).toBe('/app/profile');
    expect(leaf('/line/ABC123')).toBe('/line/:code');
    expect(leaf('/nope')).toBe('*');
  });

  it('redirects /app to /app/new', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/app'] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/new'));
  });

  it('shows a not-found page for unknown paths', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/nope'] });
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole('heading', { name: 'Nothing here.' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start a call' })).toHaveAttribute('href', '/app/new');
  });

  it('includes the /_ui showcase only in development', () => {
    expect(import.meta.env.DEV).toBe(true);
    expect(leaf('/_ui')).toBe('/_ui');
  });
});
