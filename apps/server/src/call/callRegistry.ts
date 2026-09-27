import { MAX_CONCURRENT_CALLS, type StartCallRequest } from '@carryover/protocol';
import type { BrainCallView } from '../brain/policy.js';
import type { PhoneLeg } from '../legs/phoneLeg.js';
import { type CallDeps, CallSession } from './callSession.js';

export class LimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LimitError';
  }
}

// Ended calls stay readable (summary, late Brain requests answered with silence) for a
// while, then are dropped.
const DROP_AFTER_MS = 10 * 60_000;

export interface CallRegistryOptions {
  maxConcurrent?: number;
  dropAfterMs?: number;
}

export class CallRegistry {
  private readonly calls = new Map<string, CallSession>();
  private readonly maxConcurrent: number;
  private readonly dropAfterMs: number;

  constructor(opts: CallRegistryOptions = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? MAX_CONCURRENT_CALLS;
    this.dropAfterMs = opts.dropAfterMs ?? DROP_AFTER_MS;
  }

  // Throws LimitError when MAX_CONCURRENT_CALLS calls are live. Does not start the call.
  create(req: StartCallRequest, leg: PhoneLeg, deps: CallDeps): CallSession {
    if (this.liveCount() >= this.maxConcurrent) {
      throw new LimitError(
        `Only ${this.maxConcurrent} calls can run at the same time. Try again in a few minutes.`,
      );
    }
    const session = new CallSession(req, leg, deps);
    this.calls.set(session.id, session);
    void session.finished.then(() => {
      const timer = setTimeout(() => {
        if (this.calls.get(session.id) === session) this.calls.delete(session.id);
      }, this.dropAfterMs);
      timer.unref?.();
    });
    return session;
  }

  get(id: string): CallSession | undefined {
    return this.calls.get(id);
  }

  view(id: string): BrainCallView | undefined {
    return this.calls.get(id)?.brainView();
  }

  all(): CallSession[] {
    return [...this.calls.values()];
  }

  liveCount(): number {
    let n = 0;
    for (const c of this.calls.values()) if (!c.ended) n++;
    return n;
  }
}
