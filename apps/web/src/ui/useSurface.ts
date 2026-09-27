import { useEffect } from 'react';

export type Surface = 'paper' | 'night';

/** Sets the page surface (body background, text colour and focus ring) while mounted. */
export function useSurface(surface: Surface): void {
  useEffect(() => {
    const body = document.body;
    const prev = body.dataset.surface;
    body.dataset.surface = surface;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const prevTheme = meta?.content;
    if (meta) meta.content = surface === 'night' ? '#000000' : '#F4F4F4';
    return () => {
      if (prev) body.dataset.surface = prev;
      else delete body.dataset.surface;
      if (meta && prevTheme) meta.content = prevTheme;
    };
  }, [surface]);
}
