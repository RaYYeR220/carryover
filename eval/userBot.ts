// Plays the human on the other end of the app socket: reacts to `ask` and `alert`
// AppEvents from a live call by sending AppCommands, driven entirely by the scenario's
// hidden AnswerKey (never by anything the server tells it about the "right" answer).
//
// - An `ask` whose question matches a userScript step's `onAsk` (substring,
//   case-insensitive) is answered after that step's `afterMs`, with the digit going
//   through the `keys` command for an IVR-choice ask (never `answer`) and everything
//   else through `answer`.
// - An `ask` that matches no step is declined after a short delay -- the user just
//   doesn't have that information for this call.
// - An `alert` whose kind matches a userScript step's trigger (e.g. voicemail picked up)
//   sends the scripted text as a typed `say`.
import type { AlertKind, AppCommand, AppEvent } from '@carryover/protocol';
import type { AnswerKey, UserScriptStep } from './metrics.js';

export interface UserBotDeps {
  send: (cmd: AppCommand) => void;
  log?: (msg: string) => void;
  now?: () => number;
}

const DECLINE_AFTER_MS = 800;

export class UserBot {
  private readonly key: AnswerKey;
  private readonly deps: UserBotDeps;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly firedAlerts = new Set<string>();
  private readonly handledAsks = new Set<string>();

  constructor(key: AnswerKey, deps: UserBotDeps) {
    this.key = key;
    this.deps = deps;
  }

  onEvent(e: AppEvent): void {
    if (e.t === 'ask') this.onAsk(e);
    else if (e.t === 'alert') this.onAlert(e.kind);
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private onAsk(e: Extract<AppEvent, { t: 'ask' }>): void {
    if (this.handledAsks.has(e.askId)) return;
    this.handledAsks.add(e.askId);
    const q = e.question.toLowerCase();
    const step = this.key.userScript.find(
      (s) =>
        s.trigger.type === 'ask' && s.trigger.onAsk && q.includes(s.trigger.onAsk.toLowerCase()),
    );
    if (!step) {
      this.log(`ask "${e.question}" matches no userScript step -- declining`);
      this.after(DECLINE_AFTER_MS, () =>
        this.deps.send({ t: 'answer', askId: e.askId, decline: true }),
      );
      return;
    }
    this.after(step.afterMs, () => this.applyAskStep(e.askId, step));
  }

  private applyAskStep(askId: string, step: UserScriptStep): void {
    const value = resolveAnswerWith(step.answerWith, this.key);
    if (step.via === 'keys') {
      const digits = value.replace(/[^0-9*#]/g, '');
      this.log(`ask ${askId} -> keys "${digits}"`);
      this.deps.send({ t: 'keys', digits });
      return;
    }
    this.log(`ask ${askId} -> answer "${value}"`);
    this.deps.send({ t: 'answer', askId, text: value });
  }

  private onAlert(kind: AlertKind): void {
    if (this.firedAlerts.has(kind)) return;
    const step = this.key.userScript.find(
      (s) => s.trigger.type === 'alert' && s.trigger.kind === kind,
    );
    if (!step) return;
    this.firedAlerts.add(kind);
    this.after(step.afterMs, () => {
      const text = resolveAnswerWith(step.answerWith, this.key);
      this.log(`alert ${kind} -> say "${text}"`);
      this.deps.send({ t: 'say', text, urgent: step.urgent ?? true });
    });
  }

  private after(ms: number, fn: () => void): void {
    const t = setTimeout(fn, ms);
    this.timers.add(t);
  }

  private log(msg: string): void {
    this.deps.log?.(msg);
  }
}

const FACT_PATH_RE = /^(consentedFacts|privateFacts)\.([a-zA-Z0-9_]+)$/;

// 'consentedFacts.<key>' / 'privateFacts.<key>' resolves against the key's own facts;
// anything else (including a sentence with a literal '.' in it) is the literal text.
export function resolveAnswerWith(spec: string, key: AnswerKey): string {
  const m = FACT_PATH_RE.exec(spec);
  if (!m) return spec;
  const [, group, factKey] = m;
  const facts = group === 'privateFacts' ? key.privateFacts : key.consentedFacts;
  const fact = facts.find((f) => f.key === factKey);
  if (!fact) throw new Error(`answerWith "${spec}" has no matching fact in the key`);
  return fact.value;
}
