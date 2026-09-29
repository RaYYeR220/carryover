import type { AppCommand, Autonomy, Fact } from '@carryover/protocol';
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router';
import type { CallSocketStatus } from '../lib/callSocket';
import { fmtClock } from '../lib/format';
import { buttonClass, CAPTION_SIZES, Toast, useReducedMotion, useSurface, useToast } from '../ui';
import { AskCard } from './AskCard';
import s from './CallScreen.module.css';
import { CaptionLog } from './CaptionLog';
import { Composer } from './Composer';
import { type CallDetails, DevicePanel } from './DevicePanel';
import {
  endTime,
  flashOn,
  lastThemLabel,
  ledFor,
  lineStatus,
  type Moment,
  openAsk,
  PICKUP_FLASH_MS,
  pickupPhase,
  pillFor,
  startTime,
  titleFor,
  waitingTitle,
} from './derive';
import { ConnectionBar, EndedBar, EndedScreen } from './EndedPanel';
import { PickupTakeover } from './PickupTakeover';
import { QuickReplies } from './QuickReplies';
import { SummarySheet } from './SummarySheet';
import { type CallView, fieldPhrase, type TimelineItem } from './state';
import { TopBar } from './TopBar';
import { useNow } from './useNow';
import { WaitingBar } from './WaitingBar';

export type { CallDetails } from './DevicePanel';

export interface CallScreenProps {
  view: CallView;
  /** Every command the user gives: say, answer, share, autonomy, hangup. */
  onCommand: (cmd: AppCommand) => void;
  /** The live socket's state. Omit for a scripted call. */
  status?: CallSocketStatus;
  /** Clock in ms, in the same time base as the events' `at`. Omit to follow the wall clock. */
  now?: number;
  /** When the call started (ms). Default: the earliest time in the view. */
  startedAt?: number;
  /** The user's profile, for "Share from profile" on questions. */
  vault?: readonly Fact[];
  /** Subtitle, goal, voice and shared facts for the side panel. */
  details?: CallDetails;
  /** Bottom of the side panel on desktop (the sample call player). */
  sideFooter?: ReactNode;
  /** Beside the LED strip on mobile. */
  mobileControls?: ReactNode;
  /** Shown over the transcript, e.g. "Sample call · scripted". */
  notice?: ReactNode;
  /** Reconnect after the connection was lost. */
  onRetry?: () => void;
  /** Replaces the summary's "Call again" link. */
  callAgain?: ReactNode;
  /** An extra action beside "View summary" once the call has ended. */
  endedAction?: ReactNode;
}

const CAP_KEY = 'carryover.captionSize';
/** The protocol caps `answer.text` at 500 chars, well under `say.text`'s 2000. */
const ANSWER_MAX_CHARS = 500;
/** A pickup older than this when it first reaches the screen is a replay: no flash. */
const PICKUP_FRESH_MS = 15_000;
/** Reduced motion: the steady red frame stays this long. */
const FRAME_MS = 4000;

const MODE_TOAST: Record<Autonomy, (goal?: string) => string> = {
  relay: () => 'Relay from now on. Carryover only says what you type.',
  assist: () =>
    'Assist from now on. Carryover handles menus and hold and answers only from facts you shared.',
  auto: (goal) =>
    goal
      ? `Auto from now on. Carryover works toward “${goal}” and still asks before sharing anything new.`
      : 'Auto from now on. Carryover works toward your goal and still asks before sharing anything new.',
};

function storedCaptionSize(): number | null {
  try {
    const n = Number(localStorage.getItem(CAP_KEY));
    return (CAPTION_SIZES as readonly number[]).includes(n) ? n : null;
  } catch {
    return null;
  }
}

function defaultCaptionSize(): number {
  const narrow = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 820px)').matches;
  return narrow ? 24 : 28;
}

const findFact = (vault: readonly Fact[], field?: string): Fact | undefined => {
  if (!field) return undefined;
  return (
    vault.find((f) => f.key === field) ??
    vault.find((f) => f.key.toLowerCase() === field.toLowerCase())
  );
};

/** Time of the most recent pickup row, if any. */
function latestPickup(tl: readonly TimelineItem[]): number | undefined {
  for (let i = tl.length - 1; i >= 0; i--) {
    const x = tl[i] as TimelineItem;
    if (x.type === 'event' && x.event.id.startsWith('alert:pickup:')) return x.event.at;
  }
  return undefined;
}

/**
 * The live call screen from Glyph Night, as a view of `CallView`. It holds only
 * UI state (caption size, which card is open); every change to the call goes
 * out through `onCommand`, so the same screen plays live calls and the
 * scripted sample.
 */
export function CallScreen({
  view,
  onCommand,
  status = 'open',
  now: nowProp,
  startedAt,
  vault = [],
  details,
  sideFooter,
  mobileControls,
  notice,
  onRetry,
  callAgain,
  endedAction,
}: CallScreenProps) {
  useSurface('night');
  const reducedMotion = useReducedMotion();
  const [toast, showToast, hideToast] = useToast();

  /* ---------- clock and the pickup moment ---------- */
  const [pickupAt, setPickupAt] = useState<number>();
  const [bannerGone, setBannerGone] = useState(false);
  const wall = useNow(nowProp === undefined, 500);
  const fastWall = useNow(
    nowProp === undefined && pickupAt != null && wall - pickupAt < PICKUP_FLASH_MS + 200,
    50,
  );
  const now = nowProp ?? Math.max(wall, fastWall);
  const nowRef = useRef(now);
  nowRef.current = now;

  const pickup = latestPickup(view.timeline);
  const seenPickup = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (pickup == null || seenPickup.current === pickup) return;
    seenPickup.current = pickup;
    const age = nowRef.current - pickup;
    if (Math.abs(age) > PICKUP_FRESH_MS) return;
    setPickupAt(nowRef.current);
    setBannerGone(false);
    try {
      navigator.vibrate?.([200, 100, 200]);
    } catch {
      // Vibration is best effort.
    }
  }, [pickup]);

  const moment: Moment = { now, pickupAt, reducedMotion };
  const phase = pickupPhase(moment);

  /* ---------- tab title ---------- */
  const title = titleFor(view, moment);
  useEffect(() => {
    document.title = title;
  }, [title]);
  useEffect(() => {
    const before = document.title;
    return () => {
      document.title = before;
    };
  }, []);

  /* ---------- caption size ---------- */
  const [chosenCap, setChosenCap] = useState<number | null>(storedCaptionSize);
  const cap = chosenCap ?? defaultCaptionSize();
  const onCaptionSize = (px: number) => {
    setChosenCap(px);
    try {
      localStorage.setItem(CAP_KEY, String(px));
    } catch {
      // Not remembered, still applied.
    }
  };
  const shellStyle = (chosenCap ? { '--cap': `${chosenCap}px` } : undefined) as
    | CSSProperties
    | undefined;

  /* ---------- autonomy ---------- */
  const [pendingMode, setPendingMode] = useState<Autonomy>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the server's echo settles the choice
  useEffect(() => setPendingMode(undefined), [view.autonomy]);
  const autonomy = pendingMode ?? view.autonomy;
  const onAutonomy = (value: Autonomy) => {
    setPendingMode(value);
    onCommand({ t: 'autonomy', value });
    showToast(MODE_TOAST[value](details?.goal));
  };

  /* ---------- asks ---------- */
  const ask = openAsk(view);
  const [answering, setAnswering] = useState<string>();
  const [sentFor, setSentFor] = useState<string>();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const typingAnswer = !!ask && answering === ask.askId;
  const fact = findFact(vault, ask?.field);
  const sharedKeys = new Set(details?.shared ?? []);
  for (const a of view.asks) if (a.resolved === 'shared' && a.field) sharedKeys.add(a.field);

  useEffect(() => {
    if (typingAnswer) composerRef.current?.focus();
  }, [typingAnswer]);

  /* ---------- errors from the server: say so, and let a rejected answer be retried ---------- */
  useEffect(() => {
    if (!view.error) return;
    showToast(view.error);
    setSentFor(undefined);
  }, [view.error, showToast]);

  /* ---------- voice reconnect notices: a neutral banner, not an error ---------- */
  useEffect(() => {
    if (view.lastAlert?.kind !== 'voice') return;
    showToast(view.lastAlert.message);
  }, [view.lastAlert, showToast]);

  const holdingLine = (() => {
    if (!ask) return undefined;
    for (let i = view.timeline.length - 1; i >= 0; i--) {
      const x = view.timeline[i] as TimelineItem;
      if (x.type === 'line' && x.line.who === 'you') {
        return x.line.source === 'agent' && x.line.at >= ask.at - 3000 ? x.line.text : undefined;
      }
    }
    return undefined;
  })();

  const shareFact = (f: Fact) => {
    if (!ask) return;
    onCommand({ t: 'share', fact: f });
    onCommand({ t: 'answer', askId: ask.askId, shareFactKey: f.key });
    setSentFor(ask.askId);
  };
  const decline = () => {
    if (!ask) return;
    onCommand({ t: 'answer', askId: ask.askId, decline: true });
    setSentFor(ask.askId);
  };
  const typeAnswer = () => {
    if (!ask) return;
    setAnswering(ask.askId);
    showToast('Type your answer. Carryover will say exactly that, nothing more.');
  };

  /* ---------- talking ---------- */
  const endedUi = view.ended || status === 'unauthorized';
  const canTalk = !endedUi && status !== 'closed';
  const say = (text: string) => onCommand({ t: 'say', text });
  const send = (text: string) => {
    if (typingAnswer && ask) {
      onCommand({ t: 'answer', askId: ask.askId, text });
      setAnswering(undefined);
      setSentFor(ask.askId);
      return;
    }
    say(text);
  };

  /* ---------- summary ---------- */
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [focusTop, setFocusTop] = useState(0);
  useEffect(() => {
    if (view.summary) setSummaryOpen(true);
  }, [view.summary]);
  const openTranscript = useCallback(() => {
    setSummaryOpen(false);
    setFocusTop((n) => n + 1);
  }, []);

  if (status === 'unauthorized' && view.timeline.length === 0) return <EndedScreen />;

  const start = startedAt ?? startTime(view) ?? now;
  const end = endTime(view);
  const clock = fmtClock(((endedUi && end != null ? end : now) - start) / 1000);
  const led = ledFor(view, moment);
  const line = lineStatus(view, moment);
  const sharedLabels = view.asks
    .filter((a) => a.resolved === 'shared')
    .map((a) => findFact(vault, a.field)?.label ?? (a.field ? fieldPhrase(a.field) : 'answer'));

  return (
    <div className={s.shell} style={shellStyle}>
      <TopBar
        name={view.targetLabel || 'Connecting…'}
        subtitle={details?.subtitle}
        pill={pillFor(view)}
        clock={clock}
        autonomy={autonomy}
        onAutonomy={onAutonomy}
        captionSize={cap}
        onCaptionSize={onCaptionSize}
        ended={endedUi}
        onHangUp={() => onCommand({ t: 'hangup' })}
      />
      <div className={s.body}>
        <DevicePanel
          led={led}
          status={line}
          details={details ? { ...details, shared: [...sharedKeys] } : undefined}
          footer={sideFooter}
          mobileControls={mobileControls}
        />
        <main className={s.main}>
          <div className={s.streamCol}>
            {notice}
            <CaptionLog
              view={view}
              now={now}
              startedAt={start}
              reducedMotion={reducedMotion}
              layoutKey={cap}
              focusTopKey={focusTop}
            />
          </div>
          <div className={[s.dock, ask && !typingAnswer && s.asking].filter(Boolean).join(' ')}>
            <div className={s.dockIn}>
              {endedUi ? (
                <EndedBar
                  hasSummary={!!view.summary}
                  onViewSummary={() => setSummaryOpen(true)}
                  extra={endedAction}
                />
              ) : (
                <>
                  {ask && (
                    <AskCard
                      ask={ask}
                      fact={fact}
                      alreadyShared={!!fact && sharedKeys.has(fact.key)}
                      holdingLine={holdingLine}
                      waited={Math.max(0, (now - ask.at) / 1000)}
                      busy={sentFor === ask.askId}
                      more={view.asks.filter((a) => !a.resolved).length - 1}
                      onShare={shareFact}
                      onType={typeAnswer}
                      onDecline={decline}
                    />
                  )}
                  <WaitingBar
                    items={view.queued}
                    title={waitingTitle(view)}
                    onSpeakNow={(q) => onCommand({ t: 'say', text: q.text, urgent: true })}
                  />
                  <div className={s.talk}>
                    <QuickReplies onSay={say} disabled={!canTalk} />
                    <Composer
                      onSend={send}
                      disabled={!canTalk}
                      inputRef={composerRef}
                      placeholder={
                        typingAnswer && ask
                          ? `Type your answer for ${ask.from}…`
                          : 'Type what you want said…'
                      }
                      maxLength={typingAnswer ? ANSWER_MAX_CHARS : undefined}
                      hint
                    />
                  </div>
                </>
              )}
            </div>
          </div>
          <PickupTakeover
            target={view.targetLabel || 'the other side'}
            flash={flashOn(moment)}
            frame={reducedMotion && pickupAt != null && now - pickupAt < FRAME_MS}
            banner={phase != null && !bannerGone && !endedUi}
            onDismiss={() => setBannerGone(true)}
          />
          {!endedUi && (status === 'retrying' || status === 'closed') && (
            <ConnectionBar status={status} onRetry={onRetry} />
          )}
          <Toast message={toast} onDismiss={hideToast} />
        </main>
      </div>
      {view.summary && (
        <SummarySheet
          open={summaryOpen}
          summary={view.summary}
          speaker={lastThemLabel(view)}
          sharedDuringCall={sharedLabels}
          onClose={() => setSummaryOpen(false)}
          onOpenTranscript={openTranscript}
          callAgain={
            callAgain ?? (
              <Link className={buttonClass({ variant: 'soft', size: 'lg' })} to="/app/new">
                Call again
              </Link>
            )
          }
          onToast={showToast}
        />
      )}
    </div>
  );
}
