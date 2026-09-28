import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  answerLine,
  closeSocket,
  openLineSocket,
  startTestServer,
  validCallRequest,
} from './helpers.js';

type Server = Awaited<ReturnType<typeof startTestServer>>;

async function connectClient(server: Server): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${server.httpBase}/mcp`));
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

function toolResult(res: CallToolResult): unknown {
  const first = res.content[0] as { type: string; text?: string } | undefined;
  if (!first?.text) throw new Error('tool returned no text content');
  return JSON.parse(first.text);
}

describe('MCP /mcp', () => {
  let server: Server | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await server?.close();
    server = undefined;
  });

  it('tools/list includes every relay tool', async () => {
    server = await startTestServer();
    client = await connectClient(server);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'answer_ask',
        'create_practice_line',
        'get_call',
        'hang_up',
        'list_scenarios',
        'place_call',
        'say',
      ].sort(),
    );
  });

  it('list_scenarios returns all 5 scenarios', async () => {
    server = await startTestServer();
    client = await connectClient(server);
    const res = await client.callTool({ name: 'list_scenarios', arguments: {} });
    expect(toolResult(res as CallToolResult)).toHaveLength(5);
  });

  it('create_practice_line returns a LineInfo with a QR code', async () => {
    server = await startTestServer();
    client = await connectClient(server);
    const res = await client.callTool({ name: 'create_practice_line', arguments: {} });
    const line = toolResult(res as CallToolResult) as { code: string; qrSvg: string };
    expect(line.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(line.qrSvg.startsWith('<svg')).toBe(true);
  });

  it('places a call, reads it back, says something, answers an ask, then hangs up', async () => {
    server = await startTestServer();
    client = await connectClient(server);

    const created = (await server.app.inject({ method: 'POST', url: '/api/lines' })).json();
    const opened = await openLineSocket(server.wsBase, created.code);
    const [lineWs, placeRes] = await Promise.all([
      answerLine(opened),
      client.callTool({
        name: 'place_call',
        arguments: validCallRequest({ target: { kind: 'line', code: created.code } }),
      }),
    ]);
    const placed = toolResult(placeRes as CallToolResult) as {
      callId: string;
      appToken: string;
      watchUrl: string;
    };
    expect(placed.callId).toBeTruthy();
    expect(placed.watchUrl).toBe(
      `https://example.com/app/${placed.callId}?token=${placed.appToken}`,
    );

    const getRes = await client.callTool({
      name: 'get_call',
      arguments: { callId: placed.callId, appToken: placed.appToken },
    });
    const view = toolResult(getRes as CallToolResult) as {
      state: string;
      transcript: unknown[];
      asks: unknown[];
    };
    expect(view.state).toBe('connecting');
    expect(view.transcript).toEqual([]);
    expect(view.asks).toEqual([]);

    const sayRes = await client.callTool({
      name: 'say',
      arguments: { callId: placed.callId, appToken: placed.appToken, text: 'Hello there' },
    });
    expect((sayRes as CallToolResult).isError).toBeFalsy();

    const session = server.registry.get(placed.callId);
    if (!session) throw new Error('call not found in registry');
    server.va.last.emit({
      type: 'tool.call',
      call_id: 'k1',
      name: 'ask_user',
      arguments: { question: 'What is your date of birth?' },
    });
    const [ask] = session.openAsks();
    expect(ask).toBeTruthy();

    const answerRes = await client.callTool({
      name: 'answer_ask',
      arguments: {
        callId: placed.callId,
        appToken: placed.appToken,
        askId: ask?.askId,
        text: 'June 1st, 1986',
      },
    });
    expect((answerRes as CallToolResult).isError).toBeFalsy();
    expect(session.openAsks()).toEqual([]);

    const hangupRes = await client.callTool({
      name: 'hang_up',
      arguments: { callId: placed.callId, appToken: placed.appToken },
    });
    expect((hangupRes as CallToolResult).isError).toBeFalsy();

    await closeSocket(lineWs);
  });

  it('get_call fails with an error result for a wrong appToken', async () => {
    server = await startTestServer();
    client = await connectClient(server);
    const created = (await server.app.inject({ method: 'POST', url: '/api/lines' })).json();
    const opened = await openLineSocket(server.wsBase, created.code);
    const [lineWs, placeRes] = await Promise.all([
      answerLine(opened),
      client.callTool({
        name: 'place_call',
        arguments: validCallRequest({ target: { kind: 'line', code: created.code } }),
      }),
    ]);
    const placed = toolResult(placeRes as CallToolResult) as { callId: string };

    const res = await client.callTool({
      name: 'get_call',
      arguments: { callId: placed.callId, appToken: 'wrong' },
    });
    expect((res as CallToolResult).isError).toBe(true);

    await closeSocket(lineWs);
  });

  it('place_call fails with an error result for an unknown line', async () => {
    server = await startTestServer();
    client = await connectClient(server);
    const res = await client.callTool({
      name: 'place_call',
      arguments: validCallRequest({ target: { kind: 'line', code: 'ZZZZZZ' } }),
    });
    expect((res as CallToolResult).isError).toBe(true);
  });
});
