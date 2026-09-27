import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { CaptionsStream } from '../../src/aai/captions.js';

interface FakeServer {
  wss: WebSocketServer;
  url: string;
  requestUrl: string | undefined;
  authHeader: string | undefined;
  jsonReceived: Record<string, unknown>[];
  binaryReceived: Buffer[];
  send: (obj: unknown) => void;
}

const openServers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map((wss) => new Promise<void>((r) => wss.close(() => r()))),
  );
});

function startFakeServer() {
  return new Promise<FakeServer>((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    openServers.push(wss);
    const state: FakeServer = {
      wss,
      url: '',
      requestUrl: undefined,
      authHeader: undefined,
      jsonReceived: [],
      binaryReceived: [],
      send: () => {},
    };
    wss.on('connection', (ws, req) => {
      state.requestUrl = req.url;
      state.authHeader = req.headers.authorization;
      state.send = (obj) => ws.send(JSON.stringify(obj));
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          state.binaryReceived.push(Buffer.from(data as Buffer));
          return;
        }
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        state.jsonReceived.push(msg);
        // Auto-ack Terminate so close() doesn't have to wait out its fallback timer.
        if (msg.type === 'Terminate') state.send({ type: 'Termination' });
      });
    });
    wss.on('listening', () => {
      const { port } = wss.address() as AddressInfo;
      state.url = `ws://127.0.0.1:${port}`;
      resolve(state);
    });
  });
}

function makeStream(
  server: FakeServer,
  extra: Partial<import('../../src/aai/captions.js').CaptionsOptions> = {},
) {
  const turns: import('../../src/aai/captions.js').CaptionTurn[] = [];
  const speechStarted: number[] = [];
  const errors: Error[] = [];
  const stream = new CaptionsStream({
    apiKey: 'raw-key',
    url: server.url,
    keyterms: ['Maria Gonzalez', 'Walgreens'],
    onTurn: (t) => turns.push(t),
    onSpeechStarted: (ts) => speechStarted.push(ts),
    onError: (e) => errors.push(e),
    ...extra,
  });
  return { stream, turns, speechStarted, errors };
}

describe('CaptionsStream', () => {
  it('connects with raw-key auth and the expected query params', async () => {
    const server = await startFakeServer();
    const { stream } = makeStream(server);
    await stream.connect();

    expect(server.authHeader).toBe('raw-key');
    const params = new URLSearchParams(server.requestUrl?.split('?')[1]);
    expect(params.get('speech_model')).toBe('universal-3-5-pro');
    expect(params.get('encoding')).toBe('pcm_mulaw');
    expect(params.get('sample_rate')).toBe('8000');
    expect(params.get('speaker_labels')).toBe('true');
    expect(params.get('max_speakers')).toBe('4');
    expect(params.get('continuous_partials')).toBe('true');
    expect(params.get('voice_focus')).toBe('near-field');
    expect(JSON.parse(params.get('keyterms_prompt') ?? '[]')).toEqual([
      'Maria Gonzalez',
      'Walgreens',
    ]);

    await stream.close();
  });

  it('sends audio as binary frames', async () => {
    const server = await startFakeServer();
    const { stream } = makeStream(server);
    await stream.connect();

    const mu = Buffer.alloc(800, 0xff);
    stream.sendAudio(mu);
    await waitFor(() => server.binaryReceived.length > 0);
    expect(server.binaryReceived[0]).toEqual(mu);

    await stream.close();
  });

  it('emits onTurn for Turn messages, mapping speaker_label and words', async () => {
    const server = await startFakeServer();
    const { stream, turns } = makeStream(server);
    await stream.connect();

    server.send({
      type: 'Turn',
      turn_order: 3,
      end_of_turn: true,
      transcript: 'Her name is Maria.',
      speaker_label: 'A',
      words: [
        { text: 'Her', start: 100, end: 200, confidence: 0.98, speaker: 'A' },
        { text: 'name', start: 200, end: 300, confidence: 0.95, speaker: 'A' },
      ],
    });
    await waitFor(() => turns.length > 0);

    expect(turns[0]).toEqual({
      turnOrder: 3,
      text: 'Her name is Maria.',
      final: true,
      speaker: 'A',
      words: [
        { text: 'Her', confidence: 0.98, start: 100, end: 200, speaker: 'A' },
        { text: 'name', confidence: 0.95, start: 200, end: 300, speaker: 'A' },
      ],
    });

    await stream.close();
  });

  it('marks partial turns as not final', async () => {
    const server = await startFakeServer();
    const { stream, turns } = makeStream(server);
    await stream.connect();

    server.send({
      type: 'Turn',
      turn_order: 1,
      end_of_turn: false,
      transcript: 'Her na',
      words: [],
    });
    await waitFor(() => turns.length > 0);
    expect(turns[0]?.final).toBe(false);

    await stream.close();
  });

  it('calls onSpeechStarted for SpeechStarted events', async () => {
    const server = await startFakeServer();
    const { stream, speechStarted } = makeStream(server);
    await stream.connect();

    server.send({ type: 'SpeechStarted', timestamp: 1234, confidence: 0.9 });
    await waitFor(() => speechStarted.length > 0);
    expect(speechStarted[0]).toBe(1234);

    await stream.close();
  });

  it('calls onError for Error events', async () => {
    const server = await startFakeServer();
    const { stream, errors } = makeStream(server);
    await stream.connect();

    server.send({ type: 'Error', error_code: 3006, error: 'bad param' });
    await waitFor(() => errors.length > 0);
    expect(errors[0]?.message).toBe('bad param');

    await stream.close();
  });

  it('setAgentContext sends UpdateConfiguration with agent_context', async () => {
    const server = await startFakeServer();
    const { stream } = makeStream(server);
    await stream.connect();

    stream.setAgentContext('Can you spell that?');
    await waitFor(() => server.jsonReceived.length > 0);
    expect(server.jsonReceived[0]).toEqual({
      type: 'UpdateConfiguration',
      agent_context: 'Can you spell that?',
    });

    await stream.close();
  });

  it('setKeyterms sends UpdateConfiguration with keyterms_prompt', async () => {
    const server = await startFakeServer();
    const { stream } = makeStream(server);
    await stream.connect();

    stream.setKeyterms(['lisinopril']);
    await waitFor(() => server.jsonReceived.length > 0);
    expect(server.jsonReceived[0]).toEqual({
      type: 'UpdateConfiguration',
      keyterms_prompt: ['lisinopril'],
    });

    await stream.close();
  });

  it('close() sends Terminate before closing', async () => {
    const server = await startFakeServer();
    const { stream } = makeStream(server);
    await stream.connect();

    await stream.close();
    expect(server.jsonReceived.some((m) => m.type === 'Terminate')).toBe(true);
  });
});

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
