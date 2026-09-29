import { describe, expect, it } from 'vitest';
import { defaultTrustProxy } from '../src/server.js';

describe('defaultTrustProxy', () => {
  it('maps "false", "0" and "off" to the boolean false, not the truthy string "false"', () => {
    expect(defaultTrustProxy({ TRUST_PROXY: 'false' })).toBe(false);
    expect(defaultTrustProxy({ TRUST_PROXY: '0' })).toBe(false);
    expect(defaultTrustProxy({ TRUST_PROXY: 'off' })).toBe(false);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(defaultTrustProxy({ TRUST_PROXY: 'FALSE' })).toBe(false);
    expect(defaultTrustProxy({ TRUST_PROXY: ' Off ' })).toBe(false);
    expect(defaultTrustProxy({ TRUST_PROXY: 'TRUE' })).toBe(true);
  });

  it('maps "true" to the boolean true', () => {
    expect(defaultTrustProxy({ TRUST_PROXY: 'true' })).toBe(true);
  });

  it('passes any other value straight through to Fastify (presets/CIDRs)', () => {
    expect(defaultTrustProxy({ TRUST_PROXY: 'loopback,uniquelocal' })).toBe('loopback,uniquelocal');
    expect(defaultTrustProxy({ TRUST_PROXY: '10.0.0.0/8' })).toBe('10.0.0.0/8');
  });

  it('defaults to false under vitest when TRUST_PROXY is unset', () => {
    expect(defaultTrustProxy({ VITEST: 'true' })).toBe(false);
  });

  it('defaults to the loopback/linklocal/uniquelocal preset outside of vitest', () => {
    expect(defaultTrustProxy({})).toBe('loopback,linklocal,uniquelocal');
  });

  it('treats an empty TRUST_PROXY as unset', () => {
    expect(defaultTrustProxy({ TRUST_PROXY: '', VITEST: 'true' })).toBe(false);
  });
});
