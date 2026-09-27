import { describe, expect, it } from 'vitest';
import { commitmentToIcs, icsFileName, parseWhen } from '../../src/lib/ics';

// Monday 28 September 2026, 10:00 local time.
const NOW = new Date(2026, 8, 28, 10, 0, 0);

const utc = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
const ymd = (y: number, m: number, d: number) =>
  `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;

function lines(ics: string): string[] {
  expect(ics.endsWith('\r\n')).toBe(true);
  // Unfold continuation lines before inspecting.
  return ics
    .replace(/\r\n /g, '')
    .split('\r\n')
    .filter((l) => l.length > 0);
}

function prop(ics: string, name: string): string | undefined {
  return lines(ics).find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));
}

describe('parseWhen', () => {
  it('reads a weekday with a time, resolving to the next occurrence', () => {
    expect(parseWhen('Thursday after 2 pm', NOW)).toEqual({
      date: new Date(2026, 9, 1, 14, 0),
      hasTime: true,
    });
    // Same weekday as today means next week, like the prototype.
    expect(parseWhen('Monday at 9:30 am', NOW)?.date).toEqual(new Date(2026, 9, 5, 9, 30));
  });

  it('reads ISO dates and date-times', () => {
    expect(parseWhen('2026-10-07T15:30', NOW)).toEqual({
      date: new Date(2026, 9, 7, 15, 30),
      hasTime: true,
    });
    expect(parseWhen('2026-10-07', NOW)).toEqual({ date: new Date(2026, 9, 7), hasTime: false });
  });

  it('reads month names, ordinals, today and tomorrow', () => {
    expect(parseWhen('October 7th at 3:30 pm', NOW)?.date).toEqual(new Date(2026, 9, 7, 15, 30));
    expect(parseWhen('7 Oct, 11am', NOW)?.date).toEqual(new Date(2026, 9, 7, 11, 0));
    expect(parseWhen('tomorrow at noon', NOW)?.date).toEqual(new Date(2026, 8, 29, 12, 0));
    expect(parseWhen('today after 4:15 p.m.', NOW)?.date).toEqual(new Date(2026, 8, 28, 16, 15));
  });

  it('rolls a month-day that already passed into next year', () => {
    expect(parseWhen('March 14', NOW)).toEqual({ date: new Date(2027, 2, 14), hasTime: false });
  });

  it('puts a bare time today, or tomorrow once it has passed', () => {
    expect(parseWhen('after 2 pm', NOW)?.date).toEqual(new Date(2026, 8, 28, 14, 0));
    expect(parseWhen('at 8am', NOW)?.date).toEqual(new Date(2026, 8, 29, 8, 0));
  });

  it('returns null for phrases without a date or time', () => {
    for (const s of ['soon', 'in 5-7 business days', 'reference 4471', 'next week', '', 'maybe']) {
      expect(parseWhen(s, NOW)).toBeNull();
    }
  });
});

describe('commitmentToIcs', () => {
  const pickup = { text: 'Pick up lisinopril, ref 4471', when: 'Thursday after 2 pm' };

  it('produces a valid VCALENDAR with one VEVENT', () => {
    const ics = commitmentToIcs(pickup, 'Riverside Pharmacy', { now: NOW, uid: 'abc' });
    const ls = lines(ics);
    expect(ls[0]).toBe('BEGIN:VCALENDAR');
    expect(ls.at(-1)).toBe('END:VCALENDAR');
    expect(ls).toContain('VERSION:2.0');
    expect(ls.some((l) => l.startsWith('PRODID:'))).toBe(true);
    expect(ls.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
    expect(ls.filter((l) => l === 'END:VEVENT')).toHaveLength(1);
    expect(ls.indexOf('BEGIN:VEVENT')).toBeLessThan(ls.indexOf('END:VEVENT'));
    expect(prop(ics, 'UID')).toBe('UID:abc@carryover');
    expect(prop(ics, 'DTSTAMP')).toBe(`DTSTAMP:${utc(NOW)}`);
    // Raw lines use CRLF only and never exceed 75 octets.
    for (const raw of ics.split('\r\n')) {
      expect(raw.includes('\n')).toBe(false);
      expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(75);
    }
  });

  it('uses a timed DTSTART and a one-hour DTEND when `when` is parseable', () => {
    const ics = commitmentToIcs(pickup, 'Riverside Pharmacy', { now: NOW, uid: 'abc' });
    const start = new Date(2026, 9, 1, 14, 0);
    expect(prop(ics, 'DTSTART')).toBe(`DTSTART:${utc(start)}`);
    expect(prop(ics, 'DTEND')).toBe(`DTEND:${utc(new Date(start.getTime() + 3_600_000))}`);
    expect(prop(ics, 'SUMMARY')).toBe('SUMMARY:Pick up lisinopril\\, ref 4471');
    expect(prop(ics, 'LOCATION')).toBe('LOCATION:Riverside Pharmacy');
  });

  it('makes an all-day event on the date when there is a date but no time', () => {
    const ics = commitmentToIcs({ text: 'Card arrives', when: '2026-10-07' }, 'Northstar Bank', {
      now: NOW,
    });
    expect(prop(ics, 'DTSTART')).toBe(`DTSTART;VALUE=DATE:${ymd(2026, 10, 7)}`);
    expect(prop(ics, 'DTEND')).toBe(`DTEND;VALUE=DATE:${ymd(2026, 10, 8)}`);
  });

  it('makes an all-day event today when `when` is missing or unparseable', () => {
    for (const c of [
      { text: 'Replacement card in 5-7 business days', when: 'in 5-7 business days' },
      { text: 'Call back' },
    ]) {
      const ics = commitmentToIcs(c, 'Northstar Bank', { now: NOW });
      expect(prop(ics, 'DTSTART')).toBe(`DTSTART;VALUE=DATE:${ymd(2026, 9, 28)}`);
      expect(prop(ics, 'DTEND')).toBe(`DTEND;VALUE=DATE:${ymd(2026, 9, 29)}`);
    }
  });

  it('escapes text and keeps the spoken `when` in the description', () => {
    const ics = commitmentToIcs(
      { text: 'Bring ID; card\nand letter, too', when: 'Friday, maybe' },
      'City Clinic',
      { now: NOW },
    );
    expect(prop(ics, 'SUMMARY')).toBe('SUMMARY:Bring ID\\; card\\nand letter\\, too');
    const desc = prop(ics, 'DESCRIPTION') ?? '';
    expect(desc).toContain('City Clinic');
    expect(desc).toContain('Friday\\, maybe');
  });

  it('folds long lines at 75 octets without splitting UTF-8 characters', () => {
    const text = `Confirm the appointment — ${'é'.repeat(80)}`;
    const ics = commitmentToIcs({ text }, 'Lakeview Dental', { now: NOW });
    expect(prop(ics, 'SUMMARY')).toBe(`SUMMARY:${text}`);
    expect(ics).toContain('\r\n ');
  });
});

describe('icsFileName', () => {
  it('slugs the business name', () => {
    expect(icsFileName('Riverside Pharmacy')).toBe('riverside-pharmacy.ics');
    expect(icsFileName('  ')).toBe('carryover.ics');
  });
});
