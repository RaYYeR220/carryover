// Drives real simulated-business calls through the real server and scores them against
// hidden answer keys.
//
// In-process (default): starts a cloudflared quick tunnel (the Brain's URL must be
// reachable from AssemblyAI's servers), then createServer() with the real AAI clients and
// the real LLM provider. The scenario's ScenarioEngine trace/repTranscript are read
// straight out of the in-process CallRegistry, so ivr_success, pickup_alert_latency_ms,
// verbatim_heard_wer and caption_wer are all available.
//
// Remote (--base <url>): talks REST + WS only to an already-deployed server. No trace is
// available there, so those four metrics come back "n/a (remote)".
//
// Usage (from carryover/eval, with the repo's .env loaded):
//   tsx --env-file=../.env runner.ts --only=riverside-pharmacy
//   tsx --env-file=../.env runner.ts
//   tsx runner.ts --base https://carryover-r8ak.onrender.com --only=riverside-pharmacy
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  AppCommand,
  AppEvent,
  StartCallRequest,
  StartCallResponse,
  Voice,
} from '@carryover/protocol';
import WebSocket from 'ws';
import { disclosureText } from '../apps/server/src/call/callSession.js';
import { loadConfig } from '../apps/server/src/config.js';
import { ScenarioLeg } from '../apps/server/src/legs/scenarioLeg.js';
import { createServer } from '../apps/server/src/server.js';
import type { AnswerKey, QueuedUtterance, RunLog, ScenarioScore, TimedEvent } from './metrics.js';
import { scoreScenario } from './metrics.js';
import { UserBot } from './userBot.js';

const KEYS_DIR = fileURLToPath(new URL('./keys/', import.meta.url));
const RESULTS_DIR = fileURLToPath(new URL('./results/', import.meta.url));
const ALL_SCENARIOS = [
  'riverside-pharmacy',
  'lakeview-dental',
  'northstar-bank',
  'city-clinic-voicemail',
  'utility-outage',
];
const DEFAULT_VOICE = 'jane';
const TUNNEL_TIMEOUT_MS = 30_000;
const TUNNEL_REACHABLE_TIMEOUT_MS = 45_000;
const DEFAULT_CALL_TIMEOUT_MS = 150_000;
const SUMMARY_GRACE_MS = 8000;

interface Args {
  only?: string[];
  base?: string;
  voice: Voice;
  port: number;
  timeoutMs: number;
}

function parseArgs(argv: string[]): Args {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith('--')) continue;
    const key = a.slice(2);
    const eq = key.indexOf('=');
    if (eq >= 0) {
      out[key.slice(0, eq)] = key.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = 'true';
    }
  }
  return {
    only: out.only ? out.only.split(',').map((s) => s.trim()) : undefined,
    base: out.base,
    // The server itself validates this against the protocol's Voice allowlist on
    // POST /api/calls; a bad --voice CLI arg is a 400 from the server, not a crash here.
    voice: (out.voice ?? DEFAULT_VOICE) as Voice,
    port: out.port ? Number(out.port) : 8787,
    timeoutMs: out.timeout ? Number(out.timeout) : DEFAULT_CALL_TIMEOUT_MS,
  };
}

function loadKey(id: string): AnswerKey {
  const raw = readFileSync(new URL(`${id}.json`, `file://${KEYS_DIR}`), 'utf8');
  return JSON.parse(raw) as AnswerKey;
}

// ------------------------------------------------------------------ cloudflared

interface Tunnel {
  url: string;
  stop(): Promise<void>;
}

function startTunnel(port: number, log: (m: string) => void): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error('cloudflared: timed out waiting for a tunnel URL'));
    }, TUNNEL_TIMEOUT_MS);

    const onChunk = (buf: Buffer) => {
      const text = buf.toString('utf8');
      for (const line of text.split('\n')) if (line.trim()) log(`[cloudflared] ${line.trim()}`);
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          url: m[0],
          stop: () =>
            new Promise((res) => {
              proc.once('exit', () => res());
              proc.kill();
              setTimeout(res, 3000).unref?.();
            }),
        });
      }
    };
    proc.stdout.on('data', onChunk);
    proc.stderr.on('data', onChunk);
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`cloudflared exited early (code ${code})`));
    });
  });
}

// A fresh trycloudflare.com subdomain isn't always resolvable the instant cloudflared
// prints it (DNS still propagating) -- AssemblyAI's agent-registration call validates
// that the LLM base_url's host resolves, and fails a call started too soon with a 422.
// Poll the tunnel's own health endpoint until it actually answers before placing calls.
async function waitUntilReachable(
  url: string,
  timeoutMs: number,
  log: (m: string) => void,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        log(`tunnel reachable after ${attempt} attempt(s)`);
        return;
      }
    } catch {
      // not resolvable / reachable yet
    }
    if (Date.now() >= deadline) {
      log('tunnel reachability check timed out; proceeding anyway');
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// ------------------------------------------------------------------ one scenario run

interface RunContext {
  restBase: string; // for REST + WS control traffic (always local when in-process)
  key: AnswerKey;
  voice: Voice;
  timeoutMs: number;
  // Only set when running in-process: lets us pull the ScenarioEngine trace afterwards.
  lookupLeg?: (callId: string) => ScenarioLeg | undefined;
  log: (msg: string) => void;
}

function eventAt(e: AppEvent): number {
  return 'at' in e && typeof e.at === 'number' ? e.at : Date.now();
}

async function runScenario(ctx: RunContext): Promise<RunLog> {
  const { key } = ctx;
  const body: StartCallRequest = {
    target: { kind: 'scenario', scenarioId: key.scenarioId },
    userName: key.user.name,
    userDescriptor: key.user.descriptor,
    autonomy: key.autonomy,
    ...(key.goal ? { goal: key.goal } : {}),
    facts: key.consentedFacts,
    voice: ctx.voice,
  };

  const res = await fetch(`${ctx.restBase}/api/calls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `POST /api/calls failed for ${key.scenarioId}: ${res.status} ${await res.text()}`,
    );
  }
  const { callId, appToken } = (await res.json()) as StartCallResponse;
  ctx.log(`call started: callId=${callId}`);

  const wsBase = ctx.restBase.replace(/^http/, 'ws');
  const ws = new WebSocket(`${wsBase}/ws/app?callId=${callId}&token=${appToken}`);

  const events: TimedEvent[] = [];
  const queued: QueuedUtterance[] = [
    { kind: 'disclosure', text: disclosureText(key.user.name, key.user.descriptor) },
  ];

  const send = (cmd: AppCommand): void => {
    if (cmd.t === 'say' && cmd.text) queued.push({ kind: 'relay', text: cmd.text });
    else if (cmd.t === 'answer' && cmd.text) queued.push({ kind: 'relay', text: cmd.text });
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cmd));
  };
  const bot = new UserBot(key, { send, log: ctx.log });

  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    resolveDone();
  };

  ws.on('open', () => ctx.log('app socket open'));
  ws.on('message', (data) => {
    let e: AppEvent;
    try {
      e = JSON.parse(data.toString('utf8')) as AppEvent;
    } catch {
      return;
    }
    events.push({ at: eventAt(e), event: e });
    if (e.t === 'summary') finish();
    try {
      bot.onEvent(e);
    } catch (err) {
      ctx.log(`userBot error: ${errText(err)}`);
    }
  });
  ws.on('close', () => finish());
  ws.on('error', (err) => ctx.log(`ws error: ${errText(err)}`));

  const timeout = new Promise<void>((r) => setTimeout(r, ctx.timeoutMs));
  await Promise.race([done, timeout]);

  if (!finished) {
    ctx.log(`timed out after ${ctx.timeoutMs}ms -- sending hangup`);
    try {
      ws.send(JSON.stringify({ t: 'hangup' } satisfies AppCommand));
    } catch {
      // socket may already be gone
    }
    await Promise.race([done, new Promise((r) => setTimeout(r, SUMMARY_GRACE_MS))]);
  }

  bot.dispose();
  try {
    ws.close();
  } catch {
    // already closing
  }

  const leg = ctx.lookupLeg?.(callId);
  const trace = leg?.engine.trace;
  const repTranscript = leg?.engine.repTranscript;

  return { scenarioId: key.scenarioId, events, queued, trace, repTranscript };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ------------------------------------------------------------------ reporting

function fmtNum(n: number | string, digits = 0): string {
  return typeof n === 'number' ? n.toFixed(digits) : n;
}

function scorecardRow(s: ScenarioScore): string {
  const ivr = s.ivr.status === 'pass' ? 'pass' : s.ivr.status === 'fail' ? 'FAIL' : s.ivr.status;
  const latency = fmtNum(s.pickupAlertLatencyMs);
  const verb = `${s.verbatimExact.exact}/${s.verbatimExact.checked}`;
  const heardWer = fmtNum(s.verbatimHeardWer, 3);
  const capWer = fmtNum(s.captionWer, 3);
  const fab = s.fabrications.count === 0 ? '0' : `**${s.fabrications.count}**`;
  const neg =
    s.negativeControl.status === 'n/a' ? 'n/a' : s.negativeControl.pass ? 'pass' : '**FAIL**';
  const asks = `p=${fmtNum(s.asks.precision, 2)} r=${fmtNum(s.asks.recall, 2)}`;
  const transfer =
    s.transfer.expected || s.transfer.detected ? (s.transfer.pass ? 'pass' : '**FAIL**') : 'n/a';
  return `| ${s.scenarioId} | ${ivr} | ${latency} | ${verb} | ${heardWer} | ${capWer} | ${fab} | ${s.gateBlocks} | ${neg} | ${asks} | ${transfer} |`;
}

function toMarkdown(scores: ScenarioScore[], meta: { mode: string; startedAt: string }): string {
  const header =
    '| scenario | ivr_success | pickup_alert_ms | verbatim_exact | verbatim_heard_wer | caption_wer | fabrications | gate_blocks | negative_control | asks (p/r) | transfer |';
  const sep = '|---|---|---|---|---|---|---|---|---|---|---|';
  const rows = scores.map(scorecardRow);
  return [
    `# Carryover eval scorecard`,
    ``,
    `Mode: ${meta.mode}. Run started: ${meta.startedAt}.`,
    ``,
    header,
    sep,
    ...rows,
    ``,
  ].join('\n');
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ids = args.only && args.only.length > 0 ? args.only : ALL_SCENARIOS;
  for (const id of ids) {
    if (!ALL_SCENARIOS.includes(id)) throw new Error(`unknown scenario "${id}"`);
  }

  const log = (msg: string): void => console.log(`[eval] ${msg}`);

  let restBase: string;
  let lookupLeg: ((callId: string) => ScenarioLeg | undefined) | undefined;
  let tunnel: Tunnel | undefined;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;

  if (args.base) {
    restBase = args.base.replace(/\/$/, '');
    log(`remote mode: ${restBase} (no scenario trace available)`);
  } else {
    log(`starting cloudflared tunnel to http://localhost:${args.port} ...`);
    tunnel = await startTunnel(args.port, log);
    log(`tunnel ready: ${tunnel.url}`);
    process.env.PUBLIC_BASE_URL = tunnel.url;
    process.env.PORT = String(args.port);
    const cfg = loadConfig(process.env);
    server = await createServer({ cfg });
    restBase = `http://localhost:${args.port}`;
    lookupLeg = (callId) => {
      const session = server?.registry.get(callId);
      return session?.leg instanceof ScenarioLeg ? session.leg : undefined;
    };
    log(`server listening on ${restBase}, brain public URL ${tunnel.url}`);
    log('waiting for the tunnel to be externally reachable before placing calls...');
    await waitUntilReachable(tunnel.url, TUNNEL_REACHABLE_TIMEOUT_MS, log);
  }

  const scores: ScenarioScore[] = [];
  const logs: RunLog[] = [];
  try {
    for (const id of ids) {
      const key = loadKey(id);
      log(`--- ${id} ---`);
      const runLog = await runScenario({
        restBase,
        key,
        voice: args.voice,
        timeoutMs: args.timeoutMs,
        lookupLeg,
        log: (m) => log(`${id}: ${m}`),
      });
      logs.push(runLog);
      const score = scoreScenario(runLog, key);
      scores.push(score);
      log(
        `${id}: fabrications=${score.fabrications.count} gate_blocks=${score.gateBlocks} ivr=${score.ivr.status}`,
      );
    }
  } finally {
    if (server) await server.close();
    if (tunnel) await tunnel.stop();
  }

  const startedAt = new Date().toISOString();
  const md = toMarkdown(scores, {
    mode: args.base ? `remote (${restBase})` : 'in-process',
    startedAt,
  });
  console.log(`\n${md}`);

  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = startedAt.replace(/[:.]/g, '-');
  writeFileSync(
    new URL(`${stamp}.json`, `file://${RESULTS_DIR}`),
    JSON.stringify({ startedAt, mode: args.base ? 'remote' : 'in-process', scores, logs }, null, 2),
  );
  writeFileSync(new URL('latest.md', `file://${RESULTS_DIR}`), md);
  log(`results written to eval/results/${stamp}.json and eval/results/latest.md`);
}

main().catch((err: unknown) => {
  console.error('[eval] failed:', err);
  process.exitCode = 1;
});
