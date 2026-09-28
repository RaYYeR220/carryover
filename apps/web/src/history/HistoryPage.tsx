import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { targetSubtitle } from '../call/meta';
import { type HistoryEntry, history } from '../lib/store';
import { buttonClass, IconButton } from '../ui';
import { fmtDateTime } from './format';
import s from './History.module.css';

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export default function HistoryPage() {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);

  useEffect(() => {
    let live = true;
    history
      .list()
      .then((e) => {
        if (live) setEntries(e);
      })
      .catch(() => {
        if (live) setEntries([]);
      });
    return () => {
      live = false;
    };
  }, []);

  const remove = async (callId: string) => {
    await history.remove(callId);
    setEntries((prev) => prev?.filter((e) => e.callId !== callId) ?? prev);
  };

  return (
    <div className={s.page}>
      <div className={s.wrap}>
        <div className={s.top}>
          <h1 className={s.h1}>History</h1>
          <nav className={s.nav} aria-label="Carryover">
            <Link to="/app/new">New call</Link>
            <Link to="/app/history" aria-current="page">
              History
            </Link>
            <Link to="/app/profile">Profile</Link>
          </nav>
        </div>
        <p className={s.lede}>Every call Carryover placed for you, kept on this device.</p>

        {entries == null ? (
          <p className={s.lede}>Loading…</p>
        ) : entries.length === 0 ? (
          <div className={s.empty}>
            <p>No calls yet.</p>
            <div className={s.actions}>
              <Link className={buttonClass({ variant: 'ink', size: 'md' })} to="/app/new">
                Start a call
              </Link>
            </div>
          </div>
        ) : (
          <ul className={s.list}>
            {entries.map((e) => (
              <li key={e.callId} className={s.row}>
                <Link className={s.rowLink} to={`/app/history/${e.callId}`}>
                  <div className={s.target}>
                    <b>{e.targetLabel || 'Unknown'}</b>
                    <span>{targetSubtitle(e.target)}</span>
                  </div>
                  <p className={s.outcome}>{e.outcome || 'No summary for this call.'}</p>
                  <div className={s.meta}>
                    <span>{fmtDateTime(e.startedAt)}</span>
                    <span>
                      {e.commitments.length}{' '}
                      {e.commitments.length === 1 ? 'commitment' : 'commitments'}
                    </span>
                  </div>
                </Link>
                <IconButton
                  className={s.delete}
                  tone="paper"
                  label={`Delete the call with ${e.targetLabel || 'this line'}`}
                  onClick={() => remove(e.callId)}
                >
                  <CloseIcon />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
