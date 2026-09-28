import { StartCallRequest } from '@carryover/protocol';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listScenarios } from '../scenarios/library/index.js';
import { clientIp } from './guards.js';
import type { ServerContext } from './routes.js';
import { authorize, createLine, getCallState, startCall } from './routes.js';

// ALL /mcp -- MCP Streamable HTTP server. Stateless: every request gets a fresh McpServer /
// transport pair (torn down on response close), so tool calls carry their own callId +
// appToken instead of relying on a session. Same guards as the REST API: place_call runs
// through the same startCall() as POST /api/calls.

function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

function fail(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true as const };
}

const CallAuth = { callId: z.string(), appToken: z.string() };

export function registerMcp(app: FastifyInstance, ctx: ServerContext): void {
  app.all('/mcp', async (req, reply) => {
    const server = buildMcpServer(ctx, clientIp(req));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    reply.raw.on('close', () => {
      // A rejection here must never become an unhandled rejection: one aborted MCP
      // request closing badly must not take the whole server down.
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
}

function buildMcpServer(ctx: ServerContext, ip: string): McpServer {
  const server = new McpServer({ name: 'carryover', version: '0.1.0' });

  server.registerTool(
    'list_scenarios',
    { description: 'List the simulated business scenarios available to call.' },
    async () => ok(listScenarios()),
  );

  server.registerTool(
    'create_practice_line',
    {
      description:
        'Create a practice line (a QR code / short code) a person can answer on their phone.',
    },
    async () => ok(await createLine(ctx)),
  );

  server.registerTool(
    'place_call',
    {
      description: 'Start a relay call to a line, a simulated scenario, or a phone number (PSTN).',
      inputSchema: StartCallRequest.shape,
    },
    async (args) => {
      const result = await startCall(ctx, ip, args);
      if (!result.ok) return fail(result.error);
      const watchUrl = `${ctx.cfg.publicBaseUrl}/app/${result.callId}?token=${result.appToken}`;
      return ok({ callId: result.callId, appToken: result.appToken, watchUrl });
    },
  );

  server.registerTool(
    'get_call',
    {
      description: "Get a call's state, its last 30 transcript entries and any open asks.",
      inputSchema: CallAuth,
    },
    async ({ callId, appToken }) => {
      const view = getCallState(ctx, callId, appToken);
      if (!view) return fail('Call not found.');
      return ok({
        state: view.state,
        autonomy: view.autonomy,
        targetLabel: view.targetLabel,
        startedAt: view.startedAt,
        transcript: view.transcript.slice(-30),
        asks: view.asks,
      });
    },
  );

  server.registerTool(
    'answer_ask',
    {
      description: 'Answer an open question the other party asked.',
      inputSchema: { ...CallAuth, askId: z.string(), text: z.string().max(500) },
    },
    async ({ callId, appToken, askId, text }) => {
      const session = authorize(ctx, callId, appToken);
      if (!session) return fail('Call not found.');
      session.handleCommand({ t: 'answer', askId, text });
      return ok({ ok: true });
    },
  );

  server.registerTool(
    'say',
    {
      description: 'Say something on the call, on behalf of the user.',
      inputSchema: { ...CallAuth, text: z.string().max(2000) },
    },
    async ({ callId, appToken, text }) => {
      const session = authorize(ctx, callId, appToken);
      if (!session) return fail('Call not found.');
      session.handleCommand({ t: 'say', text });
      return ok({ ok: true });
    },
  );

  server.registerTool(
    'hang_up',
    { description: 'End the call.', inputSchema: CallAuth },
    async ({ callId, appToken }) => {
      const session = authorize(ctx, callId, appToken);
      if (!session) return fail('Call not found.');
      session.handleCommand({ t: 'hangup' });
      return ok({ ok: true });
    },
  );

  return server;
}
