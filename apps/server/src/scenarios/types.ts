import type { ScenarioInfo } from '@carryover/protocol';

// A simulated business: a small graph of phone-line nodes. The engine walks it — menus,
// hold, a representative played by a second Voice Agent session, voicemail.

export interface Prompt {
  text: string; // what the recording says (also the ground truth for captions)
  asset: string; // src/scenarios/assets/<asset>.ulaw — μ-law 8 kHz mono
}

export interface IvrOption {
  digits?: string; // keypad choice, e.g. '2'
  phrase?: string; // spoken choice, e.g. 'outages' (matched as whole words, any case)
  next: string;
}

export type ScenarioNode =
  | {
      kind: 'ivr';
      id: string;
      prompt: Prompt;
      options: IvrOption[];
      repeatAfterMs: number; // silence after the prompt before it plays again
      maxRepeats: number; // replays (timeouts or invalid choices) before giving up
      onTimeout?: string; // where to go after maxRepeats; ends the call when absent
    }
  | {
      kind: 'hold';
      id: string;
      durationMs: number;
      announcement?: Prompt;
      announceEveryMs: number; // music between announcements
      next: string;
    }
  | {
      kind: 'rep';
      id: string;
      voice: string; // Voice Agent voice id
      name: string; // first name the rep introduces themselves with
      persona: string; // who they are, what they know, how they behave
      checklist: string[]; // what they need from / tell the caller, in order
      greeting: string; // spoken word for word when they pick up
      keyterms?: string[]; // words the rep's speech recognition should expect
      transferTo?: string; // rep node reached through the transfer_call tool
    }
  | { kind: 'voicemail'; id: string; prompt: Prompt; recordMs: number };

export type ScenarioNodeKind = ScenarioNode['kind'];

export interface Scenario {
  info: ScenarioInfo;
  ringMs?: number; // how long the line rings before it picks up
  start: string;
  nodes: Record<string, ScenarioNode>;
}
