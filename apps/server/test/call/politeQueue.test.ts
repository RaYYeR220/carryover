import { describe, expect, it } from 'vitest';
import { RELAY_NONCE_RE } from '../../src/brain/requestParse.js';
import { PoliteQueue, type QueueSignals, splitUtterance } from '../../src/call/politeQueue.js';

interface Harness {
  q: PoliteQueue;
  line: { them: boolean; agent: boolean; lastThemAt: number };
  spoken: { nonce: string; text: string }[];
  notes: { nonce: string; text: string; reason: 'waiting-for-pause' | 'agent-speaking' }[];
  now(): number;
  // Moves the clock in 100 ms ticks; `during` runs before each tick (keeps "them" talking).
  advance(ms: number, during?: () => void): void;
}

function harness(opts: { agentAfterSpeak?: boolean } = {}): Harness {
  let now = 10_000;
  const line = { them: false, agent: false, lastThemAt: 0 };
  const sig: QueueSignals = {
    themSpeaking: () => line.them,
    agentSpeaking: () => line.agent,
    msSinceThemAudio: () => now - line.lastThemAt,
  };
  const spoken: Harness['spoken'] = [];
  const notes: Harness['notes'] = [];
  const q = new PoliteQueue(
    sig,
    (nonce, text) => {
      spoken.push({ nonce, text });
      // The session reports the agent as speaking from reply.create until the audio drains.
      if (opts.agentAfterSpeak) line.agent = true;
    },
    (ev) => notes.push(ev),
    { now: () => now },
  );
  return {
    q,
    line,
    spoken,
    notes,
    now: () => now,
    advance(ms, during) {
      for (let t = 0; t < ms; t += 100) {
        now += 100;
        during?.();
        q.tick(now);
      }
    },
  };
}

const themTalking = (h: Harness) => () => {
  h.line.them = true;
  h.line.lastThemAt = h.now();
};

describe('PoliteQueue', () => {
  it('speaks at once when the line is clear, with a nonce the Brain can parse', () => {
    const h = harness();
    const nonces = h.q.push('Hello there.');
    expect(nonces).toHaveLength(1);
    expect(h.spoken).toEqual([{ nonce: nonces[0], text: 'Hello there.' }]);
    expect(RELAY_NONCE_RE.exec(`RELAY_UTTERANCE:${nonces[0]}`)?.[1]).toBe(nonces[0]);
    expect(h.notes).toEqual([]);
  });

  it('queues while the other party is speaking, then speaks once clear for 700 ms', () => {
    const h = harness();
    themTalking(h)();
    const [nonce] = h.q.push('My member ID is 88-1204-77.');
    expect(h.spoken).toEqual([]);
    expect(h.notes).toEqual([
      { nonce, text: 'My member ID is 88-1204-77.', reason: 'waiting-for-pause' },
    ]);

    h.advance(2000, themTalking(h)); // still talking
    expect(h.spoken).toEqual([]);

    h.line.them = false; // stopped at "now"
    h.line.lastThemAt = h.now();
    h.advance(600);
    expect(h.spoken).toEqual([]);
    h.advance(100);
    expect(h.spoken.map((s) => s.nonce)).toEqual([nonce]);
    expect(h.notes).toHaveLength(1); // one notice per wait, not one per tick
  });

  it('waits for the agent to finish, and agent speech never triggers the force-send', () => {
    const h = harness();
    h.line.agent = true;
    const [nonce] = h.q.push('Yes, that works.');
    expect(h.notes).toEqual([{ nonce, text: 'Yes, that works.', reason: 'agent-speaking' }]);
    h.advance(12_000);
    expect(h.spoken).toEqual([]);
    h.line.agent = false;
    h.advance(100);
    expect(h.spoken.map((s) => s.nonce)).toEqual([nonce]);
  });

  it('re-notifies when the reason for waiting changes', () => {
    const h = harness();
    h.line.agent = true;
    const [nonce] = h.q.push('Okay.');
    h.line.agent = false;
    h.advance(100, themTalking(h));
    expect(h.notes.map((n) => n.reason)).toEqual(['agent-speaking', 'waiting-for-pause']);
    expect(h.notes.every((n) => n.nonce === nonce)).toBe(true);
  });

  it('urgent speaks over the other party immediately', () => {
    const h = harness();
    themTalking(h)();
    const [nonce] = h.q.push('Sorry to interrupt, I need to go.', true);
    expect(h.spoken.map((s) => s.nonce)).toEqual([nonce]);
  });

  it('urgent cuts an agent reply but never our own relay utterance still being spoken', () => {
    const h = harness({ agentAfterSpeak: true });
    h.q.push('First part.');
    expect(h.spoken).toHaveLength(1); // agent now speaking our utterance
    h.q.push('Second part.', true);
    expect(h.spoken).toHaveLength(1);
    h.line.agent = false;
    h.advance(100);
    expect(h.spoken.map((s) => s.text)).toEqual(['First part.', 'Second part.']);

    // An agent reply we did not start: urgent may cut it.
    h.line.agent = false;
    h.advance(100);
    h.line.agent = true;
    h.q.push('Stop, that is wrong.', true);
    expect(h.spoken.map((s) => s.text)).toEqual([
      'First part.',
      'Second part.',
      'Stop, that is wrong.',
    ]);
  });

  it('an urgent push flushes utterances already waiting, in order', () => {
    const h = harness();
    themTalking(h)();
    h.q.push('One.');
    h.q.push('Two.', true);
    expect(h.spoken.map((s) => s.text)).toEqual(['One.']);
    h.advance(100); // `One.` is out; nothing reports the agent busy in this harness
    expect(h.spoken.map((s) => s.text)).toEqual(['One.', 'Two.']);
  });

  it('force-sends after 8 s of the other party talking non-stop', () => {
    const h = harness();
    themTalking(h)();
    const [nonce] = h.q.push('Hello?');
    h.advance(7900, themTalking(h));
    expect(h.spoken).toEqual([]);
    h.advance(100, themTalking(h));
    expect(h.spoken.map((s) => s.nonce)).toEqual([nonce]);
  });

  it('the 8 s clock is not reset by brief agent activity after each of their turns', () => {
    // A chatty line: they talk non-stop, and after each turn the agent is briefly busy.
    const h = harness();
    themTalking(h)();
    const start = h.now();
    const [nonce] = h.q.push('I have to go now.');
    const busy = (t: number) => (t >= 2000 && t < 3300) || (t >= 6000 && t < 7300);
    h.advance(7900, () => {
      themTalking(h)();
      h.line.agent = busy(h.now() - start);
    });
    expect(h.spoken).toEqual([]);
    h.advance(100, themTalking(h));
    expect(h.spoken.map((s) => s.nonce)).toEqual([nonce]); // at 8.0 s, not 8 s after 7.3 s
  });

  it('when the agent is still talking at 8 s, it goes as soon as the agent stops', () => {
    const h = harness();
    themTalking(h)();
    const start = h.now();
    h.q.push('Now, please.');
    h.advance(9000, () => {
      themTalking(h)();
      h.line.agent = h.now() - start >= 7000;
    });
    expect(h.spoken).toEqual([]);
    h.line.agent = false;
    h.advance(100, themTalking(h));
    expect(h.spoken).toHaveLength(1);
  });

  it('trims, keeps emoji, collapses newlines and rejects empty or whitespace-only text', () => {
    const h = harness();
    expect(h.q.push('')).toEqual([]);
    expect(h.q.push('   \n\t  ')).toEqual([]);
    expect(h.spoken).toEqual([]);
    expect(h.notes).toEqual([]);
    expect(h.q.pending).toBe(false);

    h.q.push('  Thanks so much 🙏\n\nSee you Thursday.  ');
    expect(h.spoken.map((s) => s.text)).toEqual(['Thanks so much 🙏 See you Thursday.']);
  });

  it('splits a 1200-char text into ordered sentence groups of at most 500 chars', () => {
    const h = harness({ agentAfterSpeak: true });
    const sentences = Array.from(
      { length: 20 },
      (_, i) =>
        `Sentence number ${String(i + 1).padStart(2, '0')} explains one more small detail about the refill.`,
    );
    const text = sentences.join(' ');
    expect(text.length).toBeGreaterThanOrEqual(1200);

    const nonces = h.q.push(text);
    expect(nonces.length).toBeGreaterThanOrEqual(3);
    expect(h.spoken).toHaveLength(1);
    // Each finished utterance releases the next one.
    for (let i = 1; i < nonces.length; i++) {
      h.line.agent = false;
      h.advance(100);
    }
    expect(h.spoken.map((s) => s.nonce)).toEqual(nonces);
    for (const s of h.spoken) {
      expect(s.text.length).toBeLessThanOrEqual(500);
      expect(s.text).toMatch(/^Sentence number \d\d .*refill\.$/);
    }
    expect(h.spoken.map((s) => s.text).join(' ')).toBe(text);
  });

  it('splits an over-long sentence on word boundaries and never breaks an emoji', () => {
    const long = Array.from({ length: 150 }, () => 'word').join(' '); // 749 chars, no period
    const parts = splitUtterance(long);
    expect(parts.length).toBe(2);
    expect(parts.every((p) => p.length <= 500)).toBe(true);
    expect(parts.join(' ')).toBe(long);

    const emojiWall = '🙂'.repeat(400); // one 800-code-unit "word"
    const cut = splitUtterance(emojiWall);
    expect(cut.every((p) => p.length <= 500)).toBe(true);
    expect(cut.join('')).toBe(emojiWall);
    expect(cut.every((p) => !/[\uD800-\uDBFF]$/.test(p))).toBe(true);
  });

  it('take is one-shot, and a taken utterance is no longer spoken', () => {
    const h = harness();
    const [spokenNonce] = h.q.push('Spoken now.');
    expect(h.q.take(spokenNonce ?? '')).toBe('Spoken now.');
    expect(h.q.take(spokenNonce ?? '')).toBeUndefined();
    expect(h.q.take('unknown00')).toBeUndefined();

    themTalking(h)();
    const [queued] = h.q.push('Still queued.');
    expect(h.q.take(queued ?? '')).toBe('Still queued.');
    h.line.them = false;
    h.advance(1000);
    expect(h.spoken.map((s) => s.text)).toEqual(['Spoken now.']);
  });

  it('pending covers queued text and text sent but not yet pulled by the Brain', () => {
    const h = harness();
    themTalking(h)();
    const [nonce] = h.q.push('Hold on.');
    expect(h.q.pending).toBe(true);
    h.line.them = false;
    h.advance(1000);
    expect(h.spoken).toHaveLength(1);
    expect(h.q.pending).toBe(true); // reply.create sent, Brain request not in yet
    h.q.take(nonce ?? '');
    expect(h.q.pending).toBe(false);

    const [lost] = h.q.push('Nobody asks for this one.');
    expect(lost).toBeDefined();
    h.advance(6000);
    expect(h.q.pending).toBe(false); // a lost reply.create does not block the Brain forever
  });

  it('clear() drops everything', () => {
    const h = harness();
    themTalking(h)();
    const [nonce] = h.q.push('Queued.');
    h.q.clear();
    expect(h.q.pending).toBe(false);
    expect(h.q.take(nonce ?? '')).toBeUndefined();
    h.line.them = false;
    h.advance(2000);
    expect(h.spoken).toEqual([]);
  });

  it('holds everything, urgent included, until the line is ready', () => {
    let now = 0;
    let ready = false;
    const spoken: string[] = [];
    const notes: string[] = [];
    const q = new PoliteQueue(
      {
        themSpeaking: () => false,
        agentSpeaking: () => false,
        msSinceThemAudio: () => 60_000,
        ready: () => ready,
      },
      (_n, text) => spoken.push(text),
      (ev) => notes.push(ev.reason),
      { now: () => now },
    );
    q.push('Typed while ringing.');
    q.push('Urgent too.', true);
    for (; now < 20_000; now += 100) q.tick(now);
    expect(spoken).toEqual([]);
    expect(notes).toEqual(['waiting-for-pause', 'waiting-for-pause']);
    ready = true;
    q.tick(now);
    q.tick(now + 100);
    expect(spoken).toEqual(['Typed while ringing.', 'Urgent too.']);
  });
});
