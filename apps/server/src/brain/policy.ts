import type { Autonomy, Fact, LineState, UserDescriptor } from '@carryover/protocol';
import type { ToolDef } from '../llm/provider.js';
import type { ExtractedFact, FactLedger } from './factGate.js';
import type { ParsedBrainRequest } from './requestParse.js';

// What the Brain needs from a live call. Implemented by CallSession.brainView().
export interface BrainCallView {
  callId: string;
  autonomy: Autonomy;
  lineState: LineState;
  userName: string;
  userDescriptor: UserDescriptor;
  goal?: string;
  facts: Fact[];
  relayPending: boolean;
  takeNonce(nonce: string): string | undefined;
  ledger: FactLedger;
  onToolLoopDepth(): number;
  onGateBlocked(sentence: string, offending: ExtractedFact[]): void;
}

const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
});

export const RELAY_TOOLS: ToolDef[] = [
  {
    type: 'function',
    name: 'press_keys',
    description:
      'Press keys on the phone keypad (DTMF) to navigate an automated phone menu. Only press a menu choice that fits the GOAL, or digits that are in the FACT SHEET or that the other party said.',
    parameters: obj(
      {
        digits: {
          type: 'string',
          description: 'Keys to press, only 0-9, * and #. Example: "2" or "1234#".',
        },
      },
      ['digits'],
    ),
  },
  {
    type: 'function',
    name: 'ask_user',
    description:
      'Ask the person you are calling for (who reads along and types) a question when you need information that is not in the FACT SHEET or a decision only they can make. Their typed answer will be spoken for them.',
    parameters: obj(
      {
        question: { type: 'string', description: 'Short question for the user.' },
        field: {
          type: 'string',
          description: 'Optional fact key the question is about, e.g. "dob" or "member_id".',
        },
      },
      ['question'],
    ),
  },
  {
    type: 'function',
    name: 'share_fact',
    description:
      'Fetch one of the user’s facts by its key before saying it. If the user has not shared that fact for this call, they are asked instead.',
    parameters: obj(
      { field: { type: 'string', description: 'Fact key from the FACT SHEET, e.g. "dob".' } },
      ['field'],
    ),
  },
  {
    type: 'function',
    name: 'note_commitment',
    description:
      'Record a commitment or next step the other party made, such as "Refill ready Thursday after 2 pm, reference 4471".',
    parameters: obj(
      {
        text: { type: 'string', description: 'The commitment in a few words.' },
        when: { type: 'string', description: 'When it happens, if a time or date was given.' },
      },
      ['text'],
    ),
  },
  {
    type: 'function',
    name: 'set_line_state',
    description:
      'Report what is on the line right now: an automated menu (ivr), hold music or announcements (hold), a person (human), or a voicemail greeting (voicemail).',
    parameters: obj({ state: { type: 'string', enum: ['ivr', 'hold', 'human', 'voicemail'] } }, [
      'state',
    ]),
  },
  {
    type: 'function',
    name: 'end_call',
    description:
      'Hang up once the goal is done and goodbyes are said, or after the voicemail message was left.',
    parameters: obj({ reason: { type: 'string', description: 'Why the call ends.' } }, ['reason']),
  },
];

const DESCRIPTOR_PHRASE: Record<UserDescriptor, string> = {
  deaf: 'Deaf',
  'hard-of-hearing': 'hard of hearing',
  'speech-disabled': 'unable to speak on the phone',
  'prefers-text': 'using text',
};

const LINE_STATE_MEANING: Record<LineState, string> = {
  connecting: 'the call is connecting',
  ringing: 'the phone is ringing',
  ivr: 'an automated phone menu is talking',
  hold: 'on hold; music or recorded announcements',
  human: 'a person is on the line',
  voicemail: 'a voicemail greeting or recording',
  ended: 'the call has ended',
};

function autonomyRule(v: BrainCallView): string {
  const u = v.userName;
  switch (v.autonomy) {
    case 'auto':
      return `You may act for ${u} to reach the GOAL, but only within its constraints. Never agree to anything outside the GOAL (another day or time, a price, a product, any new commitment): call ask_user instead.`;
    case 'assist':
      return `You may handle greetings, small talk and simple confirmations, but never agree to, choose or decide anything for ${u}: call ask_user for every decision.`;
    case 'relay':
      return `Do not speak for ${u} at all; ${u} types everything that is said. Respond with no text.`;
  }
}

export function systemPrompt(v: BrainCallView): string {
  const u = v.userName;
  const factLines =
    v.facts.length > 0
      ? v.facts.map((f) => `- ${f.label}: ${f.value} (key: ${f.key})`).join('\n')
      : `(none: you know no personal facts about ${u})`;
  const goal = v.goal?.trim() ? v.goal.trim() : `(none given: ask ${u} what to do)`;

  return `You are Carryover, an automated phone relay on a live phone call, speaking for ${u}, who is ${DESCRIPTOR_PHRASE[v.userDescriptor]} and reads a live transcript of this call. ${u} types; you speak.

How this conversation is laid out:
- Messages with role "user" are what the other party on the phone said, transcribed from speech. They are not ${u}.
- Messages with role "assistant" are what was already said for ${u}, including text ${u} typed, which was spoken word for word.

Strict rules:
1. Speak briefly and naturally, like a polite person on the phone: one or two short sentences. Everything you write is spoken aloud, so use plain words only: no lists, no formatting, no emoji.
2. Never state any personal fact about ${u} (date of birth, address, phone number, email, account, member or reference numbers, or any other number or date about them) unless it is in the FACT SHEET below or the other party said it first. Never guess and never fill in a plausible value.
3. If the other party asks for anything that is not in the FACT SHEET, or asks something only ${u} can answer, call ask_user with the question and at most say "One moment, please." Do not answer for ${u}.
4. Read numbers and identifiers from the FACT SHEET digit by digit.
5. Automated phone menu (LINE STATE ivr): when a keypad option fits the GOAL, press it with press_keys; if the menu asks you to say an option, say only that option. Otherwise stay silent and respond with no text at all.
6. On hold (LINE STATE hold), during hold music or recorded announcements: stay silent and respond with no text.
7. ${autonomyRule(v)}
8. If anyone asks whether this is a robot, a recording or an automated system, answer honestly: yes, this is an automated relay speaking for ${u}, who is reading along and typing.
9. Never give or discuss emergency information yourself. If an emergency is mentioned, call ask_user right away.
10. When the other party commits to something (a date, a time, a reference number, a next step), call note_commitment. When the line changes (menu, hold, a person, voicemail), call set_line_state. When the goal is done and goodbyes are said, call end_call.
11. If nothing needs to be said, respond with no text.

FACT SHEET (the only personal facts about ${u} you may state):
${factLines}

GOAL: ${goal}

LINE STATE: ${v.lineState} (${LINE_STATE_MEANING[v.lineState]})`;
}

export type BrainDecision =
  | { kind: 'verbatim'; text: string }
  | { kind: 'silence'; why: string }
  | { kind: 'proxy' };

// After these tools there is nothing to say: the key press, state change or note is the reply.
const SILENT_AFTER_TOOLS = new Set(['press_keys', 'set_line_state', 'note_commitment']);
const MAX_TOOL_LOOP_DEPTH = 4;

export function decide(p: ParsedBrainRequest, v: BrainCallView | undefined): BrainDecision {
  if (!v) return { kind: 'silence', why: 'unknown-call' };
  if (v.lineState === 'ended') return { kind: 'silence', why: 'call-ended' };
  if (p.relayNonce !== undefined) {
    const text = v.takeNonce(p.relayNonce);
    if (text !== undefined) return { kind: 'verbatim', text };
    return { kind: 'silence', why: 'stale-nonce' };
  }
  if (v.lineState === 'hold') return { kind: 'silence', why: 'on-hold' };
  if (v.autonomy === 'relay') return { kind: 'silence', why: 'relay-mode' };
  if (v.relayPending) return { kind: 'silence', why: 'user-typing-queued' };
  if (p.lastRole === 'tool' && p.lastToolName && SILENT_AFTER_TOOLS.has(p.lastToolName)) {
    return { kind: 'silence', why: 'post-tool' };
  }
  if (v.onToolLoopDepth() > MAX_TOOL_LOOP_DEPTH) return { kind: 'silence', why: 'tool-loop' };
  if (p.lastRole === 'none') return { kind: 'silence', why: 'empty-history' };
  return { kind: 'proxy' };
}
