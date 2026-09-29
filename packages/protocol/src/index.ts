import { z } from 'zod';

export const Autonomy = z.enum(['relay', 'assist', 'auto']);
export type Autonomy = z.infer<typeof Autonomy>;

export const LineState = z.enum([
  'connecting',
  'ringing',
  'ivr',
  'hold',
  'human',
  'voicemail',
  'ended',
]);
export type LineState = z.infer<typeof LineState>;

export const UserDescriptor = z.enum([
  'deaf',
  'hard-of-hearing',
  'speech-disabled',
  'prefers-text',
]);
export type UserDescriptor = z.infer<typeof UserDescriptor>;

// Each distinct voice creates a stored agent on the AssemblyAI account, so the request
// can't take an arbitrary string -- this is the fixed set the start page offers.
export const Voice = z.enum([
  'alba',
  'jane',
  'mary',
  'eve',
  'jean',
  'michael',
  'george',
  'anna',
  'vera',
]);
export type Voice = z.infer<typeof Voice>;

export const Fact = z.object({
  key: z.string().min(1).max(40), // 'dob', 'member_id', 'address'
  label: z.string().min(1).max(60), // 'Date of birth'
  value: z.string().min(1).max(200),
});
export type Fact = z.infer<typeof Fact>;

export const CallTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('line'), code: z.string().regex(/^[A-Z0-9]{6}$/) }),
  z.object({ kind: z.literal('scenario'), scenarioId: z.string().min(1) }),
  z.object({ kind: z.literal('pstn'), number: z.string().regex(/^\+[1-9]\d{6,14}$/) }),
]);
export type CallTarget = z.infer<typeof CallTarget>;

export const StartCallRequest = z.object({
  target: CallTarget,
  userName: z.string().min(1).max(40),
  userDescriptor: UserDescriptor,
  autonomy: Autonomy,
  goal: z.string().max(400).optional(),
  facts: z.array(Fact).max(20),
  voice: Voice,
});
export type StartCallRequest = z.infer<typeof StartCallRequest>;

export interface StartCallResponse {
  callId: string;
  appToken: string;
}

export interface SpeakerRef {
  role: 'them' | 'ivr';
  label: string;
  person: number;
}
export interface CaptionWord {
  text: string;
  confidence: number;
  start: number;
  end: number;
}
export interface TranscriptEntry {
  at: number;
  who: 'them' | 'agent' | 'user-note';
  person?: number;
  text: string;
  source?: 'relay' | 'agent' | 'disclosure';
}
export interface Commitment {
  text: string;
  when?: string;
}
export interface CallSummary {
  callId: string;
  startedAt: number;
  endedAt: number;
  targetLabel: string;
  outcome: string;
  bullets: string[];
  commitments: Commitment[];
  transcript: TranscriptEntry[];
}

export type AlertKind =
  | 'human-picked-up'
  | 'new-speaker'
  | 'voicemail'
  | 'call-ended'
  | 'ask'
  | 'voice';

export type AppEvent =
  | {
      t: 'call.state';
      lineState: LineState;
      autonomy: Autonomy;
      since: number;
      targetLabel: string;
    }
  | {
      t: 'caption';
      id: string;
      speaker: SpeakerRef;
      text: string;
      words: CaptionWord[];
      final: boolean;
      at: number;
    }
  | {
      t: 'agent.said';
      id: string;
      text: string;
      source: 'relay' | 'agent' | 'disclosure';
      interrupted: boolean;
      at: number;
    }
  | {
      t: 'relay.queued';
      nonce: string;
      text: string;
      reason: 'waiting-for-pause' | 'agent-speaking';
    }
  | { t: 'relay.spoken'; nonce: string; at: number }
  | { t: 'ask'; askId: string; question: string; field?: string; from: string; at: number }
  | { t: 'ask.resolved'; askId: string; how: 'typed' | 'shared' | 'declined' | 'expired' }
  | { t: 'alert'; kind: AlertKind; message: string; at: number }
  | { t: 'dtmf'; digits: string; at: number }
  | { t: 'gate.blocked'; sentence: string; reason: string; at: number }
  | { t: 'commitment'; commitment: Commitment; at: number }
  | { t: 'summary'; summary: CallSummary }
  | { t: 'error'; message: string };

export const AppCommand = z.discriminatedUnion('t', [
  z.object({ t: z.literal('say'), text: z.string().max(2000), urgent: z.boolean().optional() }),
  z.object({
    t: z.literal('answer'),
    askId: z.string(),
    text: z.string().max(500).optional(),
    shareFactKey: z.string().optional(),
    decline: z.boolean().optional(),
  }),
  z.object({ t: z.literal('autonomy'), value: Autonomy }),
  z.object({ t: z.literal('keys'), digits: z.string().regex(/^[0-9*#]{1,20}$/) }),
  z.object({ t: z.literal('share'), fact: Fact }),
  z.object({ t: z.literal('hangup') }),
]);
export type AppCommand = z.infer<typeof AppCommand>;

// Line socket (browser leg). Binary frames = μ-law 8 kHz audio both directions.
export type LineServerMsg =
  | {
      t: 'line.status';
      status: 'waiting' | 'ringing' | 'connected' | 'ended';
      callerLabel?: string;
    }
  | { t: 'line.hint'; text: string };
export const LineClientMsg = z.discriminatedUnion('t', [
  z.object({ t: z.literal('line.answer') }),
  z.object({ t: z.literal('line.hangup') }),
]);
export type LineClientMsg = z.infer<typeof LineClientMsg>;

export interface ScenarioInfo {
  id: string;
  label: string;
  business: string;
  description: string;
  suggestedGoal?: string;
  suggestedAutonomy: Autonomy;
}
export interface LineInfo {
  code: string;
  url: string;
  qrSvg: string;
  status: 'waiting' | 'ringing' | 'connected' | 'ended';
}

export const MAX_CALL_MS = 300_000;
export const MAX_CONCURRENT_CALLS = 3;
