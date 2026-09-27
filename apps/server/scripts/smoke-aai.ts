// Live smoke test against the real AssemblyAI APIs. Not run in CI and not
// covered by the unit tests -- run it by hand after touching anything under
// src/aai or src/llm to confirm the wire shapes still match production.
//
// Usage (from apps/server, with the real keys loaded):
//   tsx --env-file=../../../.env scripts/smoke-aai.ts
//
// PUBLIC_BASE_URL can be any public https URL: the Voice Agent session here
// only ever sends silence, so the stored agent's Brain endpoint is configured
// but never actually called. BRAIN_SECRET can be any placeholder for the
// same reason. Both default below when unset so the script runs standalone.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRegistry } from '../src/aai/agentRegistry.js';
import { CaptionsStream } from '../src/aai/captions.js';
import { type VAEvent, VoiceAgentSession } from '../src/aai/voiceAgent.js';
import { dtmfMulaw } from '../src/audio/dtmf.js';
import { CHUNK_BYTES } from '../src/audio/pacer.js';
import { loadConfig } from '../src/config.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SILENCE_BYTE = 0xff; // mu-law "zero" sample
const CHUNK_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Real-time pace a buffer out in CHUNK_BYTES frames, one every CHUNK_MS.
async function sendPaced(buf: Buffer, send: (chunk: Buffer) => void): Promise<void> {
  for (let off = 0; off < buf.length; off += CHUNK_BYTES) {
    const end = Math.min(off + CHUNK_BYTES, buf.length);
    let chunk = buf.subarray(off, end);
    if (chunk.length < CHUNK_BYTES) {
      const padded = Buffer.alloc(CHUNK_BYTES, SILENCE_BYTE);
      chunk.copy(padded);
      chunk = padded;
    }
    send(Buffer.from(chunk));
    await sleep(CHUNK_MS);
  }
}

// Prefer real recorded audio from the day-0 spike (spikes/audio/*.ulaw8) when
// this checkout has it next to the public repo; fall back to a synthesized
// DTMF + silence clip so the script also runs on a checkout that only has
// the public repo.
function loadCaptionAudio(): Buffer {
  const spikeAudioDir = path.resolve(SCRIPT_DIR, '../../../../spikes/audio');
  try {
    const files = readdirSync(spikeAudioDir)
      .filter((f) => f.endsWith('.ulaw8'))
      .sort()
      .slice(0, 3);
    if (files.length > 0) {
      console.log(`[captions] using spike audio: ${files.join(', ')}`);
      const gap = Buffer.alloc(CHUNK_BYTES * 5, SILENCE_BYTE);
      const parts = files.flatMap((f) => [readFileSync(path.join(spikeAudioDir, f)), gap]);
      return Buffer.concat(parts);
    }
  } catch {
    // spikes/ isn't part of this checkout -- fall through to the synthesized clip.
  }
  console.log('[captions] spike audio not found, using a synthesized DTMF + silence clip');
  const lead = Buffer.alloc(CHUNK_BYTES * 5, SILENCE_BYTE);
  const tones = dtmfMulaw('1234', { toneMs: 200, gapMs: 100 });
  const trail = Buffer.alloc(CHUNK_BYTES * 5, SILENCE_BYTE);
  return Buffer.concat([lead, tones, trail]);
}

function countEvents(events: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) counts[e] = (counts[e] ?? 0) + 1;
  return counts;
}

async function withTimeout<T>(label: string, ms: number, p: Promise<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function runVoiceAgent(cfg: ReturnType<typeof loadConfig>, agentId: string): Promise<void> {
  console.log('\n=== Voice Agent session ===');
  const events: string[] = [];
  const va = new VoiceAgentSession({
    apiKey: cfg.aaiKey,
    url: cfg.aaiAgentsWsUrl,
    agentId,
    onEvent: (e: VAEvent) => {
      events.push(e.type);
      console.log(`[VA event] ${e.type}`);
    },
    onClose: (code, reason) =>
      console.log(`[VA close] code=${code} reason=${JSON.stringify(reason)}`),
  });

  try {
    await withTimeout('VoiceAgentSession.connect', 10_000, va.connect());
    console.log(`[VA] ready, session_id=${va.sessionId}`);

    const silence = Buffer.alloc(CHUNK_BYTES * 20, SILENCE_BYTE); // 2s of silence
    await sendPaced(silence, (chunk) => va.sendAudio(chunk));

    await withTimeout('VoiceAgentSession.end', 5_000, va.end());
    console.log('[VA] ended cleanly');
  } finally {
    console.log('[VA] event counts:', countEvents(events));
  }
}

async function runCaptions(cfg: ReturnType<typeof loadConfig>): Promise<void> {
  console.log('\n=== Captions stream (Universal-3.5 Pro) ===');
  const events: string[] = [];
  const captions = new CaptionsStream({
    apiKey: cfg.aaiKey,
    url: cfg.aaiStreamingUrl,
    keyterms: ['Carryover', 'relay assistant'],
    onTurn: (t) => {
      events.push(t.final ? 'Turn(final)' : 'Turn(partial)');
      console.log(
        `[captions Turn] order=${t.turnOrder} final=${t.final} speaker=${t.speaker ?? '-'} text=${JSON.stringify(t.text)}`,
      );
    },
    onSpeechStarted: (ts) => {
      events.push('SpeechStarted');
      console.log(`[captions SpeechStarted] ts=${ts}`);
    },
    onError: (e) => {
      events.push('Error');
      console.error(`[captions error] ${e.message}`);
    },
  });

  try {
    await withTimeout('CaptionsStream.connect', 10_000, captions.connect());
    console.log('[captions] connected');

    captions.setAgentContext('Automated phone relay smoke test.');
    captions.setKeyterms(['Carryover', 'relay assistant', 'smoke test']);

    const audio = loadCaptionAudio();
    await sendPaced(audio, (chunk) => captions.sendAudio(chunk));

    await withTimeout('CaptionsStream.close', 5_000, captions.close());
    console.log('[captions] terminated cleanly');
  } finally {
    console.log('[captions] event counts:', countEvents(events));
  }
}

async function main(): Promise<void> {
  const env = {
    ...process.env,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL ?? 'https://example.com',
    BRAIN_SECRET: process.env.BRAIN_SECRET ?? 'smoke-test-brain-secret',
  };
  const cfg = loadConfig(env);
  console.log(
    `config: provider=${cfg.llmProvider} model=${cfg.llmModel} publicBaseUrl=${cfg.publicBaseUrl}`,
  );

  const registry = new AgentRegistry(cfg);
  const agentId = await registry.ensureRelayAgent('anna', []);
  console.log(`[registry] relay agent id=${agentId}`);

  await runVoiceAgent(cfg, agentId);
  await runCaptions(cfg);

  // Best-effort cleanup of any agents from an older smoke-test naming scheme.
  // The relay agent created above stays (it's cached/reused by config hash).
  const deleted = await registry.deleteAll('carryover-smoke-');
  console.log(`\n[registry] deleted ${deleted} leftover carryover-smoke-* agent(s)`);

  console.log('\nsmoke test complete.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nsmoke test FAILED:', err);
    process.exit(1);
  });
