import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../../src/aai/agentRegistry.js';
import type { Config } from '../../src/config.js';
import type { ToolDef } from '../../src/llm/provider.js';

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

interface RequestRecord {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  headers: IncomingHttpHeaders;
}

interface AgentRow {
  id: string;
  name: string;
  deleted_at: string | null;
}

interface FakeRest {
  url: string;
  requests: RequestRecord[];
  agents: AgentRow[];
}

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// A minimal in-memory stand-in for https://agents.assemblyai.com/v1: enough of
// POST /agents, GET /agents, and DELETE /agents/:id to exercise AgentRegistry
// without ever touching the network.
function startFakeRest(seed: AgentRow[] = []): Promise<FakeRest> {
  return new Promise((resolve) => {
    const state: FakeRest = { url: '', requests: [], agents: [...seed] };
    let nextId = 0;

    const s = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
        const path = req.url ?? '';
        const method = req.method ?? 'GET';
        state.requests.push({ method, path, body, headers: req.headers });

        if (method === 'POST' && path === '/agents') {
          const id = `agent_${++nextId}`;
          state.agents.push({ id, name: String(body?.name), deleted_at: null });
          json(res, 201, { id, ...body });
          return;
        }
        if (method === 'GET' && (path === '/agents' || path.startsWith('/agents?'))) {
          // Mirrors the live endpoint's actual response shape: a wrapped page,
          // not a bare array.
          json(res, 200, {
            agents: state.agents.map((a) => ({ id: a.id, name: a.name, deleted_at: a.deleted_at })),
            has_more: false,
            response_metadata: { next_cursor: '' },
          });
          return;
        }
        const deleteMatch = /^\/agents\/(.+)$/.exec(path);
        if (method === 'DELETE' && deleteMatch) {
          const agent = state.agents.find((a) => a.id === deleteMatch[1]);
          if (!agent) {
            json(res, 404, { detail: 'not found' });
            return;
          }
          agent.deleted_at = new Date().toISOString();
          res.writeHead(204);
          res.end();
          return;
        }
        json(res, 404, { detail: 'unhandled' });
      });
    });

    openServers.push(s);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      state.url = `http://127.0.0.1:${port}`;
      resolve(state);
    });
  });
}

function startFailingRest(status: number, detail: string): Promise<string> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      req.resume();
      req.on('end', () => json(res, status, { detail }));
    });
    openServers.push(s);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

// Two-page GET /agents, cursor-paginated, matching the live endpoint's shape.
function startPaginatedRest(): Promise<string> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/agents') {
        if (!url.searchParams.has('cursor')) {
          json(res, 200, {
            agents: [{ id: 'a1', name: 'carryover-smoke-1', deleted_at: null }],
            has_more: true,
            response_metadata: { next_cursor: 'page2' },
          });
          return;
        }
        json(res, 200, {
          agents: [{ id: 'a2', name: 'carryover-smoke-2', deleted_at: null }],
          has_more: false,
          response_metadata: { next_cursor: '' },
        });
        return;
      }
      const deleteMatch = /^\/agents\/(.+)$/.exec(url.pathname);
      if (req.method === 'DELETE' && deleteMatch) {
        res.writeHead(204);
        res.end();
        return;
      }
      json(res, 404, { detail: 'unhandled' });
    });
    openServers.push(s);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

const tools: ToolDef[] = [
  {
    type: 'function',
    name: 'ask_user',
    description: 'Ask the customer a question.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

describe('AgentRegistry.ensureRelayAgent', () => {
  it('creates a stored agent with the relay shape and returns its id', async () => {
    const rest = await startFakeRest();
    const registry = new AgentRegistry(
      baseConfig({
        aaiAgentsRestUrl: rest.url,
        publicBaseUrl: 'https://relay.example.com',
        brainSecret: 'brain-secret',
      }),
    );

    const id = await registry.ensureRelayAgent('anna', tools);
    expect(id).toBe('agent_1');

    const create = rest.requests.find((r) => r.method === 'POST' && r.path === '/agents');
    expect(create?.headers.authorization).toBe('Bearer aai-key');
    expect(create?.body).toEqual({
      name: expect.stringMatching(/^carryover-relay-anna-[0-9a-f]{8}$/),
      system_prompt: 'Automated phone relay.',
      voice: { voice_id: 'anna' },
      input: { format: { encoding: 'audio/pcmu' } },
      output: { format: { encoding: 'audio/pcmu' } },
      tools,
      llm: [
        {
          base_url: 'https://relay.example.com/brain/v1',
          model: 'carryover-brain',
          api_key: 'brain-secret',
        },
      ],
    });
    expect(create?.body?.greeting).toBeUndefined();
  });

  it('caches in memory and never re-requests for the same voice and tools', async () => {
    const rest = await startFakeRest();
    const registry = new AgentRegistry(baseConfig({ aaiAgentsRestUrl: rest.url }));

    const first = await registry.ensureRelayAgent('anna', tools);
    const second = await registry.ensureRelayAgent('anna', tools);

    expect(second).toBe(first);
    expect(rest.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    // Only the first call misses the in-memory cache and falls through to a
    // name lookup; the second is served from the cache with no request at all.
    expect(rest.requests.filter((r) => r.method === 'GET')).toHaveLength(1);
  });

  it('reuses an existing agent found by name instead of creating a duplicate', async () => {
    const rest = await startFakeRest();
    const firstId = await new AgentRegistry(
      baseConfig({ aaiAgentsRestUrl: rest.url }),
    ).ensureRelayAgent('anna', tools);
    rest.requests.length = 0;

    // A fresh registry (empty in-memory cache) must find the agent the first
    // one created, by name, instead of creating a duplicate.
    const secondId = await new AgentRegistry(
      baseConfig({ aaiAgentsRestUrl: rest.url }),
    ).ensureRelayAgent('anna', tools);

    expect(secondId).toBe(firstId);
    expect(rest.requests.some((r) => r.method === 'POST')).toBe(false);
    expect(rest.requests.some((r) => r.method === 'GET' && r.path === '/agents')).toBe(true);
  });

  it('creates a different agent when the voice or the tool set changes', async () => {
    const rest = await startFakeRest();
    const registry = new AgentRegistry(baseConfig({ aaiAgentsRestUrl: rest.url }));

    const anna = await registry.ensureRelayAgent('anna', tools);
    const george = await registry.ensureRelayAgent('george', tools);
    const noTools = await registry.ensureRelayAgent('anna', []);

    expect(new Set([anna, george, noTools]).size).toBe(3);
    expect(rest.requests.filter((r) => r.method === 'POST')).toHaveLength(3);
  });

  it('throws when the create request fails', async () => {
    const url = await startFailingRest(500, 'boom');
    const registry = new AgentRegistry(baseConfig({ aaiAgentsRestUrl: url }));

    await expect(registry.ensureRelayAgent('anna', tools)).rejects.toThrow(/500/);
  });
});

describe('AgentRegistry.deleteAll', () => {
  it('deletes only non-deleted agents matching the prefix and returns the count', async () => {
    const rest = await startFakeRest([
      { id: 'a1', name: 'carryover-smoke-1', deleted_at: null },
      { id: 'a2', name: 'carryover-smoke-2', deleted_at: null },
      { id: 'a3', name: 'carryover-smoke-3', deleted_at: '2020-01-01T00:00:00.000Z' },
      { id: 'a4', name: 'carryover-relay-anna-deadbeef', deleted_at: null },
    ]);
    const registry = new AgentRegistry(baseConfig({ aaiAgentsRestUrl: rest.url }));

    const deleted = await registry.deleteAll('carryover-smoke-');

    expect(deleted).toBe(2);
    const deletes = rest.requests.filter((r) => r.method === 'DELETE').map((r) => r.path);
    expect(new Set(deletes)).toEqual(new Set(['/agents/a1', '/agents/a2']));
    expect(rest.agents.find((a) => a.id === 'a4')?.deleted_at).toBeNull();
  });

  it('follows next_cursor across pages to find every matching agent', async () => {
    const url = await startPaginatedRest();
    const registry = new AgentRegistry(baseConfig({ aaiAgentsRestUrl: url }));

    const deleted = await registry.deleteAll('carryover-smoke-');

    expect(deleted).toBe(2);
  });
});
