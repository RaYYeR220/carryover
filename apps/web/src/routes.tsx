import type { ComponentType } from 'react';
import { Navigate, type RouteObject } from 'react-router';
import { NotFound, RouteError } from './shell/Fallbacks';
import { RootLayout } from './shell/RootLayout';

type PageModule = { default: ComponentType };

/** Load a page component on first visit. */
const page = (load: () => Promise<PageModule>): RouteObject['lazy'] => ({
  Component: async () => (await load()).default,
});

/** Dev-only primitives showcase, compiled out of production builds. */
const devRoutes: RouteObject[] = import.meta.env.DEV
  ? [{ path: '/_ui', lazy: page(() => import('./dev/UiShowcase')) }]
  : [];

export const routes: RouteObject[] = [
  {
    Component: RootLayout,
    ErrorBoundary: RouteError,
    HydrateFallback: () => null,
    children: [
      { path: '/', lazy: page(() => import('./landing/LandingPage')) },
      { path: '/app', element: <Navigate to="/app/new" replace /> },
      { path: '/app/new', lazy: page(() => import('./start/StartCallPage')) },
      { path: '/app/call/:callId', lazy: page(() => import('./call/CallPage')) },
      { path: '/app/sample', lazy: page(() => import('./sample/SamplePage')) },
      { path: '/app/history', lazy: page(() => import('./history/HistoryPage')) },
      { path: '/app/history/:callId', lazy: page(() => import('./history/HistoryDetailPage')) },
      { path: '/app/profile', lazy: page(() => import('./profile/ProfilePage')) },
      { path: '/line/:code', lazy: page(() => import('./line/LinePage')) },
      ...devRoutes,
      { path: '*', Component: NotFound },
    ],
  },
];
