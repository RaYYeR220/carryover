import type { StartCallRequest } from '@carryover/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, appSocketUrl, createApi, lineSocketUrl, wsUrl } from '../../src/lib/api';

function fakeFetch(status: number, body: unknown, contentType = 'application/json') {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(status === 204 ? null : text, {
      status,
      headers: { 'content-type': contentType },
    });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const REQ: StartCallRequest = {
  target: { kind: 'scenario', scenarioId: 'riverside-pharmacy' },
  userName: 'Maya',
  userDescriptor: 'deaf',
  autonomy: 'assist',
  facts: [{ key: 'dob', label: 'Date of birth', value: 'March 14, 1952' }],
  voice: 'jane',
};

describe('api client', () => {
  it('GETs health and scenarios', async () => {
    const f = fakeFetch(200, { ok: true, calls: 1, provider: 'venice', version: '0.1.0' });
    const api = createApi({ fetch: f.fn });
    await expect(api.health()).resolves.toEqual({
      ok: true,
      calls: 1,
      provider: 'venice',
      version: '0.1.0',
    });
    expect(f.calls[0]?.url).toBe('/api/health');
    expect(f.calls[0]?.init?.method).toBe('GET');

    const g = fakeFetch(200, [{ id: 'riverside-pharmacy' }]);
    await createApi({ fetch: g.fn }).scenarios();
    expect(g.calls[0]?.url).toBe('/api/scenarios');
  });

  it('creates and reads practice lines', async () => {
    const f = fakeFetch(200, { code: 'ABC123', url: 'u', qrSvg: '<svg/>', status: 'waiting' });
    const api = createApi({ fetch: f.fn, base: 'https://h.example' });
    await api.createLine();
    expect(f.calls[0]?.url).toBe('https://h.example/api/lines');
    expect(f.calls[0]?.init?.method).toBe('POST');
    await api.getLine('AB/12');
    expect(f.calls[1]?.url).toBe('https://h.example/api/lines/AB%2F12');
  });

  it('POSTs a start-call request as JSON', async () => {
    const f = fakeFetch(200, { callId: 'c1', appToken: 't1' });
    const res = await createApi({ fetch: f.fn }).startCall(REQ);
    expect(res).toEqual({ callId: 'c1', appToken: 't1' });
    const init = f.calls[0]?.init;
    expect(f.calls[0]?.url).toBe('/api/calls');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual(REQ);
  });

  it('reads call status with the token in the query', async () => {
    const f = fakeFetch(200, {
      state: 'hold',
      autonomy: 'assist',
      targetLabel: 'Riverside',
      startedAt: 1,
    });
    await createApi({ fetch: f.fn }).getCall('c 1', 'tok&x');
    expect(f.calls[0]?.url).toBe('/api/calls/c%201?token=tok%26x');
  });

  it('throws ApiError with the server error message', async () => {
    const f = fakeFetch(429, { error: 'Too many calls from this address' });
    const err = await createApi({ fetch: f.fn })
      .startCall(REQ)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 429, message: 'Too many calls from this address' });
  });

  it('falls back to a plain-text body or a generic message', async () => {
    const t = fakeFetch(500, 'upstream broke', 'text/plain');
    await expect(createApi({ fetch: t.fn }).health()).rejects.toMatchObject({
      status: 500,
      message: 'upstream broke',
    });
    const e = fakeFetch(404, '', 'text/plain');
    await expect(createApi({ fetch: e.fn }).getLine('ZZZZZZ')).rejects.toMatchObject({
      status: 404,
      message: 'Request failed (404)',
    });
  });

  it('maps network failures and bad JSON to ApiError', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(createApi({ fetch: down }).health()).rejects.toMatchObject({
      status: 0,
      message: 'Can’t reach Carryover. Check your connection and try again.',
    });
    const bad = fakeFetch(200, 'not json', 'application/json');
    await expect(createApi({ fetch: bad.fn }).health()).rejects.toMatchObject({ status: 200 });
  });

  it('passes an abort signal through', async () => {
    const f = fakeFetch(200, []);
    const ac = new AbortController();
    await createApi({ fetch: f.fn }).scenarios({ signal: ac.signal });
    expect(f.calls[0]?.init?.signal).toBe(ac.signal);
  });
});

describe('websocket urls', () => {
  const http = { protocol: 'http:', host: 'localhost:5173' };
  const https = { protocol: 'https:', host: 'carryover.app' };

  it('maps the page origin to ws/wss', () => {
    expect(wsUrl('/ws/x', http)).toBe('ws://localhost:5173/ws/x');
    expect(wsUrl('/ws/x', https)).toBe('wss://carryover.app/ws/x');
  });

  it('builds the app and line socket paths', () => {
    expect(appSocketUrl('c/1', 't 2', https)).toBe(
      'wss://carryover.app/ws/app?callId=c%2F1&token=t+2',
    );
    expect(lineSocketUrl('ABC123', https)).toBe('wss://carryover.app/ws/line/ABC123');
  });
});
