import type { StartCallRequest } from '@carryover/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallRegistry, LimitError } from '../../src/call/callRegistry.js';
import type { CallDeps } from '../../src/call/callSession.js';
import type { Config } from '../../src/config.js';
import { fakeCaptionsFactory } from '../fakes/fakeCaptions.js';
import { FakeLeg } from '../fakes/fakeLeg.js';
import { FakeProvider } from '../fakes/fakeProvider.js';
import { fakeVoiceAgentFactory } from '../fakes/fakeVoiceAgent.js';

const REQ: StartCallRequest = {
  target: { kind: 'scenario', scenarioId: 'riverside-pharmacy' },
  userName: 'Maya',
  userDescriptor: 'deaf',
  autonomy: 'assist',
  facts: [],
  voice: 'jane',
};

function deps(): CallDeps {
  return {
    cfg: { aaiKey: 'k', brainSecret: 's', publicBaseUrl: 'https://x.test' } as Config,
    provider: new FakeProvider(),
    agents: { ensureRelayAgent: async () => 'agent_relay' },
    makeVoiceAgent: fakeVoiceAgentFactory().make,
    makeCaptions: fakeCaptionsFactory().make,
    log: () => undefined,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('CallRegistry', () => {
  it('creates, finds and lists calls, and hands the Brain a view', () => {
    const reg = new CallRegistry();
    const a = reg.create(REQ, new FakeLeg(), deps());
    const b = reg.create(REQ, new FakeLeg(), deps());
    expect(a.id).not.toBe(b.id);
    expect(reg.get(a.id)).toBe(a);
    expect(reg.get('missing')).toBeUndefined();
    expect(reg.all()).toEqual([a, b]);
    expect(reg.view(a.id)?.callId).toBe(a.id);
    expect(reg.view('missing')).toBeUndefined();
  });

  it('refuses a 4th concurrent call with LimitError', () => {
    const reg = new CallRegistry();
    for (let i = 0; i < 3; i++) reg.create(REQ, new FakeLeg(), deps());
    expect(() => reg.create(REQ, new FakeLeg(), deps())).toThrow(LimitError);
  });

  it('an ended call frees its slot at once, and is dropped 10 minutes later', async () => {
    const reg = new CallRegistry();
    const calls = [0, 1, 2].map(() => reg.create(REQ, new FakeLeg(), deps()));
    const first = calls[0];
    if (!first) throw new Error('unreachable');
    await first.end('user-hangup');
    const next = reg.create(REQ, new FakeLeg(), deps());
    expect(reg.get(first.id)).toBe(first); // still readable (summary, late Brain requests)
    expect(reg.view(first.id)?.lineState).toBe('ended');

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(reg.get(first.id)).toBeUndefined();
    expect(reg.all()).not.toContain(first);
    expect(reg.get(next.id)).toBe(next);
    for (const c of reg.all()) await c.end('cleanup');
  });
});
