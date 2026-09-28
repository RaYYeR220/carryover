import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type { Config } from '../config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

// AAI's flat tool schema, shared with the Voice Agent stored-agent config.
export interface ToolDef {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface StreamDelta {
  text?: string;
  toolCalls?: { index: number; id?: string; name?: string; argumentsDelta?: string }[];
  done?: boolean;
}

export interface LlmProvider {
  streamChat(
    messages: ChatMessage[],
    tools?: ToolDef[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamDelta>;
  complete(messages: ChatMessage[], opts?: { json?: boolean }): Promise<string>;
}

const PROVIDER_BASE_URL: Record<Config['llmProvider'], string> = {
  venice: 'https://api.venice.ai/api/v1',
  'aai-gateway': 'https://llm-gateway.assemblyai.com/v1',
};

type Params = Record<string, unknown>;

function isPlainObject(v: unknown): v is Params {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Venice prepends its own system prompt to every request unless told not to: extra
// tokens and a second voice in a prompt that has to follow strict rules.
const VENICE_BASE_PARAMS: Params = { venice_parameters: { include_venice_system_prompt: false } };

// Per-model request params (merged over the base). A reasoning model thinks before its
// first token, which on a live call is dead air: scripts/bench-brain.ts measured these
// with reasoning off at ~0.6-0.7 s to the first token, against 1.3-2.2 s with it on.
const REASONING_OFF: Params = { reasoning: { enabled: false } };
const VENICE_MODEL_PARAMS: Record<string, Params> = {
  'openai-gpt-54-mini': REASONING_OFF,
  'deepseek-v4-1-flash': REASONING_OFF,
  'mercury-2-5': REASONING_OFF,
  'gemini-3-5-flash-lite': { venice_parameters: { disable_thinking: true } },
};

// The request params every LLM call on this provider/model carries, besides model,
// messages, stream and tools. cfg.llmParams (LLM_PARAMS) wins, merged one level deep so
// {"venice_parameters":{...}} adds to the defaults instead of replacing them.
export function llmParams(cfg: Pick<Config, 'llmProvider' | 'llmModel' | 'llmParams'>): Params {
  const layers: Params[] =
    cfg.llmProvider === 'venice'
      ? [VENICE_BASE_PARAMS, VENICE_MODEL_PARAMS[cfg.llmModel] ?? {}, cfg.llmParams ?? {}]
      : [cfg.llmParams ?? {}];
  const out: Params = {};
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer)) {
      const prev = out[k];
      out[k] = isPlainObject(prev) && isPlainObject(v) ? { ...prev, ...v } : v;
    }
  }
  return out;
}

export function toOpenAiTools(tools: ToolDef[] | undefined): ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function toChunkDelta(chunk: ChatCompletionChunk): StreamDelta | null {
  const choice = chunk.choices[0];
  if (!choice) return null;
  const delta = choice.delta;
  const out: StreamDelta = {};
  if (delta?.content !== undefined && delta?.content !== null) out.text = delta.content;
  if (delta?.tool_calls && delta.tool_calls.length > 0) {
    out.toolCalls = delta.tool_calls.map((tc) => ({
      index: tc.index,
      id: tc.id,
      name: tc.function?.name,
      argumentsDelta: tc.function?.arguments,
    }));
  }
  if (choice.finish_reason) out.done = true;
  if (out.text === undefined && out.toolCalls === undefined && !out.done) return null;
  return out;
}

function makeClient(cfg: Config, baseURL: string): OpenAI {
  if (cfg.llmProvider === 'aai-gateway') {
    // AAI's REST/gateway auth is the raw key, not "Bearer <key>" -- override the
    // SDK's default Authorization header via defaultHeaders (which wins the merge).
    return new OpenAI({
      baseURL,
      apiKey: cfg.aaiKey,
      defaultHeaders: { Authorization: cfg.aaiKey },
    });
  }
  return new OpenAI({ baseURL, apiKey: cfg.veniceKey ?? '' });
}

export function createProvider(cfg: Config, baseUrlOverride?: string): LlmProvider {
  const baseURL = baseUrlOverride ?? PROVIDER_BASE_URL[cfg.llmProvider];
  const openai = makeClient(cfg, baseURL);
  const extra = llmParams(cfg);

  return {
    async *streamChat(messages, tools, signal) {
      const toolParams = toOpenAiTools(tools);
      const stream = await openai.chat.completions.create(
        {
          ...extra,
          model: cfg.llmModel,
          stream: true,
          messages: messages as unknown as ChatCompletionMessageParam[],
          ...(toolParams ? { tools: toolParams } : {}),
        },
        { signal },
      );
      for await (const chunk of stream) {
        const delta = toChunkDelta(chunk);
        if (delta) yield delta;
      }
    },

    async complete(messages, opts) {
      const res = await openai.chat.completions.create({
        ...extra,
        model: cfg.llmModel,
        stream: false,
        messages: messages as unknown as ChatCompletionMessageParam[],
        ...(opts?.json ? { response_format: { type: 'json_object' as const } } : {}),
      });
      return res.choices[0]?.message?.content ?? '';
    },
  };
}

// Best-effort startup check: warn (never throw) if the configured model id isn't
// in the provider's published /models list. Never called from tests.
export async function warnIfModelUnavailable(
  cfg: Config,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const baseURL = PROVIDER_BASE_URL[cfg.llmProvider];
  const key = cfg.llmProvider === 'aai-gateway' ? cfg.aaiKey : (cfg.veniceKey ?? '');
  const authHeader = cfg.llmProvider === 'aai-gateway' ? key : `Bearer ${key}`;
  try {
    const res = await fetchImpl(`${baseURL}/models`, {
      headers: { Authorization: authHeader },
    });
    if (!res.ok) return;
    const body = (await res.json()) as { data?: { id: string }[] };
    const ids = new Set((body.data ?? []).map((m) => m.id));
    if (!ids.has(cfg.llmModel)) {
      console.warn(
        `[llm] model "${cfg.llmModel}" was not found in ${cfg.llmProvider}'s /models list`,
      );
    }
  } catch {
    // Best effort only -- never block startup on a models-list lookup.
  }
}
