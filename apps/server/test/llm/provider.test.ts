import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { createProvider, type StreamDelta, type ToolDef } from '../../src/llm/provider.js';

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    aaiKey: 'aai-key',
    llmProvider: 'venice',
    llmModel: 'test-model',
    veniceKey: 'venice-key',
    publicBaseUrl: 'https://example.com',
    brainSecret: 'brain-secret',
    port: 8787,
    aaiStreamingUrl: 'wss://streaming.assemblyai.com/v3/ws',
    aaiAgentsWsUrl: 'wss://agents.assemblyai.com/v1/ws',
    aaiAgentsRestUrl: 'https://agents.assemblyai.com/v1',
    ...overrides,
  };
}

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    const s = server;
    server = undefined;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

interface CapturedRequest {
  body: Record<string, unknown>;
  headers: IncomingHttpHeaders;
}

function sendSse(res: ServerResponse, events: unknown[]): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) {
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

function startFakeChatServer(
  handler: (req: CapturedRequest, res: ServerResponse) => void,
): Promise<string> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        handler({ body, headers: req.headers }, res);
      });
    });
    server = s;
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}/v1`);
    });
  });
}

describe('createProvider', () => {
  it('streamChat yields content chunks then a tool-call delta in order, and converts the flat tool schema to nested form', async () => {
    let captured: CapturedRequest | undefined;
    const url = await startFakeChatServer((req, res) => {
      captured = req;
      sendSse(res, [
        {
          id: 'c1',
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        },
        { id: 'c1', choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] },
        { id: 'c1', choices: [{ index: 0, delta: { content: ' there' }, finish_reason: null }] },
        { id: 'c1', choices: [{ index: 0, delta: { content: '!' }, finish_reason: null }] },
        {
          id: 'c1',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ]);
    });

    const provider = createProvider(baseConfig(), url);
    const tools: ToolDef[] = [
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get the current weather for a city.',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    ];

    const deltas: StreamDelta[] = [];
    for await (const delta of provider.streamChat(
      [{ role: 'user', content: 'weather in NYC?' }],
      tools,
    )) {
      deltas.push(delta);
    }

    expect(deltas).toEqual([
      { text: 'Hello' },
      { text: ' there' },
      { text: '!' },
      {
        toolCalls: [
          { index: 0, id: 'call_1', name: 'get_weather', argumentsDelta: '{"city":"NYC"}' },
        ],
      },
      { done: true },
    ]);

    expect(captured?.body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the current weather for a city.',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      },
    ]);
  });

  it('sends Bearer auth for venice and the raw key for aai-gateway', async () => {
    let veniceAuth: string | undefined;
    let gatewayAuth: string | undefined;

    const veniceUrl = await startFakeChatServer((req, res) => {
      veniceAuth = req.headers.authorization;
      sendSse(res, [
        { id: 'c1', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] },
      ]);
    });
    const veniceProvider = createProvider(baseConfig({ llmProvider: 'venice' }), veniceUrl);
    for await (const _ of veniceProvider.streamChat([{ role: 'user', content: 'hi' }])) {
      // drain
    }
    expect(veniceAuth).toBe('Bearer venice-key');

    const gatewayUrl = await startFakeChatServer((req, res) => {
      gatewayAuth = req.headers.authorization;
      sendSse(res, [
        { id: 'c1', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] },
      ]);
    });
    const gatewayProvider = createProvider(
      baseConfig({ llmProvider: 'aai-gateway', veniceKey: undefined }),
      gatewayUrl,
    );
    for await (const _ of gatewayProvider.streamChat([{ role: 'user', content: 'hi' }])) {
      // drain
    }
    expect(gatewayAuth).toBe('aai-key');
  });

  it('streamChat does not drop an empty-string content delta', async () => {
    const url = await startFakeChatServer((_req, res) => {
      sendSse(res, [
        { id: 'c1', choices: [{ index: 0, delta: { content: '' }, finish_reason: null }] },
        { id: 'c1', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
        { id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]);
    });

    const provider = createProvider(baseConfig(), url);
    const deltas: StreamDelta[] = [];
    for await (const delta of provider.streamChat([{ role: 'user', content: 'hi' }])) {
      deltas.push(delta);
    }

    expect(deltas).toEqual([{ text: '' }, { text: 'ok' }, { done: true }]);
  });

  it('complete() returns the non-streamed message content', async () => {
    const url = await startFakeChatServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'c1',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'the answer' },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    });

    const provider = createProvider(baseConfig(), url);
    const text = await provider.complete([{ role: 'user', content: 'question' }]);
    expect(text).toBe('the answer');
  });
});
