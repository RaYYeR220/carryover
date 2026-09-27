// OpenAI-compatible chat.completion.chunk SSE writer for the Brain endpoint.
// AAI's Voice Agent reads this with the OpenAI Python SDK: comment lines are ignored,
// an empty completion (role chunk + finish "stop") is clean silence, and every
// response must end with `data: [DONE]`.

export interface SseSink {
  write(data: string): unknown;
  end(): unknown;
}

const TEXT_CHUNK_CODEPOINTS = 24;

export function sseHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
}

export function chunk(id: string, model: string, delta: object, finish?: string | null): string {
  const frame = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  };
  return `data: ${JSON.stringify(frame)}\n\n`;
}

// Split on code points (never inside a surrogate pair) so every chunk is valid UTF-16
// on its own and the chunks concatenate back to exactly the input.
export function splitText(text: string, size = TEXT_CHUNK_CODEPOINTS): string[] {
  const cps = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < cps.length; i += size) out.push(cps.slice(i, i + size).join(''));
  return out;
}

export type FinishReason = 'stop' | 'tool_calls';

// Stateful writer: role chunk exactly once, content/tool chunks, idempotent finish.
// Writes after finish (or after the client went away) are silently dropped.
export class SseWriter {
  private roleSent = false;
  private closed = false;
  private wroteOutput = false;

  constructor(
    private readonly res: SseSink,
    readonly id: string,
    readonly model: string,
  ) {}

  get finished(): boolean {
    return this.closed;
  }

  // True once any content or tool call reached the client.
  get hasOutput(): boolean {
    return this.wroteOutput;
  }

  private raw(s: string): void {
    if (this.closed) return;
    try {
      this.res.write(s);
    } catch {
      this.closed = true;
    }
  }

  role(): void {
    if (this.roleSent) return;
    this.roleSent = true;
    this.raw(chunk(this.id, this.model, { role: 'assistant', content: '' }));
  }

  text(text: string): void {
    if (this.closed) return;
    this.role();
    for (const piece of splitText(text)) {
      this.raw(chunk(this.id, this.model, { content: piece }));
      this.wroteOutput = true;
    }
  }

  toolCalls(calls: object[]): void {
    if (this.closed || calls.length === 0) return;
    this.role();
    this.raw(chunk(this.id, this.model, { tool_calls: calls }));
    this.wroteOutput = true;
  }

  keepalive(): void {
    this.raw(': keepalive\n\n');
  }

  finish(reason: FinishReason = 'stop'): void {
    if (this.closed) return;
    this.role();
    this.raw(chunk(this.id, this.model, {}, reason));
    this.raw('data: [DONE]\n\n');
    this.closed = true;
    try {
      this.res.end();
    } catch {
      // client already gone
    }
  }

  // The client disconnected: stop writing without touching the socket again.
  abandon(): void {
    this.closed = true;
  }
}

export function writeText(res: SseSink, id: string, model: string, text: string): void {
  const w = new SseWriter(res, id, model);
  w.text(text);
  w.finish('stop');
}

export function writeEmpty(res: SseSink, id: string, model: string): void {
  new SseWriter(res, id, model).finish('stop');
}

export function keepalive(res: SseSink): void {
  res.write(': keepalive\n\n');
}
