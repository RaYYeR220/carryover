import type { Fact } from '@carryover/protocol';
import { createLedger, type ExtractedFact } from '../../src/brain/factGate.js';
import type { BrainCallView } from '../../src/brain/policy.js';

export interface FakeView extends BrainCallView {
  nonces: Map<string, string>;
  blocked: { sentence: string; offending: ExtractedFact[] }[];
  toolLoopDepth: number;
}

export const MAYA_FACTS: Fact[] = [
  { key: 'dob', label: 'Date of birth', value: 'March 14, 1952' },
  { key: 'member_id', label: 'Member ID', value: '88-1204-77' },
];

export function fakeView(overrides: Partial<BrainCallView> & { callId: string }): FakeView {
  const facts = overrides.facts ?? MAYA_FACTS;
  const nonces = new Map<string, string>();
  const blocked: FakeView['blocked'] = [];
  const view: FakeView = {
    autonomy: 'assist',
    lineState: 'human',
    userName: 'Maya',
    userDescriptor: 'deaf',
    goal: 'Refill the blood pressure prescription.',
    facts,
    relayPending: false,
    ledger: createLedger(facts.map((f) => f.value)),
    nonces,
    blocked,
    toolLoopDepth: 0,
    takeNonce(nonce: string) {
      const text = nonces.get(nonce);
      nonces.delete(nonce);
      return text;
    },
    onToolLoopDepth() {
      return view.toolLoopDepth;
    },
    onGateBlocked(sentence: string, offending: ExtractedFact[]) {
      blocked.push({ sentence, offending });
    },
    ...overrides,
  };
  return view;
}
