/** Call clock as m:ss (the prototype's `fmt`). Negative or non-finite input reads 0:00. */
export function fmtClock(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
