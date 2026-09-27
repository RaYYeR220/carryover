import { describe, expect, it } from 'vitest';
import {
  checkSentence,
  createLedger,
  extractFacts,
  splitSentences,
} from '../../src/brain/factGate.js';

describe('fact gate', () => {
  const ledger = createLedger(['March 14, 1952', 'Member ID 88-1204-77']);
  it('passes facts present in the ledger (numeric and spelled)', () => {
    expect(checkSentence('Her date of birth is March 14th, 1952.', ledger).ok).toBe(true);
    expect(checkSentence('Date of birth: 3/14/1952.', ledger).ok).toBe(true);
    expect(
      checkSentence('The member ID is eight eight one two zero four seven seven.', ledger).ok,
    ).toBe(true);
  });
  it('blocks invented facts (the observed qwen DOB failure)', () => {
    const r = checkSentence('Her date of birth is June 1st, 1986.', ledger);
    expect(r.ok).toBe(false);
    expect(checkSentence('Her birthday is six one one nine eight six.', ledger).ok).toBe(false);
    expect(checkSentence('You can reach her at maya@example.com.', ledger).ok).toBe(false);
  });
  it('ignores small numbers and times of day', () => {
    expect(checkSentence('I will press 2 now.', ledger).ok).toBe(true);
    expect(checkSentence('Thursday at 2 pm works.', ledger).ok).toBe(true);
  });
  it('facts heard from the other party become allowed', () => {
    const l = createLedger([]);
    l.add('Your reference number is 4471.');
    expect(checkSentence('Thanks, reference 4471.', l).ok).toBe(true);
  });
  it('splits sentences keeping the remainder', () => {
    expect(splitSentences('Hello there. How are')).toEqual({
      complete: ['Hello there.'],
      rest: ' How are',
    });
  });
  it('extracts dates and digit runs', () => {
    expect(
      extractFacts('Born 03/14/1952, id 881204')
        .map((f) => f.kind)
        .sort(),
    ).toEqual(['date', 'digits']);
  });
});

describe('extractFacts normalisation', () => {
  const norms = (s: string) => extractFacts(s).map((f) => `${f.kind}:${f.norm}`);

  it('normalises every supported date shape to YYYY-MM-DD', () => {
    expect(norms('Born March 14th, 1952.')).toEqual(['date:1952-03-14']);
    expect(norms('Born 14 March 1952.')).toEqual(['date:1952-03-14']);
    expect(norms('Born the 14th of March, 1952.')).toEqual(['date:1952-03-14']);
    expect(norms('Born 3/14/1952.')).toEqual(['date:1952-03-14']);
    expect(norms('Born 1952-03-14.')).toEqual(['date:1952-03-14']);
    expect(norms('Born 14/03/1952.')).toEqual(['date:1952-03-14']);
    expect(norms('Born Sept. 9, 2001.')).toEqual(['date:2001-09-09']);
  });

  it('parses spelled days and spelled years', () => {
    expect(norms('March fourteenth, nineteen fifty two')).toEqual(['date:1952-03-14']);
    expect(norms('the fourteenth of March, nineteen fifty-two')).toEqual(['date:1952-03-14']);
    expect(norms('June first, nineteen eighty six')).toEqual(['date:1986-06-01']);
    expect(norms('May third, nineteen oh five')).toEqual(['date:1905-05-03']);
    expect(norms('January second, two thousand three')).toEqual(['date:2003-01-02']);
    expect(norms('July fourth, twenty twenty-one')).toEqual(['date:2021-07-04']);
  });

  it('keeps month-and-day or month-and-year dates as partial dates', () => {
    expect(norms('March fourteenth')).toEqual(['date:--03-14']);
    expect(norms('born in June 1986')).toEqual(['date:1986-06']);
    expect(norms('born in June nineteen eighty six')).toEqual(['date:1986-06']);
  });

  it('does not treat the verb "may" as a month', () => {
    expect(extractFacts('May I have her date of birth?')).toEqual([]);
    expect(extractFacts('You may hear some music.')).toEqual([]);
  });

  it('joins digit runs across spaces, dashes, dots, commas and parentheses', () => {
    expect(norms('ID 88-1204-77')).toEqual(['digits:88120477']);
    expect(norms('call (555) 867-5309')).toEqual(['digits:5558675309']);
    expect(norms('eight, eight, one, two')).toEqual(['digits:8812']);
    expect(norms('88‑1204‑77')).toEqual(['digits:88120477']);
  });

  it('converts spelled number words: digits, double/triple, tens, hundreds, years', () => {
    expect(norms('double eight one two zero four double seven')).toEqual(['digits:88120477']);
    expect(norms('triple five')).toEqual(['digits:555']);
    expect(norms('eighty-eight twelve oh four seventy-seven')).toEqual(['digits:88120477']);
    expect(norms('four hundred and twelve Main Street')).toEqual(['digits:412']);
    expect(norms('she was born in nineteen eighty six')).toEqual(['digits:1986']);
  });

  it('extracts written and spoken email addresses', () => {
    expect(norms('write to Maya.G@Example.com today')).toEqual(['email:maya.g@example.com']);
    expect(norms('reach her at maya at example dot com')).toEqual(['email:maya@example.com']);
    expect(norms('it is m a y a at example dot com')).toEqual(['email:maya@example.com']);
    expect(norms('maya dot g at mail dot example dot org')).toEqual([
      'email:maya.g@mail.example.org',
    ]);
    expect(norms('reach her at maya at gmail.com')).toEqual(['email:maya@gmail.com']);
  });

  it('ignores percentages', () => {
    expect(extractFacts('Absolutely, one hundred percent.')).toEqual([]);
    expect(extractFacts('Her copay is 100% covered.')).toEqual([]);
  });

  it('ignores times of day, ordinals alone and short numbers', () => {
    expect(extractFacts('Can we do 10:30 am on the 21st?')).toEqual([]);
    expect(extractFacts('How about two thirty pm?')).toEqual([]);
    expect(extractFacts('The pharmacy opens at nine oh one AM.')).toEqual([]);
    expect(extractFacts('Thursday at two thirty works.')).toEqual([]);
    expect(extractFacts('It closes at 17:45.')).toEqual([]);
    expect(extractFacts('Around 3 o clock, on the twenty first.')).toEqual([]);
    expect(extractFacts('Press 1 or 2, it takes about 15 minutes.')).toEqual([]);
    expect(extractFacts('One moment, let me check with Maya.')).toEqual([]);
    expect(extractFacts('Oh, one more thing.')).toEqual([]);
  });
});

describe('checkSentence: spelled and partial forms (Review Focus 3)', () => {
  const ledger = createLedger(['March 14, 1952', 'Member ID 88-1204-77', 'maya@example.com']);
  const ok = (s: string) => checkSentence(s, ledger).ok;

  it('allows the consented DOB in every spoken form', () => {
    expect(ok('Her date of birth is March fourteenth, nineteen fifty two.')).toBe(true);
    expect(ok('That is the fourteenth of March, nineteen fifty-two.')).toBe(true);
    expect(ok('Her birthday is March fourteenth.')).toBe(true);
    expect(ok('She was born in nineteen fifty two.')).toBe(true);
    expect(ok('She was born in March 1952.')).toBe(true);
    expect(ok('Her date of birth is zero three one four one nine five two.')).toBe(true);
    expect(ok('Her date of birth is 1952-03-14.')).toBe(true);
  });

  it('blocks invented dates in every spoken form', () => {
    expect(ok('Her date of birth is June first, nineteen eighty six.')).toBe(false);
    expect(ok('Her birthday is June first.')).toBe(false);
    expect(ok('She was born in nineteen eighty six.')).toBe(false);
    expect(ok('Her date of birth is 6/1/1986.')).toBe(false);
    expect(ok('Her date of birth is 06011986.')).toBe(false);
    expect(ok('Her date of birth is March fourteenth, nineteen fifty three.')).toBe(false);
  });

  it('allows partial read-backs of an allowed ID but not invented partials', () => {
    expect(ok('The last four digits are zero four seven seven.')).toBe(true);
    expect(ok('It starts with 881.')).toBe(true);
    expect(ok('The middle part is twelve oh four.')).toBe(true);
    expect(ok('The last four digits are 9 9 3 1.')).toBe(false);
  });

  it('allows the ID in other spoken groupings, blocks invented ones', () => {
    expect(ok('It is eighty-eight, twelve oh four, seventy-seven.')).toBe(true);
    expect(ok('It is double eight one two zero four double seven.')).toBe(true);
    expect(ok('It is eight, eight, one, two, zero, four, seven, seven.')).toBe(true);
    expect(ok('Her member ID is forty-four seventy-one twenty-two.')).toBe(false);
    expect(ok('Her ID is six, one, one, nine, eight, six.')).toBe(false);
    expect(ok('Her ID is 88-1204-78.')).toBe(false);
  });

  it('blocks invented phone numbers, addresses and emails', () => {
    expect(ok('Her number is 555-867-5309.')).toBe(false);
    expect(ok('She lives at four hundred twelve Main Street.')).toBe(false);
    expect(ok('Her email is maya at gmail dot com.')).toBe(false);
    expect(ok('Her email is maya at example dot com.')).toBe(true);
  });

  it('reports the offending facts', () => {
    const r = checkSentence('Born June 1st, 1986, ID 611986, maya@gmail.com.', ledger);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.offending.map((f) => `${f.kind}:${f.norm}`)).toEqual([
      'email:maya@gmail.com',
      'date:1986-06-01',
      'digits:611986',
    ]);
  });

  it('facts heard in words from the other party are allowed in digits and vice versa', () => {
    const l = createLedger([]);
    l.add('Your reference number is four four seven one.');
    expect(checkSentence('Thanks, reference 4471.', l).ok).toBe(true);
    l.add('Your confirmation is 9 0 2 1 5.');
    expect(checkSentence('Confirmation nine oh two one five, got it.', l).ok).toBe(true);
    expect(checkSentence('Confirmation nine oh two one six, got it.', l).ok).toBe(false);
  });

  it('an empty ledger blocks every personal fact but not ordinary speech', () => {
    const l = createLedger([]);
    expect(checkSentence('Hi, I am calling about a prescription refill.', l).ok).toBe(true);
    expect(checkSentence('Sure, I can hold.', l).ok).toBe(true);
    expect(checkSentence('Her member ID is 88120477.', l).ok).toBe(false);
  });
});

describe('splitSentences', () => {
  it('keeps the exact text: complete + rest reassemble the buffer', () => {
    const buf = 'Hi. Yes! Really? Well... fine';
    const { complete, rest } = splitSentences(buf);
    expect(complete).toEqual(['Hi.', ' Yes!', ' Really?', ' Well...']);
    expect(complete.join('') + rest).toBe(buf);
  });
  it('holds a sentence ending in a number until the next token shows it is not continued', () => {
    expect(splitSentences('Her ID is 12. ').complete).toEqual([]);
    expect(splitSentences('Her ID is 12. 34. Thanks').complete).toEqual(['Her ID is 12. 34.']);
    expect(splitSentences('It is six one. one nine. Thanks').complete).toEqual([
      'It is six one. one nine.',
    ]);
    expect(splitSentences('Press 2. Then hold').complete).toEqual(['Press 2.']);
  });
  it('waits for the character after a terminator', () => {
    expect(splitSentences('Her email is maya@example.')).toEqual({
      complete: [],
      rest: 'Her email is maya@example.',
    });
    expect(splitSentences('It costs 3.5 dollars')).toEqual({
      complete: [],
      rest: 'It costs 3.5 dollars',
    });
  });
  it('does not split after common abbreviations or between digit groups', () => {
    expect(splitSentences('Dr. Smith is in. Next').complete).toEqual(['Dr. Smith is in.']);
    expect(splitSentences('It is 88. 1204 then. Ok').complete).toEqual(['It is 88. 1204 then.']);
  });
  it('keeps closing quotes with the sentence', () => {
    expect(splitSentences('She said "yes." Then')).toEqual({
      complete: ['She said "yes."'],
      rest: ' Then',
    });
  });
});
