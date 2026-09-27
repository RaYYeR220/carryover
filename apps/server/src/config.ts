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
}

const DEFAULT_MODEL: Record<Config['llmProvider'], string> = {
  venice: 'gemini-3-8-flash',
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
});

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
  };
}
