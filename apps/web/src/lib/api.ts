import type {
  Autonomy,
  LineInfo,
  LineState,
  ScenarioInfo,
  StartCallRequest,
  StartCallResponse,
} from '@carryover/protocol';

/** A failed request. `status` is the HTTP status, or 0 when the server could not be reached. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface Health {
  ok: boolean;
  calls: number;
  provider: string;
  version: string;
}

/** `GET /api/lines/:code` returns the line without its QR code. */
export type LineStatusInfo = Omit<LineInfo, 'qrSvg'> & { qrSvg?: string };

/** `GET /api/calls/:id?token=` */
export interface CallStatus {
  state: LineState;
  autonomy: Autonomy;
  targetLabel: string;
  startedAt: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface ApiClient {
  health(o?: RequestOptions): Promise<Health>;
  scenarios(o?: RequestOptions): Promise<ScenarioInfo[]>;
  createLine(o?: RequestOptions): Promise<LineInfo>;
  getLine(code: string, o?: RequestOptions): Promise<LineStatusInfo>;
  startCall(req: StartCallRequest, o?: RequestOptions): Promise<StartCallResponse>;
  getCall(callId: string, token: string, o?: RequestOptions): Promise<CallStatus>;
}

export interface ApiConfig {
  /** Origin prefix, e.g. "https://carryover.app". Empty = same origin. */
  base?: string;
  fetch?: typeof fetch;
}

const NETWORK_MESSAGE = 'Can’t reach Carryover. Check your connection and try again.';

async function errorMessage(res: Response): Promise<string> {
  const fallback = `Request failed (${res.status})`;
  let text = '';
  try {
    text = await res.text();
  } catch {
    return fallback;
  }
  if (!text.trim()) return fallback;
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === 'object') {
      const o = body as { error?: unknown; message?: unknown };
      if (typeof o.error === 'string' && o.error) return o.error;
      if (typeof o.message === 'string' && o.message) return o.message;
    }
    return fallback;
  } catch {
    return text.trim().slice(0, 300);
  }
}

export function createApi(config: ApiConfig = {}): ApiClient {
  const base = (config.base ?? '').replace(/\/+$/, '');
  const doFetch: typeof fetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    o?: RequestOptions,
  ) {
    const init: RequestInit = {
      method,
      headers: { accept: 'application/json' },
      signal: o?.signal,
    };
    if (body !== undefined) {
      init.headers = { accept: 'application/json', 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, init);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new ApiError(0, NETWORK_MESSAGE);
    }
    if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
    try {
      return (await res.json()) as T;
    } catch {
      throw new ApiError(res.status, 'The server sent a response Carryover couldn’t read.');
    }
  }

  const seg = encodeURIComponent;
  return {
    health: (o) => request<Health>('GET', '/api/health', undefined, o),
    scenarios: (o) => request<ScenarioInfo[]>('GET', '/api/scenarios', undefined, o),
    createLine: (o) => request<LineInfo>('POST', '/api/lines', {}, o),
    getLine: (code, o) => request<LineStatusInfo>('GET', `/api/lines/${seg(code)}`, undefined, o),
    startCall: (req, o) => request<StartCallResponse>('POST', '/api/calls', req, o),
    getCall: (callId, token, o) =>
      request<CallStatus>('GET', `/api/calls/${seg(callId)}?token=${seg(token)}`, undefined, o),
  };
}

/** Same-origin client used by the app. */
export const api: ApiClient = createApi();

type Loc = Pick<Location, 'protocol' | 'host'>;
const here = (): Loc => window.location;

/** Absolute ws:// or wss:// URL for a same-origin socket path. */
export function wsUrl(path: string, loc: Loc = here()): string {
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}${path}`;
}

/** `WS /ws/app?callId=&token=` */
export function appSocketUrl(callId: string, token: string, loc: Loc = here()): string {
  const q = new URLSearchParams({ callId, token });
  return wsUrl(`/ws/app?${q.toString()}`, loc);
}

/** `WS /ws/line/:code` */
export function lineSocketUrl(code: string, loc: Loc = here()): string {
  return wsUrl(`/ws/line/${encodeURIComponent(code)}`, loc);
}
