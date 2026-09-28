import { z } from 'zod';

export interface Config {
  aaiKey: string;
  llmProvider: 'venice' | 'aai-gateway';
  llmModel: string;
  veniceKey?: string;
  publicBaseUrl: string;
  brainSecret: string;
  port: number;
  aaiStreamingUrl: string;
  aaiAgentsWsUrl: string;
  aaiAgentsRestUrl: string;
  // LOG_LEVEL=debug: structured timing lines on stderr (src/debugLog.ts).
  debug?: boolean;
  // LLM_PARAMS: extra JSON body params for every LLM request, merged over the provider's
  // per-model defaults (e.g. {"reasoning":{"enabled":false}}).
  llmParams?: Record<string, unknown>;
}

const DEFAULT_MODEL: Record<Config['llmProvider'], string> = {
  // Fastest Venice model that handled every Brain benchmark turn (scripts/bench-brain.ts):
  // ~0.8 s to the first token with thinking off (see VENICE_MODEL_PARAMS in llm/provider.ts).
  venice: 'gemini-3-5-flash-lite',
  'aai-gateway': 'claude-sonnet-4-6',
};

const AAI_STREAMING_URL = 'wss://streaming.assemblyai.com/v3/ws';
const AAI_AGENTS_WS_URL = 'wss://agents.assemblyai.com/v1/ws';
const AAI_AGENTS_REST_URL = 'https://agents.assemblyai.com/v1';

const envSchema = z.object({
  ASSEMBLYAI_API_KEY: z.string().min(1, 'ASSEMBLYAI_API_KEY is required'),
  VENICE_API_KEY: z.string().min(1).optional(),
  LLM_PROVIDER: z.enum(['venice', 'aai-gateway']).optional(),
  LLM_MODEL: z.string().min(1).optional(),
  PUBLIC_BASE_URL: z.string().url('PUBLIC_BASE_URL must be a valid URL'),
  BRAIN_SECRET: z.string().min(1, 'BRAIN_SECRET is required'),
  PORT: z.coerce.number().int().positive().optional(),
  LOG_LEVEL: z.string().optional(),
  LLM_PARAMS: z.string().optional(),
});

function parseLlmParams(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error('LLM_PARAMS must be a JSON object');
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error('LLM_PARAMS must be a JSON object');
  }
  return v as Record<string, unknown>;
}

// Empty-string env vars (unset in the shell but present as "" in some launchers)
// should behave like "not set", not like an invalid value.
function orUndef(v: string | undefined): string | undefined {
  return v === undefined || v === '' ? undefined : v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse({
    ASSEMBLYAI_API_KEY: orUndef(env.ASSEMBLYAI_API_KEY),
    VENICE_API_KEY: orUndef(env.VENICE_API_KEY),
    LLM_PROVIDER: orUndef(env.LLM_PROVIDER),
    LLM_MODEL: orUndef(env.LLM_MODEL),
    PUBLIC_BASE_URL: orUndef(env.PUBLIC_BASE_URL),
    BRAIN_SECRET: orUndef(env.BRAIN_SECRET),
    PORT: orUndef(env.PORT),
    LOG_LEVEL: orUndef(env.LOG_LEVEL),
    LLM_PARAMS: orUndef(env.LLM_PARAMS),
  });

  const llmProvider = parsed.LLM_PROVIDER ?? 'venice';
  if (llmProvider === 'venice' && !parsed.VENICE_API_KEY) {
    throw new Error('VENICE_API_KEY is required when LLM_PROVIDER=venice');
  }

  return {
    aaiKey: parsed.ASSEMBLYAI_API_KEY,
    llmProvider,
    llmModel: parsed.LLM_MODEL ?? DEFAULT_MODEL[llmProvider],
    veniceKey: parsed.VENICE_API_KEY,
    publicBaseUrl: parsed.PUBLIC_BASE_URL,
    brainSecret: parsed.BRAIN_SECRET,
    port: parsed.PORT ?? 8787,
    aaiStreamingUrl: AAI_STREAMING_URL,
    aaiAgentsWsUrl: AAI_AGENTS_WS_URL,
    aaiAgentsRestUrl: AAI_AGENTS_REST_URL,
    debug: parsed.LOG_LEVEL === 'debug',
    llmParams: parseLlmParams(parsed.LLM_PARAMS),
  };
}
