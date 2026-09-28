import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Button, buttonClass, DotWordmark } from '../ui';
import s from './EndedPanel.module.css';

/** Full screen, when there is no call to show: bad or expired link, or a call from another tab. */
export function EndedScreen({ reason }: { reason?: string }) {
  return (
    <main className={s.screen}>
      <Link className={s.wm} to="/" aria-label="Carryover home">
        <DotWordmark ink="#fff" height={15} />
      </Link>
      <div className={s.card}>
        <span className={s.kick}>
          <i aria-hidden="true" />
          CALL ENDED
        </span>
        <h1>This call has ended</h1>
        <p>
          {reason ??
            'This call link isn’t active anymore. Calls end after five minutes, and a call can only be followed from the tab that started it.'}
        </p>
        <div className={s.actions}>
          <Link className={buttonClass({ variant: 'white', size: 'lg' })} to="/app/new">
            Start a new call
          </Link>
          <Link className={buttonClass({ variant: 'ghost', size: 'lg' })} to="/app/history">
            Call history
          </Link>
        </div>
      </div>
    </main>
  );
}

export interface EndedBarProps {
  /** The summary exists and can be reopened. */
  hasSummary: boolean;
  onViewSummary: () => void;
  /** An extra action, e.g. replaying the sample call. "New call" is in the top bar. */
  extra?: ReactNode;
}

/** In place of the composer once the call is over. */
export function EndedBar({ hasSummary, onViewSummary, extra }: EndedBarProps) {
  return (
    <section className={s.bar} aria-label="Call ended">
      <div className={s.text}>
        <b>This call has ended</b>
        <p>{hasSummary ? 'Your summary is ready.' : 'Writing your summary…'}</p>
      </div>
      <div className={s.barActions}>
        {hasSummary && (
          <Button variant="white" onClick={onViewSummary}>
            View summary
          </Button>
        )}
        <Link className={buttonClass({ variant: 'ghost' })} to="/app/history">
          History
        </Link>
        {extra}
      </div>
    </section>
  );
}

/** A lost connection: say so plainly and offer to reconnect. */
export function ConnectionBar({
  status,
  onRetry,
}: {
  status: 'retrying' | 'closed';
  onRetry?: () => void;
}) {
  return (
    <div className={s.conn} role="status">
      {status === 'retrying' ? (
        <>
          <span className={s.spin} aria-hidden="true" />
          Reconnecting to the call…
        </>
      ) : (
        <>
          Connection lost.
          {onRetry && (
            <button type="button" onClick={onRetry}>
              Reconnect
            </button>
          )}
        </>
      )}
    </div>
  );
}
