import { type AppEvent, MAX_CALL_MS, type StartCallRequest } from '@carryover/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptionTurn } from '../../src/aai/captions.js';
import { dtmfMulaw } from '../../src/audio/dtmf.js';
import { holdMusicMulaw } from '../../src/audio/holdMusic.js';
import { encodeMulaw } from '../../src/audio/mulaw.js';
import { checkSentence } from '../../src/brain/factGate.js';
import { RELAY_TOOLS } from '../../src/brain/policy.js';
import { CALL_TAG_RE } from '../../src/brain/requestParse.js';
import { CallSession, disclosureText } from '../../src/call/callSession.js';
import type { Config } from '../../src/config.js';
import { type FakeCaptions, fakeCaptionsFactory } from '../fakes/fakeCaptions.js';
import { FakeLeg } from '../fakes/fakeLeg.js';
import { FakeProvider } from '../fakes/fakeProvider.js';
import { type FakeVoiceAgent, fakeVoiceAgentFactory } from '../fakes/fakeVoiceAgent.js';

const REQ: StartCallRequest = {
  target: { kind: 'scenario', scenarioId: 'riverside-pharmacy' },
  userName: 'Maya',
  userDescriptor: 'deaf',
  autonomy: 'assist',
  goal: 'Refill the lisinopril prescription before Thursday',
  facts: [
    { key: 'dob', label: 'Date of birth', value: 'March 14, 1952' },
    { key: 'full_name', label: 'Full name', value: 'Maya Lopez' },
  ],
  voice: 'jane',
};

const DISCLOSURE =
  "Hi, this is Carryover, an automated relay calling for Maya, who is Deaf and reading along. Please speak normally — I'll pass on everything you say.";

function cfg(): Config {
  return {
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
}

interface SetupOptions {
  req?: Partial<StartCallRequest>;
  leg?: FakeLeg;
  provider?: FakeProvider;
  va?: Parameters<typeof fakeVoiceAgentFactory>[0];
  captions?: Parameters<typeof fakeCaptionsFactory>[0];
  start?: boolean;
}

const sessions: CallSession[] = [];

async function setup(opts: SetupOptions = {}) {
  const order: string[] = [];
  const leg =
    opts.leg ??
    new FakeLeg({
      start: async () => {
        order.push('leg');
      },
    });
  const vaF = fakeVoiceAgentFactory(opts.va);
  const capF = fakeCaptionsFactory(opts.captions);
  const provider = opts.provider ?? new FakeProvider();
  const agents = {
    ensureRelayAgent: vi.fn(async () => {
      order.push('agent');
      return 'agent_relay';
    }),
  };
  const logs: unknown[][] = [];
  const session = new CallSession({ ...REQ, ...opts.req }, leg, {
    cfg: cfg(),
    provider,
    agents,
    makeVoiceAgent: (id, onEvent, onClose) => {
      order.push('va');
      return vaF.make(id, onEvent, onClose);
    },
    makeCaptions: (o) => {
      order.push('captions');
      return capF.make(o);
    },
    log: (...a: unknown[]) => {
      logs.push(a);
    },
  });
  sessions.push(session);
  const events: AppEvent[] = [];
  session.subscribe((e) => events.push(e));
  if (opts.start !== false) await session.start();
  return {
    session,
    leg,
    provider,
    agents,
    events,
    logs,
    order,
    vaF,
    capF,
    get va(): FakeVoiceAgent {
      return vaF.last;
    },
    get cap(): FakeCaptions {
      return capF.last;
    },
  };
}

type Ev<T extends AppEvent['t']> = Extract<AppEvent, { t: T }>;
function all<T extends AppEvent['t']>(events: AppEvent[], t: T): Ev<T>[] {
  return events.filter((e): e is Ev<T> => e.t === t);
}
function one<T extends AppEvent['t']>(events: AppEvent[], t: T): Ev<T> {
  const found = all(events, t);
  expect(found).toHaveLength(1);
  return found[0] as Ev<T>;
}
function alertKinds(events: AppEvent[]): string[] {
  return all(events, 'alert').map((a) => a.kind);
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.end('test-cleanup').catch(() => undefined);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('CallSession start', () => {
  it('ensures the relay agent with RELAY_TOOLS, tags the session, opens captions, then dials', async () => {
    const { session, agents, va, cap, leg, order, events } = await setup();

    expect(order).toEqual(['agent', 'va', 'captions', 'leg']);
    expect(agents.ensureRelayAgent).toHaveBeenCalledWith('jane', RELAY_TOOLS);
    expect(va.agentId).toBe('agent_relay');
    expect(va.updates).toEqual([
      { system_prompt: `[[carryover-call:${session.id}]] relay session` },
    ]);
    expect(CALL_TAG_RE.exec(String(va.updates[0]?.system_prompt))?.[1]).toBe(session.id);

    expect(cap.opts.apiKey).toBe('aai-key');
    expect(cap.opts.prompt).toBe(
      'Phone call to Riverside Pharmacy (simulated). Automated phone menus, hold messages and customer service representatives.',
    );
    const terms = cap.opts.keyterms;
    expect(terms).toEqual(expect.arrayContaining(['Maya', 'March 14, 1952', 'Maya Lopez']));
    expect(terms).toEqual(expect.arrayContaining(['lisinopril', 'prescription', 'Thursday']));
    expect(terms).not.toContain('the');
    expect(terms.length).toBeLessThanOrEqual(20);
    expect(new Set(terms.map((t) => t.toLowerCase())).size).toBe(terms.length);

    expect(leg.startCalls).toBe(1);
    expect(session.lineState).toBe('connecting');
    expect(all(events, 'call.state').map((e) => e.lineState)).toEqual([
      'connecting',
      'ringing',
      'connecting',
    ]);
    expect(session.appToken.length).toBeGreaterThanOrEqual(24);
    expect(session.verifyToken(session.appToken)).toBe(true);
    expect(session.verifyToken('nope')).toBe(false);
  });

  it('keyterms skip long fact values, cap at 20 and drop terms over 50 chars', async () => {
    const { cap } = await setup({
      req: {
        facts: [
          { key: 'addr', label: 'Address', value: '12 Long Street Apartment 4 North Side Town' },
          { key: 'email', label: 'Email', value: 'maya@example.com' },
        ],
        goal: Array.from({ length: 30 }, (_, i) => `keyword${i}`).join(' '),
      },
    });
    expect(cap.opts.keyterms).not.toContain('12 Long Street Apartment 4 North Side Town');
    expect(cap.opts.keyterms).toContain('maya@example.com');
    expect(cap.opts.keyterms).toHaveLength(20);
  });

  it('a captions connect failure after the Voice Agent connected ends the VA and never dials', async () => {
    const { session, leg, vaF, capF, events } = await setup({
      start: false,
      captions: { connectBehavior: 'reject' },
    });
    await expect(session.start()).rejects.toThrow('captions connect failed');
    expect(vaF.last.endCalls).toBe(1);
    expect(capF.last.closeCalls).toBe(1);
    expect(leg.startCalls).toBe(0);
    expect(leg.hangups).toHaveLength(1);
    expect(session.lineState).toBe('ended');
    expect(all(events, 'error')).toHaveLength(1);
    await advance(0);
    expect(all(events, 'summary')).toHaveLength(1);
  });

  it('a Voice Agent connect failure ends the call without opening captions', async () => {
    // The fake, like a real ws, fires onClose synchronously as connect() fails: that
    // close must not end the call before start() can reject.
    const { session, leg, vaF, capF, events } = await setup({
      start: false,
      va: { connectBehavior: 'reject' },
    });
    await expect(session.start()).rejects.toThrow('va connect failed');
    expect(all(events, 'error')).toHaveLength(1);
    expect(all(events, 'alert').find((a) => a.kind === 'call-ended')?.message).toBe(
      'Call ended: it could not be started.',
    );
    expect(vaF.last.endCalls).toBe(1);
    expect(capF.created).toHaveLength(0);
    expect(leg.startCalls).toBe(0);
    expect(session.lineState).toBe('ended');
  });

  it('a leg that fails to connect ends the AAI sessions', async () => {
    const leg = new FakeLeg({ start: () => Promise.reject(new Error('no-answer')) });
    const { session, vaF, capF } = await setup({ start: false, leg });
    await expect(session.start()).rejects.toThrow('no-answer');
    expect(vaF.last.endCalls).toBe(1);
    expect(capF.last.closeCalls).toBe(1);
  });

  it('hanging up while the relay agent is still being prepared never opens AAI sessions', async () => {
    let release: (id: string) => void = () => undefined;
    const { session, vaF, agents } = await setup({ start: false });
    agents.ensureRelayAgent.mockImplementationOnce(() => new Promise<string>((r) => (release = r)));
    const starting = session.start();
    session.handleCommand({ t: 'hangup' });
    release('agent_relay');
    await starting.catch(() => undefined);
    expect(vaF.created).toHaveLength(0);
    expect(session.lineState).toBe('ended');
  });
  it('hanging up while the Voice Agent is connecting closes it and never dials', async () => {
    const { session, vaF, capF, leg, events } = await setup({
      start: false,
      va: { connectBehavior: 'hang' },
    });
    const starting = session.start();
    await advance(0);
    expect(vaF.created).toHaveLength(1);
    session.handleCommand({ t: 'hangup' });
    await expect(starting).resolves.toBeUndefined();
    expect(vaF.last.endCalls).toBe(1);
    expect(capF.created).toHaveLength(0);
    expect(leg.startCalls).toBe(0);
    expect(all(events, 'error')).toEqual([]);
    expect(session.lineState).toBe('ended');
  });
});

describe('CallSession voice agent resume', () => {
  const frame = () => Buffer.alloc(800, 0xff);
  const errors = (events: AppEvent[]) => all(events, 'error').map((e) => e.message);

  it('resumes the session after an abnormal close (1006) and the call carries on', async () => {
    const { session, leg, va, cap, events } = await setup();
    const tagged = { system_prompt: `[[carryover-call:${session.id}]] relay session` };
    leg.emitAudio(frame());
    expect(va.audio).toHaveLength(1);

    va.close(1006, '');
    expect(errors(events)).toEqual(['Reconnecting voice…']);
    // While reconnecting the other party's audio is dropped, not buffered, for the Voice
    // Agent; the captions keep getting it.
    leg.emitAudio(frame());
    leg.emitAudio(frame());
    expect(va.audio).toHaveLength(1);
    expect(cap.audio).toHaveLength(3);

    await advance(499);
    expect(va.resumeCalls).toBe(0);
    await advance(1);
    expect(va.resumeCalls).toBe(1);
    expect(errors(events)).toEqual(['Reconnecting voice…', 'Voice reconnected.']);
    // The resumed session is tagged again (session.ready → call tag) and hears the line.
    expect(va.updates).toEqual([tagged, tagged]);
    leg.emitAudio(frame());
    expect(va.audio).toHaveLength(2);

    expect(session.lineState).not.toBe('ended');
    expect(va.endCalls).toBe(0);
    expect(leg.hangups).toEqual([]);
    expect(alertKinds(events)).not.toContain('call-ended');
  });

  it('retries once after 2 s when the first resume fails, then carries on', async () => {
    const { session, va, events } = await setup();
    va.resumeOutcomes = ['reject', 'ready'];
    va.close(1006, '');
    await advance(500);
    expect(va.resumeCalls).toBe(1);
    // The refused socket closing is that attempt's failure, not a new drop.
    expect(errors(events)).toEqual(['Reconnecting voice…']);
    await advance(1999);
    expect(va.resumeCalls).toBe(1);
    await advance(1);
    expect(va.resumeCalls).toBe(2);
    expect(errors(events)).toEqual(['Reconnecting voice…', 'Voice reconnected.']);
    expect(session.lineState).not.toBe('ended');
  });

  it('a clean close (1000) or a session the server ended is not resumed', async () => {
    const a = await setup();
    a.va.close(1000, 'bye');
    await advance(0);
    expect(a.va.resumeCalls).toBe(0);
    expect(a.session.lineState).toBe('ended');

    const b = await setup();
    b.va.serverEnded = true;
    b.va.close(1006, '');
    await advance(3000);
    expect(b.va.resumeCalls).toBe(0);
    expect(b.session.lineState).toBe('ended');
  });

  it('hanging up while reconnecting stops the attempts and leaves no timers behind', async () => {
    const { session, va } = await setup();
    va.resumeOutcomes = ['hang'];
    va.close(1006, '');
    await advance(500);
    expect(va.resumeCalls).toBe(1);
    session.handleCommand({ t: 'hangup' });
    await advance(0);
    expect(va.endCalls).toBe(1);
    await advance(5000);
    expect(va.resumeCalls).toBe(1);
    await session.finished;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hanging up inside the 500 ms backoff settles the resume wait at once and leaves no timers', async () => {
    const { session, va } = await setup();
    const spied = vi.spyOn(session as unknown as { resumeVa: () => Promise<void> }, 'resumeVa');
    va.close(1006, '');
    expect(spied).toHaveBeenCalledTimes(1);
    let returned = false;
    const attempt = spied.mock.results[0]?.value as Promise<void> | undefined;
    expect(attempt).toBeInstanceOf(Promise);
    void attempt?.then(() => {
      returned = true;
    });
    await advance(200); // inside the first 500 ms backoff
    session.handleCommand({ t: 'hangup' });
    await advance(0);
    expect(returned).toBe(true);
    await session.finished;
    expect(va.resumeCalls).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('typed text waits during the reconnect, and text lost with the old socket is re-sent', async () => {
    const { session, va } = await setup();
    session.handleCommand({ t: 'say', text: 'Lost with the socket.' });
    expect(va.replyCreates).toHaveLength(1);
    const lost = va.nonces[0] as string;

    va.close(1006, '');
    session.handleCommand({ t: 'say', text: 'Typed while reconnecting.' });
    await advance(400);
    expect(va.replyCreates).toHaveLength(1);

    await advance(100); // resumed
    expect(va.nonces).toEqual([lost, lost]);
    expect(session.brainView().takeNonce(lost)).toBe('Lost with the socket.');
    va.emit({ type: 'reply.started', reply_id: 'r1' });
    va.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });
    await advance(100);
    expect(va.replyCreates).toHaveLength(3);
    expect(session.brainView().takeNonce(va.nonces[2] as string)).toBe('Typed while reconnecting.');
  });

  it('a reply in flight when the socket drops is treated as over', async () => {
    const { session, va } = await setup();
    va.emit({ type: 'reply.started', reply_id: 'r1' });
    va.emit({
      type: 'reply.audio',
      reply_id: 'r1',
      data: Buffer.alloc(400, 0xff).toString('base64'),
    });
    va.close(1006, '');
    await advance(500);
    // Nothing is left thinking the agent is mid-reply: typed text goes out.
    session.handleCommand({ t: 'say', text: 'Hello again.' });
    await advance(300);
    expect(va.replyCreates.length).toBeGreaterThanOrEqual(1);
  });
});

describe('CallSession exit paths (Review Focus 1)', () => {
  it('disposes AAI sessions when the leg drops', async () => {
    const { session, leg, va, cap, events } = await setup();
    leg.emitEnded('line-closed');
    // Closing starts right away, not after some timer.
    expect(va.endCalls).toBe(1);
    expect(cap.closeCalls).toBe(1);
    await advance(5000);
    expect(leg.hangups).toHaveLength(1);
    expect(session.lineState).toBe('ended');
    expect(alertKinds(events)).toContain('call-ended');
    const summary = one(events, 'summary').summary;
    expect(summary.callId).toBe(session.id);
    expect(summary.targetLabel).toBe('Riverside Pharmacy (simulated)');
    // No timers left running for a finished call.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('finishes within 5 s even when the Voice Agent never acknowledges session.end', async () => {
    const { leg, cap, events } = await setup({ va: { endBehavior: 'hang' } });
    leg.emitEnded('line-closed');
    expect(cap.closeCalls).toBe(1);
    await advance(4900);
    expect(all(events, 'summary')).toHaveLength(0);
    await advance(200);
    expect(all(events, 'summary')).toHaveLength(1);
  });

  it('the Voice Agent socket dropping ends the whole call when the session cannot be resumed', async () => {
    const { session, leg, va, cap, events } = await setup();
    va.resumeOutcomes = ['reject', 'reject'];
    va.close(1006, 'abnormal');
    await advance(2500);
    expect(va.resumeCalls).toBe(2);
    expect(cap.closeCalls).toBe(1);
    expect(leg.hangups).toHaveLength(1);
    expect(session.lineState).toBe('ended');
    expect(all(events, 'alert').find((a) => a.kind === 'call-ended')?.message).toBe(
      'Call ended: the voice connection dropped.',
    );
  });

  it('hard-stops at MAX_CALL_MS', async () => {
    const { session, leg, va, cap } = await setup();
    await advance(MAX_CALL_MS - 1000);
    expect(session.lineState).not.toBe('ended');
    await advance(1000);
    expect(va.endCalls).toBe(1);
    expect(cap.closeCalls).toBe(1);
    expect(leg.hangups).toEqual(['max-duration']);
  });

  it('end is idempotent', async () => {
    const { session, va, leg } = await setup();
    const a = session.end('user-hangup');
    const b = session.end('again');
    expect(await a).toBe(await b);
    expect(va.endCalls).toBe(1);
    expect(leg.hangups).toEqual(['user-hangup']);
  });

  it('an exception inside a caption handler does not crash the session and it still ends cleanly', async () => {
    const { session, leg, va, cap, events, logs } = await setup();
    const malformed = { turnOrder: 1, final: true } as unknown as CaptionTurn;
    expect(() => cap.turn(malformed)).not.toThrow();
    expect(logs.length).toBeGreaterThan(0);

    cap.final(2, 'Can I get her date of birth, please?', 'A');
    expect(all(events, 'caption').map((c) => c.text)).toContain(
      'Can I get her date of birth, please?',
    );

    session.handleCommand({ t: 'hangup' });
    await advance(0);
    expect(va.endCalls).toBe(1);
    expect(cap.closeCalls).toBe(1);
    expect(leg.hangups).toEqual(['user-hangup']);
    expect(all(events, 'summary')).toHaveLength(1);
  });

  it('a throwing Voice Agent event handler path is contained too', async () => {
    const { va, events } = await setup();
    // transcript.agent without text is malformed on purpose.
    expect(() => va.emit({ type: 'transcript.agent', reply_id: 'r1' })).not.toThrow();
    va.emit({ type: 'transcript.agent', reply_id: 'r2', text: 'Hello.', interrupted: false });
    expect(all(events, 'agent.said').map((e) => e.text)).toEqual(['Hello.']);
  });

  it('a throwing subscriber does not stop the others', async () => {
    const { session, cap, events } = await setup();
    session.subscribe(() => {
      throw new Error('bad subscriber');
    });
    cap.final(0, 'Hello?', 'A');
    expect(all(events, 'caption')).toHaveLength(1);
  });
});

describe('CallSession scripted pharmacy call', () => {
  it('menu, hold music, pickup → human alert, then the disclosure goes out verbatim', async () => {
    const { session, leg, va, cap, events } = await setup();

    cap.final(0, 'Thank you for calling Riverside, for pharmacy press 2', 'A');
    expect(session.lineState).toBe('ivr');

    const music = holdMusicMulaw(8);
    for (let i = 0; i + 800 <= music.length; i += 800) {
      leg.emitAudio(music.subarray(i, i + 800));
      await advance(100);
    }
    expect(session.lineState).toBe('hold');
    expect(va.audio.length).toBe(80);
    expect(cap.audio.length).toBe(80);
    expect(va.replyCreates).toEqual([]);

    cap.final(1, 'This is Dana, how can I help?', 'B');
    expect(session.lineState).toBe('human');
    const pickup = all(events, 'alert').find((a) => a.kind === 'human-picked-up');
    expect(pickup?.message).toBe('A person picked up — This is Dana, how can I help?');

    // Polite: the line was loud a moment ago (the last hold-music frame, as far as the level
    // can tell); the disclosure waits until it has been quiet for 1.5 s.
    expect(va.replyCreates).toEqual([]);
    await advance(1300);
    expect(va.replyCreates).toEqual([]);
    await advance(300);
    expect(va.replyCreates).toHaveLength(1);
    const nonce = va.nonces[0] ?? '';
    expect(va.replyCreates[0]).toBe(`RELAY_UTTERANCE:${nonce}`);
    const view = session.brainView();
    expect(view.takeNonce(nonce)).toBe(DISCLOSURE);
    expect(view.takeNonce(nonce)).toBeUndefined();
    expect(disclosureText('Maya', 'deaf')).toBe(DISCLOSURE);

    va.emit({ type: 'reply.started', reply_id: 'r1' });
    va.emit({ type: 'transcript.agent', reply_id: 'r1', text: DISCLOSURE, interrupted: false });
    va.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });
    expect(one(events, 'agent.said')).toMatchObject({ source: 'disclosure', text: DISCLOSURE });
    expect(cap.contexts).toEqual([DISCLOSURE]);

    // Captions carry who spoke: the menu voice is automated, Dana is named.
    const finals = all(events, 'caption').filter((c) => c.final);
    expect(finals[0]?.speaker).toMatchObject({ role: 'ivr', person: 1 });
    expect(finals[1]?.speaker).toEqual({ role: 'them', label: 'Dana', person: 2 });
    // The disclosure is said once only.
    cap.final(2, 'Sure, go ahead.', 'B');
    await advance(2000);
    expect(va.replyCreates).toHaveLength(1);
  });

  it('a second new voice while talking to a person raises "new person on the line"', async () => {
    const { cap, events } = await setup();
    cap.final(0, 'Hi, my name is Marcus. How can I help?', 'A');
    cap.final(1, 'Let me transfer you to our fraud team.', 'A');
    cap.final(2, 'Hi, this is Elena from the fraud team.', 'B');
    expect(alertKinds(events)).toEqual(['human-picked-up', 'new-speaker']);
    expect(all(events, 'alert').find((a) => a.kind === 'new-speaker')?.message).toBe(
      'New person on the line',
    );
  });

  it('voicemail raises an alert', async () => {
    const { session, cap, events } = await setup();
    cap.final(0, 'Please leave a message after the tone.', 'A');
    expect(session.lineState).toBe('voicemail');
    expect(alertKinds(events)).toContain('voicemail');
  });
});

describe('CallSession disclosure timing (live event ordering)', () => {
  // A 100 ms μ-law frame of "speech" (a 300 Hz tone around -17 dBFS) or of line silence.
  const loud = (() => {
    const pcm = new Int16Array(800);
    for (let i = 0; i < pcm.length; i++)
      pcm[i] = Math.round(6000 * Math.sin((2 * Math.PI * 300 * i) / 8000));
    return encodeMulaw(pcm);
  })();
  const quiet = Buffer.alloc(800, 0xff);

  type Step = [at: number, act: (t: Awaited<ReturnType<typeof setup>>) => void];

  // Replays a timeline on the real 100 ms clock: one leg frame per tick (loud inside the
  // `speech` spans), the scripted caption / Voice Agent events at their times. Returns
  // when the first reply.create went out, relative to the start.
  async function replay(
    t: Awaited<ReturnType<typeof setup>>,
    speech: [number, number][],
    steps: Step[],
    until: number,
  ) {
    const pending = [...steps].sort((a, b) => a[0] - b[0]);
    let sentAt: number | undefined;
    for (let ms = 0; ms <= until; ms += 100) {
      while (pending.length > 0 && (pending[0] as Step)[0] <= ms) (pending.shift() as Step)[1](t);
      const talking = speech.some(([from, to]) => ms >= from && ms < to);
      t.leg.emitAudio(talking ? loud : quiet);
      await advance(100);
      if (sentAt === undefined && t.va.replyCreates.length > 0) sentAt = ms + 100;
    }
    return sentAt;
  }

  async function onHold() {
    const t = await setup();
    t.cap.final(0, 'For prescription refills, press 2.', 'A');
    const music = holdMusicMulaw(8);
    for (let i = 0; i + 800 <= music.length; i += 800) {
      t.leg.emitAudio(music.subarray(i, i + 800));
      await advance(100);
    }
    expect(t.session.lineState).toBe('hold');
    return t;
  }

  // Riverside, live run: Dana's greeting is two sentences with a 1.2 s pause between
  // them; the pickup is only recognised on the first sentence's final caption (1.1 s into
  // that pause). Caption partials come ~1.3 s apart and the Voice Agent's speech events
  // trail her audio by 1.3-1.6 s. AAI's reply to her turn (silent: the disclosure is
  // queued) completes ~1.3 s after its last speech.stopped. Times in ms from her first word.
  const commitAt = (secondEnds: number) => secondEnds + 1580 + 1300;
  const pickupSteps = (secondEnds: number, settles = true): Step[] => [
    [460, ({ cap }) => cap.partial(4, 'Riverside', 'B')],
    [1390, ({ va }) => va.emit({ type: 'input.speech.started' })],
    [1790, ({ cap }) => cap.partial(4, 'Riverside Pharmacy, this is', 'B')],
    [3220, ({ cap }) => cap.final(4, 'Riverside Pharmacy, this is Dana speaking.', 'B')],
    [
      3680,
      ({ va }) => {
        va.emit({ type: 'input.speech.stopped' });
        va.emit({ type: 'transcript.user', text: 'Riverside Pharmacy, this is Dana speaking.' });
        va.emit({ type: 'reply.started', reply_id: 'auto1' }); // silent auto-reply
      },
    ],
    [
      3880,
      ({ cap }) => {
        cap.speechStarted();
        cap.partial(5, 'How can I', 'B');
      },
    ],
    [4680, ({ va }) => va.emit({ type: 'input.speech.started' })],
    ...Array.from(
      { length: Math.max(0, Math.floor((secondEnds - 3880) / 1300)) },
      (_, i): Step => [
        3880 + 1300 * (i + 1),
        ({ cap }) => cap.partial(5, 'How can I help you today', 'B'),
      ],
    ),
    [secondEnds + 1000, ({ cap }) => cap.final(5, 'How can I help you today?', 'B')],
    [secondEnds + 1580, ({ va }) => va.emit({ type: 'input.speech.stopped' })],
    ...(settles
      ? [
          [
            commitAt(secondEnds),
            ({ va }) => va.emit({ type: 'reply.done', reply_id: 'auto1', status: 'completed' }),
          ] as Step,
        ]
      : []),
  ];

  it('waits for her whole greeting and for AAI to settle her turn, then goes at once', async () => {
    const t = await onHold();
    const secondEnds = 4640;
    const sentAt = await replay(
      t,
      [
        [0, 2120],
        [3330, secondEnds],
      ],
      pickupSteps(secondEnds),
      9000,
    );
    expect(t.session.lineState).toBe('human');
    expect(sentAt).toBeDefined();
    // Never over her (the old gate sent at 4600, 40 ms before her last word), never into
    // AAI's still-open reply to her turn (live: merged there, the disclosure was cut to
    // half a second), and right after that reply completes.
    expect(sentAt as number).toBeGreaterThanOrEqual(secondEnds);
    expect(sentAt as number).toBeGreaterThan(commitAt(secondEnds));
    expect((sentAt as number) - commitAt(secondEnds)).toBeLessThanOrEqual(200);
    expect(t.session.brainView().takeNonce(t.va.nonces[0] as string)).toBe(
      disclosureText('Maya', 'deaf'),
    );
  });

  it('never starts in the gaps between caption partials while she is still talking', async () => {
    // Same pickup, but her second sentence runs 4.5 s: partials 1.3 s apart used to
    // read as a pause (the "disclosure while the rep was mid-sentence" of the first live run).
    const t = await onHold();
    const secondEnds = 7830;
    const sentAt = await replay(
      t,
      [
        [0, 2120],
        [3330, secondEnds],
      ],
      pickupSteps(secondEnds),
      13_000,
    );
    expect(sentAt).toBeDefined();
    expect(sentAt as number).toBeGreaterThanOrEqual(secondEnds);
    expect((sentAt as number) - commitAt(secondEnds)).toBeLessThanOrEqual(200);
  });

  it("waits for AAI's own end of their turn even when the level has been quiet 1.5 s (northstar)", async () => {
    // Live (northstar): Marcus's greeting ended at 5240; the level was quiet for 1.5 s at
    // 6740, but AAI's VAD only reported speech.stopped at 6900 and then committed his turn.
    // The disclosure sent at 6740 was ended by that commit with 0 ms of audio.
    const t = await onHold();
    const vaStopped = 6900;
    const commit = vaStopped + 1300;
    const steps: Step[] = [
      [270, ({ cap }) => cap.speechStarted()],
      [300, ({ cap }) => cap.partial(3, 'Thanks for holding.', 'B')],
      [1200, ({ va }) => va.emit({ type: 'input.speech.started' })],
      [1600, ({ cap }) => cap.partial(3, 'Thanks for holding. This is Marcus', 'B')],
      [2900, ({ cap }) => cap.partial(3, 'Thanks for holding. This is Marcus with Northstar', 'B')],
      [
        4340,
        ({ cap }) =>
          cap.final(
            3,
            'Thanks for holding. This is Marcus with Northstar Bank Card Services.',
            'B',
          ),
      ],
      [5190, ({ cap }) => cap.speechStarted()],
      [5300, ({ cap }) => cap.partial(4, 'How can I help', 'B')],
      [6330, ({ cap }) => cap.final(4, 'How can I help you today?', 'B')],
      [
        vaStopped,
        ({ va }) => {
          va.emit({ type: 'input.speech.stopped' });
          va.emit({ type: 'transcript.user', text: 'Thanks for holding. This is Marcus.' });
          va.emit({ type: 'reply.started', reply_id: 'turn' });
        },
      ],
      [commit, ({ va }) => va.emit({ type: 'reply.done', reply_id: 'turn', status: 'completed' })],
    ];
    const sentAt = await replay(
      t,
      [
        [0, 3120],
        [4230, 5240],
      ],
      steps,
      10_000,
    );
    expect(t.session.lineState).toBe('human');
    expect(sentAt).toBeDefined();
    expect(sentAt as number).toBeGreaterThan(commit);
    expect((sentAt as number) - commit).toBeLessThanOrEqual(200);
  });

  it('typed text never starts over someone who just began talking, before any caption or VA event', async () => {
    // Captions need ~0.4 s for a first partial and AAI's VAD reported speech 0.4-1.4 s
    // after it began (live); only the level knows at once.
    const t = await setup();
    t.cap.final(0, 'Okay, one moment please.', 'A');
    const steps: Step[] = [
      [2200, ({ session }) => session.handleCommand({ t: 'say', text: 'Take your time.' })],
      [2500, ({ cap }) => cap.partial(1, 'So I just', 'A')],
      [3300, ({ va }) => va.emit({ type: 'input.speech.started' })],
      [3800, ({ cap }) => cap.partial(1, 'So I just pulled up her file and', 'A')],
      [5900, ({ cap }) => cap.final(1, 'So I just pulled up her file and it looks fine.', 'A')],
      [
        5800,
        ({ va }) => {
          va.emit({ type: 'input.speech.stopped' });
          va.emit({ type: 'reply.started', reply_id: 'turn' });
        },
      ],
      [7100, ({ va }) => va.emit({ type: 'reply.done', reply_id: 'turn', status: 'completed' })],
    ];
    const sentAt = await replay(t, [[2000, 5000]], steps, 9000);
    expect(sentAt).toBeDefined();
    expect(sentAt as number).toBeGreaterThanOrEqual(5000);
  });

  it('goes 3 s after her last speech event when AAI never completes its silent reply', async () => {
    const t = await onHold();
    const secondEnds = 4640;
    const sentAt = await replay(
      t,
      [
        [0, 2120],
        [3330, secondEnds],
      ],
      pickupSteps(secondEnds, false),
      10_000,
    );
    const lastVaEvent = secondEnds + 1580;
    expect(sentAt).toBeDefined();
    expect(sentAt as number).toBeGreaterThanOrEqual(lastVaEvent + 3000);
    expect(sentAt as number).toBeLessThanOrEqual(lastVaEvent + 3100);
  });
});

describe('CallSession polite relay', () => {
  it('say while a caption partial is arriving → relay.queued, then spoken once clear', async () => {
    const { session, va, cap, events } = await setup();
    cap.partial(0, 'So what I need', 'A');
    session.handleCommand({ t: 'say', text: 'My member ID is 88-1204-77.' });
    const queued = one(events, 'relay.queued');
    expect(queued).toMatchObject({
      reason: 'waiting-for-pause',
      text: 'My member ID is 88-1204-77.',
    });
    expect(session.brainView().relayPending).toBe(true);

    await advance(400);
    cap.partial(0, 'So what I need from you is', 'A');
    await advance(400);
    expect(va.replyCreates).toEqual([]);
    cap.final(0, 'So what I need from you is your member ID.', 'A');
    await advance(600);
    expect(va.replyCreates).toEqual([]);
    await advance(200);
    expect(va.replyCreates).toEqual([`RELAY_UTTERANCE:${queued.nonce}`]);

    expect(session.brainView().takeNonce(queued.nonce)).toBe('My member ID is 88-1204-77.');
    expect(one(events, 'relay.spoken')).toMatchObject({ nonce: queued.nonce });
    expect(session.brainView().relayPending).toBe(false);

    va.emit({ type: 'reply.started', reply_id: 'r9' });
    va.emit({
      type: 'transcript.agent',
      reply_id: 'r9',
      text: 'My member ID is 88-1204-77.',
      interrupted: false,
    });
    expect(one(events, 'agent.said').source).toBe('relay');
  });

  it('waits while the Voice Agent hears speech, and for the agent reply to finish', async () => {
    const { session, va, leg } = await setup();
    va.emit({ type: 'input.speech.started' });
    session.handleCommand({ t: 'say', text: 'Okay.' });
    await advance(2000);
    expect(va.replyCreates).toEqual([]);
    va.emit({ type: 'input.speech.stopped' });
    va.emit({ type: 'reply.started', reply_id: 'r1' });
    va.emit({
      type: 'reply.audio',
      reply_id: 'r1',
      data: Buffer.alloc(1600, 0x55).toString('base64'),
    });
    await advance(1000);
    expect(va.replyCreates).toEqual([]); // agent reply still in flight
    va.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });
    await advance(300);
    expect(leg.sentBytes.length).toBe(1600);
    expect(va.replyCreates).toHaveLength(1);
  });

  it('two says go out one after the other, never cutting each other off', async () => {
    const { session, va } = await setup();
    session.handleCommand({ t: 'say', text: 'First.' });
    session.handleCommand({ t: 'say', text: 'Second.' });
    expect(va.replyCreates).toHaveLength(1);
    await advance(2000);
    expect(va.replyCreates).toHaveLength(1);
    va.emit({ type: 'reply.started', reply_id: 'r1' });
    session.brainView().takeNonce(va.nonces[0] as string);
    va.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });
    await advance(100);
    expect(va.replyCreates).toHaveLength(2);
  });

  it('a reply AAI starts on its own right after our reply.create does not end the ack wait', async () => {
    // Live (northstar): reply.create, then a post-tool reply of AAI's own started and
    // completed silently, then the reply that took our nonce. An urgent answer sent in
    // that gap was sent over ours and cut it.
    const { session, va } = await setup();
    session.handleCommand({ t: 'say', text: 'My member ID is 4471 2290.' });
    expect(va.replyCreates).toHaveLength(1);
    va.emit({ type: 'reply.started', reply_id: 'posttool' });
    va.emit({ type: 'reply.done', reply_id: 'posttool', status: 'completed' });
    await advance(100);
    va.emit({ type: 'reply.started', reply_id: 'mine' });
    expect(session.brainView().takeNonce(va.nonces[0] as string)).toBe(
      'My member ID is 4471 2290.',
    );
    va.emit({
      type: 'reply.audio',
      reply_id: 'mine',
      data: Buffer.alloc(1600, 0x55).toString('base64'),
    });
    await advance(100);
    session.handleCommand({ t: 'say', text: 'Ready when you are.', urgent: true });
    await advance(100);
    expect(va.replyCreates).toHaveLength(1); // never over our own utterance
    va.emit({ type: 'reply.done', reply_id: 'mine', status: 'completed' });
    await advance(500);
    expect(va.replyCreates).toHaveLength(2);
  });

  it('one ask card per question: the same field asked again through the other tool is covered', async () => {
    const { va, events } = await setup();
    va.emit({
      type: 'tool.call',
      call_id: 's1',
      name: 'share_fact',
      arguments: { field: 'member_id' },
    });
    va.emit({
      type: 'tool.call',
      call_id: 'a1',
      name: 'ask_user',
      arguments: { question: 'What is your 8-digit member ID?', field: 'member_id' },
    });
    va.emit({
      type: 'tool.call',
      call_id: 's2',
      name: 'share_fact',
      arguments: { field: 'member_id' },
    });
    va.emit({
      type: 'tool.call',
      call_id: 'a2',
      name: 'ask_user',
      arguments: { question: 'Phone number?' },
    });
    va.emit({
      type: 'tool.call',
      call_id: 'a3',
      name: 'ask_user',
      arguments: { question: 'phone number' },
    });
    expect(all(events, 'ask').map((a) => a.question)).toEqual([
      "They're asking for your member ID.",
      'Phone number?',
    ]);
    expect(va.toolResults.map((r) => (r.result as { status?: string }).status)).toEqual([
      'not_shared_asking_user',
      'already_asked_user',
      'already_asked_user',
      'asked_user',
      'already_asked_user',
    ]);
  });

  it('a lost reply.create does not block the queue forever', async () => {
    const { session, va } = await setup();
    session.handleCommand({ t: 'say', text: 'First.' });
    session.handleCommand({ t: 'say', text: 'Second.' });
    await advance(4000);
    expect(va.replyCreates).toHaveLength(2);
  });

  it('rejects an empty say with an error event', async () => {
    const { session, va, events } = await setup();
    session.handleCommand({ t: 'say', text: '  \n ' });
    expect(va.replyCreates).toEqual([]);
    expect(all(events, 'error')).toHaveLength(1);
  });
});

describe('CallSession agent audio', () => {
  it('paces reply.audio to the leg and drops the rest on interruption', async () => {
    const { va, leg, events } = await setup();
    va.emit({ type: 'reply.started', reply_id: 'r1' });
    va.emit({
      type: 'reply.audio',
      reply_id: 'r1',
      data: Buffer.alloc(8000, 0x11).toString('base64'),
    });
    expect(leg.sent).toEqual([]); // paced, not dumped
    await advance(300);
    expect(leg.sentBytes.length).toBe(2400);
    va.emit({
      type: 'transcript.agent',
      reply_id: 'r1',
      text: 'Hi, I am calling',
      interrupted: true,
    });
    va.emit({ type: 'reply.done', reply_id: 'r1', status: 'interrupted' });
    // Late audio of the interrupted reply is dropped too.
    va.emit({
      type: 'reply.audio',
      reply_id: 'r1',
      data: Buffer.alloc(800, 0x11).toString('base64'),
    });
    await advance(1000);
    expect(leg.sentBytes.length).toBe(2400);
    expect(one(events, 'agent.said')).toMatchObject({ interrupted: true, source: 'agent' });
  });

  it('pads the tail of a reply so its last partial chunk is played', async () => {
    const { va, leg } = await setup();
    va.emit({ type: 'reply.started', reply_id: 'r1' });
    va.emit({
      type: 'reply.audio',
      reply_id: 'r1',
      data: Buffer.alloc(1000, 0x22).toString('base64'),
    });
    va.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });
    await advance(500);
    expect(leg.sentBytes.length).toBe(1600);
    expect(leg.sentBytes.subarray(0, 1000)).toEqual(Buffer.alloc(1000, 0x22));
    expect(leg.sentBytes.subarray(1000)).toEqual(Buffer.alloc(600, 0xff));
  });

  it('ignores whitespace-only agent transcripts', async () => {
    const { va, events } = await setup();
    va.emit({ type: 'transcript.agent', reply_id: 'r1', text: ' ', interrupted: false });
    expect(all(events, 'agent.said')).toEqual([]);
  });
});

describe('CallSession tools', () => {
  it('press_keys → DTMF through the pacer after the reply, tool.result after reply.done, dtmf event when the tones play', async () => {
    const { va, leg, events } = await setup();
    va.emit({ type: 'reply.started', reply_id: 'r1' });
    va.emit({
      type: 'tool.call',
      call_id: 'call_1',
      name: 'press_keys',
      arguments: { digits: '2' },
    });
    expect(all(events, 'dtmf')).toEqual([]); // not playing yet
    expect(va.toolResults).toEqual([]);
    va.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });
    expect(va.toolResults).toEqual([
      { callId: 'call_1', result: { status: 'pressed', digits: '2' }, isError: false },
    ]);
    expect(leg.dtmf).toEqual([]); // tones are paced like speech, not dumped via sendDtmf
    expect(all(events, 'dtmf')).toEqual([]);
    await advance(100);
    expect(one(events, 'dtmf').digits).toBe('2'); // first tone chunk just went out
    await advance(200);
    expect(leg.sentBytes).toEqual(dtmfMulaw('2'));
  });

  it('DTMF tones follow the agent speech of the same reply without overlapping it', async () => {
    const { va, leg } = await setup();
    va.emit({ type: 'reply.started', reply_id: 'r1' });
    const speech = Buffer.alloc(1000, 0x33);
    va.emit({ type: 'reply.audio', reply_id: 'r1', data: speech.toString('base64') });
    va.emit({ type: 'tool.call', call_id: 'c1', name: 'press_keys', arguments: { digits: '5#' } });
    va.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });
    await advance(2000);
    expect(leg.sentBytes).toEqual(
      Buffer.concat([speech, Buffer.alloc(600, 0xff), dtmfMulaw('5#')]),
    );
  });

  it('drops tool results of an interrupted reply but still presses the keys', async () => {
    const { va, leg } = await setup();
    va.emit({ type: 'reply.started', reply_id: 'r1' });
    va.emit({ type: 'tool.call', call_id: 'c1', name: 'press_keys', arguments: { digits: '1' } });
    va.emit({ type: 'reply.done', reply_id: 'r1', status: 'interrupted' });
    va.emit({ type: 'reply.started', reply_id: 'r2' });
    va.emit({ type: 'reply.done', reply_id: 'r2', status: 'completed' });
    expect(va.toolResults).toEqual([]);
    await advance(300);
    expect(leg.sentBytes).toEqual(dtmfMulaw('1'));
  });

  it('holds results while the other party starts talking, and sends a late tool.call at once', async () => {
    const { va } = await setup();
    va.emit({ type: 'reply.started', reply_id: 'r1' });
    va.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });
    va.emit({
      type: 'tool.call',
      call_id: 'late',
      name: 'set_line_state',
      arguments: { state: 'ivr' },
    });
    expect(va.toolResults.map((r) => r.callId)).toEqual(['late']);

    va.emit({ type: 'reply.started', reply_id: 'r2' });
    va.emit({
      type: 'tool.call',
      call_id: 'held',
      name: 'note_commitment',
      arguments: { text: 'x' },
    });
    va.emit({ type: 'input.speech.started' });
    expect(va.toolResults.map((r) => r.callId)).toEqual(['late']);
    va.emit({ type: 'reply.done', reply_id: 'r2', status: 'completed' });
    expect(va.toolResults.map((r) => r.callId)).toEqual(['late', 'held']);
  });

  it('ask_user → ask card + alert; the typed answer is spoken verbatim at once and becomes evidence', async () => {
    const { session, va, cap, events } = await setup();
    cap.final(0, 'Hi, my name is Marcus. How can I help?', 'A');
    await advance(1000);
    const disclosureNonce = va.nonces[0] ?? '';
    session.brainView().takeNonce(disclosureNonce);
    va.emit({ type: 'reply.started', reply_id: 'r0' });
    va.emit({ type: 'reply.done', reply_id: 'r0', status: 'completed' });

    va.emit({ type: 'reply.started', reply_id: 'r1' });
    va.emit({
      type: 'tool.call',
      call_id: 'call_ask',
      name: 'ask_user',
      arguments: { question: 'What is your member ID?', field: 'member_id' },
    });
    const ask = one(events, 'ask');
    expect(ask).toMatchObject({
      question: 'What is your member ID?',
      field: 'member_id',
      from: 'Marcus',
    });
    expect(all(events, 'alert').find((a) => a.kind === 'ask')?.message).toBe(
      'Marcus asks: What is your member ID?',
    );
    expect(session.openAsks().map((a) => a.askId)).toEqual([ask.askId]);
    va.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });
    expect(va.toolResults).toEqual([
      { callId: 'call_ask', result: { status: 'asked_user' }, isError: false },
    ]);

    const view = session.brainView();
    expect(checkSentence('It is 7731 9902.', view.ledger).ok).toBe(false);

    cap.partial(3, 'Take your', 'A'); // they are talking: the answer still goes out now
    session.handleCommand({ t: 'answer', askId: ask.askId, text: 'It is 7731 9902.' });
    expect(one(events, 'ask.resolved')).toEqual({
      t: 'ask.resolved',
      askId: ask.askId,
      how: 'typed',
    });
    expect(va.replyCreates).toHaveLength(2);
    expect(view.takeNonce(va.nonces[1] ?? '')).toBe('It is 7731 9902.');
    expect(checkSentence('Her member ID is 7731 9902.', view.ledger).ok).toBe(true);
    expect(session.openAsks()).toEqual([]);
  });

  it('answer by declining, or by sharing a profile fact', async () => {
    const { session, va, events } = await setup();
    va.emit({
      type: 'tool.call',
      call_id: 'a1',
      name: 'ask_user',
      arguments: { question: 'Phone?' },
    });
    va.emit({
      type: 'tool.call',
      call_id: 'a2',
      name: 'ask_user',
      arguments: { question: 'DOB?' },
    });
    const [first, second] = all(events, 'ask');

    session.handleCommand({ t: 'answer', askId: first?.askId ?? '', decline: true });
    expect(va.replyCreates).toHaveLength(1);
    expect(session.brainView().takeNonce(va.nonces[0] ?? '')).toBe(
      'Sorry, Maya would prefer not to share that.',
    );
    va.emit({ type: 'reply.started', reply_id: 'r1' });
    va.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });

    session.handleCommand({ t: 'answer', askId: second?.askId ?? '', shareFactKey: 'dob' });
    await advance(200);
    expect(va.replyCreates).toHaveLength(2);
    expect(session.brainView().takeNonce(va.nonces[1] ?? '')).toBe(
      'Date of birth: March 14, 1952.',
    );
    expect(all(events, 'ask.resolved').map((r) => r.how)).toEqual(['declined', 'shared']);
  });

  it('share_fact returns consented facts, and asks the user for anything else', async () => {
    const { session, va, events } = await setup();
    va.emit({ type: 'tool.call', call_id: 's1', name: 'share_fact', arguments: { field: 'dob' } });
    va.emit({
      type: 'tool.call',
      call_id: 's2',
      name: 'share_fact',
      arguments: { field: 'member_id' },
    });
    expect(va.toolResults).toEqual([
      { callId: 's1', result: { value: 'March 14, 1952' }, isError: false },
      { callId: 's2', result: { status: 'not_shared_asking_user' }, isError: false },
    ]);
    const ask = one(events, 'ask');
    expect(ask.field).toBe('member_id');
    expect(ask.question).toContain('member ID');

    // Sharing mid-call makes it available (and sayable).
    session.handleCommand({
      t: 'share',
      fact: { key: 'member_id', label: 'Member ID', value: '88-1204-77' },
    });
    va.emit({
      type: 'tool.call',
      call_id: 's3',
      name: 'share_fact',
      arguments: { field: 'member_id' },
    });
    expect(va.toolResults.at(-1)).toEqual({
      callId: 's3',
      result: { value: '88-1204-77' },
      isError: false,
    });
    expect(checkSentence('It is 88 1204 77.', session.brainView().ledger).ok).toBe(true);
    expect(session.brainView().facts.map((f) => f.key)).toContain('member_id');
  });

  it('note_commitment emits a commitment and feeds the fallback summary', async () => {
    const { session, va, events } = await setup({ provider: new FakeProvider(new Error('down')) });
    va.emit({
      type: 'tool.call',
      call_id: 'n1',
      name: 'note_commitment',
      arguments: { text: 'Refill ready, reference 4471', when: 'Thursday after 2 pm' },
    });
    expect(one(events, 'commitment').commitment).toEqual({
      text: 'Refill ready, reference 4471',
      when: 'Thursday after 2 pm',
    });
    const summary = await session.end('user-hangup');
    expect(summary.commitments).toEqual([
      { text: 'Refill ready, reference 4471', when: 'Thursday after 2 pm' },
    ]);
  });

  it('set_line_state forces the state; bad values are errors', async () => {
    const { session, va } = await setup();
    va.emit({
      type: 'tool.call',
      call_id: 'l1',
      name: 'set_line_state',
      arguments: { state: 'hold' },
    });
    expect(session.lineState).toBe('hold');
    va.emit({
      type: 'tool.call',
      call_id: 'l2',
      name: 'set_line_state',
      arguments: { state: 'ended' },
    });
    expect(session.lineState).toBe('hold');
    expect(va.toolResults.at(-1)?.isError).toBe(true);
    va.emit({ type: 'tool.call', call_id: 'l3', name: 'no_such_tool', arguments: {} });
    expect(va.toolResults.at(-1)?.isError).toBe(true);
  });

  it('end_call ends the call once the goodbye reply has played out', async () => {
    const { session, va, leg } = await setup();
    va.emit({ type: 'reply.started', reply_id: 'r1' });
    va.emit({
      type: 'reply.audio',
      reply_id: 'r1',
      data: Buffer.alloc(2400, 0x44).toString('base64'),
    });
    va.emit({ type: 'tool.call', call_id: 'e1', name: 'end_call', arguments: { reason: 'done' } });
    await advance(500);
    expect(session.lineState).not.toBe('ended');
    va.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });
    await advance(1000);
    expect(leg.sentBytes.length).toBe(2400);
    expect(session.lineState).toBe('ended');
    expect(leg.hangups).toEqual(['agent-ended']);
  });

  it('end_call in an interrupted reply still ends the call, after a 1.5 s grace', async () => {
    const { session, va, leg } = await setup();
    va.emit({ type: 'reply.started', reply_id: 'r1' });
    va.emit({ type: 'tool.call', call_id: 'e1', name: 'end_call', arguments: { reason: 'done' } });
    va.emit({ type: 'reply.done', reply_id: 'r1', status: 'interrupted' });
    await advance(1300);
    expect(session.lineState).not.toBe('ended');
    await advance(300);
    expect(session.lineState).toBe('ended');
    expect(leg.hangups).toEqual(['agent-ended']);
  });

  it('a goodbye talked over by "okay, bye!" still hangs up within ~2 s (Brain goodbye + end_call)', async () => {
    // The Brain says "Thank you, goodbye." before end_call; the other party answers over
    // it, AAI reports the reply interrupted. Before: end_call was dropped and the call sat
    // open until the 5-minute limit.
    const { session, va, leg, events } = await setup();
    va.emit({ type: 'reply.started', reply_id: 'bye' });
    va.emit({
      type: 'reply.audio',
      reply_id: 'bye',
      data: Buffer.alloc(8000, 0x55).toString('base64'),
    });
    va.emit({ type: 'tool.call', call_id: 'e1', name: 'end_call', arguments: { reason: 'done' } });
    await advance(400); // part of the goodbye plays
    va.emit({ type: 'input.speech.started' });
    va.emit({ type: 'transcript.agent', reply_id: 'bye', text: 'Thank you,', interrupted: true });
    va.emit({ type: 'reply.done', reply_id: 'bye', status: 'interrupted' });
    const cutAt = Date.now();
    let endedAfter: number | undefined;
    for (let t = 0; t < 5000 && endedAfter === undefined; t += 100) {
      await advance(100);
      if (session.lineState === 'ended') endedAfter = Date.now() - cutAt;
    }
    expect(endedAfter).toBeDefined();
    expect(endedAfter as number).toBeLessThanOrEqual(2000);
    expect(leg.hangups).toEqual(['agent-ended']);
    expect(all(events, 'alert').find((a) => a.kind === 'call-ended')?.message).toBe(
      'Call ended: the conversation is finished.',
    );
    // The interrupted reply's tool result is never sent (AAI docs), the hang-up still is.
    expect(va.toolResults).toEqual([]);
  });

  it('a second end_call in a later reply never pushes back the armed hang-up (still ended by 2 s)', async () => {
    const { session, va, leg } = await setup();
    va.emit({ type: 'reply.started', reply_id: 'bye' });
    va.emit({ type: 'tool.call', call_id: 'e1', name: 'end_call', arguments: { reason: 'done' } });
    va.emit({ type: 'reply.done', reply_id: 'bye', status: 'interrupted' }); // grace armed
    await advance(200);
    // The other party's "okay, bye!" starts a new reply, and the model ends the call again.
    va.emit({ type: 'reply.started', reply_id: 'again' });
    va.emit({ type: 'tool.call', call_id: 'e2', name: 'end_call', arguments: { reason: 'bye' } });
    await advance(1800);
    expect(session.lineState).toBe('ended');
    expect(leg.hangups).toEqual(['agent-ended']);
  });

  it('a stray end_call after the hang-up was armed keeps the armed deadline', async () => {
    const { session, va } = await setup();
    va.emit({ type: 'reply.started', reply_id: 'slow' });
    va.emit({ type: 'tool.call', call_id: 'e1', name: 'end_call', arguments: { reason: 'done' } });
    va.emit({ type: 'reply.done', reply_id: 'slow', status: 'completed' });
    // Already armed by reply.done; a stray end_call outside any reply keeps that deadline.
    va.emit({ type: 'tool.call', call_id: 'e2', name: 'end_call', arguments: { reason: 'done' } });
    await advance(200);
    expect(session.lineState).toBe('ended');
  });

  it('ask cards expire after 90 s', async () => {
    const { session, va, events } = await setup();
    va.emit({ type: 'tool.call', call_id: 'a1', name: 'ask_user', arguments: { question: 'Q?' } });
    const ask = one(events, 'ask');
    await advance(89_000);
    expect(all(events, 'ask.resolved')).toEqual([]);
    await advance(1000);
    expect(one(events, 'ask.resolved')).toEqual({
      t: 'ask.resolved',
      askId: ask.askId,
      how: 'expired',
    });
    expect(session.openAsks()).toEqual([]);
  });

  it('counts the tool loop depth until the other party speaks again', async () => {
    const { session, va, cap } = await setup();
    const view = session.brainView();
    for (let i = 0; i < 3; i++) {
      va.emit({
        type: 'tool.call',
        call_id: `t${i}`,
        name: 'set_line_state',
        arguments: { state: 'ivr' },
      });
    }
    expect(view.onToolLoopDepth()).toBe(3);
    cap.final(0, 'For the pharmacy, press 1.', 'A');
    expect(view.onToolLoopDepth()).toBe(0);
  });
});

describe('CallSession Brain view and commands', () => {
  it('exposes live call state to the Brain', async () => {
    const { session, events } = await setup();
    const view = session.brainView();
    expect(view.callId).toBe(session.id);
    expect(view.userName).toBe('Maya');
    expect(view.userDescriptor).toBe('deaf');
    expect(view.goal).toBe(REQ.goal);
    expect(view.autonomy).toBe('assist');
    session.handleCommand({ t: 'autonomy', value: 'relay' });
    expect(view.autonomy).toBe('relay');
    expect(all(events, 'call.state').at(-1)).toMatchObject({ autonomy: 'relay' });
    expect(view.lineState).toBe('connecting');
  });

  it('ledger: consented facts, typed say text, shared facts and the other party count; agent speech does not', async () => {
    const { session, va, cap } = await setup();
    const ledger = session.brainView().ledger;
    const ok = (s: string) => checkSentence(s, ledger).ok;

    expect(ok('Her date of birth is March 14, 1952.')).toBe(true);
    expect(ok('Her zip code is 60614.')).toBe(false);
    session.handleCommand({ t: 'say', text: 'My zip code is 60614.' });
    expect(ok('Her zip code is 60614.')).toBe(true);

    expect(ok('The email is maya@example.com.')).toBe(false);
    session.handleCommand({
      t: 'share',
      fact: { key: 'email', label: 'Email', value: 'maya@example.com' },
    });
    expect(ok('The email is maya@example.com.')).toBe(true);

    expect(ok('Your reference is 4471.')).toBe(false);
    cap.partial(0, 'Your reference is 44', 'A');
    expect(ok('Your reference is 4471.')).toBe(false); // partials are not evidence
    cap.final(0, 'Your reference is 4471.', 'A');
    expect(ok('Your reference is 4471.')).toBe(true);

    va.emit({
      type: 'transcript.agent',
      reply_id: 'r1',
      text: 'Her phone is 555 0199.',
      interrupted: false,
    });
    expect(ok('Her phone is 555 0199.')).toBe(false);
  });

  it('a blocked sentence raises gate.blocked and asks the user', async () => {
    const { session, events } = await setup();
    session
      .brainView()
      .onGateBlocked('Her date of birth is June 1, 1986.', [
        { kind: 'date', raw: 'June 1, 1986', norm: '1986-06-01' },
      ]);
    const blocked = one(events, 'gate.blocked');
    expect(blocked.sentence).toBe('Her date of birth is June 1, 1986.');
    expect(blocked.reason).toContain('June 1, 1986');
    const ask = one(events, 'ask');
    expect(ask.question).toContain('They may need');
    expect(ask.question).toContain('June 1, 1986');
    expect(alertKinds(events)).toContain('ask');
  });

  it('keys go out as paced DTMF with a dtmf event; hangup ends the call', async () => {
    const { session, leg, events } = await setup();
    session.handleCommand({ t: 'keys', digits: '12#' });
    await advance(1000);
    expect(one(events, 'dtmf').digits).toBe('12#');
    expect(leg.sentBytes).toEqual(dtmfMulaw('12#'));
    session.handleCommand({ t: 'hangup' });
    await advance(0);
    expect(leg.hangups).toEqual(['user-hangup']);
    expect(session.lineState).toBe('ended');
    session.handleCommand({ t: 'say', text: 'too late' });
    expect(all(events, 'error').length).toBeGreaterThan(0);
  });

  it('a late subscriber gets the state first, then the history with partials collapsed', async () => {
    const { session, cap } = await setup();
    cap.partial(0, 'Thank', 'A');
    cap.partial(0, 'Thank you for', 'A');
    cap.final(0, 'Thank you for calling.', 'A');
    const late: AppEvent[] = [];
    session.subscribe((e) => late.push(e));
    expect(late[0]).toMatchObject({ t: 'call.state', lineState: 'connecting', autonomy: 'assist' });
    const captions = all(late, 'caption');
    expect(captions.map((c) => c.text)).toEqual(['Thank you for calling.']);
    expect(all(late, 'call.state')).toHaveLength(1);
  });

  it('unsubscribe stops delivery', async () => {
    const { session, cap } = await setup();
    const got: AppEvent[] = [];
    const off = session.subscribe((e) => got.push(e));
    off();
    cap.final(0, 'Hello?', 'A');
    expect(all(got, 'caption')).toEqual([]);
  });

  it('captions errors surface as an error event without ending the call', async () => {
    const { session, cap, events } = await setup();
    cap.error(new Error('stream hiccup'));
    expect(all(events, 'error')).toHaveLength(1);
    expect(session.lineState).toBe('connecting');
  });
});

describe('CallSession practice line', () => {
  it('speaks the disclosure 2.5 s after the line connects', async () => {
    const leg = new FakeLeg({ label: 'Practice line ABC123', kind: 'line' });
    const { session, va } = await setup({ leg });
    await advance(2400);
    expect(va.replyCreates).toEqual([]);
    await advance(200);
    expect(va.replyCreates).toHaveLength(1);
    expect(session.brainView().takeNonce(va.nonces[0] ?? '')).toBe(DISCLOSURE);
  });

  it('describes each kind of user in the disclosure', () => {
    expect(disclosureText('Sam', 'hard-of-hearing')).toContain('who is hard of hearing and');
    expect(disclosureText('Sam', 'speech-disabled')).toContain(
      'who is unable to speak on the phone and',
    );
    expect(disclosureText('Sam', 'prefers-text')).toContain('who is using text and');
  });
});

describe('CallSession hardening (review round 1)', () => {
  it('a number the other party said unlocks only that whole number; the VA transcript is not evidence', async () => {
    const { session, va, cap } = await setup();
    const ok = (x: string) => checkSentence(x, session.brainView().ledger).ok;
    cap.final(0, 'Your reference number is 4471 2290.', 'A');
    expect(ok('The reference is 4471 2290.')).toBe(true);
    expect(ok('It ends in 2290.')).toBe(false);
    expect(ok('It starts with 4471.')).toBe(false);

    va.emit({ type: 'transcript.user', text: 'My extension is 5561.' });
    expect(ok('Her extension is 5561.')).toBe(false);
  });

  it('the VA transcript still ends a tool loop', async () => {
    const { session, va } = await setup();
    for (const id of ['t1', 't2']) {
      va.emit({
        type: 'tool.call',
        call_id: id,
        name: 'set_line_state',
        arguments: { state: 'ivr' },
      });
    }
    expect(session.brainView().onToolLoopDepth()).toBe(2);
    va.emit({ type: 'transcript.user', text: 'Okay.' });
    expect(session.brainView().onToolLoopDepth()).toBe(0);
  });

  it('typed text gets out within 12.5 s on a chatty line (3 s bursts, 1 s pauses, silent auto-replies)', async () => {
    const { session, va, cap } = await setup();
    const plan = new Map<number, (() => void)[]>();
    const at = (t: number, fn: () => void) => plan.set(t, [...(plan.get(t) ?? []), fn]);
    const line = 'And then we also checked the other thing.';
    for (let k = 0; k < 5; k++) {
      const b = k * 4000;
      at(b, () => va.emit({ type: 'input.speech.started' }));
      for (let p = 0; p < 3000; p += 300) at(b + p, () => cap.partial(k, 'And then we also', 'A'));
      at(b + 3000, () => {
        cap.final(k, line, 'A');
        va.emit({ type: 'input.speech.stopped' });
        va.emit({ type: 'transcript.user', text: line });
        // AAI's turn reply; the Brain answers it with nothing while text is queued.
        va.emit({ type: 'reply.started', reply_id: `auto${k}` });
      });
      at(b + 4300, () =>
        va.emit({ type: 'reply.done', reply_id: `auto${k}`, status: 'completed' }),
      );
    }
    const sayAt = 500;
    at(sayAt, () => session.handleCommand({ t: 'say', text: 'Sorry, I have to go now.' }));

    let spokenAt: number | undefined;
    for (let t = 0; t <= 20_000 && spokenAt === undefined; t += 100) {
      for (const fn of plan.get(t) ?? []) fn();
      await advance(100);
      if (va.replyCreates.length > 0) spokenAt = t + 100;
    }
    expect(spokenAt).toBeDefined();
    // 8 s force-send, plus at most 4 s while AAI is mid-turn: here it always is (its VAD
    // hears a burst, or its reply to the last one is open), and text sent into that is cut.
    expect((spokenAt ?? Number.POSITIVE_INFINITY) - sayAt).toBeLessThanOrEqual(12_500);
  });

  it('a silent auto-reply holds typed text until it completes (at most 3 s); one with audio until done', async () => {
    const { session, va, cap } = await setup();
    cap.final(0, 'Okay, go ahead.', 'A');
    va.emit({ type: 'reply.started', reply_id: 'auto0' }); // the Brain will answer nothing
    await advance(800);
    session.handleCommand({ t: 'say', text: 'First.' });
    // Not into AAI's still-open reply to their turn: it would be cut off when AAI commits it.
    await advance(1000);
    expect(va.replyCreates).toHaveLength(0);
    va.emit({ type: 'reply.done', reply_id: 'auto0', status: 'completed' });
    await advance(100);
    expect(va.replyCreates).toHaveLength(1);
    va.emit({ type: 'reply.started', reply_id: 'mine' });
    session.brainView().takeNonce(va.nonces[0] as string);
    va.emit({ type: 'reply.done', reply_id: 'mine', status: 'completed' });

    va.emit({ type: 'reply.started', reply_id: 'auto1' });
    va.emit({
      type: 'reply.audio',
      reply_id: 'auto1',
      data: Buffer.alloc(800, 1).toString('base64'),
    });
    session.handleCommand({ t: 'say', text: 'Second.' });
    await advance(500);
    expect(va.replyCreates).toHaveLength(1);
    va.emit({ type: 'reply.done', reply_id: 'auto1', status: 'completed' });
    await advance(200);
    expect(va.replyCreates).toHaveLength(2);
  });

  it('a "person" that turns out to be a voicemail greeting within 10 s: disclosure withdrawn, re-armed for the real pickup', async () => {
    const { session, va, cap, events } = await setup();
    cap.final(0, 'Hi, this is Dana.', 'A');
    expect(session.lineState).toBe('human');
    cap.final(1, 'Please leave a message after the tone.', 'A');
    expect(session.lineState).toBe('voicemail');
    await advance(3000);
    expect(va.replyCreates).toEqual([]); // nothing spoken into the voicemail

    cap.final(2, 'Hello? Sorry, this is Dana, I just picked up.', 'B');
    expect(session.lineState).toBe('human');
    expect(alertKinds(events).filter((k) => k === 'human-picked-up')).toHaveLength(2);
    await advance(1000);
    expect(va.replyCreates).toHaveLength(1);
    expect(session.brainView().takeNonce(va.nonces[0] ?? '')).toBe(DISCLOSURE);
  });

  it('the disclosure is re-armed once only, and not after a real conversation', async () => {
    const { session, va, cap } = await setup();
    cap.final(0, 'Hi, this is Dana.', 'A');
    await advance(11_000); // disclosure spoken; a real conversation
    expect(va.replyCreates).toHaveLength(1);
    session.brainView().takeNonce(va.nonces[0] ?? '');
    cap.final(1, 'Please leave a message after the tone.', 'A');
    cap.final(2, 'This is Marcus, how can I help?', 'B');
    await advance(2000);
    expect(va.replyCreates).toHaveLength(1);
  });

  it('an interrupted reply drops only its own speech, never tones queued around it', async () => {
    const { session, va, leg } = await setup();
    session.handleCommand({ t: 'keys', digits: '1234567890' }); // 16,000 bytes of tones
    await advance(300);
    va.emit({ type: 'reply.started', reply_id: 'r1' });
    va.emit({
      type: 'reply.audio',
      reply_id: 'r1',
      data: Buffer.alloc(1600, 0x55).toString('base64'),
    });
    va.emit({ type: 'reply.done', reply_id: 'r1', status: 'interrupted' });
    await advance(3000);
    expect(leg.sentBytes).toEqual(dtmfMulaw('1234567890'));
  });

  it('an interrupted reply keeps the earlier reply still playing', async () => {
    const { va, leg } = await setup();
    const first = Buffer.alloc(2400, 0x11);
    va.emit({ type: 'reply.started', reply_id: 'r1' });
    va.emit({ type: 'reply.audio', reply_id: 'r1', data: first.toString('base64') });
    va.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });
    va.emit({ type: 'reply.started', reply_id: 'r2' });
    va.emit({
      type: 'reply.audio',
      reply_id: 'r2',
      data: Buffer.alloc(800, 0x22).toString('base64'),
    });
    va.emit({ type: 'reply.done', reply_id: 'r2', status: 'interrupted' });
    await advance(1000);
    expect(leg.sentBytes).toEqual(first);
  });

  it('skips an identical press_keys repeated within 5 s', async () => {
    const { va, leg } = await setup();
    const press = (id: string) =>
      va.emit({ type: 'tool.call', call_id: id, name: 'press_keys', arguments: { digits: '2' } });
    press('p1');
    await advance(2000);
    press('p2');
    expect(va.toolResults.map((r) => r.result)).toEqual([
      { status: 'pressed', digits: '2' },
      { status: 'already_pressed', digits: '2' },
    ]);
    await advance(1000);
    expect(leg.sentBytes).toEqual(dtmfMulaw('2'));
    await advance(3000);
    press('p3'); // 6 s after the first: a real second press
    expect(va.toolResults.at(-1)?.result).toEqual({ status: 'pressed', digits: '2' });
  });

  it('a reply that stalls without reply.done drops its tool results and unblocks later ones', async () => {
    const { va } = await setup();
    va.emit({ type: 'reply.started', reply_id: 'r1' });
    va.emit({
      type: 'tool.call',
      call_id: 'stuck',
      name: 'note_commitment',
      arguments: { text: 'x' },
    });
    await advance(21_000);
    va.emit({
      type: 'tool.call',
      call_id: 'next',
      name: 'set_line_state',
      arguments: { state: 'ivr' },
    });
    expect(va.toolResults.map((r) => r.callId)).toEqual(['next']);
  });

  it('a throwing Voice Agent send does not starve captions, and no chunk is re-sent', async () => {
    const { leg, va, cap } = await setup();
    va.sendAudioThrows = true;
    for (let i = 1; i <= 3; i++) leg.emitAudio(Buffer.alloc(800, i));
    expect(va.audio.map((b) => b[0])).toEqual([1, 2, 3]);
    expect(cap.audio.map((b) => b[0])).toEqual([1, 2, 3]);
  });

  it('a throwing captions send does not starve the Voice Agent', async () => {
    const { leg, va, cap } = await setup();
    cap.sendAudioThrows = true;
    for (let i = 1; i <= 3; i++) leg.emitAudio(Buffer.alloc(800, i));
    expect(va.audio.map((b) => b[0])).toEqual([1, 2, 3]);
  });
});
