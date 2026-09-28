import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../../src/server.js';
import {
  answerLine,
  cfg,
  closeSocket,
  openLineSocket,
  startTestServer,
  validCallRequest,
} from './helpers.js';

type Server = Awaited<ReturnType<typeof startTestServer>>;

// A server whose relay agent lookup always fails: every call's start() rejects (502) right
// away, so it never occupies a concurrency slot -- only the rate limiter is exercised.
function createFailingServer(opts: { trustProxy?: string | false } = {}) {
  return createServer({
    cfg: cfg(),
    trustProxy: opts.trustProxy,
    overrides: {
      agents: {
        ensureRelayAgent: async () => {
          throw new Error('boom');
        },
      },
    },
  });
}

describe('REST API', () => {
  let server: Server | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('GET /api/health reports call count, provider, model and features', async () => {
    server = await startTestServer();
    const res = await server.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      calls: 0,
      provider: 'venice',
      model: 'test-model',
      features: { pstn: false, llmGateway: false },
    });
    expect(typeof res.json().version).toBe('string');
  });

  it('GET /api/health reports llmGateway when configured for aai-gateway', async () => {
    server = await startTestServer({
      cfgOverrides: { llmProvider: 'aai-gateway', llmModel: 'claude' },
    });
    const res = await server.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json().features).toMatchObject({ llmGateway: true });
  });

  it('GET /api/scenarios lists all 5 scenarios', async () => {
    server = await startTestServer();
    const res = await server.app.inject({ method: 'GET', url: '/api/scenarios' });
    expect(res.statusCode).toBe(200);
    const scenarios = res.json();
    expect(scenarios).toHaveLength(5);
    expect(scenarios[0]).toHaveProperty('id');
    expect(scenarios[0]).toHaveProperty('suggestedAutonomy');
  });

  it('POST /api/lines creates a waiting line with an SVG QR code', async () => {
    server = await startTestServer();
    const res = await server.app.inject({ method: 'POST', url: '/api/lines' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(body.url).toBe(`https://example.com/line/${body.code}`);
    expect(body.status).toBe('waiting');
    expect(body.qrSvg.startsWith('<svg')).toBe(true);
  });

  it('GET /api/lines/:code returns the line without a QR code', async () => {
    server = await startTestServer();
    const created = (await server.app.inject({ method: 'POST', url: '/api/lines' })).json();
    const res = await server.app.inject({ method: 'GET', url: `/api/lines/${created.code}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      code: created.code,
      url: created.url,
      status: 'waiting',
      qrSvg: '',
    });
  });

  it('GET /api/lines/:code 404s for an unknown code', async () => {
    server = await startTestServer();
    const res = await server.app.inject({ method: 'GET', url: '/api/lines/ZZZZZZ' });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/calls 400s on a body that fails validation', async () => {
    server = await startTestServer();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/calls',
      payload: { nope: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
  });

  it('POST /api/calls 400s when the line target does not exist', async () => {
    server = await startTestServer();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/calls',
      payload: validCallRequest({ target: { kind: 'line', code: 'ZZZZZZ' } }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
  });

  it('POST /api/calls 400s when the scenario target does not exist', async () => {
    server = await startTestServer();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/calls',
      payload: validCallRequest({ target: { kind: 'scenario', scenarioId: 'nope' } }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/calls 400s a pstn target as not configured', async () => {
    server = await startTestServer();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/calls',
      payload: validCallRequest({ target: { kind: 'pstn', number: '+15551234567' } }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('PSTN not configured');
  });

  it('POST /api/calls 400s when the line target is not waiting', async () => {
    server = await startTestServer();
    const created = (await server.app.inject({ method: 'POST', url: '/api/lines' })).json();
    const opened = await openLineSocket(server.wsBase, created.code);
    const [lineWs, callRes] = await Promise.all([
      answerLine(opened),
      server.app.inject({
        method: 'POST',
        url: '/api/calls',
        payload: validCallRequest({ target: { kind: 'line', code: created.code } }),
      }),
    ]);
    expect(callRes.statusCode).toBe(200);

    const again = await server.app.inject({
      method: 'POST',
      url: '/api/calls',
      payload: validCallRequest({ target: { kind: 'line', code: created.code } }),
    });
    expect(again.statusCode).toBe(400);

    await closeSocket(lineWs);
  });

  it('starts a call end-to-end against an answered line, and GET /api/calls/:id reports its state', async () => {
    server = await startTestServer();
    const created = (await server.app.inject({ method: 'POST', url: '/api/lines' })).json();
    const opened = await openLineSocket(server.wsBase, created.code);
    const [lineWs, callRes] = await Promise.all([
      answerLine(opened),
      server.app.inject({
        method: 'POST',
        url: '/api/calls',
        payload: validCallRequest({ target: { kind: 'line', code: created.code } }),
      }),
    ]);
    expect(callRes.statusCode).toBe(200);
    const { callId, appToken } = callRes.json();
    expect(typeof callId).toBe('string');
    expect(typeof appToken).toBe('string');

    const health = await server.app.inject({ method: 'GET', url: '/api/health' });
    expect(health.json().calls).toBe(1);

    const stateRes = await server.app.inject({
      method: 'GET',
      url: `/api/calls/${callId}?token=${appToken}`,
    });
    expect(stateRes.statusCode).toBe(200);
    expect(stateRes.json()).toMatchObject({
      autonomy: 'assist',
      targetLabel: `Practice line ${created.code}`,
    });
    expect(typeof stateRes.json().startedAt).toBe('number');

    const wrongToken = await server.app.inject({
      method: 'GET',
      url: `/api/calls/${callId}?token=wrong`,
    });
    expect(wrongToken.statusCode).toBe(404);

    await closeSocket(lineWs);
  });

  it('rejects the 4th concurrent call with 429', async () => {
    server = await startTestServer();
    const sockets: Awaited<ReturnType<typeof answerLine>>[] = [];
    for (let i = 0; i < 3; i++) {
      const created = (await server.app.inject({ method: 'POST', url: '/api/lines' })).json();
      const opened = await openLineSocket(server.wsBase, created.code);
      const [lineWs, callRes] = await Promise.all([
        answerLine(opened),
        server.app.inject({
          method: 'POST',
          url: '/api/calls',
          payload: validCallRequest({ target: { kind: 'line', code: created.code } }),
        }),
      ]);
      expect(callRes.statusCode).toBe(200);
      sockets.push(lineWs);
    }

    const fourth = (await server.app.inject({ method: 'POST', url: '/api/lines' })).json();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/calls',
      payload: validCallRequest({ target: { kind: 'line', code: fourth.code } }),
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBeTruthy();

    await Promise.all(sockets.map(closeSocket));
  });

  it('enforces a per-IP rate limit of 10 calls/hour', async () => {
    // A separate server whose relay agent lookup always fails: every call's start()
    // rejects (502) right away, so it never occupies a concurrency slot and this test
    // only exercises the rate limiter. Default trustProxy under vitest is off, so every
    // inject() call (no X-Forwarded-For sent) resolves to the same untrusted socket ip.
    const failing = await createFailingServer();
    try {
      for (let i = 0; i < 10; i++) {
        const res = await failing.app.inject({
          method: 'POST',
          url: '/api/calls',
          payload: validCallRequest(),
        });
        expect(res.statusCode).toBe(502);
      }
      const res = await failing.app.inject({
        method: 'POST',
        url: '/api/calls',
        payload: validCallRequest(),
      });
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toBeTruthy();
    } finally {
      await failing.close();
    }
  });

  it("behind a private-network proxy (e.g. Render's load balancer on a 10.x address), keys the rate limit on the proxy-appended rightmost X-Forwarded-For entry, not the spoofable leftmost one", async () => {
    const failing = await createFailingServer({ trustProxy: 'loopback,linklocal,uniquelocal' });
    try {
      for (let i = 0; i < 10; i++) {
        const res = await failing.app.inject({
          method: 'POST',
          url: '/api/calls',
          // The immediate peer is a private-range address (Render's load balancer, not
          // loopback), and a different "client" is claimed on every call -- but the
          // rightmost X-Forwarded-For entry (what a trusted proxy actually appends) stays
          // the same, so these must all count against one bucket.
          remoteAddress: '10.1.2.3',
          headers: { 'x-forwarded-for': `6.6.6.${i}, 203.0.113.9` },
          payload: validCallRequest(),
        });
        expect(res.statusCode).toBe(502);
      }
      const res = await failing.app.inject({
        method: 'POST',
        url: '/api/calls',
        remoteAddress: '10.1.2.3',
        headers: { 'x-forwarded-for': '6.6.6.99, 203.0.113.9' },
        payload: validCallRequest(),
      });
      expect(res.statusCode).toBe(429);
    } finally {
      await failing.close();
    }
  });

  it('gives two different real clients behind the same private-network proxy separate rate-limit buckets', async () => {
    const failing = await createFailingServer({ trustProxy: 'loopback,linklocal,uniquelocal' });
    try {
      const callAs = async (ip: string) =>
        failing.app.inject({
          method: 'POST',
          url: '/api/calls',
          remoteAddress: '10.1.2.3',
          headers: { 'x-forwarded-for': ip },
          payload: validCallRequest(),
        });
      for (let i = 0; i < 10; i++) {
        expect((await callAs('203.0.113.9')).statusCode).toBe(502);
      }
      // Client A's quota is used up, but client B (through the same proxy) is unaffected.
      expect((await callAs('203.0.113.9')).statusCode).toBe(429);
      expect((await callAs('198.51.100.7')).statusCode).toBe(502);
    } finally {
      await failing.close();
    }
  });

  it('without a trusted proxy, ignores X-Forwarded-For entirely for the rate limit', async () => {
    const failing = await createFailingServer({ trustProxy: false });
    try {
      for (let i = 0; i < 10; i++) {
        const res = await failing.app.inject({
          method: 'POST',
          url: '/api/calls',
          // A fresh, unique claimed IP every call -- with no trusted proxy this must be
          // ignored, or an attacker could reset their own quota by forging the header.
          headers: { 'x-forwarded-for': `${i}.${i}.${i}.${i}` },
          payload: validCallRequest(),
        });
        expect(res.statusCode).toBe(502);
      }
      const res = await failing.app.inject({
        method: 'POST',
        url: '/api/calls',
        headers: { 'x-forwarded-for': '255.255.255.255' },
        payload: validCallRequest(),
      });
      expect(res.statusCode).toBe(429);
    } finally {
      await failing.close();
    }
  });

  it('rejects a request body over 64 KB with 413, before it ever reaches validation', async () => {
    server = await startTestServer();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/calls',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(validCallRequest({ goal: 'x'.repeat(70 * 1024) })),
    });
    expect(res.statusCode).toBe(413);
  });

  it('serves a 404 JSON body for unknown routes when there is no web build', async () => {
    server = await startTestServer();
    const res = await server.app.inject({ method: 'GET', url: '/app/some-call-id' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBeTruthy();
  });
});
