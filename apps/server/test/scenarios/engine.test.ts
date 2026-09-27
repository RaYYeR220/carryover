import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptionsOptions } from '../../src/aai/captions.js';
import type { VAEvent } from '../../src/aai/voiceAgent.js';
import { dtmfMulaw } from '../../src/audio/dtmf.js';
import { CHUNK_BYTES } from '../../src/audio/pacer.js';
import {
  beepMulaw,
  matchesPhrase,
  REP_BEHAVIOR,
  repSession,
  ScenarioEngine,
  type ScenarioEngineDeps,
} from '../../src/scenarios/engine.js';
import { getScenario } from '../../src/scenarios/library/index.js';
import { MEMBER_ID_ASK } from '../../src/scenarios/library/northstar-bank.js';
import type { Scenario } from '../../src/scenarios/types.js';
import { FakeCaptions } from '../fakes/fakeCaptions.js';
import { FakeVoiceAgent } from '../fakes/fakeVoiceAgent.js';

const ASSET_MS = 1000; // every fake prompt asset is 1 s long
const SILENCE = 0xff;

interface Rep {
  va: FakeVoiceAgent;
  session: Record<string, unknown>;
}

function scenario(id: string): Scenario {
  const s = getScenario(id);
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
}

const engines: ScenarioEngine[] = [];

function setup(id: string, opts: Partial<ScenarioEngineDeps> = {}) {
  const reps: Rep[] = [];
  const captions: FakeCaptions[] = [];
  const toCaller: Buffer[] = [];
  const ended: string[] = [];
  const engine = new ScenarioEngine(scenario(id), {
    apiKey: 'aai-key',
    makeVoiceAgent: (session, onEvent: (e: VAEvent) => void, onClose) => {
      const va = new FakeVoiceAgent('inline', onEvent, onClose);
      reps.push({ va, session });
      return va;
    },
    makeCaptions: (o: CaptionsOptions) => {
      const c = new FakeCaptions(o);
      captions.push(c);
      return c;
    },
    loadAsset: (name) => (name === 'beep' ? beepMulaw() : Buffer.alloc(ASSET_MS * 8, 0x7f)),
    emitToCaller: (mu) => toCaller.push(mu),
    onEnded: (r) => ended.push(r),
    ...opts,
  });
  engines.push(engine);
  return {
    engine,
    reps,
    captions,
    toCaller,
    ended,
    get rep(): Rep {
      const r = reps.at(-1);
      if (!r) throw new Error('no rep session');
      return r;
    },
    events: (event?: string) =>
      engine.trace.filter((e) => event === undefined || e.event === event),
  };
}

// Caller audio arrives like it does from CallSession: 800-byte frames at real-time pace.
async function sayFromCaller(engine: ScenarioEngine, audio: Buffer): Promise<void> {
  for (let off = 0; off < audio.length; off += CHUNK_BYTES) {
    const frame = Buffer.alloc(CHUNK_BYTES, SILENCE);
    audio.copy(frame, 0, off, Math.min(off + CHUNK_BYTES, audio.length));
    engine.fromCaller(frame);
    await vi.advanceTimersByTimeAsync(100);
  }
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('ScenarioEngine: phone menu', () => {
  it('plays the pharmacy menu to the caller as 100 ms frames, silence when idle', async () => {
    const { engine, toCaller, events } = setup('riverside-pharmacy');
    engine.start();
    expect(events('enter')[0]).toMatchObject({ node: 'menu', detail: 'ivr' });
    expect(events('play')[0]?.detail).toContain('For prescription refills, press 2');

    await advance(1500);
    expect(toCaller.length).toBe(15);
    expect(toCaller.every((f) => f.length === CHUNK_BYTES)).toBe(true);
    // 1 s of prompt, then silence
    expect(toCaller.slice(0, 10).every((f) => f[0] === 0x7f)).toBe(true);
    expect(toCaller.slice(10).every((f) => f.every((b) => b === SILENCE))).toBe(true);
  });

  it('keypad 2 moves to hold, and after 18 s the rep picks up with the persona', async () => {
    const t = setup('riverside-pharmacy');
    t.engine.start();
    await advance(300);
    await sayFromCaller(t.engine, dtmfMulaw('2'));

    expect(t.events('ivr-option')).toEqual([
      expect.objectContaining({ node: 'menu', detail: '2' }),
    ]);
    expect(t.engine.currentNode).toBe('hold');
    expect(t.events('play').at(-1)?.detail).toContain('Your call is important to us');
    expect(t.reps).toHaveLength(0);

    await advance(17_000);
    expect(t.engine.currentNode).toBe('hold');
    await advance(1_100);
    expect(t.engine.currentNode).toBe('dana');
    expect(t.reps).toHaveLength(1);

    const s = t.rep.session;
    expect(s.greeting).toBe('Riverside Pharmacy, this is Dana speaking. How can I help you today?');
    expect(s.output).toEqual({ voice: 'jane', format: { encoding: 'audio/pcmu' } });
    expect(s.input).toMatchObject({ format: { encoding: 'audio/pcmu' } });
    expect(s.system_prompt).toContain('You are Dana.');
    expect(s.system_prompt).toContain(REP_BEHAVIOR);
    expect(s.system_prompt).toContain('lisinopril');
    expect(s.system_prompt).toContain("It'll be ready Thursday after 2 pm, reference 4471.");
    expect((s.tools as { name: string }[]).map((x) => x.name)).toEqual(['hang_up']);
    expect(t.events('rep-ready')).toHaveLength(1);
  });

  it('plays hold music with the announcement while holding', async () => {
    const t = setup('riverside-pharmacy');
    t.engine.start();
    await sayFromCaller(t.engine, dtmfMulaw('2'));
    t.toCaller.length = 0;
    await advance(5000);
    const music = t.toCaller.slice(12); // after the 1 s announcement
    expect(music.some((f) => f.some((b) => b !== SILENCE && b !== 0x7f))).toBe(true);
  });

  it('a wrong key replays the menu; no key replays it after repeatAfterMs', async () => {
    const t = setup('riverside-pharmacy');
    t.engine.start();
    await advance(300);
    await sayFromCaller(t.engine, dtmfMulaw('5'));
    expect(t.events('ivr-invalid')).toEqual([expect.objectContaining({ detail: '5' })]);
    expect(t.events('ivr-repeat')).toHaveLength(1);
    expect(t.events('play')).toHaveLength(2);
    expect(t.engine.currentNode).toBe('menu');

    // 1 s prompt + 6 s of silence → plays again
    await advance(ASSET_MS + 6000 + 50);
    expect(t.events('ivr-repeat')).toHaveLength(2);
    expect(t.events('play')).toHaveLength(3);
  });

  it('gives up with ivr-timeout after maxRepeats', async () => {
    const t = setup('riverside-pharmacy');
    t.engine.start();
    await advance(4 * (ASSET_MS + 6000) + 500);
    expect(t.events('ivr-repeat')).toHaveLength(3);
    expect(t.events('ivr-timeout')).toHaveLength(1);
    expect(t.ended).toEqual(['ivr-timeout']);
    expect(t.engine.ended).toBe(true);
  });

  it('press 9 repeats the menu, press 3 goes to store hours', async () => {
    const t = setup('riverside-pharmacy');
    t.engine.start();
    await sayFromCaller(t.engine, dtmfMulaw('9'));
    expect(t.engine.currentNode).toBe('menu');
    expect(t.events('play')).toHaveLength(2);
    await sayFromCaller(t.engine, dtmfMulaw('3'));
    expect(t.engine.currentNode).toBe('hours');
  });

  it('ignores keys pressed while on hold', async () => {
    const t = setup('riverside-pharmacy');
    t.engine.start();
    await sayFromCaller(t.engine, dtmfMulaw('2'));
    await sayFromCaller(t.engine, dtmfMulaw('1'));
    expect(t.engine.currentNode).toBe('hold');
    expect(t.events('digit').map((e) => `${e.node}:${e.detail}`)).toEqual(['menu:2', 'hold:1']);
  });
});

describe('ScenarioEngine: spoken menu', () => {
  it('runs captions on the caller only while in a spoken menu and matches "outages"', async () => {
    const t = setup('utility-outage');
    t.engine.start();
    expect(t.captions).toHaveLength(1);
    const cap = t.captions[0] as FakeCaptions;
    expect(cap.opts.keyterms).toEqual(['outages', 'billing']);
    expect(cap.opts.apiKey).toBe('aai-key');

    await advance(500);
    // the caller side is streamed to captions (silence while quiet)
    expect(cap.audio.length).toBeGreaterThan(0);

    cap.final(0, 'Um, I have no idea.');
    expect(t.events('ivr-invalid')).toHaveLength(1);
    expect(t.engine.currentNode).toBe('menu');

    cap.partial(1, 'Outages');
    expect(t.engine.currentNode).toBe('menu');
    cap.final(1, 'Outages.');
    expect(t.events('ivr-option')).toEqual([expect.objectContaining({ detail: 'outages' })]);
    expect(t.engine.currentNode).toBe('tom');
    expect(cap.closeCalls).toBe(1);
    expect(t.rep.session.output).toEqual({ voice: 'george', format: { encoding: 'audio/pcmu' } });
    expect(t.engine.repTranscript.filter((l) => l.who === 'caller').map((l) => l.text)).toEqual([
      'Um, I have no idea.',
      'Outages.',
    ]);
  });

  it('matches whole words, singular or plural, any case', () => {
    expect(matchesPhrase('Outages, please.', 'outages')).toBe(true);
    expect(matchesPhrase('outage', 'outages')).toBe(true);
    expect(matchesPhrase('BILLING', 'billing')).toBe(true);
    expect(matchesPhrase('no power outage here', 'outages')).toBe(true);
    expect(matchesPhrase('routages', 'outages')).toBe(false);
    expect(matchesPhrase('', 'outages')).toBe(false);
  });
});

describe('ScenarioEngine: representative', () => {
  async function toRep(id: string, key: string, holdMs: number) {
    const t = setup(id);
    t.engine.start();
    await sayFromCaller(t.engine, dtmfMulaw(key));
    await advance(holdMs + 100);
    return t;
  }

  it('rep audio goes to the caller; caller audio (and silence) goes to the rep', async () => {
    const t = await toRep('riverside-pharmacy', '2', 18_000);
    const { va } = t.rep;
    t.toCaller.length = 0;

    va.emit({ type: 'reply.started', reply_id: 'r1' });
    va.emit({
      type: 'reply.audio',
      reply_id: 'r1',
      data: Buffer.alloc(1200, 0x11).toString('base64'),
    });
    va.emit({
      type: 'transcript.agent',
      reply_id: 'r1',
      text: 'Riverside Pharmacy, this is Dana speaking.',
    });
    va.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });
    expect(t.events('rep-first-audio')).toEqual([expect.objectContaining({ detail: 'Dana' })]);

    await advance(300);
    const audible = Buffer.concat(t.toCaller).filter((b) => b === 0x11).length;
    expect(audible).toBe(1200); // the partial tail was padded and played, not held back

    va.audio.length = 0;
    await sayFromCaller(t.engine, Buffer.alloc(1600, 0x22));
    expect(va.audio.filter((f) => f[0] === 0x22)).toHaveLength(2);
    // quiet caller: the rep still hears the line at real-time pace
    va.audio.length = 0;
    await advance(1000);
    expect(va.audio.length).toBeGreaterThanOrEqual(8);
    expect(va.audio.length).toBeLessThanOrEqual(11);
    expect(va.audio.every((f) => f.length === CHUNK_BYTES && f.every((b) => b === SILENCE))).toBe(
      true,
    );

    va.emit({ type: 'transcript.user', text: 'Hi, I need a refill for Maya Lopez.' });
    expect(t.engine.repTranscript).toEqual([
      expect.objectContaining({
        who: 'rep',
        person: 1,
        text: 'Riverside Pharmacy, this is Dana speaking.',
      }),
      expect.objectContaining({
        who: 'caller',
        person: 0,
        text: 'Hi, I need a refill for Maya Lopez.',
      }),
    ]);
  });

  it('a barge-in flushes the rep audio still queued for the caller', async () => {
    const t = await toRep('riverside-pharmacy', '2', 18_000);
    const { va } = t.rep;
    va.emit({ type: 'reply.started', reply_id: 'r1' });
    va.emit({
      type: 'reply.audio',
      reply_id: 'r1',
      data: Buffer.alloc(8000, 0x11).toString('base64'),
    });
    await advance(200);
    va.emit({ type: 'reply.done', reply_id: 'r1', status: 'interrupted' });
    t.toCaller.length = 0;
    await advance(500);
    expect(Buffer.concat(t.toCaller).every((b) => b === SILENCE)).toBe(true);
  });

  it('bank: Marcus asks for the member ID, transfer_call swaps to Elena on a new session', async () => {
    const t = await toRep('northstar-bank', '1', 12_000);
    expect(t.engine.currentNode).toBe('marcus');
    const marcus = t.rep;
    expect(marcus.session.system_prompt).toContain(MEMBER_ID_ASK);
    expect(marcus.session.output).toEqual({ voice: 'michael', format: { encoding: 'audio/pcmu' } });
    expect((marcus.session.tools as { name: string }[]).map((x) => x.name)).toEqual([
      'transfer_call',
      'hang_up',
    ]);

    // "I'm transferring you to Elena…" + the tool call ride on one reply.
    marcus.va.emit({ type: 'reply.started', reply_id: 'r9' });
    marcus.va.emit({
      type: 'reply.audio',
      reply_id: 'r9',
      data: Buffer.alloc(4000, 0x33).toString('base64'),
    });
    marcus.va.emit({ type: 'tool.call', call_id: 'c1', name: 'transfer_call', arguments: {} });
    await advance(200);
    expect(marcus.va.endCalls).toBe(0); // not before the reply is done
    marcus.va.emit({ type: 'reply.done', reply_id: 'r9', status: 'completed' });
    await advance(200);
    expect(marcus.va.endCalls).toBe(0); // "…transferring you" is still playing
    await advance(600);
    expect(marcus.va.endCalls).toBe(1);
    expect(t.events('transfer')).toEqual([
      expect.objectContaining({ node: 'marcus', detail: 'elena' }),
    ]);

    await advance(1600);
    expect(t.engine.currentNode).toBe('elena');
    expect(t.reps).toHaveLength(2);
    const elena = t.rep;
    expect(elena.va).not.toBe(marcus.va);
    expect(elena.session.output).toEqual({ voice: 'vera', format: { encoding: 'audio/pcmu' } });
    expect(String(elena.session.greeting)).toContain('this is Elena');
    expect(String(elena.session.greeting)).toContain('5 to 7 business days');

    // late events from Marcus's closing session are ignored
    marcus.va.emit({ type: 'transcript.agent', text: 'stale' });
    marcus.va.close(1000, 'bye');
    expect(t.ended).toEqual([]);

    elena.va.emit({
      type: 'transcript.agent',
      text: 'Hi, this is Elena on the Northstar fraud team.',
    });
    expect(t.engine.repTranscript.at(-1)).toMatchObject({ who: 'rep', person: 2 });
  });

  it('hang_up ends the call after the goodbye has played', async () => {
    const t = await toRep('riverside-pharmacy', '2', 18_000);
    const { va } = t.rep;
    va.emit({ type: 'reply.started', reply_id: 'r5' });
    va.emit({
      type: 'reply.audio',
      reply_id: 'r5',
      data: Buffer.alloc(1600, 0x44).toString('base64'),
    });
    va.emit({ type: 'tool.call', call_id: 'c2', name: 'hang_up', arguments: {} });
    va.emit({ type: 'reply.done', reply_id: 'r5', status: 'completed' });
    expect(t.ended).toEqual([]);
    await advance(500);
    expect(t.ended).toEqual(['rep-hung-up']);
    expect(va.endCalls).toBe(1);
  });

  it('ignores transfer_call on a rep without a transfer target', async () => {
    const t = await toRep('riverside-pharmacy', '2', 18_000);
    t.rep.va.emit({ type: 'tool.call', call_id: 'c3', name: 'transfer_call', arguments: {} });
    await advance(12_000);
    expect(t.engine.currentNode).toBe('dana');
    expect(t.events('rep-tool-ignored')).toHaveLength(1);
  });

  it('the rep session dropping ends the call', async () => {
    const t = await toRep('riverside-pharmacy', '2', 18_000);
    t.rep.va.close(1011, 'server error');
    expect(t.ended).toEqual(['rep-disconnected']);
  });

  it('a rep that cannot connect ends the call (its socket closes before connect rejects)', async () => {
    const created: FakeVoiceAgent[] = [];
    const t = setup('lakeview-dental', {
      makeVoiceAgent: (_s, onEvent, onClose) => {
        const va = new FakeVoiceAgent('inline', onEvent, onClose);
        va.connectBehavior = 'reject';
        created.push(va);
        return va;
      },
    });
    t.engine.start();
    await advance(10);
    expect(t.events('rep-error')).toEqual([
      expect.objectContaining({ node: 'priya', detail: 'va connect failed' }),
    ]);
    expect(t.events('rep-closed')).toEqual([]);
    expect(t.ended).toEqual(['scenario-error']);
    expect(created[0]?.endCalls).toBe(1); // still closed on the way out
  });

  it('a rep socket that closes right after connecting ends the call as a disconnect', async () => {
    class ClosesAfterReady extends FakeVoiceAgent {
      override connect(): Promise<void> {
        const ready = super.connect();
        this.close(1011, 'server error');
        return ready;
      }
    }
    const t = setup('lakeview-dental', {
      makeVoiceAgent: (_s, onEvent, onClose) => new ClosesAfterReady('inline', onEvent, onClose),
    });
    t.engine.start();
    await advance(10);
    expect(t.events('rep-ready')).toEqual([]);
    expect(t.events('rep-closed')).toEqual([
      expect.objectContaining({ node: 'priya', detail: '1011 server error' }),
    ]);
    expect(t.ended).toEqual(['rep-disconnected']);
  });

  it('dental starts straight at Priya with the morning slot offered first', () => {
    const s = scenario('lakeview-dental');
    const priya = s.nodes.priya;
    if (priya?.kind !== 'rep') throw new Error('priya is a rep');
    const prompt = String(repSession(s, priya).system_prompt);
    expect(prompt.indexOf('Tuesday at 9:30 am')).toBeLessThan(
      prompt.indexOf('Wednesday at 3:15 pm'),
    );
    expect(s.info.suggestedGoal).toBe('Move my cleaning to next week, afternoons only');
    expect(s.info.suggestedAutonomy).toBe('auto');
  });
});

describe('ScenarioEngine: voicemail and shutdown', () => {
  it('plays the greeting and beep, records for 20 s, then ends voicemail-complete', async () => {
    const t = setup('city-clinic-voicemail');
    t.engine.start();
    expect(t.events('play')[0]?.detail).toBe(
      "You've reached City Clinic. We're closed. Please leave a message after the tone.",
    );
    await advance(ASSET_MS + 400 + 100);
    expect(t.events('recording')).toHaveLength(1);
    const cap = t.captions[0] as FakeCaptions;
    await advance(500);
    cap.final(0, 'Hi, this is Maya, please call me back.');
    expect(t.engine.repTranscript.at(-1)).toMatchObject({
      who: 'caller',
      text: 'Hi, this is Maya, please call me back.',
    });

    await advance(19_000);
    expect(t.ended).toEqual([]);
    await advance(600);
    expect(t.ended).toEqual(['voicemail-complete']);
    expect(cap.closeCalls).toBe(1);
  });

  it('the beep is audible after the greeting', async () => {
    const t = setup('city-clinic-voicemail');
    t.engine.start();
    await advance(ASSET_MS + 500);
    const beep = t.toCaller.slice(10, 14);
    expect(beep.some((f) => f.some((b) => b !== SILENCE && b !== 0x7f))).toBe(true);
  });

  it('stop() closes the open sessions, silences the line and does not report an end', async () => {
    const t = setup('utility-outage');
    t.engine.start();
    const cap = t.captions[0] as FakeCaptions;
    cap.final(0, 'outages');
    const { va } = t.rep;
    await t.engine.stop();
    expect(va.endCalls).toBe(1);
    expect(cap.closeCalls).toBe(1);
    expect(t.ended).toEqual([]);
    t.toCaller.length = 0;
    await advance(1000);
    expect(t.toCaller).toHaveLength(0);
    await t.engine.stop(); // idempotent
    expect(va.endCalls).toBe(1);
  });

  it('stop() gives up on a session that never finishes closing after 5 s', async () => {
    const t = setup('lakeview-dental');
    t.engine.start();
    t.rep.va.endBehavior = 'hang';
    let done = false;
    void t.engine.stop().then(() => {
      done = true;
    });
    await advance(4900);
    expect(done).toBe(false);
    await advance(200);
    expect(done).toBe(true);
  });

  it('a missing recording is logged and played as silence; the beep falls back to a tone', async () => {
    const t = setup('city-clinic-voicemail', {
      loadAsset: () => {
        throw new Error('ENOENT');
      },
    });
    t.engine.start();
    expect(t.events('asset-missing').map((e) => e.detail?.split(':')[0])).toEqual([
      'cityclinic-voicemail',
      'beep',
    ]);
    await advance(2000 + 400 + 100);
    expect(t.events('recording')).toHaveLength(1);
    const beep = t.toCaller.slice(20, 24);
    expect(beep.some((f) => f.some((b) => b !== SILENCE))).toBe(true);
  });

  it('a throwing log listener never breaks the line', async () => {
    const t = setup('riverside-pharmacy', {
      log: () => {
        throw new Error('boom');
      },
    });
    t.engine.start();
    await sayFromCaller(t.engine, dtmfMulaw('2'));
    expect(t.engine.currentNode).toBe('hold');
  });
});
