import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type Autonomy,
  type CallTarget,
  type LineInfo,
  type LineState,
  type ScenarioInfo,
  StartCallRequest,
  type TranscriptEntry,
} from '@carryover/protocol';
import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import type { CallRegistry } from '../call/callRegistry.js';
import { LimitError } from '../call/callRegistry.js';
import type { CallDeps, CallSession, OpenAsk } from '../call/callSession.js';
import type { Config } from '../config.js';
import { BrowserLeg } from '../legs/browserLeg.js';
import type { LineCodes, LineHandle } from '../legs/lineCodes.js';
import type { PhoneLeg } from '../legs/phoneLeg.js';
import { ScenarioLeg } from '../legs/scenarioLeg.js';
import { getScenario, listScenarios } from '../scenarios/library/index.js';
import { clientIp, type IpRateLimiter } from './guards.js';

export interface ServerContext {
  cfg: Config;
  registry: CallRegistry;
  lines: LineCodes;
  deps: CallDeps;
  limiter: IpRateLimiter;
  // A single shared bucket (always checked with the key 'global'): caps total demo spend
  // across every caller, on top of each IP's own limiter above.
  globalLimiter: IpRateLimiter;
  lineLimiter: IpRateLimiter;
}

const GLOBAL_LIMIT_KEY = 'global';

export type StartCallResult =
  | { ok: true; callId: string; appToken: string }
  | { ok: false; status: 400 | 429 | 502; error: string };

export interface CallStateView {
  state: LineState;
  autonomy: Autonomy;
  targetLabel: string;
  startedAt: number;
  transcript: readonly TranscriptEntry[];
  asks: OpenAsk[];
}

const VERSION = readVersion();

function readVersion(): string {
  try {
    const url = new URL('../../package.json', import.meta.url);
    const raw = readFileSync(fileURLToPath(url), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function lineUrl(cfg: Config, code: string): string {
  return `${cfg.publicBaseUrl}/line/${code}`;
}

export async function lineInfo(
  cfg: Config,
  handle: LineHandle,
  withQr: boolean,
): Promise<LineInfo> {
  const url = lineUrl(cfg, handle.code);
  const qrSvg = withQr ? await QRCode.toString(url, { type: 'svg' }) : '';
  return { code: handle.code, url, qrSvg, status: handle.status };
}

export type CreateLineResult =
  | { ok: true; line: LineInfo }
  | { ok: false; status: 429; error: string };

// Shared by POST /api/lines and the MCP create_practice_line tool: an unlimited flood of
// line creations would evict everyone else's idle lines (LineCodes caps at 1000, evicting
// the oldest idle one past that).
export async function createLine(ctx: ServerContext, ip: string): Promise<CreateLineResult> {
  if (!ctx.lineLimiter.check(ip)) {
    return { ok: false, status: 429, error: 'Too many lines from this address. Try again later.' };
  }
  const handle = ctx.lines.create();
  return { ok: true, line: await lineInfo(ctx.cfg, handle, true) };
}

export async function getLine(ctx: ServerContext, code: string): Promise<LineInfo | undefined> {
  const handle = ctx.lines.get(code);
  if (!handle) return undefined;
  return lineInfo(ctx.cfg, handle, false);
}

type TargetResult = { ok: true; leg: PhoneLeg } | { ok: false; status: 400; error: string };

function resolveTarget(
  target: CallTarget,
  req: StartCallRequest,
  ctx: Pick<ServerContext, 'cfg' | 'lines'>,
): TargetResult {
  switch (target.kind) {
    case 'line': {
      const handle = ctx.lines.get(target.code);
      if (handle?.status !== 'waiting') {
        return { ok: false, status: 400, error: `Line ${target.code} is not available.` };
      }
      return { ok: true, leg: new BrowserLeg(handle, `${req.userName} (via Carryover)`) };
    }
    case 'scenario': {
      const scenario = getScenario(target.scenarioId);
      if (!scenario) {
        return { ok: false, status: 400, error: `Unknown scenario "${target.scenarioId}".` };
      }
      return {
        ok: true,
        leg: new ScenarioLeg(scenario, {
          apiKey: ctx.cfg.aaiKey,
          agentsWsUrl: ctx.cfg.aaiAgentsWsUrl,
          streamingUrl: ctx.cfg.aaiStreamingUrl,
        }),
      };
    }
    case 'pstn':
      return { ok: false, status: 400, error: 'PSTN not configured' };
  }
}

// Shared by POST /api/calls and the MCP place_call tool: validate, apply the demo guards,
// build the leg, and await the call actually starting.
export async function startCall(
  ctx: ServerContext,
  ip: string,
  body: unknown,
): Promise<StartCallResult> {
  const parsed = StartCallRequest.safeParse(body);
  if (!parsed.success) {
    return { ok: false, status: 400, error: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  }
  const req = parsed.data;

  const target = resolveTarget(req.target, req, ctx);
  if (!target.ok) return target;

  if (!ctx.limiter.check(ip)) {
    return { ok: false, status: 429, error: 'Too many calls from this address. Try again later.' };
  }
  if (!ctx.globalLimiter.check(GLOBAL_LIMIT_KEY)) {
    return {
      ok: false,
      status: 429,
      error: 'The demo is busy — try again in a few minutes.',
    };
  }

  let session: CallSession;
  try {
    session = ctx.registry.create(req, target.leg, ctx.deps);
  } catch (err) {
    if (err instanceof LimitError) return { ok: false, status: 429, error: err.message };
    throw err;
  }

  try {
    await session.start();
  } catch {
    return { ok: false, status: 502, error: 'Could not start the call' };
  }

  return { ok: true, callId: session.id, appToken: session.appToken };
}

export function authorize(
  ctx: Pick<ServerContext, 'registry'>,
  callId: string,
  token: string | undefined,
): CallSession | undefined {
  if (!token) return undefined;
  const session = ctx.registry.get(callId);
  if (!session?.verifyToken(token)) return undefined;
  return session;
}

export function callStateView(session: CallSession): CallStateView {
  return {
    state: session.lineState,
    autonomy: session.autonomy,
    targetLabel: session.targetLabel,
    startedAt: session.startedAt,
    transcript: session.transcript,
    asks: session.openAsks(),
  };
}

export function getCallState(
  ctx: Pick<ServerContext, 'registry'>,
  callId: string,
  token: string | undefined,
): CallStateView | undefined {
  const session = authorize(ctx, callId, token);
  return session ? callStateView(session) : undefined;
}

export function registerRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/health', async () => ({
    ok: true,
    calls: ctx.registry.liveCount(),
    provider: ctx.cfg.llmProvider,
    model: ctx.cfg.llmModel,
    version: VERSION,
    features: { pstn: false, llmGateway: ctx.cfg.llmProvider === 'aai-gateway' },
  }));

  app.get('/api/scenarios', async (): Promise<ScenarioInfo[]> => listScenarios());

  app.post('/api/lines', async (req, reply) => {
    const result = await createLine(ctx, clientIp(req));
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return result.line;
  });

  app.get<{ Params: { code: string } }>('/api/lines/:code', async (req, reply) => {
    const info = await getLine(ctx, req.params.code);
    if (!info) return reply.code(404).send({ error: 'Line not found.' });
    return info;
  });

  app.post('/api/calls', async (req, reply) => {
    const result = await startCall(ctx, clientIp(req), req.body);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return reply.send({ callId: result.callId, appToken: result.appToken });
  });

  app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    '/api/calls/:id',
    async (req, reply) => {
      const view = getCallState(ctx, req.params.id, req.query.token);
      if (!view) return reply.code(404).send({ error: 'Call not found.' });
      return {
        state: view.state,
        autonomy: view.autonomy,
        targetLabel: view.targetLabel,
        startedAt: view.startedAt,
      };
    },
  );
}
