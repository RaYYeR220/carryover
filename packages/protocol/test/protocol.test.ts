import { describe, expect, it } from 'vitest';
import { AppCommand, CallTarget, StartCallRequest, Voice } from '../src/index.js';

describe('protocol', () => {
  it('accepts a valid start request', () => {
    const r = StartCallRequest.safeParse({
      target: { kind: 'scenario', scenarioId: 'riverside-pharmacy' },
      userName: 'Maya',
      userDescriptor: 'deaf',
      autonomy: 'assist',
      facts: [{ key: 'dob', label: 'Date of birth', value: 'March 14, 1952' }],
      voice: 'alba',
    });
    expect(r.success).toBe(true);
  });
  it('rejects bad line codes and pstn numbers', () => {
    expect(CallTarget.safeParse({ kind: 'line', code: 'abc' }).success).toBe(false);
    expect(CallTarget.safeParse({ kind: 'pstn', number: '5551234' }).success).toBe(false);
  });
  it('rejects keypad junk', () => {
    expect(AppCommand.safeParse({ t: 'keys', digits: '12a' }).success).toBe(false);
  });
  it('only allows the 9 stored AssemblyAI voices', () => {
    expect(Voice.options).toEqual([
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
    const req = (voice: string) => ({
      target: { kind: 'scenario', scenarioId: 'riverside-pharmacy' },
      userName: 'Maya',
      userDescriptor: 'deaf',
      autonomy: 'assist',
      facts: [],
      voice,
    });
    expect(StartCallRequest.safeParse(req('mary')).success).toBe(true);
    expect(StartCallRequest.safeParse(req('some-other-voice')).success).toBe(false);
  });
});
