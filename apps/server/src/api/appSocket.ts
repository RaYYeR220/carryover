import { AppCommand, type AppEvent } from '@carryover/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import type { CallRegistry } from '../call/callRegistry.js';

export interface AppSocketDeps {
  registry: CallRegistry;
}

const WS_OPEN = 1;
const UNAUTHORIZED = 4401;

interface AppSocketQuery {
  callId?: string;
  token?: string;
}

// WS /ws/app?callId=&token= -- the user's app: an AppEvent stream out, AppCommands in.
export function registerAppSocket(app: FastifyInstance, deps: AppSocketDeps): void {
  app.get<{ Querystring: AppSocketQuery }>(
    '/ws/app',
    { websocket: true },
    (socket: WebSocket, req: FastifyRequest<{ Querystring: AppSocketQuery }>) => {
      const { callId, token } = req.query;
      const session = callId ? deps.registry.get(callId) : undefined;
      if (!session?.verifyToken(token ?? '')) {
        socket.close(UNAUTHORIZED, 'unauthorized');
        return;
      }

      const send = (e: AppEvent): void => {
        if (socket.readyState !== WS_OPEN) return;
        try {
          socket.send(JSON.stringify(e));
        } catch {
          // a send failing on a closing socket is not worth reporting
        }
      };
      const unsubscribe = session.subscribe(send);

      socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) return; // the app socket only carries JSON commands
        let raw: unknown;
        try {
          raw = JSON.parse(rawToText(data));
        } catch {
          send({ t: 'error', message: 'Malformed message: expected JSON.' });
          return;
        }
        const parsed = AppCommand.safeParse(raw);
        if (!parsed.success) {
          send({ t: 'error', message: 'Unrecognized command.' });
          return;
        }
        session.handleCommand(parsed.data);
      });

      socket.on('close', () => unsubscribe());
      socket.on('error', () => undefined); // 'close' follows
    },
  );
}

function rawToText(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
