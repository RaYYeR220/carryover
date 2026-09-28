import type { FastifyRequest } from 'fastify';

// Demo guards shared by the REST API and the MCP server: a per-IP call quota and the
// request body ceiling passed to Fastify's constructor. Global call concurrency is not
// duplicated here -- it lives in CallRegistry, which already throws LimitError.

export const BODY_LIMIT_BYTES = 64 * 1024;
export const RATE_LIMIT_PER_HOUR = 10;
const WINDOW_MS = 60 * 60_000;

// The first hop in x-forwarded-for (set by a trusted proxy/tunnel in front of us), else the
// socket's own address.
export function clientIp(req: Pick<FastifyRequest, 'headers' | 'ip'>): string {
  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header[0] : header;
  const first = raw?.split(',')[0]?.trim();
  return first || req.ip;
}

// A sliding-window call quota per IP: at most `limit` calls in any trailing `windowMs`.
export class IpRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts: { limit?: number; windowMs?: number; now?: () => number } = {}) {
    this.limit = opts.limit ?? RATE_LIMIT_PER_HOUR;
    this.windowMs = opts.windowMs ?? WINDOW_MS;
    this.now = opts.now ?? Date.now;
  }

  // Records this attempt and returns whether it is allowed. A rejected attempt is not
  // counted again, so retrying at the same instant does not cost another slot.
  check(ip: string): boolean {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(ip) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(ip, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(ip, recent);
    return true;
  }
}
