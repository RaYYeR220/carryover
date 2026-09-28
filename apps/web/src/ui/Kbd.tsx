import type { ReactNode } from 'react';
import s from './Kbd.module.css';

export interface KbdProps {
  children: ReactNode;
  /** `inherit` = outlined in the current colour (dock hints); `paper` = white key on paper. */
  tone?: 'inherit' | 'paper';
  className?: string;
}

export function Kbd({ children, tone = 'inherit', className }: KbdProps) {
  const cls = [s.kbd, tone === 'paper' && s.paper, className].filter(Boolean).join(' ');
  return <kbd className={cls}>{children}</kbd>;
}
