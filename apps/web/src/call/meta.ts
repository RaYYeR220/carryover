import type { Autonomy, CallTarget } from '@carryover/protocol';

/**
 * What the start page knew when it placed a call, kept for this tab so the
 * call page can label the call and file it in history. Only fact keys are
 * kept, never values. Stored in sessionStorage as `carryover.call.<callId>`.
 */
export interface CallMeta {
  target: CallTarget;
  autonomy?: Autonomy;
  goal?: string;
  /** Voice as shown to the user, e.g. "Alba". */
  voice?: string;
  /** Keys of the profile facts shared for this call. */
  shared?: string[];
}

const metaKey = (callId: string) => `carryover.call.${callId}`;

export function saveCallMeta(callId: string, meta: CallMeta): void {
  try {
    sessionStorage.setItem(metaKey(callId), JSON.stringify(meta));
  } catch {
    // Without it the call still works; history gets a generic label.
  }
}

function isTarget(t: unknown): t is CallTarget {
  if (!t || typeof t !== 'object') return false;
  const o = t as Record<string, unknown>;
  return (
    (o.kind === 'line' && typeof o.code === 'string') ||
    (o.kind === 'scenario' && typeof o.scenarioId === 'string') ||
    (o.kind === 'pstn' && typeof o.number === 'string')
  );
}

/** Reads call meta from router state (preferred) or sessionStorage. */
export function loadCallMeta(callId: string, routerState?: unknown): CallMeta | null {
  const pick = (v: unknown): CallMeta | null => {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    if (!isTarget(o.target)) return null;
    return {
      target: o.target,
      ...(typeof o.autonomy === 'string' ? { autonomy: o.autonomy as Autonomy } : {}),
      ...(typeof o.goal === 'string' && o.goal ? { goal: o.goal } : {}),
      ...(typeof o.voice === 'string' && o.voice ? { voice: o.voice } : {}),
      ...(Array.isArray(o.shared)
        ? { shared: o.shared.filter((k): k is string => typeof k === 'string') }
        : {}),
    };
  };
  const fromState = pick(routerState);
  if (fromState) return fromState;
  try {
    const raw = sessionStorage.getItem(metaKey(callId));
    return raw ? pick(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** "simulated line", "practice line · ABC123" or the number dialled. */
export function targetSubtitle(t: CallTarget): string {
  switch (t.kind) {
    case 'scenario':
      return 'simulated line';
    case 'line':
      return `practice line · ${t.code}`;
    case 'pstn':
      return t.number;
  }
}
