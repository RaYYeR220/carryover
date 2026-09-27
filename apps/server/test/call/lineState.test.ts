import type { LineState } from '@carryover/protocol';
import { describe, expect, it } from 'vitest';
import { LineStateTracker } from '../../src/call/lineState.js';
import { SpeakerMap } from '../../src/call/speakers.js';

function tracker(initial: LineState = 'connecting') {
  const changes: [LineState, LineState][] = [];
  const t = new LineStateTracker(initial, (from, to) => changes.push([from, to]));
  return { t, changes };
}

describe('LineStateTracker keyword heuristics', () => {
  // Final turns as U3.5 Pro transcribed them in the day-0 spike (st-events-main.jsonl),
  // plus the prompts of the simulated businesses.
  it.each([
    'For the pharmacy, press 1.',
    'For the photo department, press 2.',
    'Thank you for calling Riverside Pharmacy. For prescription refills, press 2.',
    'To repeat this menu, press 9.',
    "Please say 'billing' or 'outages'.",
    'Para español, oprima el nueve.',
    'Please enter your member number followed by the pound key.',
    'For lost or stolen cards, press one.',
  ])('IVR: %s', (text) => {
    const { t } = tracker();
    t.onFinalTurn(text, false);
    expect(t.state).toBe('ivr');
  });

  it.each([
    'Your call is important to us.',
    'Please stay on the line and the next available pharmacist will be with you shortly.',
    'Your call is very important to us. A pharmacy team member will be with you shortly.',
    'All of our representatives are currently assisting other callers.',
    'Your estimated wait time is 4 minutes.',
    'This call may be recorded for quality purposes.',
  ])('HOLD: %s', (text) => {
    const { t } = tracker('ivr');
    t.onFinalTurn(text, false);
    expect(t.state).toBe('hold');
  });

  it.each([
    'Hi, you have reached the voicemail of Dr. Patel.',
    'Please leave a message after the tone.',
    "You've reached City Clinic. We're closed. Please leave a message after the tone.",
    'The person you are calling is not available to take your call.',
  ])('VOICEMAIL: %s', (text) => {
    const { t } = tracker('connecting');
    t.onFinalTurn(text, true);
    expect(t.state).toBe('voicemail');
  });

  it.each([
    'Walgreens Pharmacy, this is Mark speaking.',
    'Hello, this is Walgreens Pharmacy. How can I help you?',
    'This is Dana, how can I help?',
    'Hi, my name is Marcus. Who am I speaking with?',
  ])('HUMAN: %s', (text) => {
    const { t } = tracker('hold');
    t.onFinalTurn(text, false);
    expect(t.state).toBe('human');
  });

  it.each([
    ["You've reached City Clinic.", 'ivr'],
    ['You have reached Northstar Bank.', 'ivr'],
    ['This is Riverside Pharmacy.', 'connecting'],
  ])('a business name or a recording opener is not a person: %s', (text, expected) => {
    const { t } = tracker('connecting');
    t.onFinalTurn(text, true);
    expect(t.state).toBe(expected);
  });

  it('"This is Dana." is a person', () => {
    const { t } = tracker('connecting');
    t.onFinalTurn('This is Dana.', true);
    expect(t.state).toBe('human');
  });

  it('a recording opener does not turn voicemail back into a menu', () => {
    const { t } = tracker('voicemail');
    t.onFinalTurn("You've reached Dr. Patel's office.", false);
    expect(t.state).toBe('voicemail');
  });

  it('a lower-case "this is a recording" is not a person introducing themselves', () => {
    const { t } = tracker('ivr');
    t.onFinalTurn('this is a recording', false);
    expect(t.state).toBe('ivr');
  });

  it('a new speaker after hold or IVR is a person picking up', () => {
    const hold = tracker('hold');
    hold.t.onFinalTurn('Sure.', true);
    expect(hold.t.state).toBe('human');

    const ivr = tracker('ivr');
    ivr.t.onFinalTurn('Okay, let me look.', true);
    expect(ivr.t.state).toBe('human');
  });

  it('a new speaker still reading a menu stays IVR; the same voice with filler stays put', () => {
    const { t } = tracker('ivr');
    t.onFinalTurn('For store hours, press 3.', true);
    expect(t.state).toBe('ivr');
    t.onFinalTurn('Thank you for calling Walgreens.', false);
    expect(t.state).toBe('ivr');
  });

  it('the person who put us on hold coming back is human again', () => {
    const { t, changes } = tracker('human');
    t.onFinalTurn('Please hold while I check that.', false);
    expect(t.state).toBe('hold');
    t.onFinalTurn('Thanks for waiting, I found it.', false);
    expect(t.state).toBe('human');
    expect(changes).toEqual([
      ['human', 'hold'],
      ['hold', 'human'],
    ]);
  });

  it('a greeting answering a ringing line is a person', () => {
    const { t } = tracker('connecting');
    t.onFinalTurn('Hello?', true);
    expect(t.state).toBe('human');
  });

  it('walks the spike call: greeting, menu, hold, pickup, voicemail', () => {
    const { t, changes } = tracker('connecting');
    const speakers = new SpeakerMap();
    const turns: [string, string][] = [
      ['A', 'Thank you for calling Walgreens.'],
      ['A', 'For the pharmacy, press 1.'],
      ['A', 'For the photo department, press 2.'],
      ['A', 'Your call is important to us.'],
      ['A', 'Please stay on the line and the next available pharmacist will be with you shortly.'],
      ['B', 'Walgreens Pharmacy, this is Mark speaking.'],
      ['B', 'How can I help you today?'],
      ['B', 'Can I get her date of birth, please?'],
      ['B', 'Hi, you have reached the voicemail of Dr. Patel.'],
    ];
    for (const [label, text] of turns) t.onFinalTurn(text, speakers.assign(label).isNew);
    expect(changes).toEqual([
      ['connecting', 'ivr'],
      ['ivr', 'hold'],
      ['hold', 'human'],
      ['human', 'voicemail'],
    ]);
  });
});

describe('LineStateTracker music detection', () => {
  it('loud audio with no words for 4 s means hold', () => {
    const { t } = tracker('ivr');
    let now = 0;
    for (; now < 4000; now += 100) t.onAudioLevel(-24, false, now);
    expect(t.state).toBe('ivr');
    t.onAudioLevel(-24, false, now); // 4 s after the first loud chunk
    expect(t.state).toBe('hold');
  });

  it('speech with words, or quiet, is not hold music', () => {
    const talk = tracker('ivr');
    for (let now = 0; now < 8000; now += 100) talk.t.onAudioLevel(-20, true, now);
    expect(talk.t.state).toBe('ivr');

    const quiet = tracker('human');
    for (let now = 0; now < 8000; now += 100) quiet.t.onAudioLevel(-55, false, now);
    expect(quiet.t.state).toBe('human');
  });

  it('a brief dip between notes does not restart the 4 s window', () => {
    const { t } = tracker('connecting');
    let now = 0;
    for (; now < 2000; now += 100) t.onAudioLevel(-26, false, now);
    t.onAudioLevel(-50, false, now);
    now += 100;
    for (; now <= 4100; now += 100) t.onAudioLevel(-26, false, now);
    expect(t.state).toBe('hold');
  });

  it('never flips voicemail or ended to hold', () => {
    for (const s of ['voicemail', 'ended'] as const) {
      const { t } = tracker(s);
      for (let now = 0; now < 8000; now += 100) t.onAudioLevel(-20, false, now);
      expect(t.state).toBe(s);
    }
  });
});

describe('LineStateTracker.force', () => {
  it('sets the state and reports the change once', () => {
    const { t, changes } = tracker('ivr');
    t.force('human');
    t.force('human');
    expect(t.state).toBe('human');
    expect(changes).toEqual([['ivr', 'human']]);
  });

  it('ignores turns once ended', () => {
    const { t } = tracker('human');
    t.force('ended');
    t.onFinalTurn('For the pharmacy, press 1.', true);
    expect(t.state).toBe('ended');
  });
});

describe('SpeakerMap', () => {
  it('numbers speakers by first appearance and flags new ones once', () => {
    const m = new SpeakerMap();
    expect(m.assign('A')).toEqual({ person: 1, isNew: true });
    expect(m.assign('A')).toEqual({ person: 1, isNew: false });
    expect(m.assign('B')).toEqual({ person: 2, isNew: true });
    expect(m.assign('A')).toEqual({ person: 1, isNew: false });
  });

  it('an unlabeled turn belongs to the last speaker (or is the first one)', () => {
    const m = new SpeakerMap();
    expect(m.assign(undefined)).toEqual({ person: 1, isNew: true });
    expect(m.assign(undefined)).toEqual({ person: 1, isNew: false });
    expect(m.assign('B')).toEqual({ person: 2, isNew: true });
    expect(m.assign('UNKNOWN')).toEqual({ person: 2, isNew: false });
  });

  it('peek does not register anyone', () => {
    const m = new SpeakerMap();
    expect(m.peek('A').person).toBe(1);
    expect(m.assign('A')).toEqual({ person: 1, isNew: true });
  });

  it('remembers names', () => {
    const m = new SpeakerMap();
    const { person } = m.assign('B');
    m.setName(person, 'Dana');
    expect(m.nameOf(person)).toBe('Dana');
    expect(m.nameOf(7)).toBeUndefined();
  });
});
