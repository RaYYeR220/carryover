import { render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LandingPage from '../../src/landing/LandingPage';

function renderLanding() {
  const router = createMemoryRouter([{ path: '/', element: <LandingPage /> }], {
    initialEntries: ['/'],
  });
  render(<RouterProvider router={router} />);
}

function mockReducedMotion(matches: boolean) {
  vi.mocked(window.matchMedia).mockImplementation(
    (q: string) =>
      ({
        matches: matches && q.includes('reduce'),
        media: q,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

afterEach(() => {
  mockReducedMotion(false);
});

describe('LandingPage: claim and CTAs', () => {
  it('renders the claim and subline', () => {
    renderLanding();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Calls you can see.' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Carryover joins an ordinary phone call and speaks for you\./),
    ).toBeInTheDocument();
  });

  it('"Try a call" (nav and hero) links to /app/new', () => {
    renderLanding();
    const tryLinks = screen.getAllByRole('link', { name: /Try a call/ });
    expect(tryLinks.length).toBeGreaterThanOrEqual(2);
    for (const link of tryLinks) expect(link).toHaveAttribute('href', '/app/new');
  });

  it('"How it works" (hero) points at the #how anchor', () => {
    renderLanding();
    const link = screen.getAllByRole('link', { name: 'How it works' })[0];
    expect(link).toHaveAttribute('href', '#how');
  });

  it('"Watch a sample call" links to /app/sample', () => {
    renderLanding();
    expect(screen.getByRole('link', { name: 'Watch a sample call' })).toHaveAttribute(
      'href',
      '/app/sample',
    );
  });

  it('the practice line CTA "Start a practice call" links to /app/new?to=practice', () => {
    renderLanding();
    expect(screen.getByRole('link', { name: /Start a practice call/ })).toHaveAttribute(
      'href',
      '/app/new?to=practice',
    );
  });

  it('labels the practice QR as illustrative', () => {
    renderLanding();
    expect(screen.getByRole('img', { name: /Example QR code/ })).toBeInTheDocument();
    expect(
      screen.getByText(/Example code — your real code appears when you start a practice call\./),
    ).toBeInTheDocument();
  });

  it('names AssemblyAI in the technology band', () => {
    renderLanding();
    const band = within(screen.getByRole('region', { name: 'Technology' }));
    expect(band.getByText('AssemblyAI')).toBeInTheDocument();
  });
});

describe('LandingPage: reduced motion', () => {
  it('freezes the hero on a calm frame and never applies the pickup-flash class', () => {
    mockReducedMotion(true);
    renderLanding();
    const device = screen.getByTestId('hero-device');
    expect(device).not.toHaveClass('flash');
    expect(device).not.toHaveAttribute('data-phase', 'pickup');
  });
});
