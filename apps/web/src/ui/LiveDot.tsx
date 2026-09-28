import s from './LiveDot.module.css';

export interface LiveDotProps {
  /** Slow 2.4 s breathing (ask card, "LINE OPEN"). */
  breathe?: boolean;
  size?: 'md' | 'lg';
  className?: string;
}

/** The red signal dot: live, pickup, "needs you". Decorative. */
export function LiveDot({ breathe, size = 'md', className }: LiveDotProps) {
  const cls = [s.dot, breathe && s.breathe, size === 'lg' && s.lg, className]
    .filter(Boolean)
    .join(' ');
  return <span className={cls} aria-hidden="true" />;
}
