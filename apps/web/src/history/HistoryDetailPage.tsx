import type { Commitment, TranscriptEntry } from '@carryover/protocol';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { targetSubtitle } from '../call/meta';
import { fmtClock } from '../lib/format';
import { commitmentToIcs, icsFileName } from '../lib/ics';
import { type HistoryEntry, history } from '../lib/store';
import { Button, buttonClass } from '../ui';
import { fmtDateTime } from './format';
import s from './History.module.css';

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

const whoLabel = (t: TranscriptEntry, targetLabel: string): string => {
  if (t.who === 'agent') return 'Carryover';
  if (t.who === 'user-note') return 'Note';
  return t.person && t.person > 1 ? `${targetLabel} (${t.person})` : targetLabel || 'Them';
};

function CommitmentCard({ c, targetLabel }: { c: Commitment; targetLabel: string }) {
  return (
    <div className={s.commit}>
      <div className={s.cal} aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
          <rect
            x="3.5"
            y="5"
            width="17"
            height="15"
            rx="3"
            fill="none"
            stroke="#000"
            strokeWidth="2"
          />
          <path d="M3.5 10h17M8 3v4M16 3v4" stroke="#000" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>
      <div>
        <h3>{c.text}</h3>
        {c.when && <p>{c.when}</p>}
        <div className={s.acts}>
          <Button
            variant="white"
            size="sm"
            onClick={() => download(commitmentToIcs(c, targetLabel), icsFileName(targetLabel))}
          >
            Add to calendar
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function HistoryDetailPage() {
  const { callId = '' } = useParams();
  const navigate = useNavigate();
  const [entry, setEntry] = useState<HistoryEntry | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    history
      .get(callId)
      .then((e) => {
        if (live) setEntry(e ?? null);
      })
      .catch(() => {
        if (live) setEntry(null);
      });
    return () => {
      live = false;
    };
  }, [callId]);

  const remove = async () => {
    await history.remove(callId);
    navigate('/app/history');
  };

  if (entry === undefined) {
    return (
      <div className={s.page}>
        <div className={s.wrap}>
          <p className={s.lede}>Loading…</p>
        </div>
      </div>
    );
  }

  if (entry === null) {
    return (
      <div className={s.page}>
        <div className={s.wrap}>
          <Link className={s.back} to="/app/history">
            ← History
          </Link>
          <h1 className={s.h1}>Call not found</h1>
          <p className={s.lede}>This call isn’t in your history on this device anymore.</p>
        </div>
      </div>
    );
  }

  const said = entry.transcript.filter((t) => t.who === 'agent');
  const dur = fmtClock((entry.endedAt - entry.startedAt) / 1000);

  return (
    <div className={s.page}>
      <div className={s.wrap}>
        <Link className={s.back} to="/app/history">
          ← History
        </Link>
        <div className={s.head}>
          <span className={s.kick}>
            <i aria-hidden="true" />
            CALL ENDED
          </span>
          <h1 className={s.detailTitle}>{entry.outcome || 'Call ended'}</h1>
          <p className={s.detailSub}>
            {entry.targetLabel} · {targetSubtitle(entry.target)} · {dur} ·{' '}
            {fmtDateTime(entry.startedAt)}
          </p>
        </div>

        {entry.bullets.length > 0 && (
          <section className={s.section}>
            <span className={s.lbl}>What happened</span>
            <ul className={s.bullets}>
              {entry.bullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </section>
        )}

        {entry.commitments.length > 0 && (
          <section className={s.section}>
            <span className={s.lbl}>Commitments</span>
            {entry.commitments.map((c) => (
              <CommitmentCard
                key={`${c.text}|${c.when ?? ''}`}
                c={c}
                targetLabel={entry.targetLabel}
              />
            ))}
          </section>
        )}

        <section className={s.section}>
          <span className={s.lbl}>Everything said for you</span>
          {said.length === 0 ? (
            <p className={s.detailSub}>Nothing was said for you on this call.</p>
          ) : (
            <ol className={s.said}>
              {said.map((t) => (
                <li key={`${t.at}|${t.text}`}>
                  <time>{fmtClock((t.at - entry.startedAt) / 1000)}</time>
                  <span className={s.who}>Carryover</span>
                  <q>{t.text}</q>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className={s.section}>
          <span className={s.lbl}>Transcript</span>
          <ol className={s.said}>
            {entry.transcript.map((t, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: transcript entries can repeat text/time
              <li key={i}>
                <time>{fmtClock((t.at - entry.startedAt) / 1000)}</time>
                <span className={s.who}>{whoLabel(t, entry.targetLabel)}</span>
                <span className={s.transcript}>
                  <p>{t.text}</p>
                </span>
              </li>
            ))}
          </ol>
        </section>

        <div className={s.footer}>
          <Link className={buttonClass({ variant: 'soft', size: 'lg' })} to="/app/new">
            Call again
          </Link>
          <Button variant="line" size="lg" onClick={remove}>
            Delete this call
          </Button>
        </div>
      </div>
    </div>
  );
}
