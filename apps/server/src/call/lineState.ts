import type { LineState } from '@carryover/protocol';

// What is on the other end right now: a phone menu, hold, a person or a voicemail
// greeting. Cheap keyword heuristics over each final caption turn plus a music detector;
// the Relay Brain can also force a state with the set_line_state tool.

const NUM = '\\d|zero|one|two|three|four|five|six|seven|eight|nine|star|pound';
const IVR_RE = new RegExp(
  `\\b(press|dial)\\s+(${NUM})|for .{1,40}, (press|say)|main menu|para español|say .{1,20} or .{1,20}|enter your .{1,30} followed by`,
  'i',
);
const HOLD_RE =
  /your call is (very )?important|please (continue to )?hold|next available|remain on the line|(agents|representatives) are (currently )?(busy|assisting)|estimated wait|call (may be|is being) recorded/i;
const VOICEMAIL_RE =
  /leave (a|your) message|after the (tone|beep)|voice ?mail|not available to take your call|mailbox/i;
// A person introducing themselves by name. The name must be capitalized (captions are
// formatted), so "this is a recording" does not count.
const HUMAN_NAME_RE = /\b(?:[Tt]his is|[Mm]y name is|[Yy]ou(?:'|’)ve reached) [A-Z][a-z]+/;
const HUMAN_RE = /how (can|may) i help|speaking[,.]|who am i speaking/i;
// Someone answering a ringing line with a greeting.
const GREETING_RE = /^\s*(hello|hi|hey|good (morning|afternoon|evening))\b/i;

const MUSIC_DBFS = -35;
const MUSIC_MS = 4000;
// Short dips between notes don't restart the music window.
const MUSIC_GAP_MS = 600;

export class LineStateTracker {
  private _state: LineState;
  private readonly onChange: (from: LineState, to: LineState) => void;
  private loudSince: number | undefined;
  private lastLoudAt = 0;
  // Hold that a person started ("please hold while I check"): their next words mean
  // they are back, even though it is the same voice.
  private holdFromHuman = false;

  constructor(initial: LineState, onChange: (from: LineState, to: LineState) => void) {
    this._state = initial;
    this.onChange = onChange;
  }

  get state(): LineState {
    return this._state;
  }

  onFinalTurn(text: string, speakerIsNew: boolean): void {
    const cur = this._state;
    if (cur === 'ended') return;
    const next = classify(text, speakerIsNew, cur, this.holdFromHuman);
    if (next === 'hold' && cur !== 'hold') this.holdFromHuman = cur === 'human';
    if (next) this.set(next);
  }

  onAudioLevel(dbfs: number, hadWordsRecently: boolean, now: number): void {
    const cur = this._state;
    if (cur === 'ended' || cur === 'voicemail' || cur === 'hold' || hadWordsRecently) {
      this.loudSince = undefined;
      return;
    }
    if (dbfs > MUSIC_DBFS) {
      this.loudSince ??= now;
      this.lastLoudAt = now;
      if (now - this.loudSince >= MUSIC_MS) {
        this.loudSince = undefined;
        this.holdFromHuman = cur === 'human';
        this.set('hold');
      }
    } else if (now - this.lastLoudAt > MUSIC_GAP_MS) {
      this.loudSince = undefined;
    }
  }

  force(state: LineState): void {
    this.holdFromHuman = false;
    this.set(state);
  }

  private set(to: LineState): void {
    const from = this._state;
    if (from === to) return;
    this._state = to;
    if (to !== 'hold') this.holdFromHuman = false;
    this.onChange(from, to);
  }
}

function classify(
  text: string,
  speakerIsNew: boolean,
  cur: LineState,
  holdFromHuman: boolean,
): LineState | undefined {
  if (IVR_RE.test(text)) return 'ivr';
  if (VOICEMAIL_RE.test(text)) return 'voicemail';
  if (HOLD_RE.test(text)) return 'hold';
  if (HUMAN_NAME_RE.test(text) || HUMAN_RE.test(text)) return 'human';
  if (speakerIsNew && (cur === 'ivr' || cur === 'hold')) return 'human';
  if (cur === 'hold' && holdFromHuman) return 'human';
  if ((cur === 'connecting' || cur === 'ringing') && GREETING_RE.test(text)) return 'human';
  return undefined;
}

// "This is Dana, how can I help?" → "Dana". Skips "This is Riverside Pharmacy" (a
// capitalized word right after the name reads as a business, not a person).
const NAME_RE = /\b(?:[Tt]his is|[Mm]y name is|I'm|I’m) ([A-Z][a-z]{1,20})\b(?![ -][A-Z])/;
export function spokenName(text: string): string | undefined {
  return NAME_RE.exec(text)?.[1];
}
