import WebSocket from 'ws';

const DEFAULT_URL = 'wss://agents.assemblyai.com/v1/ws';
const CONNECT_TIMEOUT_MS = 8000;
const END_TIMEOUT_MS = 1500;
const TERMINATE_TIMEOUT_MS = 1500;

export type VAEvent = { type: string; [k: string]: unknown };

export interface VoiceAgentOptions {
  apiKey: string;
  url?: string;
  // Exactly one of agentId / initialSession is required.
  agentId?: string;
  initialSession?: Record<string, unknown>;
  onEvent: (e: VAEvent) => void;
  onClose: (code: number, reason: string) => void;
  // Overridable so tests don't have to wait out the real 8s default.
  connectTimeoutMs?: number;
}

export class VoiceAgentSession {
  private readonly opts: VoiceAgentOptions;
  private ws: WebSocket | undefined;
  private _sessionId: string | undefined;
  private endRequested = false;
  private serverEnded = false;

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

  // A dropped socket can be resumed: the session is known, we did not end it, and the
  // server did not end it either (session.ended before a close means "done, don't resume").
  get resumable(): boolean {
    return this._sessionId !== undefined && !this.endRequested && !this.serverEnded;
  }

  connect(): Promise<void> {
    const session =
      this.opts.agentId !== undefined ? { agent_id: this.opts.agentId } : this.opts.initialSession;
    return this.open({ type: 'session.update', session }, 'connect');
  }

  // After an unexpected drop: a new socket whose first message is session.resume with the
  // previous session_id. AAI keeps a dropped session for 30 s. Resolves on session.ready;
  // rejects when the server refuses (session_not_found and friends close the socket) or
  // nothing is ready within the connect timeout.
  resume(): Promise<void> {
    const sessionId = this._sessionId;
    if (sessionId === undefined) return Promise.reject(new Error('no session to resume'));
    if (this.endRequested) return Promise.reject(new Error('the session was ended'));
    const old = this.ws;
    if (old && old.readyState !== WebSocket.CLOSED) {
      // Only the new socket speaks for the session from here on.
      old.removeAllListeners();
      old.on('error', () => undefined);
      old.terminate();
    }
    return this.open({ type: 'session.resume', session_id: sessionId }, 'resume');
  }

  private open(first: Record<string, unknown>, what: string): Promise<void> {
    const ws = new WebSocket(this.opts.url ?? DEFAULT_URL, {
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
    });
    this.ws = ws;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        // Never leave a half-open socket behind: a stalled handshake (TCP
        // connected but no upgrade / no session.ready) leaves the WebSocket
        // stuck in CONNECTING forever otherwise, and end() can't clean up a
        // socket that never finished connecting.
        ws.terminate();
        fail(new Error(`VoiceAgentSession.${what} timed out waiting for session.ready`));
      }, this.opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);

      ws.on('open', () => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(first));
      });

      ws.on('message', (data, isBinary) => {
        const ev = parseEvent(data, isBinary);
        if (!ev) return;
        if (ev.type === 'session.ready') {
          if (typeof ev.session_id === 'string') this._sessionId = ev.session_id;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        } else if (ev.type === 'session.ended') {
          this.serverEnded = true;
        }
        if (this.ws === ws) this.opts.onEvent(ev);
      });

      ws.on('error', (err) => fail(err));

      ws.on('close', (code, reason) => {
        // Closed before session.ready: the server refused (a resume of an expired
        // session, a bad agent) -- no need to wait out the timeout.
        fail(new Error(`VoiceAgentSession.${what}: socket closed (${code}) before session.ready`));
        if (this.ws === ws) this.opts.onClose(code, reason.toString());
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
    this.endRequested = true;
    const ws = this.ws;
    if (!ws) {
      return Promise.resolve();
    }

    if (ws.readyState === WebSocket.CONNECTING) {
      // Stuck mid-handshake (e.g. connect() timed out and terminate() is
      // still in flight, or the caller ended the session before it ever
      // became ready): there's no session to end gracefully, so just make
      // sure the socket goes away.
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, TERMINATE_TIMEOUT_MS);
        ws.once('close', finish);
        ws.terminate();
      });
    }

    if (ws.readyState !== WebSocket.OPEN) {
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
