// Structured timing lines for latency work: one JSON object per line on stderr, written
// only when LOG_LEVEL=debug. A line never carries what anyone said, facts or secrets:
// only event names, ids, counts, lengths and timestamps (epoch ms in `t`), so the Brain's
// and the call's lines can be merged into one timeline.

export type DebugValue = string | number | boolean | null | undefined | string[];
export type DebugFields = Record<string, DebugValue>;
export type DebugLog = (event: string, fields?: DebugFields) => void;

export const noDebug: DebugLog = () => undefined;

export function stderrDebugLog(now: () => number = Date.now): DebugLog {
  return (event, fields) => {
    try {
      process.stderr.write(`${JSON.stringify({ t: now(), ev: event, ...fields })}\n`);
    } catch {
      // diagnostics must never break a call
    }
  };
}

export function debugLogFor(cfg: { debug?: boolean }): DebugLog {
  return cfg.debug ? stderrDebugLog() : noDebug;
}
