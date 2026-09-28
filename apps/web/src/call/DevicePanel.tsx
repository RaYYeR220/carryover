import type { Fact } from '@carryover/protocol';
import { type ReactNode, useEffect, useId, useRef } from 'react';
import { LedMatrix } from '../ui';
import s from './DevicePanel.module.css';
import type { LedState, LineStatus } from './derive';

export interface CallDetails {
  /** Under the callee name, e.g. "(555) 014-2230 · simulated line". */
  subtitle?: string;
  goal?: string;
  voice?: string;
  /** Profile facts shown as chips; those in `shared` are lit. */
  facts?: readonly Fact[];
  /** Keys of the facts Carryover may share on this call. */
  shared?: readonly string[];
}

export interface DevicePanelProps {
  led: LedState;
  status: LineStatus;
  details?: CallDetails;
  /** Desktop: bottom of the side panel (the sample call player). */
  footer?: ReactNode;
  /** Mobile: small controls beside the LED strip. */
  mobileControls?: ReactNode;
}

/** The side panel: LED device with the line status, then what this call may use. */
export function DevicePanel({ led, status, details, footer, mobileControls }: DevicePanelProps) {
  const titleId = useId();
  const facts = details?.facts ?? [];
  const shared = new Set(details?.shared ?? []);
  const hasFacts = !!(details?.goal || details?.voice || facts.length);

  // Chips light up with a short ring when a fact is shared mid-call.
  const before = useRef<Set<string> | null>(null);
  const fresh = new Set<string>();
  if (before.current) for (const k of shared) if (!before.current.has(k)) fresh.add(k);
  const sharedKey = [...shared].sort().join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: sharedKey stands in for the set
  useEffect(() => {
    before.current = new Set(shared);
  }, [sharedKey]);

  return (
    <aside className={s.side} aria-label="Line status and call details">
      <section className={s.device} aria-labelledby={titleId}>
        <LedMatrix
          className={s.screen}
          scene={led.scene}
          data={led.data}
          level={led.level}
          ring={led.ring}
          responsive
        />
        <div className={s.lstate}>
          <b id={titleId}>{status.title}</b>
          <span>{status.sub}</span>
        </div>
      </section>
      {mobileControls && <div className={s.mobile}>{mobileControls}</div>}
      {hasFacts && (
        <dl className={s.facts}>
          {details?.goal && (
            <div>
              <dt>Goal</dt>
              <dd>{details.goal}</dd>
            </div>
          )}
          {facts.length > 0 && (
            <div>
              <dt>Carryover may share</dt>
              <dd>
                <span className={s.chips}>
                  {facts.map((f) => (
                    <span
                      key={f.key}
                      className={[s.chip, shared.has(f.key) && s.on, fresh.has(f.key) && s.new]
                        .filter(Boolean)
                        .join(' ')}
                      title={f.value}
                    >
                      {f.label}
                      {shared.has(f.key) && <span className="sr"> (shared)</span>}
                    </span>
                  ))}
                </span>
              </dd>
            </div>
          )}
          {details?.voice && (
            <div>
              <dt>Voice</dt>
              <dd>{details.voice}</dd>
            </div>
          )}
        </dl>
      )}
      {footer && <div className={s.footer}>{footer}</div>}
    </aside>
  );
}
