import type { TranscriptEntry } from '@carryover/protocol';
import { describe, expect, it } from 'vitest';
import { summarize } from '../../src/call/summary.js';
import { FakeProvider } from '../fakes/fakeProvider.js';

const TRANSCRIPT: TranscriptEntry[] = [
  { at: 1, who: 'them', person: 1, text: 'This is Dana, how can I help?' },
  {
    at: 2,
    who: 'agent',
    text: 'Hi, this is Carryover, an automated relay calling for Maya.',
    source: 'disclosure',
  },
  { at: 3, who: 'agent', text: 'I need to refill my lisinopril.', source: 'relay' },
  { at: 4, who: 'them', person: 1, text: "It'll be ready Thursday after 2 pm, reference 4471." },
];

const CTX = {
  userName: 'Maya',
  targetLabel: 'Riverside Pharmacy (simulated)',
  goal: 'Refill lisinopril',
  commitments: [{ text: 'Refill ready', when: 'Thursday after 2 pm' }],
};

describe('summarize', () => {
  it('asks the provider in JSON mode and returns the parsed summary', async () => {
    const provider = new FakeProvider(
      JSON.stringify({
        outcome: 'Refill will be ready Thursday.',
        bullets: ['Dana confirmed the lisinopril refill.', 'Reference 4471.'],
        commitments: [{ text: 'Refill ready, reference 4471', when: 'Thursday after 2 pm' }],
      }),
    );
    const s = await summarize(provider, TRANSCRIPT, CTX);
    expect(s).toEqual({
      outcome: 'Refill will be ready Thursday.',
      bullets: ['Dana confirmed the lisinopril refill.', 'Reference 4471.'],
      commitments: [{ text: 'Refill ready, reference 4471', when: 'Thursday after 2 pm' }],
    });
    const call = provider.completeCalls[0];
    expect(call?.opts).toEqual({ json: true });
    const prompt = call?.messages.map((m) => m.content).join('\n') ?? '';
    expect(prompt).toContain('Riverside Pharmacy (simulated)');
    expect(prompt).toContain('Maya');
    expect(prompt).toContain('reference 4471');
  });

  it('accepts JSON wrapped in a code fence and drops malformed items', async () => {
    const provider = new FakeProvider(
      '```json\n{"outcome":"Done","bullets":["a",3,""],"commitments":[{"text":"Call back"},{"when":"x"}]}\n```',
    );
    const s = await summarize(provider, TRANSCRIPT, CTX);
    expect(s).toEqual({ outcome: 'Done', bullets: ['a'], commitments: [{ text: 'Call back' }] });
  });

  it('keeps the commitments noted during the call when the model lists none', async () => {
    const provider = new FakeProvider('{"outcome":"Done","bullets":[],"commitments":[]}');
    const s = await summarize(provider, TRANSCRIPT, CTX);
    expect(s.commitments).toEqual(CTX.commitments);
  });

  it('falls back when the provider fails', async () => {
    const s = await summarize(new FakeProvider(new Error('upstream down')), TRANSCRIPT, CTX);
    expect(s).toEqual({ outcome: 'Call ended', bullets: [], commitments: CTX.commitments });
  });

  it('falls back on unusable output', async () => {
    for (const bad of ['not json', '[]', '{"bullets":[]}', '']) {
      const s = await summarize(new FakeProvider(bad), TRANSCRIPT, CTX);
      expect(s).toEqual({ outcome: 'Call ended', bullets: [], commitments: CTX.commitments });
    }
  });

  it('does not call the model for an empty transcript', async () => {
    const provider = new FakeProvider();
    const s = await summarize(provider, [], CTX);
    expect(provider.completeCalls).toHaveLength(0);
    expect(s.outcome).toBe('Call ended');
  });
});
