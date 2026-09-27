// Records the simulated businesses' phone-menu, hold and voicemail prompts once, with the
// Voice Agent API's own TTS, and saves them as μ-law 8 kHz files the scenario engine plays.
// Each prompt is one short inline Voice Agent session whose greeting is the prompt text
// (voice "vera", output audio/pcmu); the greeting audio is captured until reply.done.
//
// Usage (from apps/server, with the real key loaded):
//   tsx --env-file=../../../.env scripts/gen-ivr-assets.ts [--force] [--only=<asset>]
//
// Existing files are kept unless --force is given, so re-running only fills in new
// prompts. Also writes beep.ulaw (1 kHz, 400 ms).
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type VAEvent, VoiceAgentSession } from '../src/aai/voiceAgent.js';
import { decodeMulaw } from '../src/audio/mulaw.js';
import { CHUNK_BYTES } from '../src/audio/pacer.js';
import { BEEP_ASSET, beepMulaw } from '../src/scenarios/engine.js';
import { allPrompts } from '../src/scenarios/library/index.js';
import type { Prompt } from '../src/scenarios/types.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.resolve(SCRIPT_DIR, '../src/scenarios/assets');
const VOICE = 'vera';
const SESSION_TIMEOUT_MS = 30_000;
const PAUSE_BETWEEN_MS = 2500;
const SILENCE = 0xff;
const LEAD_MS = 80;
const TAIL_MS = 300;
const AUDIBLE = 600; // linear amplitude that counts as sound when trimming

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Trim the dead air TTS leaves around a clip, keeping a short natural lead and tail.
function trim(mu: Buffer): Buffer {
  const pcm = decodeMulaw(mu);
  let first = pcm.findIndex((s) => Math.abs(s) > AUDIBLE);
  if (first < 0) return mu;
  let last = pcm.length - 1;
  while (last > first && Math.abs(pcm[last] ?? 0) <= AUDIBLE) last--;
  first = Math.max(0, first - LEAD_MS * 8);
  last = Math.min(pcm.length, last + TAIL_MS * 8);
  return Buffer.from(mu.subarray(first, last));
}

async function speak(apiKey: string, prompt: Prompt): Promise<{ audio: Buffer; said: string }> {
  const chunks: Buffer[] = [];
  let said = '';
  let finished: (() => void) | undefined;
  let failed: ((e: Error) => void) | undefined;
  const done = new Promise<void>((resolve, reject) => {
    finished = resolve;
    failed = reject;
  });
  done.catch(() => undefined); // awaited below; this only keeps an early failure from going unhandled

  const va = new VoiceAgentSession({
    apiKey,
    initialSession: {
      system_prompt:
        'You are a recorded phone announcement. You never say anything except your greeting.',
      greeting: prompt.text,
      input: { format: { encoding: 'audio/pcmu' } },
      output: { voice: VOICE, format: { encoding: 'audio/pcmu' } },
    },
    onEvent: (e: VAEvent) => {
      if (e.type === 'reply.audio' && typeof e.data === 'string') {
        chunks.push(Buffer.from(e.data, 'base64'));
      } else if (e.type === 'transcript.agent' && typeof e.text === 'string') {
        said = e.text;
      } else if (e.type === 'reply.done') {
        finished?.();
      } else if (e.type === 'session.error') {
        failed?.(new Error(`session.error ${String(e.code)}: ${String(e.message)}`));
      }
    },
    onClose: (code, reason) => failed?.(new Error(`socket closed ${code} ${reason}`)),
  });

  let pumping = true;
  const timeout = setTimeout(
    () => failed?.(new Error('no reply.done in time')),
    SESSION_TIMEOUT_MS,
  );
  try {
    await va.connect();
    // Keep the input side alive with silence at real-time pace while the greeting plays.
    void (async () => {
      const silence = Buffer.alloc(CHUNK_BYTES, SILENCE);
      while (pumping) {
        va.sendAudio(silence);
        await sleep(100);
      }
    })();
    await done;
  } finally {
    pumping = false;
    clearTimeout(timeout);
    failed = undefined;
    await va.end();
  }
  return { audio: trim(Buffer.concat(chunks)), said };
}

async function main(): Promise<void> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) throw new Error('ASSEMBLYAI_API_KEY is not set');
  const force = process.argv.includes('--force');
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);
  mkdirSync(ASSET_DIR, { recursive: true });

  const beepPath = path.join(ASSET_DIR, `${BEEP_ASSET}.ulaw`);
  if (force || !existsSync(beepPath)) {
    writeFileSync(beepPath, beepMulaw());
    console.log(`wrote ${BEEP_ASSET}.ulaw (400 ms)`);
  }

  const prompts = allPrompts().filter((p) => !only || p.asset === only);
  let made = 0;
  for (const prompt of prompts) {
    const file = path.join(ASSET_DIR, `${prompt.asset}.ulaw`);
    if (!force && existsSync(file) && statSync(file).size > 0) {
      console.log(`skip ${prompt.asset} (exists)`);
      continue;
    }
    if (made > 0) await sleep(PAUSE_BETWEEN_MS);
    const { audio, said } = await speak(apiKey, prompt);
    if (audio.length < 8000)
      throw new Error(`${prompt.asset}: only ${audio.length} bytes of audio`);
    writeFileSync(file, audio);
    made++;
    console.log(
      `wrote ${prompt.asset}.ulaw  ${(audio.length / 8000).toFixed(2)} s  said: ${JSON.stringify(said)}`,
    );
  }
  console.log(`done: ${made} recorded, ${prompts.length - made} kept`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('gen-ivr-assets FAILED:', err);
    process.exit(1);
  });
