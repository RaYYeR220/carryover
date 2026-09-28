// Dev tool: starts a call over the REST API against a running server, then prints every
// AppEvent from the app WebSocket as it arrives, with elapsed time -- handy for watching a
// live run (IVR presses, hold, human pickup, disclosure, the rep conversation) without
// building the web app.
//
// Usage (from apps/server):
//   tsx scripts/watch-call.ts --scenario riverside-pharmacy --autonomy assist \
//     --name "Maya Chen" --dob "June 1st, 1986" [--base http://localhost:8787] [--voice jane]
//
//   tsx scripts/watch-call.ts --line ABC123 --autonomy relay --name "Alex"
//
// Ctrl+C sends a hangup command and closes the socket.
import type {
  AppEvent,
  Fact,
  StartCallRequest,
  StartCallResponse,
  UserDescriptor,
} from '@carryover/protocol';
import WebSocket from 'ws';

function parseArgs(argv: string[]): Record<string, string> {
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
  return out;
}

function elapsed(t0: number): string {
  return `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
}

function describe(e: AppEvent): string {
  switch (e.t) {
    case 'call.state':
      return `call.state  ${e.lineState} (autonomy=${e.autonomy}, target="${e.targetLabel}")`;
    case 'caption':
      return `caption     [${e.speaker.role}:${e.speaker.label}]${e.final ? '' : ' (partial)'} ${e.text}`;
    case 'agent.said':
      return `agent.said  (${e.source}${e.interrupted ? ', interrupted' : ''}) ${e.text}`;
    case 'relay.queued':
      return `relay.queued (${e.reason}) ${e.text}`;
    case 'relay.spoken':
      return `relay.spoken nonce=${e.nonce}`;
    case 'ask':
      return `ASK         [${e.askId}] ${e.from} asks: ${e.question}`;
    case 'ask.resolved':
      return `ask.resolved [${e.askId}] ${e.how}`;
    case 'alert':
      return `ALERT       (${e.kind}) ${e.message}`;
    case 'dtmf':
      return `dtmf        ${e.digits}`;
    case 'gate.blocked':
      return `GATE BLOCK  "${e.sentence}" -- ${e.reason}`;
    case 'commitment':
      return `commitment  ${e.commitment.text}${e.commitment.when ? ` (${e.commitment.when})` : ''}`;
    case 'summary':
      return `summary     ${e.summary.outcome}\n${e.summary.bullets.map((b) => `  - ${b}`).join('\n')}`;
    case 'error':
      return `ERROR       ${e.message}`;
    default:
      return JSON.stringify(e);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const base = (args.base ?? 'http://localhost:8787').replace(/\/$/, '');
  const scenarioId = args.scenario;
  const lineCode = args.line;
  if (!scenarioId && !lineCode) {
    throw new Error('pass --scenario <id> or --line <code>');
  }

  const facts: Fact[] = [];
  const name = args.name ?? 'Alex Rivera';
  facts.push({ key: 'full_name', label: 'Full name', value: name });
  if (args.dob) facts.push({ key: 'dob', label: 'Date of birth', value: args.dob });

  const body: StartCallRequest = {
    target: scenarioId ? { kind: 'scenario', scenarioId } : { kind: 'line', code: lineCode ?? '' },
    userName: name,
    userDescriptor: (args.descriptor as UserDescriptor | undefined) ?? 'deaf',
    autonomy: (args.autonomy as StartCallRequest['autonomy'] | undefined) ?? 'assist',
    ...(args.goal ? { goal: args.goal } : {}),
    facts,
    voice: args.voice ?? 'jane',
  };

  console.log(`POST ${base}/api/calls`);
  console.log(JSON.stringify(body, null, 2));
  const t0 = Date.now();
  const res = await fetch(`${base}/api/calls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`start call failed: ${res.status} ${await res.text()}`);
    process.exitCode = 1;
    return;
  }
  const { callId, appToken } = (await res.json()) as StartCallResponse;
  console.log(`[${elapsed(t0)}] call started: callId=${callId}`);

  const wsBase = base.replace(/^http/, 'ws');
  const ws = new WebSocket(`${wsBase}/ws/app?callId=${callId}&token=${appToken}`);

  ws.on('open', () => console.log(`[${elapsed(t0)}] app socket open`));
  ws.on('message', (data) => {
    let ev: AppEvent;
    try {
      ev = JSON.parse(data.toString('utf8')) as AppEvent;
    } catch {
      console.log(`[${elapsed(t0)}] (non-JSON message)`, data.toString('utf8'));
      return;
    }
    console.log(`[${elapsed(t0)}] ${describe(ev)}`);
  });
  ws.on('close', (code, reason) => {
    console.log(`[${elapsed(t0)}] app socket closed (${code} ${reason.toString('utf8')})`);
    // Setting exitCode (not calling exit()) lets Node flush stdout before the event loop
    // drains and the process actually exits -- exit() can truncate a piped tee mid-write.
    process.exitCode = 0;
  });
  ws.on('error', (err) => console.error(`[${elapsed(t0)}] ws error`, err));

  process.on('SIGINT', () => {
    console.log(`[${elapsed(t0)}] hanging up...`);
    try {
      ws.send(JSON.stringify({ t: 'hangup' }));
    } catch {
      // socket may already be gone
    }
    setTimeout(() => {
      process.exitCode = 0;
      ws.terminate();
    }, 1000);
  });
}

main().catch((err: unknown) => {
  console.error('watch-call failed:', err);
  process.exit(1);
});
