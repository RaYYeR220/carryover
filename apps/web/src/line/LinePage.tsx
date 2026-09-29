import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { lineSocketUrl } from '../lib/api';
import { fmtClock } from '../lib/format';
import {
  Button,
  DotWordmark,
  IconButton,
  Pill,
  type PillProps,
  Toast,
  useSurface,
  useToast,
} from '../ui';
import {
  AudioEngineLoadError,
  createLineAudioContext,
  type LineAudio,
  startLineAudio,
} from './audio/lineAudio';
import s from './LinePage.module.css';
import { connectLineSocket, type LineSocket, type LineStatusMsg } from './lineSocket';

type Phase = 'connecting' | 'waiting' | 'ringing' | 'connected' | 'ended';

/** The level meter's five bars, left to right. */
const METER_BARS = [0, 1, 2, 3, 4];

/** How long the page can sit hidden (tab backgrounded, phone locked) while connected before we hang up. */
const HIDDEN_HANGUP_MS = 20_000;

const PILL: Record<Phase, { state: PillProps['state']; label: string }> = {
  connecting: { state: 'idle', label: 'CONNECTING' },
  waiting: { state: 'idle', label: 'WAITING' },
  ringing: { state: 'ask', label: 'RINGING' },
  connected: { state: 'live', label: 'LIVE' },
  ended: { state: 'ended', label: 'ENDED' },
};

function describeAnswerError(err: unknown): string {
  if (err instanceof AudioEngineLoadError) {
    return 'Audio engine failed to load. Reload the page and try again.';
  }
  if (err instanceof DOMException) {
    if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(err.name)) {
      return 'Microphone access is blocked. Allow it in your browser’s site settings, then tap Try again.';
    }
    if (['NotFoundError', 'DevicesNotFoundError'].includes(err.name)) {
      return 'No microphone was found on this device.';
    }
  }
  return 'Couldn’t connect the microphone. Check your connection and try again.';
}

interface CloseInfo {
  message: string;
  reconnect: boolean;
}

/**
 * Maps a WS close code to what the page should show. `phaseAtClose` is the
 * last status the socket told us before it closed.
 */
function describeClose(code: number, phaseAtClose: Phase): CloseInfo | null {
  // A normal closure right after the call properly ended is expected --
  // the practice line simply isn't holding this connection open anymore.
  if (code === 1000 && phaseAtClose === 'ended') return null;
  if (code === 4000) {
    return { message: 'This line was opened on another device.', reconnect: false };
  }
  if (code === 4410) {
    return {
      message: 'This practice line expired. Start a new one from the app.',
      reconnect: false,
    };
  }
  if (code === 4409) {
    return { message: 'This line is already in a call.', reconnect: false };
  }
  return { message: 'Connection lost.', reconnect: true };
}

function MicIcon({ off }: { off?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path
        d="M6 11a6 6 0 0 0 12 0M12 17v3M9 20h6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      {off && (
        <path
          d="M4 4l16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

function HangUpIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        d="M3.4 14.6c4.8-4.1 12.4-4.1 17.2 0l-1.9 2.6c-.3.4-.9.5-1.3.3l-2.6-1.3a1 1 0 0 1-.5-1.1l.3-1.5a10 10 0 0 0-5.2 0l.3 1.5a1 1 0 0 1-.5 1.1l-2.6 1.3c-.4.2-1 .1-1.3-.3z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * The practice line: a judge scans a QR code and this page becomes "the
 * pharmacy". A WebSocket at `/ws/line/:code` carries mu-law 8 kHz audio both
 * ways and JSON `line.status` / `line.hint` messages; we send `line.answer`
 * / `line.hangup`. The AudioContext and mic are only ever touched inside the
 * Answer tap (Mobile Safari requires this).
 */
export default function LinePage() {
  useSurface('paper');
  const { code = '' } = useParams<{ code: string }>();

  const [phase, setPhase] = useState<Phase>('connecting');
  const [callerLabel, setCallerLabel] = useState<string | undefined>();
  const [answering, setAnswering] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [closeInfo, setCloseInfo] = useState<CloseInfo | null>(null);
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(0);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [toast, showToast, hideToast] = useToast();

  const socketRef = useRef<LineSocket | null>(null);
  const audioRef = useRef<LineAudio | null>(null);
  const phaseRef = useRef<Phase>('connecting');

  /** Tears down the local call: stops the mic/speaker and tells the server. Safe to call anytime. */
  const hangUpNow = useCallback(() => {
    audioRef.current?.stop();
    audioRef.current = null;
    setMuted(false);
    setLevel(0);
    socketRef.current?.hangup();
  }, []);

  // reconnectNonce isn't read in the body; bumping it is exactly how the
  // Reconnect button asks this effect to open a fresh socket.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnectNonce is a deliberate re-run trigger
  useEffect(() => {
    phaseRef.current = 'connecting';
    setPhase('connecting');
    setCallerLabel(undefined);
    setAnswerError(null);
    setCloseInfo(null);
    setConnectedAt(null);

    // Guards against a superseded socket's late callbacks (its own cleanup
    // already ran, e.g. React StrictMode's double-invoke in dev, or this
    // effect re-running for a new `code`) mutating state for the socket that
    // replaced it -- a plain `let` closed over by every handler below.
    let mySocket: LineSocket | undefined;
    const isCurrent = () => socketRef.current === mySocket;

    mySocket = connectLineSocket(lineSocketUrl(code), {
      onStatus: (msg: LineStatusMsg) => {
        if (!isCurrent()) return;
        const prev = phaseRef.current;
        phaseRef.current = msg.status;
        setPhase(msg.status);
        setCallerLabel(msg.callerLabel);
        if (msg.status === 'connected' && prev !== 'connected') setConnectedAt(Date.now());
        if (msg.status !== 'connected' && audioRef.current) {
          audioRef.current.stop();
          audioRef.current = null;
          setMuted(false);
          setLevel(0);
        }
      },
      onHint: (text) => {
        if (isCurrent()) showToast(text);
      },
      onAudio: (mu) => {
        if (isCurrent()) audioRef.current?.playFrame(mu);
      },
      onClose: (ev) => {
        if (!isCurrent()) return;
        audioRef.current?.stop();
        audioRef.current = null;
        setCloseInfo(describeClose(ev.code, phaseRef.current));
      },
    });
    socketRef.current = mySocket;

    return () => {
      socketRef.current = null;
      audioRef.current?.stop();
      audioRef.current = null;
      mySocket?.close();
    };
  }, [code, showToast, reconnectNonce]);

  useEffect(() => {
    if (phase !== 'connected') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase]);

  // A judge locking their phone or switching apps mid-call must not leave
  // the mic hot and the server-side leg dangling. `pagehide` (tab really
  // going away) hangs up immediately; a plain visibility change (phone
  // locked, brief app switch) gives it 20 s before doing the same, in case
  // they come right back.
  useEffect(() => {
    let hideTimer: ReturnType<typeof setTimeout> | null = null;

    const onPageHide = () => hangUpNow();

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (phaseRef.current === 'connected' && hideTimer === null) {
          hideTimer = setTimeout(() => {
            hideTimer = null;
            hangUpNow();
          }, HIDDEN_HANGUP_MS);
        }
      } else if (hideTimer !== null) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    };

    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (hideTimer !== null) clearTimeout(hideTimer);
    };
  }, [hangUpNow]);

  function handleReconnect() {
    setCloseInfo(null);
    setReconnectNonce((n) => n + 1);
  }

  async function handleAnswer() {
    if (answering) return;
    setAnswerError(null);
    // Must be created synchronously, right here in the tap, or Mobile Safari
    // will not let it run.
    const ctx = createLineAudioContext();
    setAnswering(true);
    try {
      const audio = await startLineAudio(ctx, {
        onAudioFrame: (mu) => socketRef.current?.sendAudio(mu),
        onLevel: setLevel,
      });
      if (phaseRef.current !== 'ringing') {
        // The call moved on (caller hung up, or the 60 s ring timed out)
        // while we were still asking for the mic.
        audio.stop();
        return;
      }
      audioRef.current = audio;
      socketRef.current?.answer();
    } catch (err) {
      try {
        ctx.close();
      } catch {
        // already closing/closed
      }
      setAnswerError(describeAnswerError(err));
      socketRef.current?.hangup();
    } finally {
      setAnswering(false);
    }
  }

  function handleMute() {
    setMuted((m) => {
      const next = !m;
      audioRef.current?.setMuted(next);
      return next;
    });
  }

  const pill = PILL[phase];
  const elapsed = connectedAt ? fmtClock((now - connectedAt) / 1000) : '0:00';

  return (
    <main className={s.page}>
      <div className={s.top}>
        <DotWordmark height={17} />
        <span className={s.vsep} aria-hidden="true" />
        <span className={`t-dot ${s.lineTag}`}>LINE {code}</span>
      </div>

      <div className={s.body}>
        <Toast message={toast} onDismiss={hideToast} className={s.hint} />

        {closeInfo ? (
          <div className={s.card}>
            <Pill state="ended">DISCONNECTED</Pill>
            <h1>{closeInfo.message}</h1>
            {closeInfo.reconnect && (
              <div className={s.actions}>
                <Button variant="ink" size="lg" onClick={handleReconnect}>
                  Reconnect
                </Button>
              </div>
            )}
          </div>
        ) : answerError ? (
          <div className={s.card}>
            <Pill state="ended">BLOCKED</Pill>
            <h1>Microphone blocked.</h1>
            <p>{answerError}</p>
            <div className={s.actions}>
              <Button variant="ink" size="lg" onClick={() => setAnswerError(null)}>
                Try again
              </Button>
            </div>
          </div>
        ) : (
          <div className={s.card}>
            <Pill state={pill.state}>{pill.label}</Pill>

            {phase === 'connecting' && (
              <>
                <h1>Connecting…</h1>
                <p>Opening the practice line.</p>
              </>
            )}

            {phase === 'waiting' && (
              <>
                <h1>You are the business.</h1>
                <p>
                  Keep this tab open. When Carryover calls this practice line, it rings here —
                  answer it like you would any call.
                </p>
              </>
            )}

            {phase === 'ringing' && (
              <>
                <h1>{callerLabel ? `${callerLabel} is calling.` : 'Incoming call.'}</h1>
                <p>
                  Tap Answer, then talk normally. This simulates a business picking up the phone.
                </p>
                <Button
                  variant="ink"
                  size="lg"
                  shape="rect"
                  block
                  onClick={handleAnswer}
                  disabled={answering}
                >
                  {answering ? 'Connecting…' : 'Answer'}
                </Button>
              </>
            )}

            {phase === 'connected' && (
              <>
                <h1>You’re on the call.</h1>
                <span className={s.timer}>{elapsed}</span>
                <div className={s.meterRow}>
                  <div className={s.meter} aria-hidden="true">
                    {METER_BARS.map((i) => (
                      <span
                        key={`bar-${i}`}
                        className={s.bar}
                        data-on={level * 5 > i ? '' : undefined}
                        style={{ height: `${Math.max(15, Math.min(1, level * 5 - i) * 100)}%` }}
                      />
                    ))}
                  </div>
                  <span className={s.meterLabel}>Microphone level</span>
                </div>
                <div className={s.controls}>
                  <IconButton
                    label={muted ? 'Unmute microphone' : 'Mute microphone'}
                    tone="paper"
                    aria-pressed={muted}
                    className={s.mute}
                    onClick={handleMute}
                  >
                    <MicIcon off={muted} />
                  </IconButton>
                  <Button variant="red" icon={<HangUpIcon />} onClick={hangUpNow}>
                    Hang up
                  </Button>
                </div>
                <p className={s.caption}>Carryover is speaking with you as the business.</p>
              </>
            )}

            {phase === 'ended' && (
              <>
                <h1>Call ended.</h1>
                <p>This line is free for the next call.</p>
              </>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
