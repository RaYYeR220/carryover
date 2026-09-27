// Code-enforced fabrication gate. Every sentence the LLM wants to say on the user's
// behalf is checked here before it reaches the phone line: any date, digit run (>= 3
// digits, after turning spoken number words into digits) or email address it contains
// must already be in the call's ledger (the user's consented facts, answers the user
// typed, and everything the other party said). Prompts can be ignored by a model; this
// check cannot.

export interface ExtractedFact {
  kind: 'digits' | 'date' | 'email';
  raw: string;
  norm: string;
}

export interface FactLedger {
  add(text: string): void;
  has(fact: ExtractedFact): boolean;
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
  // "oh" is a zero only next to other digits ("nine oh one", "nineteen oh five").
  for (let k = 0; k < 4; k++) {
    const before = out;
    out = out.replace(/(?<=\d[\s,-]{0,3})\boh\b|\boh\b(?=[\s,-]{1,3}\d)/gi, '0');
    if (out === before) break;
  }
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
const YEAR = '((?:19|20)(?:\\d{2}|[ -]\\d{2}|[ -]0[ -]?\\d)|1 9 \\d \\d|2 0 \\d \\d)(?![ -]?\\d)';
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)';
const YEAR_TAIL = `(?:\\s*,?\\s*(?:of\\s+|in\\s+)?${YEAR})?`;

const ISO_RE = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g;
const NUMERIC_DATE_RE = /\b(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})\b/g;
const MONTH_YEAR_RE = new RegExp(`\\b${MONTH},?\\s+(?:of\\s+|in\\s+)?${YEAR}`, 'gi');
const MONTH_DAY_RE = new RegExp(`\\b${MONTH},?\\s+(?:the\\s+)?${DAY}${YEAR_TAIL}`, 'gi');
const DAY_MONTH_RE = new RegExp(`\\b(?:the\\s+)?${DAY}\\s+(?:of\\s+)?${MONTH}${YEAR_TAIL}`, 'gi');

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
// "at 2 30" (from "at two thirty"); never when more digits follow ("at 12 34 56" is a number).
const TIME_AFTER_PREP_RE =
  /\b(at|around|by|until|till|before|after|from|between)\s+(\d{1,2})[ ](0[ ]?\d|\d{2})\b(?![\s,.-]*\d)/gi;
const ORDINAL_RE = /\b\d{1,2}(?:st|nd|rd|th)\b/gi;
// Percentages ("one hundred percent", "20%") are not facts about anyone.
const PERCENT_RE = /\b\d{1,3}(?:\.\d+)?\s?(?:%|percent\b)/gi;
// A digit run: digits joined by up to 3 separator characters (space, comma, dot, dash, parens).
const DIGIT_RUN_RE = /\d(?:[\s,.()-]{0,3}\d)*/g;

const MASK = ' | ';

function monthNumber(name: string): number {
  for (const [re, n] of MONTHS) if (re.test(name)) return n;
  return 0;
}

function yearNumber(raw: string): number {
  const digits = raw.replace(/\D/g, '');
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
  let t = text.replace(ISO_RE, (m, y: string, mo: string, d: string) => {
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
  t = t.replace(MONTH_DAY_RE, (m, mon: string, d: string, y: string | undefined) => {
    const day = Number(d);
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
  t = t.replace(TIME_AFTER_PREP_RE, (m, prep: string, h: string, mm: string) => {
    const minutes = Number(mm.replace(/\D/g, ''));
    return Number(h) <= 23 && minutes <= 59 ? `${prep}${MASK}` : m;
  });
  return t.replace(ORDINAL_RE, MASK).replace(PERCENT_RE, MASK);
}

function digitRuns(text: string): { raw: string; norm: string }[] {
  const out: { raw: string; norm: string }[] = [];
  for (const m of text.matchAll(DIGIT_RUN_RE)) {
    const norm = m[0].replace(/\D/g, '');
    if (norm.length >= 3) out.push({ raw: m[0], norm });
  }
  return out;
}

// Order matters: emails, then dates, then times/ordinals are masked before digit runs,
// so "Born 03/14/1952, id 881204" yields exactly one date and one digit run.
export function extractFacts(sentence: string): ExtractedFact[] {
  const emails: ExtractedFact[] = [];
  const dates: ExtractedFact[] = [];
  let t = extractEmails(sentence, emails);
  t = normalizeNumbers(t);
  t = extractDates(t, dates);
  t = maskTimes(t);
  const digits: ExtractedFact[] = digitRuns(t).map((r) => ({
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

  add(text: string): void {
    if (!text) return;
    for (const f of extractFacts(text)) this.addFact(f);
    // Also allow every digit run of the text read without date/time masking, so a
    // number that happened to parse as a date or time can still be read back digit by
    // digit ("12-04-77" → "120477", "9:15" → "915").
    for (const r of digitRuns(normalizeNumbers(text))) this.digits.add(r.norm);
  }

  private addFact(f: ExtractedFact): void {
    if (f.kind === 'email') {
      this.emails.add(f.norm);
      return;
    }
    if (f.kind === 'digits') {
      this.addWithSubstrings(f.norm);
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
const LAST_TOKEN_RE = /([A-Za-z]+|\d)[^A-Za-z\d]*$/;
const FIRST_TOKEN_RE = /^[^A-Za-z\d]*([A-Za-z]+|\d)/;

function numberish(token: string | undefined): boolean {
  return !!token && (/\d/.test(token) || NUMBER_WORDS.has(token.toLowerCase()));
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
