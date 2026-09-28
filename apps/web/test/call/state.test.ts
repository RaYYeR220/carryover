import type { AppEvent, CaptionWord, SpeakerRef } from '@carryover/protocol';
import { describe, expect, it } from 'vitest';
import {
  type CallView,
  type CaptionLine,
  type EventRowItem,
  initialView,
  reduce,
} from '../../src/call/state';

const T0 = 1_760_000_000_000;
const dana: SpeakerRef = { role: 'them', label: 'Dana', person: 1 };
const menu: SpeakerRef = { role: 'ivr', label: 'Automated line', person: 0 };

const words = (text: string, low: string[] = []): CaptionWord[] =>
  text.split(' ').map((w, i) => ({
    text: w,
    confidence: low.includes(w) ? 0.41 : 0.95,
    start: i * 300,
    end: i * 300 + 250,
  }));

const cap = (
  id: string,
  text: string,
  final: boolean,
  at: number,
  speaker: SpeakerRef = dana,
): AppEvent => ({ t: 'caption', id, speaker, text, words: words(text), final, at });

const run = (events: AppEvent[], from: CallView = initialView) => events.reduce(reduce, from);

const lines = (v: CallView): CaptionLine[] =>
  v.timeline.flatMap((x) => (x.type === 'line' ? [x.line] : []));
const rows = (v: CallView): EventRowItem[] =>
  v.timeline.flatMap((x) => (x.type === 'event' ? [x.event] : []));

describe('reduce', () => {
  it('starts connecting with an empty call', () => {
    expect(initialView.lineState).toBe('connecting');
    expect(initialView.timeline).toEqual([]);
    expect(initialView.asks).toEqual([]);
    expect(initialView.queued).toEqual([]);
    expect(initialView.ended).toBe(false);
  });

  it('applies call.state', () => {
    const v = run([
      {
        t: 'call.state',
        lineState: 'hold',
        autonomy: 'auto',
        since: T0 + 5000,
        targetLabel: 'Riverside Pharmacy',
      },
    ]);
    expect(v.lineState).toBe('hold');
    expect(v.autonomy).toBe('auto');
    expect(v.since).toBe(T0 + 5000);
    expect(v.targetLabel).toBe('Riverside Pharmacy');
    expect(v.ended).toBe(false);
  });

  it('replaces a partial with its final in place', () => {
    const v = run([
      cap('c1', 'Hi Maya', false, T0 + 1000),
      cap('c2', 'Please', false, T0 + 2000, menu),
      cap('c1', 'Hi Maya, this is Dana.', true, T0 + 1500),
    ]);
    const ls = lines(v);
    expect(ls.map((l) => l.id)).toEqual(['c1', 'c2']);
    expect(ls[0]).toMatchObject({
      id: 'c1',
      who: 'them',
      label: 'Dana',
      person: 1,
      text: 'Hi Maya, this is Dana.',
      final: true,
    });
    expect(ls[0]?.words.map((w) => w.text)).toEqual(['Hi', 'Maya,', 'this', 'is', 'Dana.']);
    expect(ls[1]).toMatchObject({ id: 'c2', who: 'ivr', final: false });
  });

  it('keeps line positions when finals arrive out of order', () => {
    const v = run([
      cap('c1', 'One', false, T0 + 1000),
      cap('c2', 'Two', false, T0 + 2000),
      cap('c2', 'Two done.', true, T0 + 2500),
      cap('c1', 'One done.', true, T0 + 3000),
    ]);
    expect(lines(v).map((l) => [l.id, l.text, l.final])).toEqual([
      ['c1', 'One done.', true],
      ['c2', 'Two done.', true],
    ]);
  });

  it('never downgrades a final caption to a late partial', () => {
    const v = run([cap('c1', 'Final words.', true, T0), cap('c1', 'Final', false, T0)]);
    expect(lines(v)[0]).toMatchObject({ text: 'Final words.', final: true });
  });

  it('orders new lines by time, so a replay after call.state lands in place', () => {
    const v = run([
      {
        t: 'call.state',
        lineState: 'hold',
        autonomy: 'assist',
        since: T0 + 9000,
        targetLabel: 'Riverside Pharmacy',
      },
      cap('c1', 'Please hold.', true, T0 + 4000, menu),
    ]);
    expect(v.timeline.map((x) => (x.type === 'line' ? x.line.id : x.event.kind))).toEqual([
      'c1',
      'state',
    ]);
  });

  it('adds agent.said as a line said for you, then relay.spoken clears the queue without a second line', () => {
    const v = run([
      {
        t: 'relay.queued',
        nonce: 'n1',
        text: 'I’m checking on my refill.',
        reason: 'waiting-for-pause',
      },
      {
        t: 'agent.said',
        id: 'r1',
        text: 'I’m checking on my refill.',
        source: 'relay',
        interrupted: false,
        at: T0 + 3000,
      },
    ]);
    expect(v.queued).toEqual([
      { nonce: 'n1', text: 'I’m checking on my refill.', reason: 'waiting-for-pause' },
    ]);
    expect(lines(v)).toHaveLength(1);
    expect(lines(v)[0]).toMatchObject({
      id: 'r1',
      who: 'you',
      text: 'I’m checking on my refill.',
      final: true,
      source: 'relay',
      interrupted: false,
    });

    const after = reduce(v, { t: 'relay.spoken', nonce: 'n1', at: T0 + 3100 });
    expect(after.queued).toEqual([]);
    expect(lines(after)).toHaveLength(1);
  });

  it('updates a queued item in place when its reason changes', () => {
    const v = run([
      { t: 'relay.queued', nonce: 'n1', text: 'One', reason: 'waiting-for-pause' },
      { t: 'relay.queued', nonce: 'n2', text: 'Two', reason: 'waiting-for-pause' },
      { t: 'relay.queued', nonce: 'n1', text: 'One', reason: 'agent-speaking' },
    ]);
    expect(v.queued.map((q) => [q.nonce, q.reason])).toEqual([
      ['n1', 'agent-speaking'],
      ['n2', 'waiting-for-pause'],
    ]);
  });

  it('opens an ask and marks it resolved', () => {
    const v = run([
      {
        t: 'ask',
        askId: 'a1',
        question: 'Can I get your date of birth, please?',
        field: 'dob',
        from: 'Dana',
        at: T0 + 4000,
      },
    ]);
    expect(v.asks).toEqual([
      {
        askId: 'a1',
        question: 'Can I get your date of birth, please?',
        field: 'dob',
        from: 'Dana',
        at: T0 + 4000,
      },
    ]);
    const done = reduce(v, { t: 'ask.resolved', askId: 'a1', how: 'shared' });
    expect(done.asks[0]?.resolved).toBe('shared');
    const shared = rows(done).find((r) => r.kind === 'ask');
    expect(shared).toMatchObject({
      tag: 'SHARED',
      text: 'You shared your date of birth for this call',
    });
  });

  it('records a declined ask as a row', () => {
    const v = run([
      { t: 'ask', askId: 'a1', question: 'Member ID?', field: 'member_id', from: 'Dana', at: T0 },
      { t: 'ask.resolved', askId: 'a1', how: 'declined' },
    ]);
    expect(v.asks[0]?.resolved).toBe('declined');
    expect(rows(v).find((r) => r.kind === 'ask')).toMatchObject({
      tag: 'NO',
      text: 'You declined to share your member ID',
    });
  });

  it('ignores a resolution for an ask it never saw', () => {
    const v = reduce(initialView, { t: 'ask.resolved', askId: 'ghost', how: 'expired' });
    expect(v).toEqual(initialView);
  });

  it('sets lastAlert and never rolls it back to an older alert', () => {
    const v = run([
      { t: 'alert', kind: 'human-picked-up', message: 'A person picked up', at: T0 + 20_000 },
    ]);
    expect(v.lastAlert).toEqual({
      kind: 'human-picked-up',
      message: 'A person picked up',
      at: T0 + 20_000,
    });
    const older = reduce(v, { t: 'alert', kind: 'ask', message: 'old', at: T0 + 1000 });
    expect(older.lastAlert?.kind).toBe('human-picked-up');
    const newer = reduce(v, { t: 'alert', kind: 'ask', message: 'Dana asks', at: T0 + 30_000 });
    expect(newer.lastAlert?.kind).toBe('ask');
  });

  it('turns pickup, keys, commitments and blocked sentences into event rows', () => {
    const v = run([
      { t: 'dtmf', digits: '2', at: T0 + 1000 },
      {
        t: 'alert',
        kind: 'human-picked-up',
        message: 'A person picked up — Hi, this is Dana',
        at: T0 + 2000,
      },
      { t: 'alert', kind: 'new-speaker', message: 'New person on the line', at: T0 + 3000 },
      {
        t: 'commitment',
        commitment: { text: 'Pick up lisinopril', when: 'Thursday after 2 pm' },
        at: T0 + 4000,
      },
      {
        t: 'gate.blocked',
        sentence: 'Her member ID is 4471.',
        reason: 'Not in what Maya shared: 4471',
        at: T0 + 5000,
      },
    ]);
    expect(rows(v).map((r) => [r.kind, r.tag, r.text])).toEqual([
      ['dtmf', 'KEY 2', 'Pressed 2'],
      ['state', 'LIVE', 'A person picked up'],
      ['new-speaker', 'LIVE', 'New person on the line'],
      ['commitment', undefined, 'Pick up lisinopril'],
      ['gate', 'HELD', 'Held back something you haven’t shared'],
    ]);
    expect(rows(v)[1]).toMatchObject({ tone: 'signal', sub: 'Hi, this is Dana' });
    expect(rows(v)[3]?.sub).toBe('Thursday after 2 pm');
  });

  it('closes the hold row when the line leaves hold', () => {
    const state = (lineState: 'hold' | 'human', since: number): AppEvent => ({
      t: 'call.state',
      lineState,
      autonomy: 'assist',
      since,
      targetLabel: 'Riverside Pharmacy',
    });
    const v = run([state('hold', T0 + 10_000), state('human', T0 + 280_000)]);
    const hold = rows(v).find((r) => r.tag === 'HOLD');
    expect(hold).toMatchObject({ at: T0 + 10_000, until: T0 + 280_000 });
  });

  it('keeps one calling row however often the state repeats', () => {
    const s = (lineState: 'connecting' | 'ringing', since: number): AppEvent => ({
      t: 'call.state',
      lineState,
      autonomy: 'assist',
      since,
      targetLabel: 'Riverside Pharmacy',
    });
    const v = run([s('connecting', T0), s('ringing', T0 + 800), s('ringing', T0 + 800)]);
    expect(rows(v).filter((r) => r.tag === 'CALL')).toHaveLength(1);
    expect(rows(v)[0]).toMatchObject({ text: 'Calling Riverside Pharmacy' });
  });

  it('marks the call ended on summary', () => {
    const summary = {
      callId: 'k1',
      startedAt: T0,
      endedAt: T0 + 325_000,
      targetLabel: 'Riverside Pharmacy',
      outcome: 'Your refill is ready Thursday.',
      bullets: [],
      commitments: [],
      transcript: [],
    };
    const v = reduce(initialView, { t: 'summary', summary });
    expect(v.ended).toBe(true);
    expect(v.summary).toEqual(summary);
  });

  it('marks the call ended on the ended state and on the call-ended alert', () => {
    const a = reduce(initialView, {
      t: 'call.state',
      lineState: 'ended',
      autonomy: 'assist',
      since: T0,
      targetLabel: 'X',
    });
    expect(a.ended).toBe(true);
    const b = reduce(initialView, {
      t: 'alert',
      kind: 'call-ended',
      message: 'Call ended: you hung up.',
      at: T0,
    });
    expect(b.ended).toBe(true);
    expect(rows(b)).toEqual([
      expect.objectContaining({ tag: 'END', text: 'Call ended', sub: 'You hung up.' }),
    ]);
  });

  it('keeps the latest error', () => {
    const v = reduce(initialView, { t: 'error', message: 'Nothing to say: the message is empty.' });
    expect(v.error).toBe('Nothing to say: the message is empty.');
  });

  it('is pure: never mutates the view it is given', () => {
    const before = run([cap('c1', 'Hi', false, T0)]);
    const snapshot = structuredClone(before);
    reduce(before, cap('c1', 'Hi there.', true, T0));
    reduce(before, { t: 'relay.queued', nonce: 'n', text: 'x', reason: 'agent-speaking' });
    expect(before).toEqual(snapshot);
  });
});

/** A 50-event call: dial, menu, key, hold, pickup, captions, an ask, typed relays, end. */
function fiftyEvents(): AppEvent[] {
  const e: AppEvent[] = [];
  const state = (
    lineState: 'connecting' | 'ringing' | 'ivr' | 'hold' | 'human' | 'ended',
    since: number,
  ): AppEvent => ({
    t: 'call.state',
    lineState,
    autonomy: 'assist',
    since,
    targetLabel: 'Riverside Pharmacy',
  });
  e.push(state('connecting', T0), state('ringing', T0 + 500), state('ivr', T0 + 2000));
  e.push(cap('m1', 'Thanks for calling', false, T0 + 2200, menu));
  e.push(cap('m1', 'Thanks for calling Riverside Pharmacy.', false, T0 + 2200, menu));
  e.push(
    cap(
      'm1',
      'Thanks for calling Riverside Pharmacy. For prescriptions, press 2.',
      true,
      T0 + 2200,
      menu,
    ),
  );
  e.push({ t: 'dtmf', digits: '2', at: T0 + 8600 });
  e.push(cap('m2', 'Please hold', false, T0 + 9400, menu));
  e.push(cap('m2', 'Please hold for the next', false, T0 + 9400, menu));
  e.push(cap('m2', 'Please hold for the next available pharmacist.', true, T0 + 9400, menu));
  e.push(state('hold', T0 + 12_000));
  e.push(state('human', T0 + 282_000));
  e.push({ t: 'alert', kind: 'human-picked-up', message: 'A person picked up', at: T0 + 282_000 });
  e.push({
    t: 'relay.queued',
    nonce: 'd1',
    text: 'Hi, I’m Carryover.',
    reason: 'waiting-for-pause',
  });
  e.push({ t: 'relay.spoken', nonce: 'd1', at: T0 + 283_000 });
  e.push({
    t: 'agent.said',
    id: 'r1',
    text: 'Hi, I’m Carryover.',
    source: 'disclosure',
    interrupted: false,
    at: T0 + 286_000,
  });
  for (const [i, w] of ['Hi', 'Hi Maya,', 'Hi Maya, this is Dana.'].entries()) {
    e.push(cap('c1', w, i === 2, T0 + 288_000));
  }
  e.push({
    t: 'relay.queued',
    nonce: 'u1',
    text: 'I’m checking on my refill.',
    reason: 'waiting-for-pause',
  });
  e.push({
    t: 'relay.queued',
    nonce: 'u1',
    text: 'I’m checking on my refill.',
    reason: 'agent-speaking',
  });
  e.push({ t: 'relay.spoken', nonce: 'u1', at: T0 + 292_000 });
  e.push({
    t: 'agent.said',
    id: 'r2',
    text: 'I’m checking on my refill.',
    source: 'relay',
    interrupted: false,
    at: T0 + 294_000,
  });
  for (const [i, w] of [
    'Sure,',
    'Sure, let me pull up your',
    'Sure, let me pull up your lisinopril.',
    'Sure, let me pull up your lisinopril. Can I get your date of birth, please?',
  ].entries()) {
    e.push(cap('c2', w, i === 3, T0 + 296_000));
  }
  e.push({
    t: 'ask',
    askId: 'a1',
    question: 'Can I get your date of birth, please?',
    field: 'dob',
    from: 'Dana',
    at: T0 + 301_000,
  });
  e.push({
    t: 'alert',
    kind: 'ask',
    message: 'Dana asks for your date of birth',
    at: T0 + 301_000,
  });
  e.push({
    t: 'agent.said',
    id: 'r3',
    text: 'One moment, please.',
    source: 'agent',
    interrupted: false,
    at: T0 + 302_000,
  });
  e.push({ t: 'ask.resolved', askId: 'a1', how: 'shared' });
  e.push({
    t: 'relay.queued',
    nonce: 'u2',
    text: 'Date of birth: March 14, 1952.',
    reason: 'agent-speaking',
  });
  e.push({ t: 'relay.spoken', nonce: 'u2', at: T0 + 306_000 });
  e.push({
    t: 'agent.said',
    id: 'r4',
    text: 'Date of birth: March 14, 1952.',
    source: 'relay',
    interrupted: false,
    at: T0 + 308_000,
  });
  for (const [i, w] of [
    'Thank you.',
    'Thank you. Your lisinopril will be ready',
    'Thank you. Your lisinopril will be ready Thursday after 2 pm, reference 4471.',
  ].entries()) {
    e.push(cap('c3', w, i === 2, T0 + 310_000));
  }
  e.push({
    t: 'commitment',
    commitment: { text: 'Pick up lisinopril, ref 4471', when: 'Thursday after 2 pm' },
    at: T0 + 314_000,
  });
  e.push({
    t: 'gate.blocked',
    sentence: 'Her member ID is RX-20931.',
    reason: 'Not in what Maya shared: RX-20931',
    at: T0 + 315_000,
  });
  e.push({
    t: 'relay.queued',
    nonce: 'u3',
    text: 'Thursday works. Thank you, Dana!',
    reason: 'waiting-for-pause',
  });
  e.push({ t: 'alert', kind: 'new-speaker', message: 'New person on the line', at: T0 + 316_000 });
  e.push({ t: 'relay.spoken', nonce: 'u3', at: T0 + 318_000 });
  e.push({
    t: 'agent.said',
    id: 'r5',
    text: 'Thursday works. Thank you, Dana!',
    source: 'relay',
    interrupted: true,
    at: T0 + 320_000,
  });
  e.push(cap('c4', 'You’re welcome', false, T0 + 322_000));
  e.push(cap('c4', 'You’re welcome, Maya.', true, T0 + 322_000));
  e.push({ t: 'dtmf', digits: '#', at: T0 + 323_000 });
  e.push({ t: 'error', message: 'That did not work. Please try again.' });
  e.push(state('ended', T0 + 325_000));
  e.push({ t: 'alert', kind: 'call-ended', message: 'Call ended: you hung up.', at: T0 + 325_000 });
  e.push({
    t: 'summary',
    summary: {
      callId: 'k1',
      startedAt: T0,
      endedAt: T0 + 325_000,
      targetLabel: 'Riverside Pharmacy',
      outcome: 'Your refill is ready Thursday.',
      bullets: ['Ready after 2 pm'],
      commitments: [{ text: 'Pick up lisinopril, ref 4471', when: 'Thursday after 2 pm' }],
      transcript: [],
    },
  });
  return e;
}

describe('replay', () => {
  it('uses a 50-event call', () => {
    expect(fiftyEvents()).toHaveLength(50);
  });

  it('replay is idempotent: the same 50 events twice give an identical view', () => {
    const events = fiftyEvents();
    const once = run(events);
    const twice = run(events, once);
    expect(twice).toEqual(once);
    // Nothing duplicated.
    const ids = once.timeline.map((x) =>
      x.type === 'line' ? `l:${x.line.id}` : `e:${x.event.id}`,
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(lines(once).filter((l) => l.who === 'you')).toHaveLength(5);
    expect(once.queued).toEqual([]);
    expect(once.asks).toHaveLength(1);
  });

  it('a reconnect replay (current state, then the recorded tail) changes nothing', () => {
    const events = fiftyEvents();
    const once = run(events);
    // The server sends the current call.state, then the last events it recorded, with each
    // caption only in its latest version.
    const latest = new Map<string, number>();
    events.forEach((e, i) => {
      if (e.t === 'caption') latest.set(e.id, i);
    });
    const tail = events.filter(
      (e, i) => e.t !== 'call.state' && (e.t !== 'caption' || latest.get(e.id) === i),
    );
    const current: AppEvent = {
      t: 'call.state',
      lineState: 'ended',
      autonomy: 'assist',
      since: T0 + 325_000,
      targetLabel: 'Riverside Pharmacy',
    };
    expect(run([current, ...tail.slice(-30)], once)).toEqual(once);
  });

  it('a fresh subscriber builds the same transcript order from the replay', () => {
    const events = fiftyEvents();
    const once = run(events);
    const latest = new Map<string, number>();
    events.forEach((e, i) => {
      if (e.t === 'caption') latest.set(e.id, i);
    });
    const tail = events.filter(
      (e, i) => e.t !== 'call.state' && (e.t !== 'caption' || latest.get(e.id) === i),
    );
    const fresh = run([
      {
        t: 'call.state',
        lineState: 'ended',
        autonomy: 'assist',
        since: T0 + 325_000,
        targetLabel: 'Riverside Pharmacy',
      },
      ...tail,
    ]);
    expect(lines(fresh).map((l) => l.id)).toEqual(lines(once).map((l) => l.id));
  });
});
