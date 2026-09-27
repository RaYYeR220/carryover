import WebSocket from 'ws';

const DEFAULT_BASE_URL = 'wss://streaming.assemblyai.com/v3/ws';
const TERMINATE_TIMEOUT_MS = 3000;

export interface CaptionWord {
  text: string;
  confidence: number;
  start: number;
  end: number;
  speaker?: string;
}

export interface CaptionTurn {
  turnOrder: number;
  text: string;
  final: boolean;
  speaker?: string;
  words: CaptionWord[];
}

export interface CaptionsOptions {
  apiKey: string;
  url?: string;
  keyterms: string[];
  prompt?: string;
  onTurn: (t: CaptionTurn) => void;
  onSpeechStarted: (tsMs: number) => void;
  onError: (e: Error) => void;
}

interface StreamEvent {
  type: string;
  [k: string]: unknown;
}

export class CaptionsStream {
  private readonly opts: CaptionsOptions;
  private ws: WebSocket | undefined;

  constructor(opts: CaptionsOptions) {
    this.opts = opts;
  }

  connect(): Promise<void> {
    const url = buildUrl(this.opts.url ?? DEFAULT_BASE_URL, this.opts.keyterms, this.opts.prompt);
    const ws = new WebSocket(url, { headers: { Authorization: this.opts.apiKey } });
    this.ws = ws;

    ws.on('message', (data, isBinary) => {
      const ev = parseEvent(data, isBinary);
      if (!ev) return;
      this.handleEvent(ev);
    });
    ws.on('error', (err) => this.opts.onError(err instanceof Error ? err : new Error(String(err))));

    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });
  }

  sendAudio(mu800: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(mu800);
  }

  setAgentContext(text: string): void {
    this.send({ type: 'UpdateConfiguration', agent_context: text });
  }

  setKeyterms(terms: string[]): void {
    this.send({ type: 'UpdateConfiguration', keyterms_prompt: terms });
  }

  close(): Promise<void> {
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
      const timer = setTimeout(finish, TERMINATE_TIMEOUT_MS);
      const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
        const ev = parseEvent(data, isBinary);
        if (ev?.type === 'Termination') finish();
      };
      ws.on('message', onMessage);
      this.send({ type: 'Terminate' });
    });
  }

  private send(obj: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(obj));
  }

  private handleEvent(ev: StreamEvent): void {
    if (ev.type === 'Turn') {
      this.opts.onTurn(toCaptionTurn(ev));
      return;
    }
    if (ev.type === 'SpeechStarted') {
      const ts = typeof ev.timestamp === 'number' ? ev.timestamp : Date.now();
      this.opts.onSpeechStarted(ts);
      return;
    }
    if (ev.type === 'Error') {
      const message = typeof ev.error === 'string' ? ev.error : (ev.message ?? 'streaming error');
      this.opts.onError(new Error(String(message)));
    }
  }
}

function toCaptionTurn(ev: StreamEvent): CaptionTurn {
  const rawWords = Array.isArray(ev.words) ? (ev.words as Record<string, unknown>[]) : [];
  const words: CaptionWord[] = rawWords.map((w) => ({
    text: String(w.text ?? ''),
    confidence: typeof w.confidence === 'number' ? w.confidence : 0,
    start: typeof w.start === 'number' ? w.start : 0,
    end: typeof w.end === 'number' ? w.end : 0,
    speaker: typeof w.speaker === 'string' ? w.speaker : undefined,
  }));
  return {
    turnOrder: typeof ev.turn_order === 'number' ? ev.turn_order : 0,
    text: typeof ev.transcript === 'string' ? ev.transcript : '',
    final: Boolean(ev.end_of_turn),
    speaker: typeof ev.speaker_label === 'string' ? ev.speaker_label : undefined,
    words,
  };
}

function buildUrl(base: string, keyterms: string[], prompt: string | undefined): string {
  const params = new URLSearchParams({
    speech_model: 'universal-3-5-pro',
    encoding: 'pcm_mulaw',
    sample_rate: '8000',
    speaker_labels: 'true',
    max_speakers: '4',
    continuous_partials: 'true',
    voice_focus: 'near-field',
  });
  if (keyterms.length > 0) {
    params.set('keyterms_prompt', JSON.stringify(keyterms));
  }
  if (prompt) {
    params.set('prompt', prompt);
  }
  return `${base}?${params.toString()}`;
}

function parseEvent(data: WebSocket.RawData, isBinary: boolean): StreamEvent | null {
  if (isBinary) return null;
  try {
    return JSON.parse(data.toString()) as StreamEvent;
  } catch {
    return null;
  }
}
