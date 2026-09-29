import type { AddressInfo } from 'node:net';
import type { StartCallRequest } from '@carryover/protocol';
import WebSocket from 'ws';
import type { Config } from '../../src/config.js';
import { createServer } from '../../src/server.js';
import { fakeCaptionsFactory } from '../fakes/fakeCaptions.js';
import { FakeProvider } from '../fakes/fakeProvider.js';
import { fakeVoiceAgentFactory } from '../fakes/fakeVoiceAgent.js';

export function cfg(overrides: Partial<Config> = {}): Config {
  return {
    aaiKey: 'aai-key',
    llmProvider: 'venice',
    llmModel: 'test-model',
    veniceKey: 'venice-key',
    publicBaseUrl: 'https://example.com',
    brainSecret: 'secret',
    port: 0,
    aaiStreamingUrl: 'wss://streaming.assemblyai.com/v3/ws',
    aaiAgentsWsUrl: 'wss://agents.assemblyai.com/v1/ws',
    aaiAgentsRestUrl: 'https://agents.assemblyai.com/v1',
    ...overrides,
  };
}

// Fast, network-free CallDeps: the relay side (agent lookup, Voice Agent, captions) all
// resolve immediately so CallSession.start() completes without touching AssemblyAI. Used
// as `overrides` for createServer() in every API test.
export function fakeDeps() {
  const va = fakeVoiceAgentFactory();
  const captions = fakeCaptionsFactory();
  const provider = new FakeProvider();
  const agents = { ensureRelayAgent: async () => 'agent_relay' };
  return {
    va,
    captions,
    provider,
    agents,
    overrides: {
      provider,
      agents,
      makeVoiceAgent: va.make,
      makeCaptions: captions.make,
    },
  };
}

export async function startTestServer(
  opts: { cfgOverrides?: Partial<Config>; webDist?: string | null } = {},
) {
  const deps = fakeDeps();
  const server = await createServer({
    cfg: cfg(opts.cfgOverrides),
    overrides: deps.overrides,
    webDist: opts.webDist,
  });
  const address = server.app.server.address() as AddressInfo;
  const httpBase = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  return { ...server, ...deps, httpBase, wsBase, port: address.port };
}

export function validCallRequest(overrides: Partial<StartCallRequest> = {}): StartCallRequest {
  return {
    target: { kind: 'scenario', scenarioId: 'riverside-pharmacy' },
    userName: 'Maya',
    userDescriptor: 'deaf',
    autonomy: 'assist',
    facts: [],
    voice: 'jane',
    ...overrides,
  };
}

export interface QueuedSocket {
  readonly ws: WebSocket;
  // Resolves with the next parsed-JSON text message. Messages that arrive before this is
  // called are queued, not dropped.
  next(): Promise<Record<string, unknown>>;
  waitClose(): Promise<{ code: number; reason: string }>;
  close(): Promise<void>;
}

// Connects and wraps the socket in a message queue that starts listening the instant the
// WebSocket object exists -- synchronously, in the same tick, before 'open' even fires.
// Waiting for 'open' and only then registering a 'message' listener (as a naive two-step
// helper would) loses any message the server sends immediately on connect: 'ws' can parse
// and emit 'message' for data that arrived in the same read as the handshake before a
// listener added on a later microtask turn ever attaches, and a plain EventEmitter drops
// events nobody was listening for.
export function connectSocket(url: string): Promise<QueuedSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue: Record<string, unknown>[] = [];
    const waiters: ((v: Record<string, unknown>) => void)[] = [];
    let closeInfo: { code: number; reason: string } | undefined;
    let closeWaiter: ((v: { code: number; reason: string }) => void) | undefined;

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      const waiter = waiters.shift();
      if (waiter) waiter(parsed);
      else queue.push(parsed);
    });
    ws.on('close', (code: number, reason: Buffer) => {
      closeInfo = { code, reason: reason.toString('utf8') };
      closeWaiter?.(closeInfo);
    });

    ws.once('open', () =>
      resolve({
        ws,
        next(): Promise<Record<string, unknown>> {
          const queued = queue.shift();
          if (queued) return Promise.resolve(queued);
          return new Promise((r) => waiters.push(r));
        },
        waitClose(): Promise<{ code: number; reason: string }> {
          if (closeInfo) return Promise.resolve(closeInfo);
          return new Promise((r) => {
            closeWaiter = r;
          });
        },
        close(): Promise<void> {
          return new Promise((res) => {
            if (ws.readyState === WebSocket.CLOSED) {
              res();
              return;
            }
            ws.once('close', () => res());
            ws.close();
          });
        },
      }),
    );
    ws.once('error', reject);
  });
}

// Waits for a socket to close without going through connectSocket's 'open' step first --
// for connections the server rejects before ever completing (e.g. a bad line code), where
// 'open' still fires (the WS handshake succeeds) shortly before the server-initiated close.
export function connectAndWaitClose(url: string): Promise<{ code: number; reason: string }> {
  return connectSocket(url).then((sock) => sock.waitClose());
}

// Opens the practice-line page socket for `code` and waits for its initial 'waiting'
// status. Attaching before the call is placed (rather than racing the two) matters: a
// status change sent while nobody is attached is not buffered for a later listener.
export async function openLineSocket(wsBase: string, code: string): Promise<QueuedSocket> {
  const sock = await connectSocket(`${wsBase}/ws/line/${code}`);
  const waiting = await sock.next();
  if (waiting.status !== 'waiting') throw new Error(`line ${code} was not waiting`);
  return sock;
}

// Drives an already-attached, waiting line socket through ringing -> answered -> connected,
// like a person tapping "answer" on their phone. Run this concurrently with whatever places
// the call (its listener is already registered from connectSocket, so no message is missed
// regardless of how fast the other side responds).
export async function answerLine(sock: QueuedSocket): Promise<QueuedSocket> {
  const ringing = await sock.next();
  if (ringing.status !== 'ringing') throw new Error('line did not ring');
  const connectedPromise = sock.next();
  sock.ws.send(JSON.stringify({ t: 'line.answer' }));
  const connected = await connectedPromise;
  if (connected.status !== 'connected') throw new Error('line did not connect');
  return sock;
}

export function closeSocket(sock: QueuedSocket): Promise<void> {
  return sock.close();
}
