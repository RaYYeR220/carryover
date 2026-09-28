import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { AgentRegistry } from './aai/agentRegistry.js';
import { CaptionsStream } from './aai/captions.js';
import { VoiceAgentSession } from './aai/voiceAgent.js';
import { registerAppSocket } from './api/appSocket.js';
import { BODY_LIMIT_BYTES, IpRateLimiter } from './api/guards.js';
import { registerLineSocket } from './api/lineSocket.js';
import { registerMcp } from './api/mcp.js';
import type { ServerContext } from './api/routes.js';
import { registerRoutes } from './api/routes.js';
import { registerBrainRoute } from './brain/brainRoute.js';
import { CallRegistry } from './call/callRegistry.js';
import type { CallDeps } from './call/callSession.js';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { LineCodes } from './legs/lineCodes.js';
import { createProvider } from './llm/provider.js';

// The web app's build output, when present: served as a static SPA at '/', with a
// client-side-routing fallback to index.html (so /app/:id and /line/:code work on refresh).
const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));
const RESERVED_PREFIXES = ['/api', '/ws', '/brain', '/mcp', '/twilio'];
const SHUTDOWN_CAP_MS = 5000;

export interface CreateServerOptions {
  cfg?: Config;
  overrides?: Partial<CallDeps>;
}

export interface CreatedServer {
  app: FastifyInstance;
  registry: CallRegistry;
  lines: LineCodes;
  close(): Promise<void>;
}

function defaultCallDeps(cfg: Config): CallDeps {
  return {
    cfg,
    provider: createProvider(cfg),
    agents: new AgentRegistry(cfg),
    makeVoiceAgent: (agentId, onEvent, onClose) =>
      new VoiceAgentSession({
        apiKey: cfg.aaiKey,
        url: cfg.aaiAgentsWsUrl,
        agentId,
        onEvent,
        onClose,
      }),
    makeCaptions: (o) => new CaptionsStream(o),
  };
}

function withTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    p.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function createServer(opts: CreateServerOptions = {}): Promise<CreatedServer> {
  const cfg = opts.cfg ?? loadConfig();
  const app = Fastify({ bodyLimit: BODY_LIMIT_BYTES, logger: false });
  const registry = new CallRegistry();
  const lines = new LineCodes();
  const deps: CallDeps = { ...defaultCallDeps(cfg), ...opts.overrides };
  const limiter = new IpRateLimiter();
  const ctx: ServerContext = { cfg, registry, lines, deps, limiter };

  await app.register(fastifyWebsocket);

  registerBrainRoute(app, {
    cfg,
    provider: deps.provider,
    lookup: (callId) => registry.view(callId),
  });
  registerRoutes(app, ctx);
  registerAppSocket(app, { registry });
  registerLineSocket(app, { lines });
  registerMcp(app, ctx);

  const hasWebBuild = existsSync(WEB_DIST);
  if (hasWebBuild) {
    await app.register(fastifyStatic, { root: WEB_DIST, wildcard: false });
  }
  app.setNotFoundHandler((req, reply) => {
    const isPage = req.method === 'GET' && !RESERVED_PREFIXES.some((p) => req.url.startsWith(p));
    if (hasWebBuild && isPage) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'Not found.' });
  });

  await app.listen({ port: cfg.port, host: '0.0.0.0' });

  return {
    app,
    registry,
    lines,
    async close(): Promise<void> {
      // Every AAI session must be closed on every exit path; give the calls up to 5 s to do
      // that (CallSession itself caps the AAI/leg teardown at 5 s), then close regardless --
      // a slow summary must never hold up shutdown.
      await withTimeout(
        Promise.allSettled(registry.all().map((c) => c.end('server-shutdown'))),
        SHUTDOWN_CAP_MS,
      );
      await app.close();
    },
  };
}
