import { describe, expect, it } from 'vitest';
import { clientIp, IpRateLimiter } from '../../src/api/guards.js';

describe('clientIp', () => {
  it('prefers the first hop of x-forwarded-for', () => {
    const req = { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, ip: '127.0.0.1' };
    expect(clientIp(req)).toBe('1.2.3.4');
  });

  it('falls back to the socket ip without the header', () => {
    const req = { headers: {}, ip: '10.0.0.9' };
    expect(clientIp(req)).toBe('10.0.0.9');
  });

  it('ignores an array header by taking its first value', () => {
    const req = { headers: { 'x-forwarded-for': ['9.9.9.9', '1.1.1.1'] }, ip: '127.0.0.1' };
    expect(clientIp(req)).toBe('9.9.9.9');
  });
});

describe('IpRateLimiter', () => {
  it('allows up to the limit, then rejects', () => {
    const limiter = new IpRateLimiter({ limit: 3 });
    expect(limiter.check('a')).toBe(true);
    expect(limiter.check('a')).toBe(true);
    expect(limiter.check('a')).toBe(true);
    expect(limiter.check('a')).toBe(false);
  });

  it('tracks each ip independently', () => {
    const limiter = new IpRateLimiter({ limit: 1 });
    expect(limiter.check('a')).toBe(true);
    expect(limiter.check('b')).toBe(true);
    expect(limiter.check('a')).toBe(false);
    expect(limiter.check('b')).toBe(false);
  });

  it('forgets attempts once the window has passed', () => {
    let now = 0;
    const limiter = new IpRateLimiter({ limit: 1, windowMs: 1000, now: () => now });
    expect(limiter.check('a')).toBe(true);
    expect(limiter.check('a')).toBe(false);
    now = 1001;
    expect(limiter.check('a')).toBe(true);
  });
});
