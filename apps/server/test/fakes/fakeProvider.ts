import type { ChatMessage, LlmProvider, StreamDelta } from '../../src/llm/provider.js';

type Reply = string | Error | (() => Promise<string>);

// LLM provider for call tests: complete() answers from a script (or throws), streamChat()
// yields nothing (the Brain route is not exercised here).
export class FakeProvider implements LlmProvider {
  readonly completeCalls: { messages: ChatMessage[]; opts?: { json?: boolean } }[] = [];
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

  async complete(messages: ChatMessage[], opts?: { json?: boolean }): Promise<string> {
    this.completeCalls.push({ messages, opts });
    const r = this.reply;
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r();
    return r;
  }
}
