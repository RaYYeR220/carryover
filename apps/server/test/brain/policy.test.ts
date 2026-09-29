import { describe, expect, it } from 'vitest';
import { decide, RELAY_TOOLS, systemPrompt } from '../../src/brain/policy.js';
import type { ParsedBrainRequest } from '../../src/brain/requestParse.js';
import { fakeView } from './fakeView.js';

const userTurn: ParsedBrainRequest = {
  callTag: { kind: 'call', callId: 'call-aaaa-1111' },
  lastRole: 'user',
  history: [{ role: 'user', content: 'Can I get her date of birth?' }],
  lastUserText: 'Can I get her date of birth?',
};

describe('decide', () => {
  it('no view → silence unknown-call', () => {
    expect(decide(userTurn, undefined)).toEqual({ kind: 'silence', why: 'unknown-call' });
  });

  it('known nonce → verbatim (one-shot)', () => {
    const v = fakeView({ callId: 'call-aaaa-1111' });
    v.nonces.set('nonce12345', 'Her date of birth is March 14, 1952.');
    const p = { ...userTurn, relayNonce: 'nonce12345', lastRole: 'system' as const };
    expect(decide(p, v)).toEqual({
      kind: 'verbatim',
      text: 'Her date of birth is March 14, 1952.',
    });
    expect(decide(p, v)).toEqual({ kind: 'silence', why: 'stale-nonce' });
  });

  it('verbatim wins over hold / relay mode / pending typing', () => {
    const v = fakeView({
      callId: 'call-aaaa-1111',
      lineState: 'hold',
      autonomy: 'relay',
      relayPending: true,
    });
    v.nonces.set('nonce12345', 'Still here.');
    expect(decide({ ...userTurn, relayNonce: 'nonce12345' }, v)).toEqual({
      kind: 'verbatim',
      text: 'Still here.',
    });
  });

  it('follows the decision table in order', () => {
    const base = { callId: 'call-aaaa-1111' };
    expect(decide(userTurn, fakeView({ ...base, lineState: 'hold', autonomy: 'relay' }))).toEqual({
      kind: 'silence',
      why: 'on-hold',
    });
    expect(decide(userTurn, fakeView({ ...base, autonomy: 'relay', relayPending: true }))).toEqual({
      kind: 'silence',
      why: 'relay-mode',
    });
    expect(decide(userTurn, fakeView({ ...base, relayPending: true }))).toEqual({
      kind: 'silence',
      why: 'user-typing-queued',
    });
    for (const tool of ['press_keys', 'end_call']) {
      expect(decide({ ...userTurn, lastRole: 'tool', lastToolName: tool }, fakeView(base))).toEqual(
        { kind: 'silence', why: 'post-tool' },
      );
    }
    // A note or a line-state fix is not an answer: silent only when something was already
    // said after the other party's turn (live: note_commitment alone left "Anything
    // else?" unanswered and the call hung).
    for (const tool of ['set_line_state', 'note_commitment']) {
      const post = { ...userTurn, lastRole: 'tool' as const, lastToolName: tool };
      expect(decide({ ...post, answeredSinceUser: true }, fakeView(base))).toEqual({
        kind: 'silence',
        why: 'post-tool',
      });
      expect(decide(post, fakeView(base))).toEqual({ kind: 'proxy' });
    }
    expect(
      decide({ ...userTurn, lastRole: 'tool', lastToolName: 'ask_user' }, fakeView(base)),
    ).toEqual({ kind: 'proxy' });
    const loopy = fakeView(base);
    loopy.toolLoopDepth = 5;
    expect(decide(userTurn, loopy)).toEqual({ kind: 'silence', why: 'tool-loop' });
    loopy.toolLoopDepth = 4;
    expect(decide(userTurn, loopy)).toEqual({ kind: 'proxy' });
    expect(decide(userTurn, fakeView({ ...base, autonomy: 'auto' }))).toEqual({ kind: 'proxy' });
  });

  it('an ended call or an empty conversation is silence', () => {
    const base = { callId: 'call-aaaa-1111' };
    expect(decide(userTurn, fakeView({ ...base, lineState: 'ended' }))).toEqual({
      kind: 'silence',
      why: 'call-ended',
    });
    expect(decide({ lastRole: 'none', history: [] }, fakeView(base))).toEqual({
      kind: 'silence',
      why: 'empty-history',
    });
  });
});

describe('systemPrompt', () => {
  it('says FACT SHEET details directly and keeps share_fact for missing ones (no extra LLM round trip)', () => {
    const s = systemPrompt(fakeView({ callId: 'call-aaaa-1111' }));
    expect(s).toMatch(
      /asks for a detail that is in the FACT SHEET, say it right away in your reply, with no tool call/,
    );
    const share = RELAY_TOOLS.find((t) => t.name === 'share_fact');
    expect(share?.description).toMatch(/^Only for a detail that is NOT in the FACT SHEET/);
    expect(share?.description).not.toMatch(/before saying it/);
    expect(s).toMatch(/call note_commitment and, in the same reply, still answer them/);
    // assist: a detail the GOAL states (which prescription) is said, not asked (live: the
    // rep's "Which prescription?" became an ask card and the call waited on the user).
    expect(s).toMatch(/say what the GOAL already states/);
  });

  it('states identity, strict rules, fact sheet, goal and line state', () => {
    const v = fakeView({ callId: 'call-aaaa-1111', autonomy: 'auto', lineState: 'ivr' });
    const s = systemPrompt(v);
    expect(s).toContain('automated relay');
    expect(s).toContain('Maya');
    expect(s).toContain('Deaf');
    expect(s).toMatch(/never state any personal fact/i);
    expect(s).toContain('ask_user');
    expect(s).toContain('press_keys');
    expect(s).toMatch(/robot/i);
    expect(s).toMatch(/emergency/i);
    expect(s).toMatch(/hold/i);
    expect(s).toContain('FACT SHEET');
    expect(s).toContain('Date of birth: March 14, 1952');
    expect(s).toContain('Member ID: 88-1204-77');
    expect(s).toContain('GOAL: Refill the blood pressure prescription.');
    expect(s).toMatch(/LINE STATE: ivr/);
    expect(s).not.toContain('carryover-call');
  });

  it('only the FACT SHEET is a source of personal facts, and read-back values are never confirmed', () => {
    const s = systemPrompt(fakeView({ callId: 'call-aaaa-1111' }));
    expect(s).toMatch(/never state any personal fact[^.]*unless it is written in the FACT SHEET/i);
    expect(s).not.toMatch(/other party said it first/i);
    expect(s).toContain(
      'Never confirm a personal fact read to you unless it matches the FACT SHEET; otherwise call ask_user',
    );
    expect(s).toContain('Is her date of birth June 1st, 1986?');
    expect(s).toMatch(/call ask_user instead of saying yes or no/i);
  });

  it('with no facts says it knows none', () => {
    const s = systemPrompt(fakeView({ callId: 'call-aaaa-1111', facts: [], goal: undefined }));
    expect(s).toMatch(/FACT SHEET[\s\S]*none/i);
    expect(s).toMatch(/GOAL: \(none/);
  });
});

describe('RELAY_TOOLS', () => {
  it('declares the six relay tools in AAI flat schema', () => {
    expect(RELAY_TOOLS.map((t) => t.name)).toEqual([
      'press_keys',
      'ask_user',
      'share_fact',
      'note_commitment',
      'set_line_state',
      'end_call',
    ]);
    for (const t of RELAY_TOOLS) {
      expect(t.type).toBe('function');
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.parameters).toMatchObject({ type: 'object' });
    }
    const pk = RELAY_TOOLS[0]?.parameters as { required: string[] };
    expect(pk.required).toEqual(['digits']);
  });
});
