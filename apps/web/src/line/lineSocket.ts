import type { LineClientMsg, LineServerMsg } from '@carryover/protocol';

export type LineStatusMsg = Extract<LineServerMsg, { t: 'line.status' }>;

export interface LineSocketHandlers {
  /** The line's/call's state changed: waiting, ringing, connected or ended. */
  onStatus: (msg: LineStatusMsg) => void;
  /** A short suggestion from the agent, shown as a transient hint. */
  onHint: (text: string) => void;
  /** One 20 ms / 160-byte mu-law frame of the agent's audio, ready to play. */
  onAudio: (mu: Uint8Array) => void;
  /** The socket closed, whether we asked for it or not. */
  onClose: (ev: { code: number; wasClean: boolean }) => void;
}

export interface LineSocket {
  /** Tell the server the page tapped Answer. */
  answer: () => void;
  /** Tell the server to hang up; the line becomes free for the next call. */
  hangup: () => void;
  /** Send one mic frame (mu-law, 8 kHz) as a binary WS message. No-op unless open. */
  sendAudio: (mu: Uint8Array) => void;
  /** Close the underlying WebSocket (route change, page teardown). */
  close: () => void;
}

type WebSocketLike = Pick<WebSocket, 'send' | 'close' | 'addEventListener' | 'readyState'> & {
  binaryType: string;
};
type WebSocketCtor = new (url: string) => WebSocketLike;

function send(ws: WebSocketLike, msg: LineClientMsg): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}

/**
 * Opens `WS /ws/line/:code`. Binary frames carry mu-law 8 kHz audio in both
 * directions; JSON frames are `line.status` / `line.hint` from the server
 * and `line.answer` / `line.hangup` to it. `WS` is injectable for tests.
 */
export function connectLineSocket(
  url: string,
  handlers: LineSocketHandlers,
  WS: WebSocketCtor = WebSocket,
): LineSocket {
  const ws = new WS(url);
  ws.binaryType = 'arraybuffer';

  ws.addEventListener('message', (ev) => {
    const { data } = ev as MessageEvent;
    if (typeof data === 'string') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object' || !('t' in parsed)) return;
      const msg = parsed as LineServerMsg;
      if (msg.t === 'line.status') handlers.onStatus(msg);
      else if (msg.t === 'line.hint') handlers.onHint(msg.text);
      return;
    }
    handlers.onAudio(new Uint8Array(data as ArrayBuffer));
  });

  ws.addEventListener('close', (ev) => {
    const { code, wasClean } = ev as CloseEvent;
    handlers.onClose({ code, wasClean });
  });

  return {
    answer: () => send(ws, { t: 'line.answer' }),
    hangup: () => send(ws, { t: 'line.hangup' }),
    sendAudio: (mu) => {
      // Uint8Array is typed generic over ArrayBufferLike (which includes
      // SharedArrayBuffer); WebSocket.send only accepts a plain ArrayBuffer
      // view. Frames we ever pass here are always backed by a fresh,
      // non-shared ArrayBuffer (encodeMulaw / worklet postMessage), so this
      // is a type-only cast, not an unsafe one.
      if (ws.readyState === WebSocket.OPEN) ws.send(mu as unknown as BufferSource);
    },
    close: () => ws.close(),
  };
}
