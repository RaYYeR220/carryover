import { stderrDebugLog } from '../debugLog.js';
import { ScenarioEngine, type ScenarioEngineDeps, type TraceEntry } from '../scenarios/engine.js';
import type { Scenario } from '../scenarios/types.js';
import { defaultSendDtmf, type PhoneLeg } from './phoneLeg.js';

export type ScenarioLegDeps = Omit<ScenarioEngineDeps, 'emitToCaller' | 'onEnded'>;

// A simulated business as a phone leg: rings for the scenario's ringMs, then the engine
// answers (menu, hold, representative or voicemail).
// With LOG_LEVEL=debug the simulated business side joins the timing lines (event names
// and detail lengths only), so a live run shows what the representative heard and when.
function traceToDebug(): ((e: TraceEntry) => void) | undefined {
  if (process.env.LOG_LEVEL !== 'debug') return undefined;
  const debug = stderrDebugLog();
  return (e) => debug(`biz.${e.event}`, { node: e.node, len: e.detail?.length });
}

export class ScenarioLeg implements PhoneLeg {
  readonly label: string;
  readonly kind = 'scenario' as const;
  readonly scenario: Scenario;

  private readonly eng: ScenarioEngine;
  private readonly audioCbs: ((mu: Buffer) => void)[] = [];
  private readonly endCbs: ((reason: string) => void)[] = [];
  private ringTimer: ReturnType<typeof setTimeout> | undefined;
  private cancelRing: (() => void) | undefined;
  private done = false;

  constructor(s: Scenario, deps: ScenarioLegDeps) {
    this.scenario = s;
    this.label = `${s.info.business} (simulated)`;
    this.eng = new ScenarioEngine(s, {
      ...deps,
      log: deps.log ?? traceToDebug(),
      emitToCaller: (mu) => {
        for (const cb of this.audioCbs) cb(mu);
      },
      onEnded: (reason) => this.ended(reason),
    });
  }

  // Trace and representative transcript for the eval.
  get engine(): ScenarioEngine {
    return this.eng;
  }

  start(): Promise<void> {
    if (this.done) return Promise.reject(new Error('the call has ended'));
    return new Promise((resolve) => {
      this.cancelRing = resolve;
      this.ringTimer = setTimeout(() => {
        this.ringTimer = undefined;
        this.cancelRing = undefined;
        if (!this.done) this.eng.start();
        resolve();
      }, this.scenario.ringMs ?? 0);
    });
  }

  onAudio(cb: (mu: Buffer) => void): void {
    this.audioCbs.push(cb);
  }

  sendAudio(mu: Buffer): void {
    this.eng.fromCaller(mu);
  }

  sendDtmf(digits: string): void {
    defaultSendDtmf(this, digits);
  }

  onEnded(cb: (reason: string) => void): void {
    this.endCbs.push(cb);
  }

  async hangup(_reason: string): Promise<void> {
    this.done = true;
    this.stopRinging();
    await this.eng.stop();
  }

  private ended(reason: string): void {
    if (this.done) return;
    this.done = true;
    this.stopRinging();
    for (const cb of this.endCbs) {
      try {
        cb(reason);
      } catch {
        // a listener failing must not stop the others hearing the hang-up
      }
    }
  }

  private stopRinging(): void {
    if (this.ringTimer) clearTimeout(this.ringTimer);
    this.ringTimer = undefined;
    // Hung up while ringing: the dial attempt is over, not stuck.
    this.cancelRing?.();
    this.cancelRing = undefined;
  }
}
