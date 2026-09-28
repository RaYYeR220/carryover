import type { FastifyInstance, FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import type { LineCodes } from '../legs/lineCodes.js';

export interface LineSocketDeps {
  lines: LineCodes;
}

const LINE_NOT_FOUND = 4404;

// WS /ws/line/:code -- the other party's page (usually a phone that scanned the QR code).
// JSON LineServerMsg / LineClientMsg plus binary mu-law frames, handled by the LineHandle
// itself; this just finds the line and hands the socket over.
export function registerLineSocket(app: FastifyInstance, deps: LineSocketDeps): void {
  app.get<{ Params: { code: string } }>(
    '/ws/line/:code',
    { websocket: true },
    (socket: WebSocket, req: FastifyRequest<{ Params: { code: string } }>) => {
      const handle = deps.lines.get(req.params.code);
      if (!handle) {
        socket.close(LINE_NOT_FOUND, 'line not found');
        return;
      }
      handle.attachSocket(socket);
    },
  );
}
