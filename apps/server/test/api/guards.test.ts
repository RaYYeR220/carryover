import { describe, expect, it } from 'vitest';
import { clientIp, IpRateLimiter } from '../../src/api/guards.js';

describe('clientIp', () => {
  it("is Fastify's own req.ip, not a hand-parsed header", () => {
    // req.ip is only ever X-Forwarded-For-derived when Fastify's trustProxy config (set in
    // server.ts from a trusted connection) says so; clientIp must not re-parse headers
    // itself, or a caller could bypass that trust decision. Coverage for the actual
    // trust-boundary behavior (spoofed XFF ignored/accepted depending on trustProxyHops)
    // lives in routes.test.ts and mcp.test.ts, against a real server.
    expect(clientIp({ ip: '10.0.0.9' })).toBe('10.0.0.9');
    // A header on the request object must have no effect -- clientIp only reads .ip.
    const withHeaders = { ip: '10.0.0.9', headers: { 'x-forwarded-for': '1.2.3.4' } };
    expect(clientIp(withHeaders)).toBe('10.0.0.9');
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

  it('evicts an ip once its whole window has expired, bounding memory', () => {
    let now = 0;
    const limiter = new IpRateLimiter({ limit: 1, windowMs: 1000, now: () => now });
    for (let i = 0; i < 500; i++) limiter.check(`ip-${i}`);
    expect(limiter.size).toBe(500);
    now = 2000; // every prior entry is now outside the window
    // A single check() call (for an unrelated ip) sweeps all of them, not just its own.
    limiter.check('someone-new');
    expect(limiter.size).toBe(1);
  });
});
