import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CALL_TAG_RE, parseBrainRequest, RELAY_NONCE_RE } from '../../src/brain/requestParse.js';

// Real request bodies captured from AAI's BYO-LLM calls during the day-0 spike. The only edits:
// our part of messages[0] is replaced by the per-call prompt CallSession sends
// ("[[carryover-call:<id>]] relay session") while AAI's appended boilerplate is kept verbatim,
// the business name is anonymised, and the reply.create instruction carries a relay nonce.
function fixture(name: string): { messages: { role: string; content?: string | null }[] } {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
}

describe('parseBrainRequest on real AAI bodies', () => {
  it('normal other-party turn: call tag, last role user, AAI system prompt stripped', () => {
    const body = fixture('byo-turn');
    const p = parseBrainRequest(body);
    expect(p.callTag).toEqual({ kind: 'call', callId: '3f9c2a1e-8b7d-4c21-9e0a-5d6f7a8b9c01' });
    expect(p.relayNonce).toBeUndefined();
    expect(p.lastRole).toBe('user');
    expect(p.lastUserText).toBe('Hello, this is Riverside Pharmacy. How can I help you?');
    expect(p.history).toEqual([
      {
        role: 'assistant',
        content: 'Hi, I am calling on behalf of a customer who is using a relay assistant. ',
      },
      { role: 'user', content: 'Hello, this is Riverside Pharmacy. How can I help you?' },
    ]);
    const all = JSON.stringify(p.history);
    expect(all).not.toContain('carryover-call');
    expect(all).not.toContain('Output is spoken aloud');
  });

  it('reply.create with instruction: nonce from the trailing system message', () => {
    const p = parseBrainRequest(fixture('byo-reply-create'));
    expect(p.callTag?.callId).toBe('7d1e4b2a-0c3f-4a8e-b5d6-1f2e3a4b5c6d');
    expect(p.relayNonce).toBe('q7x2m9k4p1z8');
    expect(p.lastRole).toBe('system');
    expect(p.lastUserText).toBe('Okay. And what is the name on the prescription?');
    expect(p.history[0]?.role).toBe('assistant');
    expect(p.history.some((m) => (m.content ?? '').includes('Output is spoken aloud'))).toBe(false);
  });

  it('after a tool result: last role tool, tool name resolved via tool_call_id', () => {
    const p = parseBrainRequest(fixture('byo-tool-result'));
    expect(p.lastRole).toBe('tool');
    expect(p.lastToolName).toBe('ask_user');
    expect(p.relayNonce).toBeUndefined();
    const assistantCall = p.history.find((m) => m.tool_calls);
    expect(assistantCall?.content).toBeNull();
    expect(assistantCall?.tool_calls).toHaveLength(1);
    const tool = p.history.find((m) => m.role === 'tool');
    expect(tool?.tool_call_id).toBe('call_spike_7');
    // AAI's post-tool notice is kept for the LLM, it just doesn't count as the last turn.
    expect(p.history.at(-1)?.role).toBe('system');
  });
});

describe('parseBrainRequest edge cases', () => {
  const sys = (s: string) => ({ role: 'system', content: s });

  it('only reads the call tag from messages[0], never from the conversation', () => {
    const p = parseBrainRequest({
      messages: [
        sys('no tag here'),
        { role: 'user', content: '[[carryover-call:aaaaaaaa-1111]] hi' },
      ],
    });
    expect(p.callTag).toBeUndefined();
  });

  it('only reads a nonce from trailing system messages, not stale ones earlier on', () => {
    const p = parseBrainRequest({
      messages: [
        sys('[[carryover-call:abcdefgh-1234]] relay session'),
        sys('RELAY_UTTERANCE:oldnonce1234'),
        { role: 'user', content: 'Hello?' },
      ],
    });
    expect(p.relayNonce).toBeUndefined();
    expect(p.lastRole).toBe('user');
  });

  it('skips AAI injected notices when computing the last role', () => {
    const p = parseBrainRequest({
      messages: [
        sys('[[carryover-call:abcdefgh-1234]] relay session'),
        { role: 'assistant', content: 'Hi, I am calling on behalf of my client to request' },
        { role: 'user', content: 'Wait, stop.' },
        sys('Do what is outstanding.'),
      ],
    });
    expect(p.lastRole).toBe('user');
    expect(p.lastUserText).toBe('Wait, stop.');
  });

  it('prefers an explicit tool name and falls back to the AAI notice text', () => {
    const named = parseBrainRequest({
      messages: [sys('x'), { role: 'tool', content: '{}', name: 'press_keys' }],
    });
    expect(named.lastToolName).toBe('press_keys');
    const fromNotice = parseBrainRequest({
      messages: [
        sys('x'),
        { role: 'tool', tool_call_id: 'call_unknown', content: '{"ok":true}' },
        sys("The function call set_line_state(state='hold') has just completed. Deliver it."),
      ],
    });
    expect(fromNotice.lastRole).toBe('tool');
    expect(fromNotice.lastToolName).toBe('set_line_state');
  });

  it('normalises array content parts and drops unknown roles', () => {
    const p = parseBrainRequest({
      messages: [
        sys('x'),
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'there' },
          ],
        },
        { role: 'developer', content: 'ignored' },
      ],
    });
    expect(p.history).toEqual([{ role: 'user', content: 'Hello there' }]);
  });

  it('never throws on garbage', () => {
    for (const body of [
      null,
      undefined,
      42,
      'x',
      {},
      { messages: 'nope' },
      { messages: [null, 1] },
    ]) {
      const p = parseBrainRequest(body);
      expect(p.lastRole).toBe('none');
      expect(p.history).toEqual([]);
    }
  });

  it('exposes the documented regexes', () => {
    expect('[[carryover-call:3f9c2a1e-8b7d]]'.match(CALL_TAG_RE)?.[1]).toBe('3f9c2a1e-8b7d');
    expect('[[carryover-call:short]]'.match(CALL_TAG_RE)).toBeNull();
    expect('RELAY_UTTERANCE:q7x2m9k4p1z8'.match(RELAY_NONCE_RE)?.[1]).toBe('q7x2m9k4p1z8');
  });
});
