import type { FastifyRequest } from 'fastify';

// Demo guards shared by the REST API and the MCP server: a per-IP call quota and the
// request body ceiling passed to Fastify's constructor. Global call concurrency is not
// duplicated here -- it lives in CallRegistry, which already throws LimitError.

export const BODY_LIMIT_BYTES = 64 * 1024;
// ws's own default maxPayload is 100 MiB; without an explicit cap, one free line lets
// anyone stream 100 MB frames at the 512 MB demo instance until it falls over.
export const WS_MAX_PAYLOAD_BYTES = 64 * 1024;
export const RATE_LIMIT_PER_HOUR = 10;
// A handful of IPs could otherwise keep all MAX_CONCURRENT_CALLS slots busy around the
// clock; this caps total demo spend regardless of how the load is spread across callers.
export const GLOBAL_RATE_LIMIT_PER_HOUR = 40;
export const LINE_RATE_LIMIT_PER_HOUR = 30;
const WINDOW_MS = 60 * 60_000;

// Fastify's own req.ip, resolved with `trustProxy` awareness (see server.ts): it only reads
// X-Forwarded-For when the connection came through a peer we actually trust to have set it
// truthfully, and falls back to the raw socket address otherwise. A caller cannot get a
// fresh rate-limit bucket by forging the header on a connection we don't trust -- do not
// parse X-Forwarded-For by hand here, that reintroduces the spoof.
export function clientIp(req: Pick<FastifyRequest, 'ip'>): string {
  return req.ip;
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
    this.evictIdle(cutoff);

    const recent = (this.hits.get(ip) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(ip, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(ip, recent);
    return true;
  }

  // Distinct IPs currently tracked -- test-only introspection for the eviction behavior.
  get size(): number {
    return this.hits.size;
  }

  // Bounds memory on a long-lived server: an IP whose whole window has expired (it has not
  // called again since) is forgotten instead of sitting in the map forever.
  private evictIdle(cutoff: number): void {
    for (const [ip, timestamps] of this.hits) {
      const last = timestamps[timestamps.length - 1];
      if (last === undefined || last <= cutoff) this.hits.delete(ip);
    }
  }
}
