import { describe, expect, it } from 'vitest';
import { initialView, reduce } from '../../src/call/state';
import { PHARMACY_SCRIPT, rebase, SAMPLE_TOTAL_MS } from '../../src/sample/pharmacyScript';

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
      "Hi, this is Carryover, an automated relay calling for Maya, who is Deaf and reading along. Please speak normally — I'll pass on everything you say.",
    );
    expect(texts).toContain("Thank you, that's all I needed.");

    const queued = PHARMACY_SCRIPT.flatMap((se) =>
      se.event.t === 'relay.queued' ? [se.event] : [],
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]?.text).toBe("Thank you, that's all I needed.");
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

  it('rebase shifts every timestamp in an event by the same base, keeping order', () => {
    const base = 1_760_000_000_000;
    const rebased = PHARMACY_SCRIPT.map((se) => rebase(se.event, base));
    const view = rebased.reduce(reduce, initialView);
    expect(view.ended).toBe(true);
    expect(view.summary?.startedAt).toBe(base);
    expect(view.summary?.endedAt).toBe(base + SAMPLE_TOTAL_MS);
    for (const t of view.summary?.transcript ?? []) expect(t.at).toBeGreaterThanOrEqual(base);
  });
});
