import type { ReactNode } from 'react';
import s from './Pill.module.css';

export type PillState = 'dial' | 'menu' | 'hold' | 'live' | 'ask' | 'ended' | 'idle';

export interface PillProps {
  state: PillState;
  /** Short Doto label: DIALING, MENU, HOLD, LIVE, ENDED. */
  children: ReactNode;
  /** `auto` shrinks to the compact size at ≤ 820 px. */
  size?: 'md' | 'sm' | 'auto';
  className?: string;
}

/** Status pill: a state dot (red when live or asking) and a Doto label. */
export function Pill({ state, children, size = 'md', className }: PillProps) {
  const cls = [s.pill, size !== 'md' && s[size], className].filter(Boolean).join(' ');
  return (
    <span className={cls} data-s={state}>
      <i aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}
