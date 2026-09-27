import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VAEvent } from '../../src/aai/voiceAgent.js';
import { dtmfMulaw } from '../../src/audio/dtmf.js';
import { CallSession } from '../../src/call/callSession.js';
import type { Config } from '../../src/config.js';
import { ScenarioLeg } from '../../src/legs/scenarioLeg.js';
import { getScenario } from '../../src/scenarios/library/index.js';
import type { Scenario } from '../../src/scenarios/types.js';
import { FakeCaptions, fakeCaptionsFactory } from '../fakes/fakeCaptions.js';
import { FakeProvider } from '../fakes/fakeProvider.js';
import { FakeVoiceAgent, fakeVoiceAgentFactory } from '../fakes/fakeVoiceAgent.js';

function scenario(id: string): Scenario {
  const s = getScenario(id);
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
}

const legs: ScenarioLeg[] = [];

function setup(id: string) {
  const vas: FakeVoiceAgent[] = [];
  const leg = new ScenarioLeg(scenario(id), {
    apiKey: 'aai-key',
    makeVoiceAgent: (_session, onEvent: (e: VAEvent) => void, onClose) => {
      const va = new FakeVoiceAgent('inline', onEvent, onClose);
      vas.push(va);
      return va;
    },
    makeCaptions: (o) => new FakeCaptions(o),
    loadAsset: () => Buffer.alloc(8000, 0x7f),
  });
  legs.push(leg);
  const heard: Buffer[] = [];
  const ended: string[] = [];
  leg.onAudio((mu) => heard.push(mu));
  leg.onEnded((r) => ended.push(r));
  return { leg, vas, heard, ended };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  for (const l of legs.splice(0)) await l.hangup('test-cleanup');
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('ScenarioLeg', () => {
  it('is labelled as a simulated business', () => {
    const { leg } = setup('riverside-pharmacy');
    expect(leg.kind).toBe('scenario');
    expect(leg.label).toBe('Riverside Pharmacy (simulated)');
  });

  it('rings for ringMs, then answers with the menu', async () => {
    const { leg, heard } = setup('city-clinic-voicemail');
    let answered = false;
    const started = leg.start().then(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(2900);
    expect(answered).toBe(false);
    expect(heard).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    await started;
    expect(answered).toBe(true);
    expect(leg.engine.trace[0]).toMatchObject({ event: 'start' });
    await vi.advanceTimersByTimeAsync(300);
    expect(heard.length).toBe(3);
  });

  it('keypad tones sent down the leg reach the menu', async () => {
    const { leg } = setup('northstar-bank');
    const started = leg.start();
    await vi.advanceTimersByTimeAsync(1500);
    await started;
    leg.sendDtmf('1');
    expect(leg.engine.currentNode).toBe('hold');
  });

  it('agent audio sent down the leg reaches the rep', async () => {
    const { leg, vas } = setup('lakeview-dental');
    const started = leg.start();
    await vi.advanceTimersByTimeAsync(2500);
    await started;
    await vi.advanceTimersByTimeAsync(10);
    const va = vas[0] as FakeVoiceAgent;
    leg.sendAudio(Buffer.alloc(800, 0x22));
    expect(va.audio.at(-1)?.[0]).toBe(0x22);
  });

  it('reports the business hanging up', async () => {
    const { leg, ended } = setup('city-clinic-voicemail');
    const started = leg.start();
    await vi.advanceTimersByTimeAsync(3000);
    await started;
    await vi.advanceTimersByTimeAsync(25_000);
    expect(ended).toEqual(['voicemail-complete']);
  });

  it('hangup while ringing never answers and does not report an end', async () => {
    const { leg, ended, heard } = setup('city-clinic-voicemail');
    const started = leg.start();
    await vi.advanceTimersByTimeAsync(1000);
    await leg.hangup('user-hangup');
    await started;
    await vi.advanceTimersByTimeAsync(5000);
    expect(leg.engine.trace).toEqual([]);
    expect(heard).toEqual([]);
    expect(ended).toEqual([]);
  });

  it('hangup closes the rep session', async () => {
    const { leg, vas, ended } = setup('lakeview-dental');
    const started = leg.start();
    await vi.advanceTimersByTimeAsync(2500);
    await started;
    await leg.hangup('user-hangup');
    expect((vas[0] as FakeVoiceAgent).endCalls).toBe(1);
    expect(ended).toEqual([]);
    expect(leg.engine.ended).toBe(true);
    // pressing keys after the hang-up is harmless
    leg.sendAudio(dtmfMulaw('1'));
  });
});

describe('ScenarioLeg inside a CallSession', () => {
  it("the relay agent's keypress travels through the call's audio path into the menu", async () => {
    const { leg, vas } = setup('riverside-pharmacy');
    const relay = fakeVoiceAgentFactory();
    const caps = fakeCaptionsFactory();
    const cfg: Config = {
      aaiKey: 'aai-key',
      llmProvider: 'venice',
      llmModel: 'test-model',
      veniceKey: 'venice-key',
      publicBaseUrl: 'https://example.com',
      brainSecret: 'secret',
      port: 8787,
      aaiStreamingUrl: 'wss://streaming.assemblyai.com/v3/ws',
      aaiAgentsWsUrl: 'wss://agents.assemblyai.com/v1/ws',
      aaiAgentsRestUrl: 'https://agents.assemblyai.com/v1',
    };
    const call = new CallSession(
      {
        target: { kind: 'scenario', scenarioId: 'riverside-pharmacy' },
        userName: 'Maya',
        userDescriptor: 'deaf',
        autonomy: 'assist',
        facts: [],
        voice: 'jane',
      },
      leg,
      {
        cfg,
        provider: new FakeProvider(),
        agents: { ensureRelayAgent: async () => 'agent_relay' },
        makeVoiceAgent: relay.make,
        makeCaptions: caps.make,
        log: () => undefined,
      },
    );
    const started = call.start();
    await vi.advanceTimersByTimeAsync(2000);
    await started;
    await vi.advanceTimersByTimeAsync(1000);
    // the menu reaches the call as a steady 100 ms frame stream
    expect(relay.last.audio.length).toBeGreaterThanOrEqual(9);
    expect(relay.last.audio.every((f) => f.length === 800)).toBe(true);

    relay.last.emit({
      type: 'tool.call',
      call_id: 'k1',
      name: 'press_keys',
      arguments: { digits: '2' },
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(leg.engine.trace).toContainEqual(
      expect.objectContaining({ node: 'menu', event: 'ivr-option', detail: '2' }),
    );
    expect(leg.engine.currentNode).toBe('hold');

    await vi.advanceTimersByTimeAsync(18_000);
    expect(leg.engine.currentNode).toBe('dana');
    expect(vas).toHaveLength(1);

    await call.end('test-done');
    expect((vas[0] as FakeVoiceAgent).endCalls).toBe(1);
    expect(relay.last.endCalls).toBe(1);
  });
});
