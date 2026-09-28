import { useEffect, useState } from 'react';

/** Wall-clock milliseconds, re-read every `ms` while `enabled`. */
export function useNow(enabled: boolean, ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [enabled, ms]);
  return now;
}
