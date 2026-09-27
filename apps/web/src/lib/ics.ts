import type { Commitment } from '@carryover/protocol';

/**
 * Calendar export for a commitment heard on a call ("Thursday after 2 pm").
 * `when` is free text copied from the captions, so parsing is deliberately
 * conservative: a date and time it can read become a timed event, a date alone
 * becomes an all-day event on that date, and anything else becomes an all-day
 * reminder today with the original words kept in the description.
 */

export interface ParsedWhen {
  date: Date;
  hasTime: boolean;
}

export interface IcsOptions {
  now?: Date;
  uid?: string;
}

const MONTHS: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sept: 8,
  sep: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};
const MONTH_RE = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join('|');
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const RE_ISO = /\b(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2}))?/i;
const RE_MONTH_DAY = new RegExp(
  `\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`,
);
const RE_DAY_MONTH = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\b\\.?(?:,?\\s+(\\d{4}))?`,
);
const RE_WEEKDAY = new RegExp(`\\b(${WEEKDAYS.join('|')})\\b`);
const RE_TIME_MERIDIEM = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\b\.?/;
const RE_TIME_COLON = /\b(\d{1,2}):(\d{2})\b/;
const RE_TIME_AT = /\bat\s+(\d{1,2})\b(?![:\d])/;

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function readTime(s: string): { h: number; m: number } | null {
  if (/\bnoon\b/.test(s)) return { h: 12, m: 0 };
  const mer = RE_TIME_MERIDIEM.exec(s);
  if (mer) {
    let h = Number(mer[1]);
    const m = Number(mer[2] ?? 0);
    if (h < 1 || h > 12 || m > 59) return null;
    if (mer[3] === 'p' && h !== 12) h += 12;
    if (mer[3] === 'a' && h === 12) h = 0;
    return { h, m };
  }
  // Without am/pm, small hours on a business call mean the afternoon.
  const afternoon = (h: number) => (h >= 1 && h <= 7 ? h + 12 : h);
  const col = RE_TIME_COLON.exec(s);
  if (col) {
    const h = Number(col[1]);
    const m = Number(col[2]);
    if (h > 23 || m > 59) return null;
    return { h: afternoon(h), m };
  }
  const at = RE_TIME_AT.exec(s);
  if (at) {
    const h = Number(at[1]);
    if (h < 1 || h > 12) return null;
    return { h: afternoon(h), m: 0 };
  }
  return null;
}

function readDate(s: string, now: Date): Date | null {
  const today = startOfDay(now);
  const iso = RE_ISO.exec(s);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

  const md = RE_MONTH_DAY.exec(s);
  const dm = md ? null : RE_DAY_MONTH.exec(s);
  const hit = md
    ? { month: md[1], day: md[2], year: md[3] }
    : dm
      ? { month: dm[2], day: dm[1], year: dm[3] }
      : null;
  if (hit) {
    const month = MONTHS[hit.month ?? ''] ?? 0;
    const day = Number(hit.day);
    const yearText = hit.year;
    if (day < 1 || day > 31) return null;
    if (yearText) return new Date(Number(yearText), month, day);
    const d = new Date(today.getFullYear(), month, day);
    if (d < today) d.setFullYear(today.getFullYear() + 1);
    return d;
  }

  if (/\btomorrow\b/.test(s))
    return new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(s)) return today;

  const wd = RE_WEEKDAY.exec(s);
  if (wd) {
    const target = WEEKDAYS.indexOf(wd[1] as string);
    const add = (target - today.getDay() + 7) % 7 || 7;
    return new Date(today.getFullYear(), today.getMonth(), today.getDate() + add);
  }
  return null;
}

/** Read a spoken date/time phrase relative to `now` (local time). Null when nothing is recognisable. */
export function parseWhen(when: string, now: Date = new Date()): ParsedWhen | null {
  const s = when.toLowerCase().trim();
  if (!s) return null;

  const iso = RE_ISO.exec(s);
  if (iso?.[4] != null) {
    return {
      date: new Date(
        Number(iso[1]),
        Number(iso[2]) - 1,
        Number(iso[3]),
        Number(iso[4]),
        Number(iso[5]),
      ),
      hasTime: true,
    };
  }

  const date = readDate(s, now);
  const time = readTime(s);
  if (date && time) {
    return {
      date: new Date(date.getFullYear(), date.getMonth(), date.getDate(), time.h, time.m),
      hasTime: true,
    };
  }
  if (date) return { date, hasTime: false };
  if (time) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), time.h, time.m);
    if (d <= now) d.setDate(d.getDate() + 1);
    return { date: d, hasTime: true };
  }
  return null;
}

/* ---------- iCalendar text ---------- */

const pad = (n: number) => String(n).padStart(2, '0');
const utcStamp = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
const dateValue = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

const encoder = new TextEncoder();

/** Fold a content line at 75 octets (RFC 5545 §3.1) without splitting characters. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    if (bytes + n > limit) {
      out.push(cur);
      cur = ' ';
      bytes = 1;
      limit = 75;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n');
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Build an .ics file for `c`. `title` is who the call was with (the target
 * label); it becomes the event location and is named in the description.
 */
export function commitmentToIcs(c: Commitment, title: string, opts: IcsOptions = {}): string {
  const now = opts.now ?? new Date();
  const parsed = c.when ? parseWhen(c.when, now) : null;

  const timing: string[] = [];
  if (parsed?.hasTime) {
    timing.push(`DTSTART:${utcStamp(parsed.date)}`);
    timing.push(`DTEND:${utcStamp(new Date(parsed.date.getTime() + 60 * 60 * 1000))}`);
  } else {
    const day = startOfDay(parsed?.date ?? now);
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    timing.push(`DTSTART;VALUE=DATE:${dateValue(day)}`);
    timing.push(`DTEND;VALUE=DATE:${dateValue(next)}`);
  }

  const who = title.trim();
  const description = [
    who ? `From your Carryover call with ${who}.` : 'From your Carryover call.',
    c.when ? `When: ${c.when}.` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const content = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Carryover//Call summary//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${opts.uid ?? randomId()}@carryover`,
    `DTSTAMP:${utcStamp(now)}`,
    ...timing,
    `SUMMARY:${escapeText(c.text)}`,
    ...(who ? [`LOCATION:${escapeText(who)}`] : []),
    `DESCRIPTION:${escapeText(description)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${content.map(fold).join('\r\n')}\r\n`;
}

/** A download name like "riverside-pharmacy.ics". */
export function icsFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'carryover'}.ics`;
}
