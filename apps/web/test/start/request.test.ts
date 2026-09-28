import type { Fact, ScenarioInfo } from '@carryover/protocol';
import { StartCallRequest as StartCallRequestSchema } from '@carryover/protocol';
import { describe, expect, it } from 'vitest';
import {
  buildStartCallRequest,
  DEFAULT_AUTONOMY,
  DEFAULT_SHARED_KEYS,
  DEFAULT_VOICE,
  destinationId,
  destinationLabel,
  factNote,
  MAX_FACTS,
  targetFor,
  VOICE_LABELS,
  VOICES,
} from '../../src/start/request';

const FACTS: Fact[] = [
  { key: 'name', label: 'Name', value: 'Maya Chen' },
  { key: 'dob', label: 'Date of birth', value: 'March 14, 1952' },
  { key: 'address', label: 'Address', value: '41 Alder Street, Portland OR 97205' },
  { key: 'member_id', label: 'Member ID', value: '40718233' },
];

const SCENARIO: ScenarioInfo = {
  id: 'riverside-pharmacy',
  label: 'Riverside Pharmacy',
  business: 'Pharmacy',
  description: 'A pharmacy that answers after a short hold.',
  suggestedGoal: 'Check on my lisinopril refill',
  suggestedAutonomy: 'assist',
};

describe('buildStartCallRequest', () => {
  it('builds exactly the selected fields, snapshotted', () => {
    const req = buildStartCallRequest({
      target: { kind: 'scenario', scenarioId: 'riverside-pharmacy' },
      userName: 'Maya Chen',
      userDescriptor: 'deaf',
      autonomy: 'auto',
      goal: 'Check on my lisinopril refill',
      facts: FACTS,
      sharedKeys: new Set(['name', 'dob']),
      voice: 'alba',
    });
    expect(req).toEqual({
      target: { kind: 'scenario', scenarioId: 'riverside-pharmacy' },
      userName: 'Maya Chen',
      userDescriptor: 'deaf',
      autonomy: 'auto',
      goal: 'Check on my lisinopril refill',
      facts: [
        { key: 'name', label: 'Name', value: 'Maya Chen' },
        { key: 'dob', label: 'Date of birth', value: 'March 14, 1952' },
      ],
      voice: 'alba',
    });
  });

  it('sends only the toggled facts, in vault order, never the untoggled ones', () => {
    const req = buildStartCallRequest({
      target: { kind: 'line', code: 'ABC123' },
      userName: 'Maya Chen',
      userDescriptor: 'deaf',
      autonomy: 'assist',
      goal: '',
      facts: FACTS,
      sharedKeys: new Set(['member_id']),
      voice: 'jane',
    });
    expect(req.facts).toEqual([{ key: 'member_id', label: 'Member ID', value: '40718233' }]);
  });

  it('omits an empty or whitespace-only goal rather than sending ""', () => {
    const base = {
      target: { kind: 'line' as const, code: 'ABC123' },
      userName: 'Maya Chen',
      userDescriptor: 'deaf' as const,
      autonomy: 'relay' as const,
      facts: [],
      sharedKeys: new Set<string>(),
      voice: 'alba',
    };
    expect(buildStartCallRequest({ ...base, goal: '' })).not.toHaveProperty('goal');
    expect(buildStartCallRequest({ ...base, goal: '   ' })).not.toHaveProperty('goal');
    expect(buildStartCallRequest({ ...base, goal: '  Ask about hours  ' }).goal).toBe(
      'Ask about hours',
    );
  });

  it('trims the user name', () => {
    const req = buildStartCallRequest({
      target: { kind: 'line', code: 'ABC123' },
      userName: '  Maya Chen  ',
      userDescriptor: 'deaf',
      autonomy: 'relay',
      goal: '',
      facts: [],
      sharedKeys: new Set(),
      voice: 'alba',
    });
    expect(req.userName).toBe('Maya Chen');
  });

  it('caps the sent facts at the protocol’s 20-fact limit, and the result always parses', () => {
    const manyFacts: Fact[] = Array.from({ length: 25 }, (_, i) => ({
      key: `fact_${i}`,
      label: `Fact ${i}`,
      value: `value ${i}`,
    }));
    const req = buildStartCallRequest({
      target: { kind: 'line', code: 'ABC123' },
      userName: 'Maya Chen',
      userDescriptor: 'deaf',
      autonomy: 'assist',
      goal: '',
      facts: manyFacts,
      sharedKeys: new Set(manyFacts.map((f) => f.key)),
      voice: 'alba',
    });
    expect(req.facts).toHaveLength(MAX_FACTS);
    expect(req.facts).toEqual(manyFacts.slice(0, MAX_FACTS));
    expect(StartCallRequestSchema.safeParse(req).success).toBe(true);
  });

  it('clamps userName and fact values to the protocol’s limits, so the result always parses', () => {
    const req = buildStartCallRequest({
      target: { kind: 'line', code: 'ABC123' },
      userName: 'M'.repeat(60),
      userDescriptor: 'deaf',
      autonomy: 'assist',
      goal: '',
      facts: [{ key: 'note', label: 'Note', value: 'x'.repeat(250) }],
      sharedKeys: new Set(['note']),
      voice: 'alba',
    });
    expect(req.userName).toHaveLength(40);
    expect(req.facts[0]?.value).toHaveLength(200);
    expect(StartCallRequestSchema.safeParse(req).success).toBe(true);
  });

  it('a request built from a small, in-limits vault also parses against the real schema', () => {
    const req = buildStartCallRequest({
      target: { kind: 'scenario', scenarioId: 'riverside-pharmacy' },
      userName: 'Maya Chen',
      userDescriptor: 'deaf',
      autonomy: 'assist',
      goal: '',
      facts: FACTS,
      sharedKeys: new Set(['name', 'dob']),
      voice: 'alba',
    });
    expect(StartCallRequestSchema.safeParse(req).success).toBe(true);
  });
});

describe('destinations', () => {
  it('identifies the practice line and each scenario by id', () => {
    expect(destinationId({ kind: 'practice' })).toBe('practice');
    expect(destinationId({ kind: 'scenario', scenario: SCENARIO })).toBe('riverside-pharmacy');
  });

  it('labels the practice line and scenarios', () => {
    expect(destinationLabel({ kind: 'practice' })).toBe('Practice line');
    expect(destinationLabel({ kind: 'scenario', scenario: SCENARIO })).toBe('Riverside Pharmacy');
  });

  it('targets a scenario directly, but the practice line only once it has a code', () => {
    expect(targetFor({ kind: 'scenario', scenario: SCENARIO }, undefined)).toEqual({
      kind: 'scenario',
      scenarioId: 'riverside-pharmacy',
    });
    expect(targetFor({ kind: 'practice' }, undefined)).toBeNull();
    expect(targetFor({ kind: 'practice' }, 'ABC123')).toEqual({ kind: 'line', code: 'ABC123' });
  });
});

describe('defaults', () => {
  it('lists all nine AssemblyAI voices with alba first', () => {
    expect(VOICES).toEqual([
      'alba',
      'jane',
      'mary',
      'eve',
      'jean',
      'michael',
      'george',
      'anna',
      'vera',
    ]);
    expect(DEFAULT_VOICE).toBe('alba');
  });

  it('defaults autonomy to assist and pre-shares name and dob', () => {
    expect(DEFAULT_AUTONOMY).toBe('assist');
    expect(DEFAULT_SHARED_KEYS.has('name')).toBe(true);
    expect(DEFAULT_SHARED_KEYS.has('dob')).toBe(true);
    expect(DEFAULT_SHARED_KEYS.has('member_id')).toBe(false);
  });

  it('notes that the member ID is not shared by default, and nothing else', () => {
    expect(factNote('member_id')).toBe('Not shared by default.');
    expect(factNote('dob')).toBeUndefined();
  });

  it('labels every voice with its name and AssemblyAI’s documented accent', () => {
    for (const v of VOICES) expect(VOICE_LABELS[v]).toMatch(/^[A-Z][a-z]+ · [a-z]+, (US|UK)$/);
    expect(VOICE_LABELS.anna).toContain('UK');
    expect(VOICE_LABELS.vera).toContain('UK');
    expect(VOICE_LABELS.alba).toContain('US');
  });
});
