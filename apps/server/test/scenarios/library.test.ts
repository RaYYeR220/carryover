import { existsSync, readFileSync } from 'node:fs';
import type { LineState } from '@carryover/protocol';
import { describe, expect, it } from 'vitest';
import { LineStateTracker } from '../../src/call/lineState.js';
import { BEEP_ASSET, loadAssetFile, repSession } from '../../src/scenarios/engine.js';
import {
  allPrompts,
  getScenario,
  listScenarios,
  SCENARIOS,
} from '../../src/scenarios/library/index.js';
import { MEMBER_ID_ASK } from '../../src/scenarios/library/northstar-bank.js';

const VOICES = new Set([
  'alba',
  'eve',
  'george',
  'jane',
  'jean',
  'mary',
  'michael',
  'anna',
  'charles',
  'paul',
  'vera',
]);
const ASSET_DIR = new URL('../../src/scenarios/assets/', import.meta.url);

// What the call's line-state heuristics make of a caption turn, starting from `from`.
function classify(text: string, from: LineState = 'connecting', speakerIsNew = false): LineState {
  const t = new LineStateTracker(from, () => undefined);
  t.onFinalTurn(text, speakerIsNew);
  return t.state;
}

describe('scenario library', () => {
  it('has the five scenarios, listed by info', () => {
    expect(SCENARIOS.map((s) => s.info.id)).toEqual([
      'riverside-pharmacy',
      'lakeview-dental',
      'northstar-bank',
      'city-clinic-voicemail',
      'utility-outage',
    ]);
    expect(listScenarios()).toHaveLength(5);
    for (const info of listScenarios()) {
      expect(info.label).toBeTruthy();
      expect(info.business).toBeTruthy();
      expect(info.description.length).toBeGreaterThan(40);
    }
    expect(getScenario('nope')).toBeUndefined();
  });

  it.each(SCENARIOS.map((s) => [s.info.id, s] as const))('%s is a well-formed graph', (_id, s) => {
    expect(s.nodes[s.start]).toBeDefined();
    for (const [key, node] of Object.entries(s.nodes)) {
      expect(node.id).toBe(key);
      if (node.kind === 'ivr') {
        expect(node.options.length).toBeGreaterThan(0);
        for (const o of node.options) {
          expect(Boolean(o.digits) !== Boolean(o.phrase)).toBe(true);
          expect(s.nodes[o.next]).toBeDefined();
        }
        if (node.onTimeout) expect(s.nodes[node.onTimeout]).toBeDefined();
      }
      if (node.kind === 'hold') expect(s.nodes[node.next]).toBeDefined();
      if (node.kind === 'rep') {
        expect(VOICES.has(node.voice)).toBe(true);
        expect(node.checklist.length).toBeGreaterThan(1);
        if (node.transferTo) {
          const to = s.nodes[node.transferTo];
          expect(to?.kind).toBe('rep');
          if (to?.kind === 'rep') expect(to.voice).not.toBe(node.voice);
        }
      }
    }
  });

  it('every recorded prompt exists and runs longer than a second', () => {
    const prompts = allPrompts();
    expect(prompts.length).toBe(8);
    for (const p of prompts) {
      const file = new URL(`${p.asset}.ulaw`, ASSET_DIR);
      expect(existsSync(file), p.asset).toBe(true);
      const bytes = readFileSync(file).length;
      expect(bytes, p.asset).toBeGreaterThan(8000);
      expect(bytes, p.asset).toBeLessThan(8000 * 30);
    }
    expect(loadAssetFile(BEEP_ASSET).length).toBe(3200);
  });

  it('bank: Marcus asks for the 8-digit member ID, then Elena on the fraud team', () => {
    const s = getScenario('northstar-bank');
    const marcus = s?.nodes.marcus;
    if (!s || marcus?.kind !== 'rep') throw new Error('marcus is a rep');
    expect(MEMBER_ID_ASK).toBe('And can I get your eight-digit member ID, please?');
    expect(String(repSession(s, marcus).system_prompt)).toContain(MEMBER_ID_ASK);
    expect(marcus.checklist.findIndex((c) => c.includes('member ID'))).toBeGreaterThan(
      marcus.checklist.findIndex((c) => c.includes('date of birth')),
    );
    expect(marcus.transferTo).toBe('elena');
  });

  it("the call's line-state heuristics recognise every recording and pickup", () => {
    for (const s of SCENARIOS) {
      for (const node of Object.values(s.nodes)) {
        if (node.kind === 'ivr') expect(classify(node.prompt.text), node.id).toBe('ivr');
        if (node.kind === 'hold' && node.announcement) {
          expect(classify(node.announcement.text, 'ivr'), node.id).toBe('hold');
        }
        if (node.kind === 'voicemail')
          expect(classify(node.prompt.text), node.id).toBe('voicemail');
        if (node.kind === 'rep') {
          expect(classify(node.greeting, 'hold'), node.id).toBe('human');
          expect(classify(node.greeting, 'connecting'), node.id).toBe('human');
        }
      }
    }
  });

  it('no rep asks the caller to hold (a transfer must read as a new person, not hold)', () => {
    for (const s of SCENARIOS) {
      for (const node of Object.values(s.nodes)) {
        if (node.kind !== 'rep') continue;
        expect(classify(node.greeting, 'human'), node.id).toBe('human');
        for (const item of node.checklist) {
          const quoted = [...item.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
          for (const q of quoted) expect(classify(q, 'human'), `${node.id}: ${q}`).toBe('human');
        }
      }
    }
  });
});
