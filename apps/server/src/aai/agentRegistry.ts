import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import type { ToolDef } from '../llm/provider.js';

export interface StoredAgentSpec {
  name: string;
  voice: string;
  systemPrompt: string;
  tools: ToolDef[];
  llm: { base_url: string; model: string; api_key: string };
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}

interface AgentListItem {
  id: string;
  name: string;
  deleted_at: string | null;
}

interface AgentListResponse {
  agents: AgentListItem[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

const RELAY_SYSTEM_PROMPT = 'Automated phone relay.';
const RELAY_LLM_MODEL = 'carryover-brain';
const PCMU_FORMAT = { format: { encoding: 'audio/pcmu' } };

export class AgentRegistry {
  private readonly cfg: Config;
  private readonly cache = new Map<string, string>();

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  async ensureRelayAgent(voice: string, tools: ToolDef[]): Promise<string> {
    const baseUrl = `${this.cfg.publicBaseUrl}/brain/v1`;
    const name = relayAgentName(voice, baseUrl, tools);

    const cached = this.cache.get(name);
    if (cached) return cached;

    const existing = await this.findByName(name);
    if (existing) {
      this.cache.set(name, existing);
      return existing;
    }

    const body: Record<string, unknown> = {
      name,
      system_prompt: RELAY_SYSTEM_PROMPT,
      voice: { voice_id: voice },
      input: PCMU_FORMAT,
      output: PCMU_FORMAT,
      tools,
      llm: [{ base_url: baseUrl, model: RELAY_LLM_MODEL, api_key: this.cfg.brainSecret }],
    };

    const res = await this.call('POST', '/agents', body);
    if (!res.ok) {
      throw new Error(`AgentRegistry: create agent failed (${res.status}): ${await safeText(res)}`);
    }
    const json = (await res.json()) as { id: string };
    this.cache.set(name, json.id);
    return json.id;
  }

  async deleteAll(prefix: string): Promise<number> {
    const list = await this.listAgents();
    const toDelete = list.filter((a) => a.name.startsWith(prefix) && !a.deleted_at);

    let deleted = 0;
    for (const agent of toDelete) {
      const res = await this.call('DELETE', `/agents/${agent.id}`);
      if (res.ok) {
        deleted++;
        for (const [name, id] of this.cache) {
          if (id === agent.id) this.cache.delete(name);
        }
      }
    }
    return deleted;
  }

  private async findByName(name: string): Promise<string | undefined> {
    const list = await this.listAgents();
    return list.find((a) => a.name === name && !a.deleted_at)?.id;
  }

  // The live endpoint wraps the page in { agents, has_more, response_metadata },
  // not a bare array -- follow next_cursor until has_more is false. A hard cap
  // keeps this from looping forever if the server's pagination ever misbehaves.
  private async listAgents(): Promise<AgentListItem[]> {
    const all: AgentListItem[] = [];
    let cursor: string | undefined;
    for (let pageCount = 0; pageCount < 50; pageCount++) {
      const path = cursor ? `/agents?cursor=${encodeURIComponent(cursor)}` : '/agents';
      const res = await this.call('GET', path);
      if (!res.ok) {
        throw new Error(
          `AgentRegistry: list agents failed (${res.status}): ${await safeText(res)}`,
        );
      }
      const data = (await res.json()) as AgentListResponse;
      all.push(...(data.agents ?? []));
      const nextCursor = data.response_metadata?.next_cursor;
      if (!data.has_more || !nextCursor) break;
      cursor = nextCursor;
    }
    return all;
  }

  private call(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.cfg.aaiAgentsRestUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.aaiKey}`,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
}

// cfgHash covers everything that changes the agent's behavior on a call (the
// Brain endpoint it talks to and the tool set) so a config change creates a
// fresh agent instead of silently reusing a stale one.
function relayAgentName(voice: string, baseUrl: string, tools: ToolDef[]): string {
  const hash = createHash('sha256')
    .update(JSON.stringify({ baseUrl, tools }))
    .digest('hex')
    .slice(0, 8);
  return `carryover-relay-${voice}-${hash}`;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
