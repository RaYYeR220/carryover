import { afterEach, describe, expect, it } from 'vitest';
import type { CallDeps } from '../../src/call/callSession.js';
import { FakeLeg } from '../fakes/fakeLeg.js';
import {
  answerLine,
  cfg,
  closeSocket,
  connectSocket,
  openLineSocket,
  startTestServer,
  validCallRequest,
} from './helpers.js';

type Server = Awaited<ReturnType<typeof startTestServer>>;

async function makeLiveCall(server: Server) {
  const callDeps: CallDeps = {
    cfg: cfg(),
    provider: server.provider,
    agents: server.agents,
    makeVoiceAgent: server.va.make,
    makeCaptions: server.captions.make,
  };
  const leg = new FakeLeg();
  const session = server.registry.create(validCallRequest(), leg, callDeps);
  await session.start();
  return { session, leg };
}

describe('WS /ws/app', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('closes with 4401 for a wrong token', async () => {
    server = await startTestServer();
    const { session } = await makeLiveCall(server);
    const sock = await connectSocket(`${server.wsBase}/ws/app?callId=${session.id}&token=wrong`);
    const closed = await sock.waitClose();
    expect(closed.code).toBe(4401);
  });

  it('closes with 4401 for an unknown call id', async () => {
    server = await startTestServer();
    const sock = await connectSocket(`${server.wsBase}/ws/app?callId=nope&token=nope`);
    const closed = await sock.waitClose();
    expect(closed.code).toBe(4401);
  });

  it('replays call.state on subscribe and answers a malformed message with {t:"error"}', async () => {
    server = await startTestServer();
    const { session } = await makeLiveCall(server);
    const sock = await connectSocket(
      `${server.wsBase}/ws/app?callId=${session.id}&token=${session.appToken}`,
    );
    const first = await sock.next();
    expect(first).toMatchObject({ t: 'call.state' });

    const nonJson = sock.next();
    sock.ws.send('not json');
    expect(await nonJson).toMatchObject({ t: 'error' });

    await closeSocket(sock);
  });

  it('answers an unrecognized command with {t:"error"}', async () => {
    server = await startTestServer();
    const { session } = await makeLiveCall(server);
    const sock = await connectSocket(
      `${server.wsBase}/ws/app?callId=${session.id}&token=${session.appToken}`,
    );
    await sock.next(); // initial call.state

    const errored = sock.next();
    sock.ws.send(JSON.stringify({ t: 'nonsense' }));
    expect(await errored).toMatchObject({ t: 'error' });

    await closeSocket(sock);
  });

  it('applies a valid AppCommand and reflects it back as call.state', async () => {
    server = await startTestServer();
    const { session } = await makeLiveCall(server);
    const sock = await connectSocket(
      `${server.wsBase}/ws/app?callId=${session.id}&token=${session.appToken}`,
    );
    await sock.next(); // initial call.state

    const updated = sock.next();
    sock.ws.send(JSON.stringify({ t: 'autonomy', value: 'auto' }));
    expect(await updated).toMatchObject({ t: 'call.state', autonomy: 'auto' });
    expect(session.autonomy).toBe('auto');

    await closeSocket(sock);
  });
});

describe('WS /ws/line/:code', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('closes with 4404 for an unknown line code', async () => {
    server = await startTestServer();
    const sock = await connectSocket(`${server.wsBase}/ws/line/ZZZZZZ`);
    const closed = await sock.waitClose();
    expect(closed.code).toBe(4404);
  });

  it('reports waiting -> ringing -> connected and forwards binary audio once connected', async () => {
    server = await startTestServer();
    const created = (await server.app.inject({ method: 'POST', url: '/api/lines' })).json();
    const opened = await openLineSocket(server.wsBase, created.code);
    const [lineSock, callRes] = await Promise.all([
      answerLine(opened),
      server.app.inject({
        method: 'POST',
        url: '/api/calls',
        payload: validCallRequest({ target: { kind: 'line', code: created.code } }),
      }),
    ]);
    expect(callRes.statusCode).toBe(200);

    const frame = Buffer.alloc(800, 0x7f);
    lineSock.ws.send(frame, { binary: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(server.va.last.audio.some((b) => b.length === 800 && b[0] === 0x7f)).toBe(true);

    await closeSocket(lineSock);
  });
});
