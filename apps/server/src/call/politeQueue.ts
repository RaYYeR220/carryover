import { randomBytes } from 'node:crypto';

// Polite relay: text the user typed waits until the other party pauses (and the agent is
// not mid-reply) before it is spoken, because a reply.create speaks over whoever is
// talking and cuts the agent's current reply (spike A-x4). Each utterance gets a one-shot
// nonce; the session sends reply.create "RELAY_UTTERANCE:<nonce>" and the Brain pulls the
// text back with take().

export interface QueueSignals {
  themSpeaking(): boolean;
  agentSpeaking(): boolean;
  msSinceThemAudio(): number;
  // Optional: false while nothing can be spoken yet (the line is not connected).
  ready?(): boolean;
}

export type QueueReason = 'waiting-for-pause' | 'agent-speaking';
export interface QueueNotice {
  nonce: string;
  text: string;
  reason: QueueReason;
}

export interface PoliteQueueOptions {
  clearMs?: number; // silence needed after the other party's last audio
  maxWaitMs?: number; // longest wait at the front of the queue, then speak over them anyway
  now?: () => number;
}

export const MAX_UTTERANCE_CHARS = 500;
const DEFAULT_CLEAR_MS = 700;
const DEFAULT_MAX_WAIT_MS = 8000;
// The Brain pulls a sent utterance ~100-250 ms after reply.create; after this it no
// longer counts as pending, so a lost reply.create can't keep the Brain silent.
const SENT_PENDING_MS = 5000;
// Sent text the Brain never asked for is forgotten after this.
const SENT_RETAIN_MS = 60_000;
// Last resort if the agent-speaking signal ever gets stuck.
const HARD_MAX_WAIT_MS = 60_000;

interface Item {
  nonce: string;
  text: string;
  urgent: boolean;
  headSince?: number; // when it reached the front of the queue (start of the force clock)
  notified?: QueueReason;
}

interface Stored {
  text: string;
  sentAt?: number;
}

export class PoliteQueue {
  private readonly sig: QueueSignals;
  private readonly speak: (nonce: string, text: string) => void;
  private readonly notify: (ev: QueueNotice) => void;
  private readonly clearMs: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;
  private readonly items: Item[] = [];
  private readonly texts = new Map<string, Stored>();
  // True from speaking an utterance until the agent is seen idle again: an urgent
  // utterance may cut an agent reply, but never our own previous utterance.
  private ownActive = false;

  constructor(
    sig: QueueSignals,
    speak: (nonce: string, text: string) => void,
    notify: (ev: QueueNotice) => void,
    opts: PoliteQueueOptions = {},
  ) {
    this.sig = sig;
    this.speak = speak;
    this.notify = notify;
    this.clearMs = opts.clearMs ?? DEFAULT_CLEAR_MS;
    this.maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.now = opts.now ?? Date.now;
  }

  // Returns the nonces of the queued utterances (several when the text was split), or []
  // when there is nothing to say.
  push(text: string, urgent = false): string[] {
    const parts = splitUtterance(text);
    if (parts.length === 0) return [];
    const nonces = parts.map((part) => {
      const nonce = randomBytes(8).toString('hex');
      this.texts.set(nonce, { text: part });
      this.items.push({ nonce, text: part, urgent });
      return nonce;
    });
    // "Interrupt now" also releases whatever was already waiting ahead of it.
    if (urgent) for (const it of this.items) it.urgent = true;

    this.tick(this.now());

    const reason: QueueReason = this.sig.agentSpeaking() ? 'agent-speaking' : 'waiting-for-pause';
    for (const it of this.items) {
      if (it.notified || !nonces.includes(it.nonce)) continue;
      it.notified = reason;
      this.notify({ nonce: it.nonce, text: it.text, reason });
    }
    return nonces;
  }

  // Called every 100 ms and on speech events. Speaks at most one utterance per call, so
  // the session can report the agent busy before the next one is considered.
  tick(now: number): void {
    this.forgetOldSent(now);
    const agent = this.sig.agentSpeaking();
    if (!agent) this.ownActive = false;

    const head = this.items[0];
    if (!head) return;
    if (this.sig.ready && !this.sig.ready()) {
      head.headSince = now; // waiting for the line to connect doesn't count
      this.notifyHead(head, 'waiting-for-pause');
      return;
    }
    // The force clock is never reset once running: on a chatty line the agent is "busy"
    // for a moment after every turn, and resetting on that would postpone typed text
    // indefinitely. The agent audibly speaking only defers it until the agent is done.
    if (head.headSince === undefined) head.headSince = now;

    let go: boolean;
    if (head.urgent) {
      go = !(agent && this.ownActive);
    } else if (agent) {
      go = false;
    } else {
      const clear = !this.sig.themSpeaking() && this.sig.msSinceThemAudio() >= this.clearMs;
      go = clear || now - head.headSince >= this.maxWaitMs;
    }
    if (!go && now - head.headSince >= HARD_MAX_WAIT_MS) go = true;

    if (go) {
      this.items.shift();
      const stored = this.texts.get(head.nonce);
      if (stored) stored.sentAt = now;
      this.ownActive = true;
      this.speak(head.nonce, head.text);
      return;
    }

    this.notifyHead(head, agent ? 'agent-speaking' : 'waiting-for-pause');
  }

  private notifyHead(head: Item, reason: QueueReason): void {
    if (head.notified === reason) return;
    head.notified = reason;
    this.notify({ nonce: head.nonce, text: head.text, reason });
  }

  // Queued text, or text sent moments ago that the Brain has not pulled yet.
  get pending(): boolean {
    if (this.items.length > 0) return true;
    const now = this.now();
    for (const s of this.texts.values()) {
      if (s.sentAt !== undefined && now - s.sentAt < SENT_PENDING_MS) return true;
    }
    return false;
  }

  // One-shot: the Brain pulls the text for a nonce. A still-queued utterance that is
  // taken is not spoken again.
  take(nonce: string): string | undefined {
    const stored = this.texts.get(nonce);
    if (!stored) return undefined;
    this.texts.delete(nonce);
    const i = this.items.findIndex((it) => it.nonce === nonce);
    if (i >= 0) this.items.splice(i, 1);
    return stored.text;
  }

  clear(): void {
    this.items.length = 0;
    this.texts.clear();
    this.ownActive = false;
  }

  private forgetOldSent(now: number): void {
    for (const [nonce, s] of this.texts) {
      if (s.sentAt !== undefined && now - s.sentAt > SENT_RETAIN_MS) this.texts.delete(nonce);
    }
  }
}

// Whitespace (newlines included) collapses to single spaces; text over `max` UTF-16
// units is split into sentence groups, over-long sentences on word boundaries, and a
// single over-long "word" by code point (never inside a surrogate pair).
export function splitUtterance(text: string, max = MAX_UTTERANCE_CHARS): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];

  const units: string[] = [];
  for (const raw of text.split(/(?<=[.!?…]["'”’)\]]*)\s+|\s*\n\s*/)) {
    const sentence = raw.replace(/\s+/g, ' ').trim();
    if (!sentence) continue;
    if (sentence.length <= max) units.push(sentence);
    else units.push(...splitWords(sentence, max));
  }
  return group(units, max);
}

function splitWords(sentence: string, max: number): string[] {
  const pieces: string[] = [];
  for (const word of sentence.split(' ')) {
    if (word.length <= max) pieces.push(word);
    else pieces.push(...hardCut(word, max));
  }
  return group(pieces, max);
}

function hardCut(word: string, max: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const cp of word) {
    if (cur.length + cp.length > max) {
      out.push(cur);
      cur = '';
    }
    cur += cp;
  }
  if (cur) out.push(cur);
  return out;
}

function group(units: string[], max: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const u of units) {
    if (!cur) cur = u;
    else if (cur.length + 1 + u.length <= max) cur += ` ${u}`;
    else {
      out.push(cur);
      cur = u;
    }
  }
  if (cur) out.push(cur);
  return out;
}
