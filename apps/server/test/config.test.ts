import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const REQUIRED_ENV = {
  ASSEMBLYAI_API_KEY: 'aai-key',
  VENICE_API_KEY: 'venice-key',
  PUBLIC_BASE_URL: 'https://example.com',
  BRAIN_SECRET: 'brain-secret',
};

describe('loadConfig', () => {
  it('applies defaults: port 8787, provider venice, venice model', () => {
    const cfg = loadConfig(REQUIRED_ENV);
    expect(cfg.port).toBe(8787);
    expect(cfg.llmProvider).toBe('venice');
    expect(cfg.llmModel).toBe('gemini-3-5-flash-lite');
    expect(cfg.debug).toBe(false);
    expect(cfg.llmParams).toBeUndefined();
    expect(cfg.aaiKey).toBe('aai-key');
    expect(cfg.veniceKey).toBe('venice-key');
    expect(cfg.publicBaseUrl).toBe('https://example.com');
    expect(cfg.brainSecret).toBe('brain-secret');
    expect(cfg.aaiStreamingUrl).toBe('wss://streaming.assemblyai.com/v3/ws');
    expect(cfg.aaiAgentsWsUrl).toBe('wss://agents.assemblyai.com/v1/ws');
    expect(cfg.aaiAgentsRestUrl).toBe('https://agents.assemblyai.com/v1');
  });

  it('defaults the gateway model when LLM_PROVIDER=aai-gateway', () => {
    const cfg = loadConfig({ ...REQUIRED_ENV, LLM_PROVIDER: 'aai-gateway' });
    expect(cfg.llmProvider).toBe('aai-gateway');
    expect(cfg.llmModel).toBe('claude-sonnet-4-6');
  });

  it('lets LLM_MODEL override the provider default', () => {
    const cfg = loadConfig({ ...REQUIRED_ENV, LLM_MODEL: 'custom-model' });
    expect(cfg.llmModel).toBe('custom-model');
  });

  it('LOG_LEVEL=debug turns on timing lines', () => {
    expect(loadConfig({ ...REQUIRED_ENV, LOG_LEVEL: 'debug' }).debug).toBe(true);
    expect(loadConfig({ ...REQUIRED_ENV, LOG_LEVEL: 'info' }).debug).toBe(false);
  });

  it('LLM_PARAMS is a JSON object of extra LLM request params', () => {
    const cfg = loadConfig({ ...REQUIRED_ENV, LLM_PARAMS: '{"reasoning":{"enabled":false}}' });
    expect(cfg.llmParams).toEqual({ reasoning: { enabled: false } });
    expect(() => loadConfig({ ...REQUIRED_ENV, LLM_PARAMS: '[1]' })).toThrow(/LLM_PARAMS/);
    expect(() => loadConfig({ ...REQUIRED_ENV, LLM_PARAMS: '{oops' })).toThrow(/LLM_PARAMS/);
  });

  it('coerces PORT from a string', () => {
    const cfg = loadConfig({ ...REQUIRED_ENV, PORT: '9999' });
    expect(cfg.port).toBe(9999);
  });

  it('throws when ASSEMBLYAI_API_KEY is missing', () => {
    const { ASSEMBLYAI_API_KEY: _drop, ...rest } = REQUIRED_ENV;
    expect(() => loadConfig(rest)).toThrow();
  });

  it('throws when PUBLIC_BASE_URL is not a valid URL', () => {
    expect(() => loadConfig({ ...REQUIRED_ENV, PUBLIC_BASE_URL: 'not-a-url' })).toThrow();
  });

  it('throws when LLM_PROVIDER=venice and VENICE_API_KEY is missing', () => {
    const { VENICE_API_KEY: _drop, ...rest } = REQUIRED_ENV;
    expect(() => loadConfig(rest)).toThrow(/VENICE_API_KEY/);
  });

  it('does not require VENICE_API_KEY when LLM_PROVIDER=aai-gateway', () => {
    const { VENICE_API_KEY: _drop, ...rest } = REQUIRED_ENV;
    const cfg = loadConfig({ ...rest, LLM_PROVIDER: 'aai-gateway' });
    expect(cfg.veniceKey).toBeUndefined();
  });
});
