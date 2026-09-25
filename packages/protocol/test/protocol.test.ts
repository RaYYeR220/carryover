import { describe, expect, it } from 'vitest';
import { AppCommand, CallTarget, StartCallRequest } from '../src/index.js';

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
});
