import type { AppCommand, CallTarget, Fact } from '@carryover/protocol';
import { lazy, Suspense, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { api } from '../lib/api';
import { CallSocket, type CallSocketStatus } from '../lib/callSocket';
import { history, loadCallToken, saveCallToken, vault } from '../lib/store';
import { CallScreen } from './CallScreen';
import { loadCallMeta, targetSubtitle } from './meta';
import { initialView, reduce } from './state';

/** Dev-only canned states for screenshot comparison: /app/call/_fixture?state=menu. */
const Fixture = import.meta.env.DEV ? lazy(() => import('./dev/CallFixture')) : null;

/** Used for history when the start page left no record of what was dialled. */
const UNKNOWN_TARGET: CallTarget = { kind: 'scenario', scenarioId: 'unknown' };

export default function CallPage() {
  const { callId = '' } = useParams();
  if (Fixture && callId === '_fixture') {
    return (
      <Suspense fallback={null}>
        <Fixture />
      </Suspense>
    );
  }
  return <LiveCall key={callId} callId={callId} />;
}

function LiveCall({ callId }: { callId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  // A watch link (the MCP place_call tool's watchUrl) carries the token in the query
  // string, since sessionStorage was never populated on this device/tab: pick it up once,
  // save it like a normally-started call would, then strip it from the URL below.
  const [token] = useState(() => {
    const fromQuery = new URLSearchParams(location.search).get('token');
    if (fromQuery) {
      saveCallToken(callId, fromQuery);
      return fromQuery;
    }
    return loadCallToken(callId);
  });
  const [meta] = useState(() => loadCallMeta(callId, location.state));

  // biome-ignore lint/correctness/useExhaustiveDependencies: strip ?token= once, on mount
  useEffect(() => {
    if (new URLSearchParams(location.search).has('token')) {
      navigate(location.pathname, { replace: true });
    }
  }, []);
  const [view, dispatch] = useReducer(reduce, initialView);
  const [status, setStatus] = useState<CallSocketStatus>(token ? 'connecting' : 'unauthorized');
  const [startedAt, setStartedAt] = useState<number>();
  const [facts, setFacts] = useState<Fact[]>([]);
  const [attempt, setAttempt] = useState(0);
  const socket = useRef<CallSocket | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt reconnects
  useEffect(() => {
    if (!token) return;
    const s = new CallSocket(callId, token, { onEvent: dispatch, onStatus: setStatus });
    socket.current = s;
    return () => {
      s.close();
      if (socket.current === s) socket.current = null;
    };
  }, [callId, token, attempt]);

  // The call's real start time, for the timer; the socket alone only knows the current state.
  useEffect(() => {
    if (!token) return;
    const ac = new AbortController();
    api
      .getCall(callId, token, { signal: ac.signal })
      .then((c) => setStartedAt(c.startedAt))
      .catch(() => {
        // The socket reports an ended or unknown call on its own.
      });
    return () => ac.abort();
  }, [callId, token]);

  useEffect(() => {
    let live = true;
    vault
      .list()
      .then((f) => {
        if (live) setFacts(f);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // File the finished call in history once, then stop listening.
  const saved = useRef(false);
  useEffect(() => {
    const summary = view.summary;
    if (!summary || saved.current) return;
    saved.current = true;
    history
      .save({ ...summary, target: meta?.target ?? UNKNOWN_TARGET, mode: view.autonomy })
      .catch(() => {});
    socket.current?.close();
  }, [view.summary, view.autonomy, meta]);

  const onCommand = useCallback((cmd: AppCommand) => socket.current?.send(cmd), []);
  const onRetry = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <CallScreen
      view={view}
      onCommand={onCommand}
      status={status}
      startedAt={startedAt}
      vault={facts}
      details={{
        subtitle: meta ? targetSubtitle(meta.target) : undefined,
        goal: meta?.goal,
        voice: meta?.voice,
        facts,
        shared: meta?.shared,
      }}
      onRetry={onRetry}
    />
  );
}
