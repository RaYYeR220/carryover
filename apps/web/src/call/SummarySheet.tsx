import type { CallSummary, Commitment } from '@carryover/protocol';
import type { ReactNode } from 'react';
import { fmtClock } from '../lib/format';
import { commitmentToIcs, icsFileName, parseWhen } from '../lib/ics';
import { Button, Sheet } from '../ui';
import { viaLabel } from './CaptionLog';
import { CalendarIcon, CheckIcon } from './icons';
import s from './SummarySheet.module.css';

export interface SummarySheetProps {
  open: boolean;
  summary: CallSummary;
  /** Who they spoke with, for "Dana said this". */
  speaker?: string;
  /** Facts shared mid-call after the user approved them (labels). */
  sharedDuringCall?: readonly string[];
  onClose: () => void;
  onOpenTranscript: () => void;
  /** "Call again": a link or a button, supplied by the page. */
  callAgain: ReactNode;
  onToast?: (text: string) => void;
}

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** The little calendar tile: THU / 2 PM, or FRI / 7 OCT for a date without a time. */
function CalTile({ when }: { when?: string }) {
  const p = when ? parseWhen(when) : null;
  if (!p) {
    return (
      <div className={s.cal} aria-hidden="true">
        <CalendarIcon size={24} />
      </div>
    );
  }
  const d = p.date;
  let big: string;
  let unit: string;
  if (p.hasTime) {
    const h = d.getHours();
    big =
      String(h % 12 || 12) + (d.getMinutes() ? `:${String(d.getMinutes()).padStart(2, '0')}` : '');
    unit = h < 12 ? 'AM' : 'PM';
  } else {
    big = String(d.getDate());
    unit = MONTHS[d.getMonth()] ?? '';
  }
  return (
    <div className={s.cal} aria-hidden="true">
      <small>{WEEKDAYS[d.getDay()]}</small>
      <b>
        {big}
        <span>{unit}</span>
      </b>
    </div>
  );
}

function download(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const heading = (c: Commitment) =>
  c.when && !c.text.toLowerCase().includes(c.when.toLowerCase()) ? `${c.text} · ${c.when}` : c.text;

function CommitmentCard({
  c,
  summary,
  speaker,
  onToast,
}: {
  c: Commitment;
  summary: CallSummary;
  speaker?: string;
  onToast?: (text: string) => void;
}) {
  const detail = `${heading(c)} (${summary.targetLabel})`;
  return (
    <div className={s.commit}>
      <CalTile when={c.when} />
      <div>
        <h3>{heading(c)}</h3>
        <p>
          {summary.targetLabel}. {speaker ? `${speaker} said this` : 'They said this'}; it’s copied
          from the captions, not made up.
        </p>
        <div className={s.acts}>
          <Button
            variant="white"
            size="sm"
            onClick={() => {
              download(commitmentToIcs(c, summary.targetLabel), icsFileName(summary.targetLabel));
              onToast?.('Calendar file downloaded.');
            }}
          >
            Add to calendar
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(detail);
                onToast?.('Copied.');
              } catch {
                onToast?.(`Copy isn’t available here. ${detail}`);
              }
            }}
          >
            Copy details
          </Button>
        </div>
      </div>
    </div>
  );
}

/** After the call: the outcome, commitments with calendar export, and everything said for you. */
export function SummarySheet({
  open,
  summary,
  speaker,
  sharedDuringCall = [],
  onClose,
  onOpenTranscript,
  callAgain,
  onToast,
}: SummarySheetProps) {
  const said = summary.transcript.filter((t) => t.who === 'agent');
  const dur = fmtClock((summary.endedAt - summary.startedAt) / 1000);
  const shared = sharedDuringCall.map((l) => l.toLowerCase());
  const ok = shared.length
    ? `Your ${joinAnd(shared)} ${shared.length === 1 ? 'was' : 'were'} shared once, after you approved it. Nothing else about you was shared.`
    : 'Only the facts you chose before the call could be used. Nothing else about you was shared.';

  return (
    <Sheet
      open={open}
      onClose={onClose}
      width="narrow"
      kicker="CALL ENDED"
      title={summary.outcome || 'Call ended'}
      description={`${summary.targetLabel} · ${dur} call`}
      closeLabel="Close summary"
      footer={
        <>
          <Button variant="ink" size="lg" className={s.done} onClick={onClose}>
            Done
          </Button>
          <Button variant="soft" size="lg" onClick={onOpenTranscript}>
            Open transcript
          </Button>
          {callAgain}
        </>
      }
    >
      {summary.bullets.length > 0 && (
        <ul className={s.bullets}>
          {summary.bullets.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
      {summary.commitments.map((c) => (
        <CommitmentCard
          key={`${c.text}|${c.when ?? ''}`}
          c={c}
          summary={summary}
          speaker={speaker}
          onToast={onToast}
        />
      ))}
      <div className={s.said}>
        <span className={s.lbl}>Everything said for you</span>
        {said.length ? (
          <ol>
            {said.map((t) => {
              const via = viaLabel({ source: t.source ?? 'agent' });
              return (
                <li key={`${t.at}|${t.text}`}>
                  <time>{fmtClock((t.at - summary.startedAt) / 1000)}</time>
                  <span>
                    <q>{t.text}</q>
                    <small>{via.charAt(0).toUpperCase() + via.slice(1)}</small>
                  </span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className={s.none}>Nothing was said for you on this call.</p>
        )}
        <p className={s.ok}>
          <i aria-hidden="true">
            <CheckIcon />
          </i>
          <span>{ok}</span>
        </p>
      </div>
    </Sheet>
  );
}

function joinAnd(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? '';
  return `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
}
