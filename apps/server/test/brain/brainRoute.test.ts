import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { type BrainTiming, registerBrainRoute } from '../../src/brain/brainRoute.js';
import type { BrainCallView } from '../../src/brain/policy.js';
import { RELAY_TOOLS } from '../../src/brain/policy.js';
import type { Config } from '../../src/config.js';
import {
  type ChatMessage,
  createProvider,
  type LlmProvider,
  type StreamDelta,
  type ToolDef,
} from '../../src/llm/provider.js';
import { type FakeView, fakeView } from './fakeView.js';

const SECRET = 'test-brain-secret';
const AUTH = { authorization: `Bearer ${SECRET}` };
const URL_PATH = '/brain/v1/chat/completions';

function cfg(): Config {
  return {
    aaiKey: 'aai-key',
    llmProvider: 'venice',
    llmModel: 'test-model',
    veniceKey: 'venice-key',
    publicBaseUrl: 'https://example.com',
    brainSecret: SECRET,
    port: 8787,
    aaiStreamingUrl: 'wss://streaming.assemblyai.com/v3/ws',
    aaiAgentsWsUrl: 'wss://agents.assemblyai.com/v1/ws',
    aaiAgentsRestUrl: 'https://agents.assemblyai.com/v1',
  };
}

type Script = (signal: AbortSignal) => AsyncIterable<StreamDelta>;

class FakeProvider implements LlmProvider {
  calls: { messages: ChatMessage[]; tools?: ToolDef[]; signal: AbortSignal }[] = [];
  constructor(private readonly script: Script) {}
  streamChat(messages: ChatMessage[], tools?: ToolDef[], signal?: AbortSignal) {
    const s = signal ?? new AbortController().signal;
    this.calls.push({ messages, tools, signal: s });
    return this.script(s);
  }
  async complete(): Promise<string> {
    return '';
  }
}

const never: Script = () => ({
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.reject(new Error('provider must not be called')),
  }),
});

function textScript(text: string, piece = 5): Script {
  return async function* () {
    for (let i = 0; i < text.length; i += piece) yield { text: text.slice(i, i + piece) };
    yield { done: true };
  };
}

function waitAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new Error('aborted'));
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

// An LLM that never produces a token until it is aborted.
const hangUntilAbort: Script = (signal) => ({
  [Symbol.asyncIterator]: () => ({ next: () => waitAbort(signal) }),
});

const AAI_BOILERPLATE =
  '\n\nOutput is spoken aloud. Plain conversational text only — no formatting characters.';

function body(callId: string | undefined, ...rest: { role: string; content: string }[]) {
  const tag = callId ? `[[carryover-call:${callId}]] relay session` : 'relay session';
  return {
    messages: [{ role: 'system', content: tag + AAI_BOILERPLATE }, ...rest],
    model: 'relay-brain',
    stream: true,
    stream_options: { include_usage: true },
    tool_choice: 'auto',
    tools: [],
  };
}
const them = (content: string) => ({ role: 'user', content });
const nonceMsg = (nonce: string) => ({ role: 'system', content: `RELAY_UTTERANCE:${nonce}` });

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
}

interface Sse {
  frames: { choices: { delta: Record<string, unknown>; finish_reason: string | null }[] }[];
  text: string;
  toolCalls: { index: number; id?: string; name?: string; args: string }[];
  finish: (string | null)[];
  done: boolean;
  comments: number;
}

function parseSse(raw: string): Sse {
  const out: Sse = { frames: [], text: '', toolCalls: [], finish: [], done: false, comments: 0 };
  for (const block of raw.split('\n\n')) {
    if (!block) continue;
    if (block.startsWith(':')) {
      out.comments++;
      continue;
    }
    expect(block.startsWith('data: ')).toBe(true);
    const data = block.slice(6);
    if (data === '[DONE]') {
      out.done = true;
      continue;
    }
    const f = JSON.parse(data);
    out.frames.push(f);
    const choice = f.choices[0];
    if (choice.finish_reason) out.finish.push(choice.finish_reason);
    if (typeof choice.delta.content === 'string') out.text += choice.delta.content;
    for (const tc of choice.delta.tool_calls ?? []) {
      let t = out.toolCalls.find((x) => x.index === tc.index);
      if (!t) {
        t = { index: tc.index, args: '' };
        out.toolCalls.push(t);
      }
      if (tc.id) t.id = tc.id;
      if (tc.function?.name) t.name = tc.function.name;
      t.args += tc.function?.arguments ?? '';
    }
  }
  return out;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function makeApp(
  provider: LlmProvider,
  views: BrainCallView[],
  timing?: Partial<BrainTiming>,
  lookupOverride?: (id: string) => BrainCallView | undefined,
) {
  const a = Fastify();
  const lookups: string[] = [];
  registerBrainRoute(a, {
    cfg: cfg(),
    provider,
    lookup:
      lookupOverride ??
      ((id) => {
        lookups.push(id);
        return views.find((v) => v.callId === id);
      }),
    timing,
  });
  app = a;
  return { app: a, lookups };
}

async function post(a: FastifyInstance, payload: unknown, headers: Record<string, string> = AUTH) {
  const res = await a.inject({
    method: 'POST',
    url: URL_PATH,
    headers,
    payload: payload as object,
  });
  const isSse = String(res.headers['content-type']).startsWith('text/event-stream');
  return { res, sse: isSse ? parseSse(res.body) : parseSse('') };
}

function expectEmptyCompletion(
  res: { statusCode: number; headers: Record<string, unknown> },
  sse: Sse,
) {
  expect(res.statusCode).toBe(200);
  expect(String(res.headers['content-type'])).toMatch(/^text\/event-stream/);
  expect(sse.text).toBe('');
  expect(sse.toolCalls).toEqual([]);
  expect(sse.finish).toEqual(['stop']);
  expect(sse.done).toBe(true);
}

const CALL_A = '3f9c2a1e-8b7d-4c21-9e0a-5d6f7a8b9c01';
const CALL_B = '7d1e4b2a-0c3f-4a8e-b5d6-1f2e3a4b5c6d';

describe('brain route: routing, auth and silence (Review Focus 2)', () => {
  it('unknown call → 200 SSE with an empty completion + [DONE], never 500', async () => {
    const { app: a } = makeApp(new FakeProvider(never), []);
    const { res, sse } = await post(a, fixture('byo-turn'));
    expectEmptyCompletion(res, sse);
  });

  it('request without a call tag → empty completion', async () => {
    const { app: a, lookups } = makeApp(new FakeProvider(never), [fakeView({ callId: CALL_A })]);
    const { res, sse } = await post(a, body(undefined, them('Hello?')));
    expectEmptyCompletion(res, sse);
    expect(lookups).toEqual([]);
  });

  it('wrong or missing secret → 401 and the call is never looked up', async () => {
    const { app: a, lookups } = makeApp(new FakeProvider(never), [fakeView({ callId: CALL_A })]);
    const wrong = await post(a, fixture('byo-turn'), { authorization: 'Bearer nope' });
    expect(wrong.res.statusCode).toBe(401);
    const raw = await post(a, fixture('byo-turn'), { authorization: SECRET });
    expect(raw.res.statusCode).toBe(401);
    const missing = await post(a, fixture('byo-turn'), {});
    expect(missing.res.statusCode).toBe(401);
    expect(lookups).toEqual([]);
  });

  it('invalid JSON body → 200 empty completion', async () => {
    const { app: a } = makeApp(new FakeProvider(never), []);
    const res = await a.inject({
      method: 'POST',
      url: URL_PATH,
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: '{"messages": [',
    });
    expectEmptyCompletion(res, parseSse(res.body));
  });

  it('lookup throwing → 200 empty completion', async () => {
    const { app: a } = makeApp(new FakeProvider(never), [], undefined, () => {
      throw new Error('registry exploded');
    });
    const { res, sse } = await post(a, fixture('byo-turn'));
    expectEmptyCompletion(res, sse);
  });

  it('relay mode + other-party turn → empty completion, LLM not called', async () => {
    const provider = new FakeProvider(never);
    const { app: a } = makeApp(provider, [fakeView({ callId: CALL_A, autonomy: 'relay' })]);
    const { res, sse } = await post(a, fixture('byo-turn'));
    expectEmptyCompletion(res, sse);
    expect(provider.calls).toHaveLength(0);
  });

  it('after press_keys (real AAI post-tool body shape) → silence', async () => {
    const b = fixture('byo-tool-result') as { messages: { tool_calls?: unknown[] }[] };
    const withPress = JSON.parse(JSON.stringify(b).replaceAll('ask_user', 'press_keys'));
    const provider = new FakeProvider(never);
    const { app: a } = makeApp(provider, [fakeView({ callId: CALL_A })]);
    const { res, sse } = await post(a, withPress);
    expectEmptyCompletion(res, sse);
    expect(provider.calls).toHaveLength(0);
  });

  it('after end_call (real AAI post-tool body shape) → silence, the LLM is not asked again', async () => {
    // Asking again after end_call invited a second end_call that reset the hang-up.
    const b = fixture('byo-tool-result') as { messages: { tool_calls?: unknown[] }[] };
    const withEnd = JSON.parse(JSON.stringify(b).replaceAll('ask_user', 'end_call'));
    const provider = new FakeProvider(never);
    const { app: a } = makeApp(provider, [fakeView({ callId: CALL_A })]);
    const { res, sse } = await post(a, withEnd);
    expectEmptyCompletion(res, sse);
    expect(provider.calls).toHaveLength(0);
  });
});

describe('brain route: after bookkeeping tools', () => {
  // Live run (riverside): the rep said "It'll be ready Thursday after 2 PM, reference
  // 4471. Is there anything else you need?", the LLM answered with note_commitment only,
  // the post-tool request was answered with silence and the call hung for two minutes.
  const noteOnly = (answer?: string) =>
    body(
      CALL_A,
      them("It'll be ready Thursday after 2 PM, reference 4471. Is there anything else you need?"),
      ...(answer ? [{ role: 'assistant', content: answer }] : []),
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_n1',
            type: 'function',
            function: { name: 'note_commitment', arguments: '{"text":"Refill ready"}' },
          },
        ],
      } as unknown as { role: string; content: string },
      { role: 'tool', tool_call_id: 'call_n1', content: '{"status":"noted"}' } as unknown as {
        role: string;
        content: string;
      },
      {
        role: 'system',
        content:
          "The function call note_commitment(text='Refill ready') has just completed. Do not read out raw data verbatim.",
      },
    );

  it('note_commitment with nothing said yet → the LLM still answers the open question', async () => {
    const provider = new FakeProvider(textScript('No, that is everything. Thank you!'));
    const { app: a } = makeApp(provider, [fakeView({ callId: CALL_A })]);
    const { sse } = await post(a, noteOnly());
    expect(provider.calls).toHaveLength(1);
    expect(sse.text).toBe('No, that is everything. Thank you!');
  });

  it('note_commitment after an answer was already spoken → silence (no second answer)', async () => {
    const provider = new FakeProvider(never);
    const { app: a } = makeApp(provider, [fakeView({ callId: CALL_A })]);
    const { res, sse } = await post(a, noteOnly('Great, thank you. That is all.'));
    expectEmptyCompletion(res, sse);
    expect(provider.calls).toHaveLength(0);
  });
});

describe('brain route: hanging up', () => {
  function toolScript(name: string, args: string, text?: string): Script {
    return async function* () {
      if (text) yield { text };
      yield { toolCalls: [{ index: 0, id: 'call_e1', name, argumentsDelta: args }] };
      yield { done: true };
    };
  }

  it('end_call with nothing said → a goodbye goes first (never hang up without a word)', async () => {
    const provider = new FakeProvider(toolScript('end_call', '{"reason":"done"}'));
    const { app: a } = makeApp(provider, [fakeView({ callId: CALL_A })]);
    const { sse } = await post(a, body(CALL_A, them('Is there anything else I can help with?')));
    expect(sse.text).toBe('Thank you, goodbye.');
    expect(sse.toolCalls).toEqual([
      { index: 0, id: 'call_e1', name: 'end_call', args: '{"reason":"done"}' },
    ]);
    expect(sse.finish).toEqual(['tool_calls']);
    // The goodbye is spoken before the hang-up is requested.
    const firstTool = sse.frames.findIndex((f) => f.choices[0]?.delta.tool_calls);
    const firstText = sse.frames.findIndex(
      (f) => typeof f.choices[0]?.delta.content === 'string' && f.choices[0]?.delta.content !== '',
    );
    expect(firstText).toBeLessThan(firstTool);
  });

  it('end_call after the LLM said its own goodbye adds nothing', async () => {
    const provider = new FakeProvider(
      toolScript('end_call', '{"reason":"done"}', 'No, that is all. Thanks, bye!'),
    );
    const { app: a } = makeApp(provider, [fakeView({ callId: CALL_A })]);
    const { sse } = await post(a, body(CALL_A, them('Anything else?')));
    expect(sse.text).toBe('No, that is all. Thanks, bye!');
    expect(sse.toolCalls.map((t) => t.name)).toEqual(['end_call']);
  });
});

describe('brain route: timing lines', () => {
  function appWithDebug(provider: LlmProvider, views: BrainCallView[]) {
    const lines: { event: string; fields: Record<string, unknown> }[] = [];
    const a = Fastify();
    registerBrainRoute(a, {
      cfg: cfg(),
      provider,
      lookup: (id) => views.find((v) => v.callId === id),
      debug: (event, fields) => lines.push({ event, fields: fields ?? {} }),
    });
    app = a;
    return { a, lines };
  }

  it('one line per request with decision, LLM first token, first byte and done, never text', async () => {
    const said = 'Her date of birth is March 14, 1952.';
    const provider = new FakeProvider(textScript(said));
    const { a, lines } = appWithDebug(provider, [fakeView({ callId: CALL_A })]);
    await post(a, body(CALL_A, them('What is her date of birth?')));

    expect(lines).toHaveLength(1);
    const { event, fields } = lines[0] as (typeof lines)[number];
    expect(event).toBe('brain.request');
    expect(fields).toMatchObject({
      call: CALL_A.slice(0, 8),
      decision: 'proxy',
      last_role: 'user',
      end: 'done',
      chars: said.length,
    });
    for (const k of ['received_at', 'llm_first_token_ms', 'first_byte_ms', 'done_ms']) {
      expect(typeof fields[k]).toBe('number');
    }
    expect(fields.first_byte_ms as number).toBeGreaterThanOrEqual(
      fields.llm_first_token_ms as number,
    );
    const json = JSON.stringify(fields);
    expect(json).not.toContain('1952');
    expect(json).not.toContain('date of birth');
  });

  it('verbatim and silence decisions are logged with their reason', async () => {
    const view = fakeView({ callId: CALL_A, autonomy: 'relay' });
    view.nonces.set('nonce00000009', 'Typed text.');
    const { a, lines } = appWithDebug(new FakeProvider(never), [view]);
    await post(a, body(CALL_A, them('Hi?'), nonceMsg('nonce00000009')));
    await post(a, body(CALL_A, them('Hello?')));
    expect(lines.map((l) => [l.fields.decision, l.fields.nonce])).toEqual([
      ['verbatim', 'nonce00000009'],
      ['silence:relay-mode', undefined],
    ]);
  });
});

describe('brain route: verbatim relay', () => {
  it('verbatim nonce → streamed text equals the stored text exactly', async () => {
    const typed =
      'Hi, yes — it is for my blood pressure pills, the 20 mg ones 💊. Can you check if they are ready?';
    const view = fakeView({ callId: CALL_B });
    view.nonces.set('q7x2m9k4p1z8', typed);
    const provider = new FakeProvider(never);
    const { app: a } = makeApp(provider, [view]);
    const { res, sse } = await post(a, fixture('byo-reply-create'));
    expect(res.statusCode).toBe(200);
    expect(sse.text).toBe(typed);
    expect(sse.finish).toEqual(['stop']);
    expect(sse.done).toBe(true);
    expect(sse.frames.length).toBeGreaterThan(3);
    expect(provider.calls).toHaveLength(0);
    // one-shot: a retry of the same request is silent, never a repeat
    const again = await post(a, fixture('byo-reply-create'));
    expectEmptyCompletion(again.res, again.sse);
  });

  it('verbatim text is not filtered by the gate (the user typed it)', async () => {
    const view = fakeView({ callId: CALL_A, facts: [] });
    view.nonces.set('nonce00000001', 'My new member ID is 99 31 22.');
    const { app: a } = makeApp(new FakeProvider(never), [view]);
    const { sse } = await post(a, body(CALL_A, them('ID?'), nonceMsg('nonce00000001')));
    expect(sse.text).toBe('My new member ID is 99 31 22.');
  });

  it('routes by call tag with two live calls (Review Focus 5)', async () => {
    const va = fakeView({ callId: CALL_A });
    const vb = fakeView({ callId: CALL_B, userName: 'Sam' });
    va.nonces.set('nonceaaaa1111', 'Text typed by the user of call A.');
    vb.nonces.set('noncebbbb2222', 'Text typed by the user of call B.');
    const { app: a } = makeApp(new FakeProvider(never), [va, vb]);

    const [ra, rb] = await Promise.all([
      post(a, body(CALL_A, them('Go ahead.'), nonceMsg('nonceaaaa1111'))),
      post(a, body(CALL_B, them('Go ahead.'), nonceMsg('noncebbbb2222'))),
    ]);
    expect(ra.sse.text).toBe('Text typed by the user of call A.');
    expect(rb.sse.text).toBe('Text typed by the user of call B.');

    // A request tagged for call A can never pull a nonce belonging to call B.
    vb.nonces.set('noncebbbb3333', 'Private text of call B.');
    const cross = await post(a, body(CALL_A, them('Go ahead.'), nonceMsg('noncebbbb3333')));
    expectEmptyCompletion(cross.res, cross.sse);
    expect(vb.nonces.get('noncebbbb3333')).toBe('Private text of call B.');
    const own = await post(a, body(CALL_B, them('Go ahead.'), nonceMsg('noncebbbb3333')));
    expect(own.sse.text).toBe('Private text of call B.');
  });
});

describe('brain route: proxy through the fact gate', () => {
  it('sends our system prompt + AAI history (without AAI prompt) + RELAY_TOOLS', async () => {
    const provider = new FakeProvider(textScript('Hi, yes, I can hold.'));
    const { app: a } = makeApp(provider, [fakeView({ callId: CALL_A })]);
    const { sse } = await post(a, fixture('byo-turn'));
    expect(sse.text).toBe('Hi, yes, I can hold.');
    expect(sse.finish).toEqual(['stop']);
    expect(sse.done).toBe(true);
    const call = provider.calls[0];
    expect(call?.messages[0]?.role).toBe('system');
    expect(call?.messages[0]?.content).toContain('FACT SHEET');
    expect(call?.messages[0]?.content).toContain('Maya');
    expect(call?.messages.slice(1)).toEqual([
      {
        role: 'assistant',
        content: 'Hi, I am calling on behalf of a customer who is using a relay assistant. ',
      },
      { role: 'user', content: 'Hello, this is Riverside Pharmacy. How can I help you?' },
    ]);
    expect(JSON.stringify(call?.messages)).not.toContain('Output is spoken aloud');
    expect(call?.tools).toBe(RELAY_TOOLS);
  });

  it('allowed facts stream through untouched', async () => {
    const reply = 'Sure. Her date of birth is March 14th, 1952. Anything else?';
    const view = fakeView({ callId: CALL_A });
    const { app: a } = makeApp(new FakeProvider(textScript(reply, 3)), [view]);
    const { sse } = await post(a, body(CALL_A, them('Date of birth?')));
    expect(sse.text).toBe(reply);
    expect(view.blocked).toHaveLength(0);
  });

  it('blocks an invented DOB: filler instead, generation stopped, onGateBlocked once', async () => {
    const provider = new FakeProvider(
      textScript('Her date of birth is June 1st, 1986. Anything else?'),
    );
    const view = fakeView({ callId: CALL_A });
    const { app: a } = makeApp(provider, [view]);
    const { res, sse } = await post(a, body(CALL_A, them('And her date of birth?')));
    expect(res.statusCode).toBe(200);
    expect(sse.text).toContain('One moment, let me check with Maya.');
    expect(sse.text).not.toContain('1986');
    expect(sse.text).not.toContain('June');
    expect(sse.text).not.toContain('Anything else');
    expect(sse.finish).toEqual(['stop']);
    expect(sse.done).toBe(true);
    expect(view.blocked).toHaveLength(1);
    expect(view.blocked[0]?.sentence).toBe('Her date of birth is June 1st, 1986.');
    expect(view.blocked[0]?.offending.map((f) => f.norm)).toEqual(['1986-06-01']);
    expect(provider.calls[0]?.signal.aborted).toBe(true);
  });

  it('releases clean sentences before a blocked one and blocks spelled digits', async () => {
    const view = fakeView({ callId: CALL_A });
    const { app: a } = makeApp(
      new FakeProvider(
        textScript('Sure, one second. Her member ID is six one one nine eight six.'),
      ),
      [view],
    );
    const { sse } = await post(a, body(CALL_A, them('Member ID?')));
    expect(sse.text).toBe('Sure, one second. One moment, let me check with Maya.');
    expect(view.blocked).toHaveLength(1);
  });

  it('blocks an ID read out with ellipsis separators, streamed in tiny pieces', async () => {
    const view = fakeView({ callId: CALL_A });
    const { app: a } = makeApp(
      new FakeProvider(textScript('Sure. Her member ID is 8… 8… 1… 3. Anything else?', 2)),
      [view],
    );
    const { sse } = await post(a, body(CALL_A, them('Member ID?')));
    expect(sse.text).toBe('Sure. One moment, let me check with Maya.');
    expect(view.blocked).toHaveLength(1);
    expect(view.blocked[0]?.offending.map((f) => f.norm)).toEqual(['8813']);
  });

  it('checks the unterminated tail when the stream ends', async () => {
    const view = fakeView({ callId: CALL_A });
    const { app: a } = makeApp(new FakeProvider(textScript('Her email is maya@example.com')), [
      view,
    ]);
    const { sse } = await post(a, body(CALL_A, them('Email?')));
    expect(sse.text).toBe('One moment, let me check with Maya.');
    expect(sse.text).not.toContain('@');
    expect(view.blocked).toHaveLength(1);
  });

  it('numbers the other party said are allowed', async () => {
    const view = fakeView({ callId: CALL_A });
    view.ledger.add('Your reference number is 4471.');
    const { app: a } = makeApp(
      new FakeProvider(textScript('Thank you, reference four four seven one.')),
      [view],
    );
    const { sse } = await post(a, body(CALL_A, them('Your reference number is 4471.')));
    expect(sse.text).toBe('Thank you, reference four four seven one.');
  });

  it('passes a press_keys tool call through as an OpenAI tool_calls delta', async () => {
    const provider = new FakeProvider(async function* () {
      yield { toolCalls: [{ index: 0, id: 'call_1', name: 'press_keys', argumentsDelta: '' }] };
      yield { toolCalls: [{ index: 0, argumentsDelta: '{"digits":' }] };
      yield { toolCalls: [{ index: 0, argumentsDelta: '"2"}' }] };
      yield { done: true };
    });
    const { app: a } = makeApp(provider, [fakeView({ callId: CALL_A, lineState: 'ivr' })]);
    const { res, sse } = await post(a, body(CALL_A, them('For pharmacy, press 2.')));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"tool_calls"');
    expect(sse.toolCalls).toEqual([
      { index: 0, id: 'call_1', name: 'press_keys', args: '{"digits":"2"}' },
    ]);
    const first = sse.frames.find((f) => f.choices[0]?.delta.tool_calls);
    expect(first?.choices[0]?.delta.tool_calls).toEqual([
      {
        index: 0,
        id: 'call_1',
        type: 'function',
        function: { name: 'press_keys', arguments: '{"digits":"2"}' },
      },
    ]);
    expect(sse.finish).toEqual(['tool_calls']);
    expect(sse.done).toBe(true);
    expect(sse.text).toBe('');
  });

  it('streams other tool calls delta by delta, keeping text before them', async () => {
    const provider = new FakeProvider(async function* () {
      yield { text: 'One moment, please.' };
      yield { toolCalls: [{ index: 0, id: 'call_7', name: 'ask_user', argumentsDelta: '' }] };
      yield { toolCalls: [{ index: 0, argumentsDelta: '{"question":"What is' }] };
      yield { toolCalls: [{ index: 0, argumentsDelta: ' your address?"}' }] };
      yield { done: true };
    });
    const { app: a } = makeApp(provider, [fakeView({ callId: CALL_A })]);
    const { sse } = await post(a, body(CALL_A, them('What is her address?')));
    expect(sse.text).toBe('One moment, please.');
    expect(sse.toolCalls).toEqual([
      { index: 0, id: 'call_7', name: 'ask_user', args: '{"question":"What is your address?"}' },
    ]);
    const toolFrames = sse.frames.filter((f) => f.choices[0]?.delta.tool_calls);
    expect(toolFrames.length).toBe(3);
    expect(sse.finish).toEqual(['tool_calls']);
  });

  it('blocks press_keys that would key in an invented number', async () => {
    const invented = new FakeProvider(async function* () {
      yield {
        toolCalls: [
          { index: 0, id: 'c1', name: 'press_keys', argumentsDelta: '{"digits":"611986#"}' },
        ],
      };
      yield { done: true };
    });
    const view = fakeView({ callId: CALL_A, lineState: 'ivr' });
    const { app: a } = makeApp(invented, [view]);
    const { sse } = await post(a, body(CALL_A, them('Enter your member ID followed by pound.')));
    expect(sse.toolCalls).toEqual([]);
    expect(sse.text).toBe('One moment, let me check with Maya.');
    expect(sse.finish).toEqual(['stop']);
    expect(view.blocked).toHaveLength(1);

    const real = new FakeProvider(async function* () {
      yield {
        toolCalls: [
          { index: 0, id: 'c2', name: 'press_keys', argumentsDelta: '{"digits":"88120477#"}' },
        ],
      };
      yield { done: true };
    });
    const view2 = fakeView({ callId: CALL_B, lineState: 'ivr' });
    const second = makeApp(real, [view2]);
    const ok = await post(
      second.app,
      body(CALL_B, them('Enter your member ID followed by pound.')),
    );
    expect(ok.sse.toolCalls).toEqual([
      { index: 0, id: 'c2', name: 'press_keys', args: '{"digits":"88120477#"}' },
    ]);
    expect(view2.blocked).toHaveLength(0);
    await second.app.close();
  });

  it('lets short menu key sequences through (press_keys "132")', async () => {
    const provider = new FakeProvider(async function* () {
      yield {
        toolCalls: [{ index: 0, id: 'c3', name: 'press_keys', argumentsDelta: '{"digits":"132"}' }],
      };
      yield { done: true };
    });
    const view = fakeView({ callId: CALL_A, lineState: 'ivr' });
    const { app: a } = makeApp(provider, [view]);
    const { sse } = await post(a, body(CALL_A, them('Press 1, then 3, then 2 for refills.')));
    expect(sse.toolCalls).toEqual([
      { index: 0, id: 'c3', name: 'press_keys', args: '{"digits":"132"}' },
    ]);
    expect(view.blocked).toHaveLength(0);
  });

  it('finishes with what was said when the LLM stalls after the first sentence', async () => {
    const provider = new FakeProvider(async function* (signal) {
      yield { text: 'Sure, I can hold. ' };
      yield { text: 'And ' };
      await waitAbort(signal);
    });
    const { app: a } = makeApp(provider, [fakeView({ callId: CALL_A })], {
      keepaliveMs: 20,
      firstOutputTimeoutMs: 5000,
      stallMs: 120,
      maxStreamMs: 5000,
    });
    const started = Date.now();
    const { res, sse } = await post(a, body(CALL_A, them('Can you hold?')));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.statusCode).toBe(200);
    expect(sse.text).toBe('Sure, I can hold.');
    expect(sse.finish).toEqual(['stop']);
    expect(sse.done).toBe(true);
    expect(provider.calls[0]?.signal.aborted).toBe(true);
  });

  it('provider throwing → 200 with an empty completion', async () => {
    const provider = new FakeProvider(async function* () {
      yield* [];
      throw new Error('upstream 500');
    });
    const { app: a } = makeApp(provider, [fakeView({ callId: CALL_A })]);
    const { res, sse } = await post(a, body(CALL_A, them('Hello?')));
    expectEmptyCompletion(res, sse);
  });

  it('provider throwing mid-stream → keeps what was said, still a valid finish', async () => {
    const provider = new FakeProvider(async function* () {
      yield { text: 'Sure, I can hold. ' };
      yield { text: 'And' };
      throw new Error('socket hang up');
    });
    const { app: a } = makeApp(provider, [fakeView({ callId: CALL_A })]);
    const { res, sse } = await post(a, body(CALL_A, them('Can you hold?')));
    expect(res.statusCode).toBe(200);
    expect(sse.text).toBe('Sure, I can hold.');
    expect(sse.finish).toEqual(['stop']);
    expect(sse.done).toBe(true);
  });

  it('sends keepalives while the LLM is silent and a filler at the hard timeout', async () => {
    const provider = new FakeProvider(hangUntilAbort);
    const { app: a } = makeApp(provider, [fakeView({ callId: CALL_A })], {
      keepaliveMs: 20,
      firstOutputTimeoutMs: 150,
    });
    const { res, sse } = await post(a, body(CALL_A, them('Are you there?')));
    expect(res.statusCode).toBe(200);
    expect(sse.comments).toBeGreaterThanOrEqual(3);
    expect(sse.text).toBe('Sorry, one moment.');
    expect(sse.finish).toEqual(['stop']);
    expect(sse.done).toBe(true);
    expect(provider.calls[0]?.signal.aborted).toBe(true);
  });
});

describe('brain route over real HTTP', () => {
  async function listen(provider: LlmProvider, views: FakeView[]) {
    const { app: a } = makeApp(provider, views);
    await a.listen({ port: 0, host: '127.0.0.1' });
    const port = (a.server.address() as AddressInfo).port;
    return `http://127.0.0.1:${port}/brain/v1`;
  }

  it('an OpenAI SDK client (what AAI uses) reads verbatim text and tool calls', async () => {
    let turn = 0;
    const provider = new FakeProvider(async function* () {
      turn++;
      yield {
        toolCalls: [{ index: 0, id: 'call_9', name: 'press_keys', argumentsDelta: '{"digits"' }],
      };
      yield { toolCalls: [{ index: 0, argumentsDelta: ':"2"}' }] };
      yield { done: true };
    });
    const view = fakeView({ callId: CALL_A, lineState: 'ivr' });
    view.nonces.set('nonceviahttp1', 'Hello from the relay, 👋 over real HTTP.');
    const baseUrl = await listen(provider, [view]);
    const client = createProvider({ ...cfg(), veniceKey: SECRET }, baseUrl);

    const history = body(CALL_A, them('Hello?'), nonceMsg('nonceviahttp1'))
      .messages as ChatMessage[];
    let text = '';
    for await (const d of client.streamChat(history)) text += d.text ?? '';
    expect(text).toBe('Hello from the relay, 👋 over real HTTP.');

    const calls = new Map<number, { id?: string; name?: string; args: string }>();
    for await (const d of client.streamChat(
      body(CALL_A, them('Press 2.')).messages as ChatMessage[],
    )) {
      for (const tc of d.toolCalls ?? []) {
        const c = calls.get(tc.index) ?? { args: '' };
        if (tc.id) c.id = tc.id;
        if (tc.name) c.name = tc.name;
        c.args += tc.argumentsDelta ?? '';
        calls.set(tc.index, c);
      }
    }
    expect(turn).toBe(1);
    expect(calls.get(0)).toEqual({ id: 'call_9', name: 'press_keys', args: '{"digits":"2"}' });
  });

  it('aborts the LLM stream when AAI drops the request', async () => {
    const provider = new FakeProvider(hangUntilAbort);
    const baseUrl = await listen(provider, [fakeView({ callId: CALL_A })]);
    const ac = new AbortController();
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(body(CALL_A, them('Hello?'))),
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    await reader?.read(); // first bytes (role chunk) arrive right away
    ac.abort();
    const deadline = Date.now() + 2000;
    while (!provider.calls[0]?.signal.aborted && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(provider.calls[0]?.signal.aborted).toBe(true);
  });
});
