import type { ChatMessage, LlmProvider, StreamDelta } from '../../src/llm/provider.js';

type Reply = string | Error | (() => Promise<string>);

// LLM provider for call tests: complete() answers from a script (or throws), streamChat()
// yields nothing (the Brain route is not exercised here).
export class FakeProvider implements LlmProvider {
  readonly completeCalls: {
    messages: ChatMessage[];
    opts?: { json?: boolean };
    signal?: AbortSignal;
  }[] = [];
  reply: Reply;

  constructor(reply: Reply = '{"outcome":"Call ended","bullets":[],"commitments":[]}') {
    this.reply = reply;
  }

  streamChat(): AsyncIterable<StreamDelta> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true, value: undefined }),
      }),
    };
  }

  // Like the real OpenAI client: an aborted signal rejects the call, racing whatever the
  // scripted reply was going to do. A `reply` that never settles on its own (a hung
  // provider) only ever resolves this way, so callers can test their own timeout/abort
  // handling without a real network call.
  async complete(
    messages: ChatMessage[],
    opts?: { json?: boolean },
    signal?: AbortSignal,
  ): Promise<string> {
    this.completeCalls.push({ messages, opts, signal });
    const settle = (): Promise<string> => {
      const r = this.reply;
      if (r instanceof Error) return Promise.reject(r);
      if (typeof r === 'function') return r();
      return Promise.resolve(r);
    };
    if (!signal) return settle();
    return new Promise<string>((resolve, reject) => {
      const abortError = () => new DOMException('The operation was aborted.', 'AbortError');
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      settle().then(
        (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (err: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }
}
