import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { type VAEvent, VoiceAgentSession } from '../../src/aai/voiceAgent.js';

interface FakeServer {
  wss: WebSocketServer;
  url: string;
  received: Record<string, unknown>[];
  authHeader: string | undefined;
  send: (obj: unknown) => void;
}

const openServers: WebSocketServer[] = [];
const openTcpServers: net.Server[] = [];
const openTcpSockets: net.Socket[] = [];

afterEach(async () => {
  // node's http.Server.close() (which ws uses under the hood for port:0 servers)
  // only stops accepting new connections -- it waits for existing ones to end
  // before firing its callback. Most tests here never close the client socket
  // themselves, so terminate any still-open clients or this would hang until
  // vitest's hook timeout on every run.
  await Promise.all(
    openServers.splice(0).map(
      (wss) =>
        new Promise<void>((r) => {
          for (const client of wss.clients) client.terminate();
          wss.close(() => r());
        }),
    ),
  );
  for (const s of openTcpSockets.splice(0)) {
    if (!s.destroyed) s.destroy();
  }
  await Promise.all(
    openTcpServers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

// A bare TCP listener that accepts the connection but never sends an HTTP
// upgrade response, so a WebSocket client connecting to it is stuck in
// CONNECTING forever -- exactly the stalled-handshake scenario the connect
// timeout exists for.
function startStallingServer(): Promise<{ url: string }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      openTcpSockets.push(socket);
    });
    openTcpServers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `ws://127.0.0.1:${port}` });
    });
  });
}

function startFakeServer(
  onMessage?: (msg: Record<string, unknown>, send: (o: unknown) => void) => void,
) {
  return new Promise<FakeServer>((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    openServers.push(wss);
    const state: FakeServer = {
      wss,
      url: '',
      received: [],
      authHeader: undefined,
      send: () => {},
    };
    wss.on('connection', (ws, req) => {
      state.authHeader = req.headers.authorization;
      state.send = (obj) => ws.send(JSON.stringify(obj));
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        state.received.push(msg);
        onMessage?.(msg, state.send);
      });
    });
    wss.on('listening', () => {
      const { port } = wss.address() as AddressInfo;
      state.url = `ws://127.0.0.1:${port}`;
      resolve(state);
    });
  });
}

function readySession(
  server: FakeServer,
  extra: Partial<import('../../src/aai/voiceAgent.js').VoiceAgentOptions> = {},
) {
  const events: VAEvent[] = [];
  const closes: { code: number; reason: string }[] = [];
  const session = new VoiceAgentSession({
    apiKey: 'test-key',
    url: server.url,
    agentId: 'agent_abc',
    onEvent: (e) => events.push(e),
    onClose: (code, reason) => closes.push({ code, reason }),
    ...extra,
  });
  return { session, events, closes };
}

describe('VoiceAgentSession', () => {
  it('throws unless exactly one of agentId / initialSession is given', () => {
    const onEvent = () => {};
    const onClose = () => {};
    expect(() => new VoiceAgentSession({ apiKey: 'k', onEvent, onClose })).toThrow();
    expect(
      () =>
        new VoiceAgentSession({
          apiKey: 'k',
          agentId: 'a',
          initialSession: {},
          onEvent,
          onClose,
        }),
    ).toThrow();
  });

  it('sends the stored-agent first message, authenticates with Bearer, and resolves on session.ready', async () => {
    const server = await startFakeServer((msg, send) => {
      if (msg.type === 'session.update') {
        send({ type: 'session.ready', session_id: 'sess_123' });
      }
    });
    const { session, events } = readySession(server);
    await session.connect();

    expect(session.sessionId).toBe('sess_123');
    expect(server.received[0]).toEqual({
      type: 'session.update',
      session: { agent_id: 'agent_abc' },
    });
    expect(server.authHeader).toBe('Bearer test-key');
    expect(events.some((e) => e.type === 'session.ready')).toBe(true);
  });

  it('sends an inline session.update when initialSession is given', async () => {
    const server = await startFakeServer((msg, send) => {
      if (msg.type === 'session.update') send({ type: 'session.ready', session_id: 'sess_inline' });
    });
    const inline = { system_prompt: 'hi', voice: { voice_id: 'anna' } };
    const { session } = readySession(server, { agentId: undefined, initialSession: inline });
    await session.connect();

    expect(server.received[0]).toEqual({ type: 'session.update', session: inline });
  });

  it('encodes sent audio as input.audio with base64 audio', async () => {
    const server = await startFakeServer((msg, send) => {
      if (msg.type === 'session.update') send({ type: 'session.ready', session_id: 's1' });
    });
    const { session } = readySession(server);
    await session.connect();

    const mu = Buffer.from([0x01, 0x02, 0x03]);
    session.sendAudio(mu);

    await waitFor(() => server.received.some((m) => m.type === 'input.audio'));
    const audioMsg = server.received.find((m) => m.type === 'input.audio');
    expect(audioMsg).toEqual({ type: 'input.audio', audio: mu.toString('base64') });
  });

  it('sends reply.create with instructions', async () => {
    const server = await startFakeServer((msg, send) => {
      if (msg.type === 'session.update') send({ type: 'session.ready', session_id: 's1' });
    });
    const { session } = readySession(server);
    await session.connect();

    session.replyCreate('say thanks');
    await waitFor(() => server.received.some((m) => m.type === 'reply.create'));
    expect(server.received.find((m) => m.type === 'reply.create')).toEqual({
      type: 'reply.create',
      instructions: 'say thanks',
    });
  });

  it('sends tool.result with a JSON-stringified result and defaults is_error to false', async () => {
    const server = await startFakeServer((msg, send) => {
      if (msg.type === 'session.update') send({ type: 'session.ready', session_id: 's1' });
    });
    const { session } = readySession(server);
    await session.connect();

    session.toolResult('call_1', { answer: 'ok' });
    await waitFor(() => server.received.some((m) => m.type === 'tool.result'));
    expect(server.received.find((m) => m.type === 'tool.result')).toEqual({
      type: 'tool.result',
      call_id: 'call_1',
      result: JSON.stringify({ answer: 'ok' }),
      is_error: false,
    });

    session.toolResult('call_2', { error: 'nope' }, true);
    await waitFor(() =>
      server.received.some((m) => m.type === 'tool.result' && m.call_id === 'call_2'),
    );
    expect(server.received.find((m) => m.type === 'tool.result' && m.call_id === 'call_2')).toEqual(
      {
        type: 'tool.result',
        call_id: 'call_2',
        result: JSON.stringify({ error: 'nope' }),
        is_error: true,
      },
    );
  });

  it('updateSession sends session.update with the given session object', async () => {
    let server!: FakeServer;
    server = await startFakeServer((msg, send) => {
      if (msg.type !== 'session.update') return;
      const updateCount = server.received.filter((m) => m.type === 'session.update').length;
      if (updateCount === 1) send({ type: 'session.ready', session_id: 's1' });
    });
    const { session } = readySession(server);
    await session.connect();

    session.updateSession({ system_prompt: 'updated' });
    await waitFor(() => server.received.filter((m) => m.type === 'session.update').length > 1);
    const updates = server.received.filter((m) => m.type === 'session.update');
    expect(updates[1]).toEqual({ type: 'session.update', session: { system_prompt: 'updated' } });
  });

  it('forwards every server event (e.g. tool.call) through onEvent', async () => {
    const server = await startFakeServer((msg, send) => {
      if (msg.type === 'session.update') send({ type: 'session.ready', session_id: 's1' });
    });
    const { session, events } = readySession(server);
    await session.connect();

    server.send({
      type: 'tool.call',
      call_id: 'call_1',
      name: 'get_weather',
      arguments: { city: 'X' },
    });
    await waitFor(() => events.some((e) => e.type === 'tool.call'));
    expect(events.find((e) => e.type === 'tool.call')).toMatchObject({ name: 'get_weather' });
  });

  it('end() sends session.end, waits for session.ended, then closes the socket', async () => {
    const server = await startFakeServer((msg, send) => {
      if (msg.type === 'session.update') send({ type: 'session.ready', session_id: 's1' });
      if (msg.type === 'session.end') {
        send({ type: 'session.ended', session_duration_seconds: 1, timestamp: Date.now() / 1000 });
      }
    });
    const { session, closes } = readySession(server);
    await session.connect();

    await session.end();

    expect(server.received.some((m) => m.type === 'session.end')).toBe(true);
    await waitFor(() => closes.length > 0);
    expect(closes[0]?.code).toBe(1000);
  });

  it('connect() rejects within the timeout and terminates the socket on a stalled handshake', async () => {
    const { url } = await startStallingServer();
    const closes: { code: number; reason: string }[] = [];
    const session = new VoiceAgentSession({
      apiKey: 'test-key',
      url,
      agentId: 'agent_abc',
      connectTimeoutMs: 50,
      onEvent: () => {},
      onClose: (code, reason) => closes.push({ code, reason }),
    });

    const started = Date.now();
    await expect(session.connect()).rejects.toThrow(/timed out/);
    // Well under the real 8s default -- proves the override actually applied
    // rather than the promise settling for some unrelated reason.
    expect(Date.now() - started).toBeLessThan(2000);

    // The underlying socket must actually be torn down, not just abandoned:
    // onClose is only ever invoked from the socket's own 'close' event.
    await waitFor(() => closes.length > 0);
  });

  it('end() on a still-connecting session resolves promptly and terminates the socket', async () => {
    const { url } = await startStallingServer();
    const closes: { code: number; reason: string }[] = [];
    const session = new VoiceAgentSession({
      apiKey: 'test-key',
      url,
      agentId: 'agent_abc',
      connectTimeoutMs: 2000, // long enough that end() -- not the timeout -- drives cleanup
      onEvent: () => {},
      onClose: (code, reason) => closes.push({ code, reason }),
    });

    const connectPromise = session.connect();
    connectPromise.catch(() => {});
    // Give the socket a moment to actually reach CONNECTING before ending.
    await new Promise((r) => setTimeout(r, 50));

    const started = Date.now();
    await session.end();
    expect(Date.now() - started).toBeLessThan(2000);

    await waitFor(() => closes.length > 0);
  });
});

describe('VoiceAgentSession.resume', () => {
  // Plays AAI: session.update → session.ready s1; session.resume of s1 → session.ready s1,
  // anything else → session.error session_not_found and a 1008 close.
  async function resumableServer(opts: { refuse?: boolean } = {}) {
    const sockets: import('ws').WebSocket[] = [];
    const server = await startFakeServer();
    server.wss.on('connection', (ws) => {
      sockets.push(ws);
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.type === 'session.update') {
          ws.send(JSON.stringify({ type: 'session.ready', session_id: 's1' }));
        }
        if (msg.type === 'session.resume') {
          if (!opts.refuse && msg.session_id === 's1') {
            ws.send(JSON.stringify({ type: 'session.ready', session_id: 's1' }));
          } else {
            ws.send(JSON.stringify({ type: 'session.error', code: 'session_not_found' }));
            ws.close(1008, 'session_not_found');
          }
        }
      });
    });
    return { server, sockets };
  }

  it('reconnects a dropped socket with session.resume and the previous session_id', async () => {
    const { server, sockets } = await resumableServer();
    const { session, events, closes } = readySession(server);
    await session.connect();
    expect(session.resumable).toBe(true);

    sockets[0]?.terminate(); // the network drops: no close frame, the client sees 1006
    await waitFor(() => closes.length === 1);
    expect(closes[0]?.code).toBe(1006);

    await session.resume();
    expect(server.received.at(-1)).toEqual({ type: 'session.resume', session_id: 's1' });
    expect(sockets).toHaveLength(2);
    expect(events.filter((e) => e.type === 'session.ready')).toHaveLength(2);

    // The new socket carries the session: audio and control messages go through it.
    session.replyCreate('RELAY_UTTERANCE:abc12345');
    await waitFor(() => server.received.some((m) => m.type === 'reply.create'));
  });

  it('rejects promptly when the server refuses the resume (session expired)', async () => {
    const { server, sockets } = await resumableServer({ refuse: true });
    const { session, closes } = readySession(server, { connectTimeoutMs: 5000 });
    await session.connect();
    sockets[0]?.terminate();
    await waitFor(() => closes.length === 1);

    const started = Date.now();
    await expect(session.resume()).rejects.toThrow(/closed \(1008\)/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('is not resumable after our end() or after the server ended the session', async () => {
    const ended = await resumableServer();
    const a = readySession(ended.server);
    await a.session.connect();
    await a.session.end();
    expect(a.session.resumable).toBe(false);
    await expect(a.session.resume()).rejects.toThrow(/ended/);

    const byServer = await startFakeServer((msg, send) => {
      if (msg.type === 'session.update') {
        send({ type: 'session.ready', session_id: 's2' });
        send({ type: 'session.ended', session_duration_seconds: 1 });
      }
    });
    const b = readySession(byServer);
    await b.session.connect();
    await waitFor(() => b.events.some((e) => e.type === 'session.ended'));
    expect(b.session.resumable).toBe(false);
  });
});

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
