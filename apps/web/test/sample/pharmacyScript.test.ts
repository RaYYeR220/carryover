import { describe, expect, it } from 'vitest';
import { initialView, reduce } from '../../src/call/state';
import {
  ASK_ID,
  buildPharmacyScript,
  callDisplayMs,
  PHARMACY_DETAILS,
  PHARMACY_SCRIPT,
  rebase,
  SAMPLE_TOTAL_MS,
} from '../../src/sample/pharmacyScript';

describe('pharmacyScript', () => {
  it('is sorted by t', () => {
    const ts = PHARMACY_SCRIPT.map((se) => se.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it('never fires before the call starts, and ends within SAMPLE_TOTAL_MS', () => {
    for (const se of PHARMACY_SCRIPT) expect(se.t).toBeGreaterThanOrEqual(0);
    expect(SAMPLE_TOTAL_MS).toBe(PHARMACY_SCRIPT.at(-1)?.t);
    // About 65 s, per the brief.
    expect(SAMPLE_TOTAL_MS).toBeGreaterThan(55_000);
    expect(SAMPLE_TOTAL_MS).toBeLessThan(80_000);
  });

  it('resolves every ask before the summary', () => {
    const summaryT = PHARMACY_SCRIPT.find((se) => se.event.t === 'summary')?.t;
    expect(summaryT).toBeDefined();
    const asked = PHARMACY_SCRIPT.filter((se) => se.event.t === 'ask');
    expect(asked.length).toBeGreaterThan(0);
    for (const a of asked) {
      if (a.event.t !== 'ask') continue;
      const askId = a.event.askId;
      const resolved = PHARMACY_SCRIPT.find(
        (se) => se.event.t === 'ask.resolved' && se.event.askId === askId,
      );
      expect(resolved, `ask ${askId} is never resolved`).toBeDefined();
      expect(resolved?.t).toBeLessThanOrEqual(summaryT as number);
    }
  });

  it('has the disclosure and the typed-relay closing line the brief quotes', () => {
    const texts = PHARMACY_SCRIPT.flatMap((se) =>
      se.event.t === 'agent.said' ? [se.event.text] : [],
    );
    expect(texts).toContain(
      "Hi, I'm Carryover, an automated relay calling for Maya, who is Deaf and reading along.",
    );
    expect(texts).toContain('Thursday works. Thank you, Dana!');

    const queued = PHARMACY_SCRIPT.flatMap((se) =>
      se.event.t === 'relay.queued' ? [se.event] : [],
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]?.text).toBe('Thursday works. Thank you, Dana!');
    const spokenNonces = PHARMACY_SCRIPT.flatMap((se) =>
      se.event.t === 'relay.spoken' ? [se.event.nonce] : [],
    );
    expect(spokenNonces).toContain(queued[0]?.nonce);
  });

  it('has one word at confidence 0.45 in Dana’s final caption', () => {
    const finals = PHARMACY_SCRIPT.flatMap((se) =>
      se.event.t === 'caption' && se.event.final && se.event.speaker.role === 'them'
        ? [se.event]
        : [],
    );
    const low = finals.flatMap((c) => c.words.filter((w) => w.confidence === 0.45));
    expect(low).toHaveLength(1);
  });

  it('streams Dana’s date-of-birth question as a partial before the final', () => {
    const dobLines = PHARMACY_SCRIPT.filter(
      (se) => se.event.t === 'caption' && se.event.id === 'c-d2',
    );
    expect(dobLines.map((se) => se.event.t === 'caption' && se.event.final)).toEqual([false, true]);
  });

  it('the reducer ends with ended === true and a summary', () => {
    const view = PHARMACY_SCRIPT.reduce((v, se) => reduce(v, se.event), initialView);
    expect(view.ended).toBe(true);
    expect(view.summary).toBeDefined();
    expect(view.summary?.commitments.length).toBeGreaterThan(0);
    expect(view.summary?.bullets.length).toBeGreaterThan(0);
    expect(view.summary?.transcript.length).toBeGreaterThan(0);
  });

  it('names a real AssemblyAI voice, matching the start page', () => {
    expect(PHARMACY_DETAILS.voice).toBe('Alba · warm, US');
  });

  it('rebase shifts every timestamp by base, through the realistic hold clock, keeping order', () => {
    const base = 1_760_000_000_000;
    const rebased = PHARMACY_SCRIPT.map((se) => rebase(se.event, base));
    const view = rebased.reduce(reduce, initialView);
    expect(view.ended).toBe(true);
    expect(view.summary?.startedAt).toBe(base);
    // The displayed call runs longer than the raw ~67.5 s of playback: the
    // 8.4 s of compressed hold maps to a realistic 4:30 wait.
    expect(view.summary?.endedAt).toBeGreaterThan(base + SAMPLE_TOTAL_MS);
    for (const t of view.summary?.transcript ?? []) expect(t.at).toBeGreaterThanOrEqual(base);
  });

  describe('callDisplayMs (B’s callT mapping)', () => {
    it('is identity before hold starts', () => {
      expect(callDisplayMs(0)).toBe(0);
      expect(callDisplayMs(5000)).toBe(5000);
    });

    it('stretches the 8.4 s of compressed hold into a realistic 4:30', () => {
      expect(callDisplayMs(20_600) - callDisplayMs(12_200)).toBe(270_000);
    });

    it('is 1:1 (offset only) once the call is live again', () => {
      expect(callDisplayMs(31_000) - callDisplayMs(30_000)).toBe(1000);
    });
  });

  describe('the ask card choice', () => {
    function said(script: ReturnType<typeof buildPharmacyScript>): string[] {
      return script.flatMap((se) => (se.event.t === 'agent.said' ? [se.event.text] : []));
    }

    it('share (the default): resolves "shared" and says the profile date of birth', () => {
      const script = buildPharmacyScript({ kind: 'share' });
      const view = script.reduce((v, se) => reduce(v, se.event), initialView);
      expect(view.asks.find((a) => a.askId === ASK_ID)?.resolved).toBe('shared');
      expect(said(script)).toContain('March 14, 1952.');
      expect(view.summary?.bullets.join(' ')).toMatch(/Shared your date of birth/);
    });

    it('typed: resolves "typed" and says exactly the typed text, not the vault fact', () => {
      const script = buildPharmacyScript({ kind: 'typed', text: 'The 14th of March, 1952' });
      const view = script.reduce((v, se) => reduce(v, se.event), initialView);
      expect(view.asks.find((a) => a.askId === ASK_ID)?.resolved).toBe('typed');
      expect(said(script)).toContain('The 14th of March, 1952');
      expect(said(script)).not.toContain('March 14, 1952.');
      expect(view.summary?.bullets.join(' ')).toMatch(/Typed your date of birth/);
    });

    it('declined: resolves "declined", apologises, and Dana offers another way', () => {
      const script = buildPharmacyScript({ kind: 'declined' });
      const view = script.reduce((v, se) => reduce(v, se.event), initialView);
      expect(view.asks.find((a) => a.askId === ASK_ID)?.resolved).toBe('declined');
      expect(said(script)).toContain('Sorry, Maya would prefer not to share that.');
      expect(said(script)).not.toContain('March 14, 1952.');
      const d3 = script.find((se) => se.event.t === 'caption' && se.event.id === 'c-d3');
      expect(d3 && d3.event.t === 'caption' ? d3.event.text : '').toMatch(
        /^No problem, I can use her phone number\./,
      );
      expect(view.summary?.bullets.join(' ')).toMatch(/Declined to share your date of birth/);
    });

    it('every branch is the same length, with the ask resolved and a summary', () => {
      const branches = [
        { kind: 'share' } as const,
        { kind: 'typed', text: 'x' } as const,
        { kind: 'declined' } as const,
      ];
      for (const answer of branches) {
        const script = buildPharmacyScript(answer);
        expect(Math.max(...script.map((se) => se.t))).toBe(SAMPLE_TOTAL_MS);
        const view = script.reduce((v, se) => reduce(v, se.event), initialView);
        expect(view.ended).toBe(true);
        expect(view.summary).toBeDefined();
      }
    });
  });
});
