import type { AppCommand, AppEvent } from '@carryover/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { CallScreen } from '../call/CallScreen';
import { initialView, reduce } from '../call/state';
import { fmtClock } from '../lib/format';
import { Button, IconButton } from '../ui';
import {
  ASK_ID,
  ASK_JUMP_MS,
  type AskAnswer,
  buildPharmacyScript,
  callDisplayMs,
  PHARMACY_DETAILS,
  PHARMACY_VAULT,
  rebase,
  SAMPLE_TOTAL_MS,
} from './pharmacyScript';
import s from './SamplePlayer.module.css';

/** How often the clock advances. */
const TICK_MS = 200;
/** How long a typed reply waits before Carryover "says" it, in the sample. */
const SAY_DELAY_MS = 900;
/** Autoplay kicks in shortly after load, so the sample never just sits at 0:00. */
const AUTOPLAY_DELAY_MS = 600;
const SHARE_ANSWER: AskAnswer = { kind: 'share' };

/** A line the visitor typed themselves, merged into the scripted timeline. */
interface Extra {
  t: number;
  event: AppEvent;
}

function devSeekMs(search: URLSearchParams): number | undefined {
  if (!import.meta.env.DEV) return undefined;
  const raw = search.get('t');
  if (raw == null) return undefined;
  const secs = Number(raw);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : undefined;
}

/**
 * Drives `reduce` on a clock over `PHARMACY_SCRIPT` and renders `CallScreen`
 * in sample mode: play/pause/replay, a "Sample call · scripted" banner, and
 * commands simulated locally (Share on the ask card advances the script;
 * typing shows the text "said for you" after a short delay).
 */
export default function SamplePlayer() {
  const [search] = useSearchParams();
  const seek = useMemo(() => devSeekMs(search), [search]);

  const [elapsed, setElapsed] = useState(() =>
    seek != null ? Math.min(seek, SAMPLE_TOTAL_MS) : 0,
  );
  // Glyph Night's demo starts paused for an instant, then autoplays (below):
  // a visitor should never just sit looking at a 0:00 Play button.
  const [playing, setPlaying] = useState(false);
  const [answer, setAnswer] = useState<AskAnswer>(SHARE_ANSWER);
  const [extras, setExtras] = useState<Extra[]>([]);
  const [playId, setPlayId] = useState(0);
  const baseRef = useRef(Date.now());
  const nextExtraId = useRef(0);

  const script = useMemo(() => buildPharmacyScript(answer), [answer]);
  const timeline = useMemo(
    () => [...script, ...extras].sort((a, b) => a.t - b.t),
    [script, extras],
  );

  const view = useMemo(() => {
    const base = baseRef.current;
    let v = initialView;
    for (const se of timeline) {
      if (se.t > elapsed) break;
      v = reduce(v, rebase(se.event, base));
    }
    return v;
  }, [timeline, elapsed]);

  // The clock: ticks while playing, clamped to the script's length.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setElapsed((e) => Math.min(e + TICK_MS, SAMPLE_TOTAL_MS));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [playing]);

  // Reaching the end pauses (and re-pressing Play then replays).
  useEffect(() => {
    if (elapsed >= SAMPLE_TOTAL_MS) setPlaying(false);
  }, [elapsed]);

  // Autoplay shortly after load. A `?t=` dev seek (a frozen frame for
  // screenshots) opts out. Reduced motion still autoplays — nothing here
  // flashes; the no-flash rules live in CallScreen/PickupTakeover.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on mount
  useEffect(() => {
    if (seek != null) return;
    const id = setTimeout(() => setPlaying(true), AUTOPLAY_DELAY_MS);
    return () => clearTimeout(id);
  }, []);

  const now = baseRef.current + callDisplayMs(elapsed);

  function advanceTo(target: number) {
    setElapsed((e) => Math.max(e, Math.min(target, SAMPLE_TOTAL_MS)));
    setPlaying(true);
  }

  function seekTo(target: number) {
    setElapsed(Math.max(0, Math.min(target, SAMPLE_TOTAL_MS)));
  }

  function replay() {
    baseRef.current = Date.now();
    setExtras([]);
    setAnswer(SHARE_ANSWER);
    setElapsed(0);
    setPlaying(true);
    setPlayId((n) => n + 1);
  }

  function togglePlay() {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (elapsed >= SAMPLE_TOTAL_MS) {
      replay();
      return;
    }
    setPlaying(true);
  }

  function handleCommand(cmd: AppCommand) {
    switch (cmd.t) {
      case 'answer': {
        if (cmd.askId !== ASK_ID) return;
        // Honour whichever choice the visitor made on the ask card: Share
        // resolves "shared" and says the profile fact; Type says exactly
        // what they typed and resolves "typed"; Decline resolves "declined"
        // and Carryover apologises before Dana offers another way. Either
        // way, jump straight to the line said right after the resolution.
        setAnswer(
          cmd.decline
            ? { kind: 'declined' }
            : cmd.text != null
              ? { kind: 'typed', text: cmd.text }
              : SHARE_ANSWER,
        );
        advanceTo(ASK_JUMP_MS);
        return;
      }
      case 'say': {
        const at = elapsed + SAY_DELAY_MS;
        const id = `local-${nextExtraId.current++}`;
        const event: AppEvent = {
          t: 'agent.said',
          id,
          text: cmd.text,
          source: 'relay',
          interrupted: false,
          at,
        };
        setExtras((xs) => [...xs, { t: at, event }]);
        setPlaying(true);
        return;
      }
      case 'hangup':
        advanceTo(SAMPLE_TOTAL_MS);
        return;
      default:
        // `share` and `autonomy` are decorative in a scripted sample.
        return;
    }
  }

  return (
    <CallScreen
      key={playId}
      view={view}
      onCommand={handleCommand}
      now={now}
      startedAt={baseRef.current}
      vault={PHARMACY_VAULT}
      details={PHARMACY_DETAILS}
      notice={
        <p className={s.notice}>
          <i className={s.dot} aria-hidden="true" />
          <span>
            <b>Sample call</b> · scripted — hold time is shortened for this preview.
          </span>
        </p>
      }
      sideFooter={
        <DesktopPlayer
          elapsedMs={elapsed}
          totalMs={SAMPLE_TOTAL_MS}
          playing={playing}
          onToggle={togglePlay}
          onReplay={replay}
          onSeek={seekTo}
        />
      }
      mobileControls={<MobileControls playing={playing} onToggle={togglePlay} onReplay={replay} />}
      callAgain={
        <Button variant="soft" size="lg" onClick={replay}>
          Replay sample call
        </Button>
      }
      endedAction={
        <Button variant="ghost" onClick={replay}>
          Replay
        </Button>
      }
    />
  );
}

/* ---------- controls ---------- */

function DesktopPlayer({
  elapsedMs,
  totalMs,
  playing,
  onToggle,
  onReplay,
  onSeek,
}: {
  elapsedMs: number;
  totalMs: number;
  playing: boolean;
  onToggle: () => void;
  onReplay: () => void;
  onSeek: (ms: number) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const pct = totalMs > 0 ? Math.min(100, (elapsedMs / totalMs) * 100) : 0;

  const seekFromClientX = (clientX: number) => {
    const el = barRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const frac = r.width ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;
    onSeek(frac * totalMs);
  };

  return (
    <section className={s.player} aria-label="Sample call controls">
      <div className={s.head}>
        <b>Sample call</b>
        <span>
          {fmtClock(elapsedMs / 1000)} / {fmtClock(totalMs / 1000)}
        </span>
      </div>
      <div
        ref={barRef}
        className={s.bar}
        role="slider"
        tabIndex={0}
        aria-label="Sample call position"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        onClick={(e) => seekFromClientX(e.clientX)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') {
            e.preventDefault();
            onSeek(elapsedMs + 5000);
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            onSeek(elapsedMs - 5000);
          }
        }}
      >
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className={s.row}>
        <Button
          variant="soft"
          size="sm"
          onClick={onToggle}
          icon={playing ? <PauseIcon /> : <PlayIcon />}
        >
          {playing ? 'Pause' : 'Play'}
        </Button>
        <Button variant="soft" size="sm" onClick={onReplay} icon={<ReplayIcon />}>
          Replay
        </Button>
      </div>
      <p>Scripted for this preview. Hold time is shortened.</p>
    </section>
  );
}

function MobileControls({
  playing,
  onToggle,
  onReplay,
}: {
  playing: boolean;
  onToggle: () => void;
  onReplay: () => void;
}) {
  return (
    <>
      <IconButton label={playing ? 'Pause sample call' : 'Play sample call'} onClick={onToggle}>
        {playing ? <PauseIcon /> : <PlayIcon />}
      </IconButton>
      <IconButton label="Replay sample call" onClick={onReplay}>
        <ReplayIcon />
      </IconButton>
    </>
  );
}

function PlayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 2.5l9 5.5-9 5.5z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 3h3v10H4zM9 3h3v10H9z" fill="currentColor" />
    </svg>
  );
}

function ReplayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 3a5 5 0 1 1-4.6 3.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M2.6 2.4v4h4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
