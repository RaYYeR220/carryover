import WebSocket from 'ws';

const DEFAULT_URL = 'wss://agents.assemblyai.com/v1/ws';
const CONNECT_TIMEOUT_MS = 8000;
const END_TIMEOUT_MS = 1500;

export type VAEvent = { type: string; [k: string]: unknown };

export interface VoiceAgentOptions {
  apiKey: string;
  url?: string;
  // Exactly one of agentId / initialSession is required.
  agentId?: string;
  initialSession?: Record<string, unknown>;
  onEvent: (e: VAEvent) => void;
  onClose: (code: number, reason: string) => void;
}

export class VoiceAgentSession {
  private readonly opts: VoiceAgentOptions;
  private ws: WebSocket | undefined;
  private _sessionId: string | undefined;

  constructor(opts: VoiceAgentOptions) {
    const hasAgentId = opts.agentId !== undefined;
    const hasInitialSession = opts.initialSession !== undefined;
    if (hasAgentId === hasInitialSession) {
      throw new Error('VoiceAgentOptions requires exactly one of agentId or initialSession');
    }
    this.opts = opts;
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  connect(): Promise<void> {
    const ws = new WebSocket(this.opts.url ?? DEFAULT_URL, {
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
    });
    this.ws = ws;

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('VoiceAgentSession.connect timed out waiting for session.ready'));
      }, CONNECT_TIMEOUT_MS);

      ws.on('open', () => {
        const session =
          this.opts.agentId !== undefined
            ? { agent_id: this.opts.agentId }
            : this.opts.initialSession;
        this.send({ type: 'session.update', session });
      });

      ws.on('message', (data, isBinary) => {
        const ev = parseEvent(data, isBinary);
        if (!ev) return;
        if (ev.type === 'session.ready') {
          this._sessionId = typeof ev.session_id === 'string' ? ev.session_id : undefined;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        }
        this.opts.onEvent(ev);
      });

      ws.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });

      ws.on('close', (code, reason) => {
        this.opts.onClose(code, reason.toString());
      });
    });
  }

  updateSession(session: Record<string, unknown>): void {
    this.send({ type: 'session.update', session });
  }

  sendAudio(mu: Buffer): void {
    this.send({ type: 'input.audio', audio: mu.toString('base64') });
  }

  replyCreate(instructions: string): void {
    this.send({ type: 'reply.create', instructions });
  }

  toolResult(callId: string, result: unknown, isError = false): void {
    this.send({
      type: 'tool.result',
      call_id: callId,
      result: JSON.stringify(result),
      is_error: isError,
    });
  }

  end(): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.removeListener('message', onMessage);
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000);
        }
        resolve();
      };
      const timer = setTimeout(finish, END_TIMEOUT_MS);
      const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
        const ev = parseEvent(data, isBinary);
        if (ev?.type === 'session.ended') finish();
      };
      ws.on('message', onMessage);
      this.send({ type: 'session.end' });
    });
  }

  private send(obj: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(obj));
  }
}

function parseEvent(data: WebSocket.RawData, isBinary: boolean): VAEvent | null {
  if (isBinary) return null;
  try {
    return JSON.parse(data.toString()) as VAEvent;
  } catch {
    return null;
  }
}
