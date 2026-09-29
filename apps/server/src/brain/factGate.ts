// Code-enforced fabrication gate. Every sentence the LLM wants to say on the user's
// behalf is checked here before it reaches the phone line: any date, digit run (>= 3
// digits, after turning spoken number words into digits) or email address it contains
// must already be in the call's ledger (the user's consented facts, answers the user
// typed, and everything the other party said). Prompts can be ignored by a model; this
// check cannot.
//
// Known limits (deliberate, documented so nobody mistakes the gate for more than it is):
// - Numbers under 3 digits are not facts (ages, "press 2", "20 mg"). A number split across
//   sentences into 2-digit fragments ("Her ID is 12." ... "34.") is only caught when the
//   fragments arrive in one sentence; splitSentences holds number-ended sentences to
//   make that hard, not impossible.
// - Alphanumeric IDs are only gated on their digits ("AB12C" → nothing, "MX-4471" → 4471).
// - Digit groups separated by ordinary words ("45 or 12 or 99", "45 apples 12") are
//   separate numbers; only spoken separators (dash, slash, then, point, dot, space) and
//   short punctuation runs join groups into one number.
// - Names, street names, cities and other words are not gated at all.
// - Clock times, ordinals ("the 21st"), percentages, prices under $100, "24/7", toll-free
//   "800 number" phrases, "about a hundred dollars" and "since 2019"-style years are
//   treated as ordinary speech (never when the sentence talks about an ID, "ends in",
//   "last four" or, for years, birth).
// - The clock-time allowance is decided per sentence: in a sentence with time context
//   ("?", "works", a weekday ...) and no identifier words, any "H MM"-shaped number
//   (1-12 and 00-59, e.g. "4 15") passes as a time.
// - A dash date without a year ("born on 6-1") is not caught; slash forms ("6/1") are.
// - Spoken lists are joined: "Press 1, then 3, then 2" is read as 132 and blocked unless
//   allowed. Keying menu choices through the press_keys tool is unaffected.
// - Echo-confirmation is prompt-only: confirming a wrong value read out by the other
//   party ("Yes, that's right") contains no fact, so only the system prompt guards it.

export interface ExtractedFact {
  kind: 'digits' | 'date' | 'email';
  raw: string;
  norm: string;
}

// Who a ledger text came from. 'user' (the default): consented facts, typed answers;
// partial read-backs of their numbers are allowed. 'other': what the other party said
// (CallSession should pass 'other' for captions); only whole numbers are allowed back.
export type FactSource = 'user' | 'other';

export interface FactLedger {
  add(text: string, source?: FactSource): void;
  has(fact: ExtractedFact): boolean;
}

// ---------------------------------------------------------------- text preparation

// Maps any Unicode decimal digit to ASCII. Decimal digits come in contiguous runs of ten
// starting at zero, so a digit's value is its distance to the start of its run.
function asciiDigit(ch: string): string {
  const cp = ch.codePointAt(0) as number;
  let v = 0;
  while (v < 9 && /\p{Nd}/u.test(String.fromCodePoint(cp - v - 1))) v++;
  return String(v);
}

// NFKC folds fullwidth digits, "…" → "...", ligatures; format characters (zero-width
// space/joiner, soft hyphen, bidi marks) are dropped so they cannot hide inside a number.
export function prepareText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Nd}/gu, (ch) => (ch >= '0' && ch <= '9' ? ch : asciiDigit(ch)));
}

// ---------------------------------------------------------------- number words → digits

const UNITS: Record<string, number> = {
  zero: 0,
  nought: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
};
const TEENS: Record<string, number> = {
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fourty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  thirtieth: 30,
};
const REPEAT: Record<string, number> = { double: 2, triple: 3 };

function ordinalSuffix(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return 'th';
  switch (n % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

interface Word {
  w: string; // lower-cased
  start: number;
  end: number;
}

const WORD_GAP_RE = /^[ \t-]$/; // words of one number ("twenty-one", "twenty one")
const PHRASE_GAP_RE = /^[ \t]+$/; // words of one phrase ("four hundred and twelve")

// Parses a cardinal below 100 at words[i]: units, teens, tens, tens+unit.
function below100(words: Word[], i: number, text: string): { value: number; next: number } | null {
  const cur = words[i];
  if (!cur) return null;
  if (cur.w in UNITS) return { value: UNITS[cur.w] as number, next: i + 1 };
  if (cur.w in TEENS) return { value: TEENS[cur.w] as number, next: i + 1 };
  if (cur.w in TENS) {
    const tens = TENS[cur.w] as number;
    const nx = words[i + 1];
    if (
      nx &&
      WORD_GAP_RE.test(text.slice(cur.end, nx.start)) &&
      nx.w in UNITS &&
      UNITS[nx.w] !== 0
    ) {
      return { value: tens + (UNITS[nx.w] as number), next: i + 2 };
    }
    return { value: tens, next: i + 1 };
  }
  return null;
}

function gapIs(text: string, a: Word | undefined, b: Word | undefined, re: RegExp): boolean {
  return !!a && !!b && re.test(text.slice(a.end, b.start));
}

// Tries "X hundred [and] Y" / "X thousand [and] Y" after a below-100 value.
function scaled(
  words: Word[],
  first: { value: number; next: number },
  text: string,
): { value: number; next: number } {
  let { value, next } = first;
  const hw = words[next];
  if (hw?.w === 'hundred' && gapIs(text, words[next - 1], hw, PHRASE_GAP_RE) && value > 0) {
    value *= 100;
    next++;
    let k = next;
    if (words[k]?.w === 'and' && gapIs(text, words[k - 1], words[k], PHRASE_GAP_RE)) k++;
    const rest = gapIs(text, words[k - 1], words[k], PHRASE_GAP_RE)
      ? below100(words, k, text)
      : null;
    if (rest && rest.value > 0) {
      value += rest.value;
      next = rest.next;
    }
  }
  const tw = words[next];
  if (tw?.w === 'thousand' && gapIs(text, words[next - 1], tw, PHRASE_GAP_RE) && value > 0) {
    value *= 1000;
    next++;
    let k = next;
    if (words[k]?.w === 'and' && gapIs(text, words[k - 1], words[k], PHRASE_GAP_RE)) k++;
    const r = gapIs(text, words[k - 1], words[k], PHRASE_GAP_RE) ? below100(words, k, text) : null;
    if (r && r.value > 0) {
      const withHundreds = scaled(words, r, text);
      if (withHundreds.value < 1000) {
        value += withHundreds.value;
        next = withHundreds.next;
      }
    }
  }
  return { value, next };
}

// Units and quantity nouns: a number right before one of these is an amount, not an ID.
const UNIT_WORDS =
  'minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|seconds?|secs?|mg|mcg|milligrams?|ml|milliliters?|dollars?|bucks|cents?|percent|pills?|tablets?|capsules?|refills?|doses?|times|people|persons|patients|customers|calls|items?|units?|miles?|feet|pounds?|things|ways';
const QUANTITY_NOUN_AFTER_RE = new RegExp(`^\\s+(?:more\\s+|other\\s+)?(?:${UNIT_WORDS})\\b`, 'i');

const ZERO_WORD_RE =
  /(?<=\d[\s,.-]{0,3})\b(?:oh|o)\b(?![\s']*clock)|\b(?:oh|o)\b(?![\s']*clock)(?=[\s,.-]{1,3}\d)/gi;
const connector = (words: string) =>
  new RegExp(`(?<=\\d)[\\s,;:.]*\\b(?:${words})\\b[\\s,;:.]*(?=\\d)`, 'gi');
const CONNECTORS: [RegExp, string][] = [
  [connector('slash'), '/'],
  [connector('dash|hyphen'), '-'],
  [connector('point|dot'), '.'],
  [connector('space|then|and then'), ', '],
];

// Rewrites spoken numbers as digits, keeping every other character in place:
// "eight eight one two" → "8 8 1 2", "nineteen fifty two" → "19 52",
// "March fourteenth" → "March 14th", "double seven" → "77", "four hundred twelve" → "412".
export function normalizeNumbers(input: string): string {
  const text = input.replace(/[‐-―−]/g, '-');
  const words: Word[] = [];
  for (const m of text.matchAll(/[A-Za-z]+/g)) {
    words.push({ w: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  }
  let out = '';
  let pos = 0;
  let i = 0;
  const emit = (from: number, to: number, repl: string) => {
    out += text.slice(pos, from) + repl;
    pos = to;
  };
  while (i < words.length) {
    const cur = words[i] as Word;
    const nx = words[i + 1];
    // double / triple + digit
    if (
      cur.w in REPEAT &&
      nx &&
      gapIs(text, cur, nx, PHRASE_GAP_RE) &&
      (nx.w in UNITS || nx.w === 'oh')
    ) {
      const d = nx.w === 'oh' ? 0 : (UNITS[nx.w] as number);
      emit(cur.start, nx.end, String(d).repeat(REPEAT[cur.w] as number));
      i += 2;
      continue;
    }
    // ordinals: "fourteenth", "twenty-first", "thirty first"
    if (cur.w in ORDINALS) {
      const n = ORDINALS[cur.w] as number;
      emit(cur.start, cur.end, `${n}${ordinalSuffix(n)}`);
      i++;
      continue;
    }
    if (cur.w in TENS && nx && gapIs(text, cur, nx, WORD_GAP_RE) && nx.w in ORDINALS) {
      const u = ORDINALS[nx.w] as number;
      if (u < 10) {
        const n = (TENS[cur.w] as number) + u;
        emit(cur.start, nx.end, `${n}${ordinalSuffix(n)}`);
        i += 2;
        continue;
      }
    }
    // "a hundred and twelve", "a thousand". A bare "a hundred" before a unit or quantity
    // noun ("about a hundred dollars", "a hundred times") is an approximate amount and
    // stays in words.
    if (
      cur.w === 'a' &&
      nx &&
      (nx.w === 'hundred' || nx.w === 'thousand') &&
      gapIs(text, cur, nx, PHRASE_GAP_RE)
    ) {
      if (QUANTITY_NOUN_AFTER_RE.test(text.slice(nx.end))) {
        i += 2;
        continue;
      }
      const r = scaled(words, { value: 1, next: i + 1 }, text);
      const last = words[r.next - 1] as Word;
      emit(cur.start, last.end, String(r.value));
      i = r.next;
      continue;
    }
    const base = below100(words, i, text);
    if (base) {
      const r = scaled(words, base, text);
      const last = words[r.next - 1] as Word;
      emit(cur.start, last.end, String(r.value));
      i = r.next;
      continue;
    }
    i++;
  }
  out += text.slice(pos);
  // "oh" / a lone "o" is a zero only next to other digits ("nine oh one", "four O four
  // seven"), never in "o'clock".
  for (let k = 0; k < 4; k++) {
    const before = out;
    out = out.replace(ZERO_WORD_RE, '0');
    if (out === before) break;
  }
  // Spoken separators between digits: "45 dash 12", "6 slash 1 slash 86", "45, then 12".
  for (const [re, sep] of CONNECTORS) out = out.replace(re, sep);
  return out;
}

// ---------------------------------------------------------------- extraction

const MONTHS: [RegExp, number][] = [
  [/^jan/i, 1],
  [/^feb/i, 2],
  [/^mar/i, 3],
  [/^apr/i, 4],
  [/^may/i, 5],
  [/^jun/i, 6],
  [/^jul/i, 7],
  [/^aug/i, 8],
  [/^sep/i, 9],
  [/^oct/i, 10],
  [/^nov/i, 11],
  [/^dec/i, 12],
];
const MONTH =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b\\.?';
// Years as they come out of normalizeNumbers: 1952, "19 52", "19 0 5", "1 9 5 2", 2003, "20 21".
const YEAR =
  "((?:19|20)(?:\\d{2}|[ -]\\d{2}|[ -]0[ -]?\\d)|1 9 \\d \\d|2 0 \\d \\d|['‘’]\\d{2})(?![ -]?\\d)";
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)';
const YEAR_TAIL = `(?:\\s*,?\\s*(?:of\\s+|in\\s+)?${YEAR})?`;

const ISO_RE = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g;
const NUMERIC_DATE_RE = /\b(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})\b/g;
const NUMERIC_MONTH_DAY_RE = /\b(\d{1,2})\/(\d{1,2})\b(?!\s*\/)/g;
// "June of 86", "June in 86" (a bare "June 86" is handled as day > 31 below).
const MONTH_OF_YY_RE = new RegExp(`\\b${MONTH},?\\s+(?:of|in)\\s+(\\d{2})(?![ -]?\\d)`, 'gi');
// "24/7", "twenty four seven": not when part of a longer digit sequence ("45 24 7").
const TWENTY_FOUR_SEVEN_RE = /(?<!\d[^\p{L}\d]{0,6})\b24\s?[/\s-]\s?7\b(?![^\p{L}\d]{0,6}\d)/gu;
const MONTH_YEAR_RE = new RegExp(`\\b${MONTH},?\\s+(?:of\\s+|in\\s+)?${YEAR}`, 'gi');
const MONTH_DAY_RE = new RegExp(`\\b${MONTH},?\\s+(?:the\\s+)?${DAY}${YEAR_TAIL}`, 'gi');
const DAY_MONTH_RE = new RegExp(`\\b(?:the\\s+)?${DAY}\\s+(?:of\\s+)?${MONTH}${YEAR_TAIL}`, 'gi');
// A day spoken as two lone spelled-out digits right after a month name ("March one four" ->
// normalizeNumbers already turned "one"/"four" into separate single digits "1"/"4", still
// space-separated because below100() never fuses two bare UNITS words together). Joins them
// into one two-digit token ("14") so MONTH_DAY_RE's DAY group reads it as a single day
// instead of splitting into a 1-day plus a stray "4". Scoped to immediately after a month
// name so a digit-by-digit ID or number read elsewhere in the sentence is untouched.
const MONTH_SPELLED_DAY_RE = new RegExp(
  `\\b${MONTH}(,?\\s+(?:the\\s+)?)(\\d)\\s(\\d)\\b(?!\\s?\\d)`,
  'gi',
);

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const TLD = '(?:com|org|net|edu|gov|mil|io|co|us|uk|ca|au|de|info|biz|me|ai|app|dev|email|mail)';
// "maya at example dot com", "m a y a at example dot com", "maya dot g at mail dot example dot org",
// "maya at gmail.com"
const SPOKEN_EMAIL_RE = new RegExp(
  `\\b((?:[a-z0-9]\\b(?:\\s+[a-z0-9]\\b)+)|(?:[a-z0-9]+(?:\\s+(?:dot|underscore|dash|hyphen)\\s+[a-z0-9]+)*))\\s+at\\s+((?:[a-z0-9-]+(?:\\s+dot\\s+|\\.))+${TLD})\\b`,
  'gi',
);

const TIME_RES: RegExp[] = [
  /\b\d{1,2}(?::\d{2}|[ ]\d{2}|[ ]0[ ]?\d)?\s*(?:a\.?\s?m\b\.?|p\.?\s?m\b\.?|o'?\s?clock\b)/gi,
  /\b\d{1,2}:\d{2}\b/g,
];
const ORDINAL_RE = /\b\d{1,2}(?:st|nd|rd|th)\b/gi;
// Percentages ("one hundred percent", "20%") are not facts about anyone.
const PERCENT_RE = /\b\d{1,3}(?:\.\d+)?\s?(?:%|percent\b)/gi;
// Prices under $100 ("Is the copay $12.99?").
const PRICE_RE = /\$\s?\d{1,2}(?:[.,]\d{2})?(?![\d.,]*\d)/g;
// A digit run: digit groups joined by short runs (<= 6) of anything that is neither a
// letter nor a digit: spaces, commas, dots, dashes, slashes, "...", "·", parentheses.
const RUN_RE = /\d+(?:[^\p{L}\p{N}]{1,6}\d+)*/gu;

const TIME_PREP_BEFORE_RE = /\b(?:at|around|by|until|till|before|after|from|between|to)\s+$/i;
const TIME_CONTEXT_RE =
  /\?|\b(?:works?|working|okay|ok|fine|good|great|tomorrow|today|tonight|morning|afternoon|evening|noon|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|how about|what about|appointment|slot|time|available|availability|free|schedule|scheduled|reschedule|pick ?up|ready|opens?|closes?)\b/i;
const ID_CONTEXT_RE =
  /#|\b(?:id|identifier|numbers?|no|code|pin|account|acct|member|membership|reference|ref|zip|postal|policy|confirmation|dob|birth|birthday|born|digits?|phone|card|ssn|social|routing|extension|ext|claim|group|order|case|ticket|password|passcode|address|street|apartment|apt|suite)\b/i;
const YEAR_PREP_BEFORE_RE = /\b(?:since|in|from|until|till|by|before|after|around|of)\s+$/i;
const BIRTH_CONTEXT_RE = /\b(?:born|birth|birthday|dob|age|aged)\b/i;
// "ends in 2014", "starts with 1987", "the last four ...": the number is part of an ID.
const PART_OF_ID_BEFORE_RE =
  /\b(?:ends?|ending|ended|starts?|starting|started|begins?|beginning)\s+(?:in|with)\s+$/i;
const PART_OF_ID_SENTENCE_RE = /\blast\s+(?:two|three|four|five|six|2|3|4|5|6)\b|\bdigits?\b/i;
const UNIT_AFTER_RE = new RegExp(
  `^\\s*(?:,?\\s*(?:or|and|to|maybe|-)\\s*\\d+\\s*)?(?:${UNIT_WORDS}|%)(?![a-z])`,
  'i',
);
const QUANTITY_LIST_RE = /^\d+(?:\s*[,-]\s*\d+)+$/;
const TOLL_FREE = new Set(['800', '888', '877', '866', '855', '844', '833']);
const TOLL_FREE_AFTER_RE = /^\s*-?\s*numbers?\b/i;

const MASK = ' masked ';

function monthNumber(name: string): number {
  for (const [re, n] of MONTHS) if (re.test(name)) return n;
  return 0;
}

function yearNumber(raw: string): number {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 2) return twoDigitYear(Number(digits));
  return digits.length === 4 ? Number(digits) : 0;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function validDay(d: number): boolean {
  return d >= 1 && d <= 31;
}

function fullDate(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function twoDigitYear(yy: number): number {
  const pivot = new Date().getFullYear() % 100;
  return yy <= pivot ? 2000 + yy : 1900 + yy;
}

function extractDates(text: string, facts: ExtractedFact[]): string {
  const push = (raw: string, norm: string) => facts.push({ kind: 'date', raw: raw.trim(), norm });
  let t = text.replace(TWENTY_FOUR_SEVEN_RE, MASK);
  // "March 1 4" -> "March 14": see MONTH_SPELLED_DAY_RE. Must run before the day/month
  // date regexes below so a spelled-digit-by-digit day is seen as one number, not two.
  t = t.replace(
    MONTH_SPELLED_DAY_RE,
    (_m, mon: string, sep: string, d1: string, d2: string) => `${mon}${sep}${d1}${d2}`,
  );
  t = t.replace(ISO_RE, (m, y: string, mo: string, d: string) => {
    const month = Number(mo);
    const day = Number(d);
    if (month < 1 || month > 12 || !validDay(day)) return m;
    push(m, fullDate(Number(y), month, day));
    return MASK;
  });
  t = t.replace(NUMERIC_DATE_RE, (m, a: string, _sep: string, b: string, y: string) => {
    let month = Number(a);
    let day = Number(b);
    if (month > 12 && day <= 12) [month, day] = [day, month];
    if (month < 1 || month > 12 || !validDay(day)) return m;
    const year = y.length === 2 ? twoDigitYear(Number(y)) : Number(y);
    push(m, fullDate(year, month, day));
    return MASK;
  });
  t = t.replace(NUMERIC_MONTH_DAY_RE, (m, a: string, b: string) => {
    let month = Number(a);
    let day = Number(b);
    if (month > 12 && day <= 12) [month, day] = [day, month];
    if (month < 1 || month > 12 || !validDay(day)) return m;
    push(m, `--${pad2(month)}-${pad2(day)}`);
    return MASK;
  });
  // Day-first before month-year, so "14 March 1952" keeps its day.
  t = t.replace(DAY_MONTH_RE, (m, d: string, mon: string, y: string | undefined) => {
    const day = Number(d);
    if (!validDay(day)) return m;
    const month = monthNumber(mon);
    push(m, y ? fullDate(yearNumber(y), month, day) : `--${pad2(month)}-${pad2(day)}`);
    return MASK;
  });
  t = t.replace(MONTH_YEAR_RE, (m, mon: string, y: string) => {
    push(m, `${yearNumber(y)}-${pad2(monthNumber(mon))}`);
    return MASK;
  });
  t = t.replace(MONTH_OF_YY_RE, (m, mon: string, yy: string) => {
    push(m, `${twoDigitYear(Number(yy))}-${pad2(monthNumber(mon))}`);
    return MASK;
  });
  t = t.replace(MONTH_DAY_RE, (m, mon: string, d: string, y: string | undefined) => {
    const day = Number(d);
    if (!y && d.length === 2 && day > 31) {
      // "June 86": a day can't be 86, so it's a two-digit year.
      push(m, `${twoDigitYear(day)}-${pad2(monthNumber(mon))}`);
      return MASK;
    }
    if (!validDay(day)) return m;
    const month = monthNumber(mon);
    push(m, y ? fullDate(yearNumber(y), month, day) : `--${pad2(month)}-${pad2(day)}`);
    return MASK;
  });
  return t;
}

function extractEmails(text: string, facts: ExtractedFact[]): string {
  let t = text.replace(EMAIL_RE, (m) => {
    facts.push({ kind: 'email', raw: m, norm: m.toLowerCase() });
    return MASK;
  });
  t = t.replace(SPOKEN_EMAIL_RE, (m, local: string, domain: string) => {
    const localNorm = local
      .toLowerCase()
      .replace(/\s+dot\s+/g, '.')
      .replace(/\s+underscore\s+/g, '_')
      .replace(/\s+(?:dash|hyphen)\s+/g, '-')
      .replace(/\s+/g, '');
    const domainNorm = domain.toLowerCase().replace(/\s+dot\s+/g, '.');
    facts.push({ kind: 'email', raw: m, norm: `${localNorm}@${domainNorm}` });
    return MASK;
  });
  return t;
}

function maskTimes(text: string): string {
  let t = text;
  for (const re of TIME_RES) t = t.replace(re, MASK);
  return t.replace(ORDINAL_RE, MASK).replace(PERCENT_RE, MASK).replace(PRICE_RE, MASK);
}

interface Run {
  raw: string;
  start: number;
  end: number;
  groups: string[];
}

// Spaced or repeated punctuation between digit groups ("4 . . . 5", "45 ....... 12",
// "45 - - - - 12") is compacted so it cannot exceed the run finder's separator cap.
function compactSeparators(text: string): string {
  return text.replace(/[^\p{L}\p{N}]{2,}/gu, (sep) =>
    sep.replace(/\s+/g, ' ').replace(/([^\s\p{L}\p{N}])(?:\s?\1)+/gu, '$1$1$1'),
  );
}

// `text` must already be compacted (see compactSeparators).
function findRuns(text: string): Run[] {
  const out: Run[] = [];
  for (const m of text.matchAll(RUN_RE)) {
    out.push({
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
      groups: m[0].split(/\D+/).filter((g) => g !== ''),
    });
  }
  return out;
}

// "3 30", "10 15", "9 0 5": an hour 1-12 and minutes 00-59, spaced like a spoken time.
function looksLikeClockTime(r: Run): boolean {
  const [h, a, b] = r.groups;
  if (!/^\d+ \d+( \d+)?$/.test(r.raw)) return false;
  const hour = Number(h);
  if (hour < 1 || hour > 12 || (h ?? '').length > 2) return false;
  if (r.groups.length === 2) return /^\d{2}$/.test(a ?? '') && Number(a) <= 59;
  return r.groups.length === 3 && a === '0' && /^\d$/.test(b ?? '');
}

// Digit runs that are facts. `sentence` gives context: a spoken clock time is only a time
// when the sentence talks about time and not about an identifier.
function factRuns(input: string, sentence: string): { raw: string; norm: string }[] {
  const text = compactSeparators(input);
  const out: { raw: string; norm: string }[] = [];
  for (const r of findRuns(text)) {
    const norm = r.groups.join('');
    if (norm.length < 3) continue;
    const before = text.slice(Math.max(0, r.start - 24), r.start);
    const after = text.slice(r.end, r.end + 40);
    if (TOLL_FREE.has(norm.replace(/^1/, '')) && TOLL_FREE_AFTER_RE.test(after)) continue;
    const partOfId =
      ID_CONTEXT_RE.test(sentence) ||
      PART_OF_ID_BEFORE_RE.test(before) ||
      PART_OF_ID_SENTENCE_RE.test(sentence);
    if (
      looksLikeClockTime(r) &&
      (TIME_PREP_BEFORE_RE.test(before) || TIME_CONTEXT_RE.test(sentence)) &&
      !partOfId
    ) {
      continue;
    }
    // "since 2019": a bare year in ordinary talk. Never in birth or identifier talk.
    const year = Number(norm);
    if (
      norm.length === 4 &&
      r.groups.length <= 2 &&
      year >= 1900 &&
      year <= 2099 &&
      YEAR_PREP_BEFORE_RE.test(before) &&
      !BIRTH_CONTEXT_RE.test(sentence) &&
      !partOfId
    ) {
      continue;
    }
    // "10, 15 minutes", "10-15 minutes", "In 5, 10, or 15 minutes": a list or range of
    // quantities, not one number. Only for comma/dash lists in non-identifier talk.
    if (
      r.groups.length > 1 &&
      r.groups.length <= 3 &&
      r.groups.every((g) => g.length <= 3) &&
      QUANTITY_LIST_RE.test(r.raw) &&
      UNIT_AFTER_RE.test(after) &&
      !ID_CONTEXT_RE.test(sentence)
    ) {
      for (const g of r.groups) if (g.length >= 3) out.push({ raw: g, norm: g });
      continue;
    }
    out.push({ raw: r.raw, norm });
  }
  return out;
}

// Every digit run, whole, with no classification (used for ledger read-back forms).
function plainRuns(text: string): string[] {
  return findRuns(compactSeparators(text))
    .map((r) => r.groups.join(''))
    .filter((n) => n.length >= 3);
}

// Order matters: emails, then dates, then times/ordinals are masked before digit runs,
// so "Born 03/14/1952, id 881204" yields exactly one date and one digit run.
export function extractFacts(sentence: string): ExtractedFact[] {
  const emails: ExtractedFact[] = [];
  const dates: ExtractedFact[] = [];
  const prepared = prepareText(sentence);
  let t = extractEmails(prepared, emails);
  t = normalizeNumbers(t);
  const context = t;
  t = extractDates(t, dates);
  t = maskTimes(t);
  const digits: ExtractedFact[] = factRuns(t, context).map((r) => ({
    kind: 'digits',
    raw: r.raw.trim(),
    norm: r.norm,
  }));
  return [...emails, ...dates, ...digits];
}

// ---------------------------------------------------------------- ledger

const MAX_RUN_FOR_SUBSTRINGS = 40;

class Ledger implements FactLedger {
  private readonly digits = new Set<string>();
  private readonly dates = new Set<string>();
  private readonly emails = new Set<string>();

  add(text: string, source: FactSource = 'user'): void {
    if (!text) return;
    for (const f of extractFacts(text)) this.addFact(f, source);
    // Also allow every digit run of the text read without date/time masking, so a
    // number that happened to parse as a date or time can still be read back digit by
    // digit ("12-04-77" → "120477", "9:15" → "915"). Whole runs only.
    for (const n of plainRuns(normalizeNumbers(prepareText(text)))) this.digits.add(n);
  }

  private addFact(f: ExtractedFact, source: FactSource): void {
    if (f.kind === 'email') {
      this.emails.add(f.norm);
      return;
    }
    if (f.kind === 'digits') {
      // Slices of the user's own numbers are fine to read back ("the last four are
      // 0477"); slices of a number the other party said are not facts we were given.
      if (source === 'user') this.addWithSubstrings(f.norm);
      else this.digits.add(f.norm);
      return;
    }
    this.dates.add(f.norm);
    const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(f.norm);
    if (full) {
      const [, y, m, d] = full as unknown as [string, string, string, string];
      this.dates.add(`--${m}-${d}`);
      this.dates.add(`${y}-${m}`);
      const mi = String(Number(m));
      const di = String(Number(d));
      // The same date read out as plain digits.
      for (const enc of [
        y,
        `${m}${d}${y}`,
        `${mi}${di}${y}`,
        `${m}${d}${y.slice(2)}`,
        `${d}${m}${y}`,
        `${di}${mi}${y}`,
        `${y}${m}${d}`,
      ]) {
        this.digits.add(enc);
      }
      return;
    }
    const ym = /^(\d{4})-\d{2}$/.exec(f.norm);
    if (ym?.[1]) this.digits.add(ym[1]);
  }

  // Partial read-backs ("the last four digits are 0477") of an allowed number are allowed.
  private addWithSubstrings(run: string): void {
    this.digits.add(run);
    if (run.length > MAX_RUN_FOR_SUBSTRINGS) return;
    for (let i = 0; i < run.length; i++) {
      for (let j = i + 3; j <= run.length; j++) this.digits.add(run.slice(i, j));
    }
  }

  has(fact: ExtractedFact): boolean {
    switch (fact.kind) {
      case 'digits':
        return this.digits.has(fact.norm);
      case 'email':
        return this.emails.has(fact.norm);
      case 'date':
        return this.dates.has(fact.norm);
    }
  }
}

export function createLedger(seed: string[]): FactLedger {
  const l = new Ledger();
  for (const s of seed) l.add(s);
  return l;
}

export function checkSentence(
  sentence: string,
  ledger: FactLedger,
): { ok: true } | { ok: false; offending: ExtractedFact[] } {
  const offending = extractFacts(sentence).filter((f) => !ledger.has(f));
  return offending.length === 0 ? { ok: true } : { ok: false, offending };
}

// ---------------------------------------------------------------- sentence splitting

const TERMINATOR_RE = /[.!?…]+["'”’)\]]*(?=\s)/g;
const ABBREVIATION_RE = /(?:^|[\s(])(?:mr|mrs|ms|dr|st|jr|sr|no|vs|mt|ft|prof|approx)\.$/i;
const NUMBER_WORDS = new Set([
  ...Object.keys(UNITS),
  ...Object.keys(TEENS),
  ...Object.keys(TENS),
  'oh',
  'double',
  'triple',
  'hundred',
  'thousand',
]);
const LAST_TOKEN_RE = /(\p{L}+|\p{Nd})[^\p{L}\p{Nd}]*$/u;
const FIRST_TOKEN_RE = /^[^\p{L}\p{Nd}]*(\p{L}+|\p{Nd})/u;

function numberish(token: string | undefined): boolean {
  return !!token && (/\p{Nd}/u.test(token) || NUMBER_WORDS.has(token.toLowerCase()));
}

// Cuts a streaming buffer into complete sentences. A terminator only counts once the
// next character (whitespace) has arrived, so "maya@example." or "3." never releases
// early. complete.join('') + rest === buffer.
export function splitSentences(buffer: string): { complete: string[]; rest: string } {
  const complete: string[] = [];
  let cut = 0;
  for (const m of buffer.matchAll(TERMINATOR_RE)) {
    const end = m.index + m[0].length;
    const upto = buffer.slice(cut, end);
    if (m[0] === '.' && ABBREVIATION_RE.test(upto)) continue;
    // Keep digit groups together: "88. 1204" (or "eight eight. one two") is one number
    // read in pieces, not two sentences whose halves would each pass the gate alone.
    if (numberish(LAST_TOKEN_RE.exec(upto)?.[1])) {
      const next = FIRST_TOKEN_RE.exec(buffer.slice(end));
      if (!next) break; // wait for the next token before deciding
      if (numberish(next[1])) continue;
    }
    complete.push(upto);
    cut = end;
  }
  return { complete, rest: buffer.slice(cut) };
}
