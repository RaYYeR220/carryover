import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../lib/api';

export type PracticeStatus = 'waiting' | 'ringing' | 'connected' | 'ended';

export interface PracticeLineState {
  code?: string;
  url?: string;
  qrSvg?: string;
  status?: PracticeStatus;
  loading: boolean;
  error?: string;
}

const POLL_MS = 2000;

/**
 * Creates a practice line while `active`, then polls `GET /api/lines/:code`
 * every 2 s so the page can show waiting / ringing / connected. `regenerate`
 * creates a fresh line (the old one ended, or the request failed).
 */
export function usePracticeLine(active: boolean): PracticeLineState & { regenerate: () => void } {
  const [state, setState] = useState<PracticeLineState>({ loading: false });
  const [nonce, setNonce] = useState(0);
  const regenerate = () => setNonce((n) => n + 1);

  // Create the line. `nonce` lets `regenerate()` force a fresh one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce is a deliberate re-run trigger
  useEffect(() => {
    if (!active) return;
    const ac = new AbortController();
    setState({ loading: true });
    api
      .createLine({ signal: ac.signal })
      .then((line) => {
        setState({
          code: line.code,
          url: line.url,
          qrSvg: line.qrSvg,
          status: line.status,
          loading: false,
        });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setState({
          loading: false,
          error: err instanceof ApiError ? err.message : 'Couldn’t start a practice line.',
        });
      });
    return () => ac.abort();
  }, [active, nonce]);

  // Poll its status.
  const code = state.code;
  const endedRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets the "seen ended" flag whenever the code changes (a fresh line)
  useEffect(() => {
    endedRef.current = false;
  }, [code]);
  useEffect(() => {
    if (!active || !code) return;
    let cancelled = false;
    const tick = () => {
      if (endedRef.current) return;
      api
        .getLine(code)
        .then((line) => {
          if (cancelled) return;
          if (line.status === 'ended') endedRef.current = true;
          setState((s) => (s.code === code ? { ...s, status: line.status } : s));
        })
        .catch(() => {
          // Transient network hiccup; the next tick tries again.
        });
    };
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, code]);

  return { ...state, regenerate };
}
