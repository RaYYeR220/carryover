import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { ChatMessage, LlmProvider, StreamDelta } from '../llm/provider.js';
import { checkSentence, type ExtractedFact, splitSentences } from './factGate.js';
import { type BrainCallView, decide, RELAY_TOOLS, systemPrompt } from './policy.js';
import { parseBrainRequest } from './requestParse.js';
import { type SseSink, SseWriter, sseHeaders, writeEmpty } from './sse.js';

// The Relay Brain: the OpenAI-compatible streaming endpoint AAI's Voice Agent calls as its
// LLM. It decides every word the agent says: the user's typed text verbatim, silence, or
// an LLM reply released sentence by sentence through the fact gate.
//
// Contract with AAI (measured in the day-0 spike): it gives up after 10 s without bytes
// (SSE comments keep it waiting), repeated 500s make it retry for ~11 s and then go
// silent, and an empty completion is clean silence. So: never answer 500; every failure
// is an empty completion.

export const BRAIN_PATH = '/brain/v1/chat/completions';

export interface BrainTiming {
  keepaliveMs: number; // SSE comment cadence while the LLM is thinking
  firstOutputTimeoutMs: number; // nothing said by then → polite filler and finish
  maxStreamMs: number; // hard cap on one proxied reply
  stallMs: number; // once something was said, an LLM silent this long ends the reply
}

export const DEFAULT_BRAIN_TIMING: BrainTiming = {
  keepaliveMs: 3000,
  firstOutputTimeoutMs: 8000,
  maxStreamMs: 30000,
  stallMs: 7000,
};

export interface BrainRouteDeps {
  cfg: Config;
  provider: LlmProvider;
  lookup: (callId: string) => BrainCallView | undefined;
  timing?: Partial<BrainTiming>;
}

const TIMEOUT_FILLER = 'Sorry, one moment.';
const DEFAULT_MODEL = 'carryover-brain';
// Menu navigation ("2", "132") is keyed freely; 4+ digits look like an identifier and
// must be in the ledger.
const MIN_GATED_KEYED_DIGITS = 4;

function authorized(header: string | undefined, secret: string): boolean {
  if (!secret || typeof header !== 'string') return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

function modelOf(body: unknown): string {
  const m = (body as { model?: unknown } | null | undefined)?.model;
  return typeof m === 'string' && m.length > 0 && m.length <= 100 ? m : DEFAULT_MODEL;
}

function completionId(): string {
  return `chatcmpl-${randomUUID()}`;
}

function emptyCompletionBody(id: string, model: string): string {
  let out = '';
  const sink: SseSink = {
    write: (s: string) => {
      out += s;
    },
    end: () => undefined,
  };
  writeEmpty(sink, id, model);
  return out;
}

class Aborted extends Error {}

// Iterates `src` but stops as soon as `signal` aborts, even if the source never settles
// (a provider that ignores its AbortSignal must not pin the request forever).
async function* untilAborted<T>(src: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const it = src[Symbol.asyncIterator]();
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new Aborted());
    signal.addEventListener('abort', () => reject(new Aborted()), { once: true });
  });
  aborted.catch(() => undefined);
  try {
    while (true) {
      const next = it.next();
      next.catch(() => undefined);
      const r = await Promise.race([next, aborted]);
      if (r.done) return;
      yield r.value;
    }
  } finally {
    Promise.resolve()
      .then(() => it.return?.())
      .catch(() => undefined);
  }
}

interface ToolAcc {
  id: string;
  name?: string;
  args: string;
  held: boolean;
  headerSent: boolean;
}

// Streams one proxied LLM reply through the fact gate.
async function runProxy(
  w: SseWriter,
  view: BrainCallView,
  history: ChatMessage[],
  provider: LlmProvider,
  timing: BrainTiming,
  ac: AbortController,
): Promise<void> {
  let buffer = '';
  let textEmitted = false;
  let toolEmitted = false;
  let stopped = false;
  const tools = new Map<number, ToolAcc>();

  const finishReason = () => (toolEmitted ? 'tool_calls' : 'stop');

  const emitText = (s: string) => {
    const out = textEmitted ? s : s.trimStart();
    if (!out) return;
    w.text(out);
    textEmitted = true;
  };

  const block = (sentence: string, offending: ExtractedFact[]) => {
    try {
      view.onGateBlocked(sentence, offending);
    } catch {
      // the call's bookkeeping failing must not let the sentence through
    }
    emitText(`${textEmitted ? ' ' : ''}One moment, let me check with ${view.userName}.`);
    stopped = true;
    ac.abort();
  };

  // Returns false when the sentence was blocked (generation must stop).
  const release = (sentence: string): boolean => {
    if (!sentence.trim()) return true;
    const verdict = checkSentence(sentence, view.ledger);
    if (verdict.ok) {
      emitText(sentence);
      return true;
    }
    block(sentence.trim(), verdict.offending);
    return false;
  };

  const onToolDelta = (tc: NonNullable<StreamDelta['toolCalls']>[number]) => {
    let t = tools.get(tc.index);
    if (!t) {
      t = {
        id: tc.id ?? `call_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
        args: '',
        held: false,
        headerSent: false,
      };
      tools.set(tc.index, t);
    }
    if (tc.name && !t.name) t.name = tc.name;
    const piece = tc.argumentsDelta ?? '';
    t.args += piece;
    if (!t.name) return;
    // press_keys is held until complete: keying in an invented number over DTMF is as much
    // a fabrication as saying it, so its digits go through the ledger check at the end.
    if (t.name === 'press_keys') {
      t.held = true;
      return;
    }
    if (!t.headerSent) {
      t.headerSent = true;
      w.toolCalls([
        {
          index: tc.index,
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: t.args },
        },
      ]);
    } else if (piece) {
      w.toolCalls([{ index: tc.index, function: { arguments: piece } }]);
    }
    toolEmitted = true;
  };

  const flushHeldTools = () => {
    for (const [index, t] of tools) {
      if (!t.held || stopped) continue;
      const digits = t.args.replace(/\D/g, '');
      if (digits.length >= MIN_GATED_KEYED_DIGITS) {
        const fact: ExtractedFact = { kind: 'digits', raw: digits, norm: digits };
        if (!view.ledger.has(fact)) {
          block(`press_keys ${digits}`, [fact]);
          return;
        }
      }
      w.toolCalls([
        { index, id: t.id, type: 'function', function: { name: 'press_keys', arguments: t.args } },
      ]);
      toolEmitted = true;
    }
  };

  const keepalive = setInterval(() => w.keepalive(), timing.keepaliveMs);
  const firstOutput = setTimeout(() => {
    if (w.finished || w.hasOutput) return;
    w.text(TIMEOUT_FILLER);
    w.finish('stop');
    ac.abort();
  }, timing.firstOutputTimeoutMs);
  const hardCap = setTimeout(() => {
    w.finish(finishReason());
    ac.abort();
  }, timing.maxStreamMs);
  // Keepalives hold AAI's read timeout off, so a stalled LLM would otherwise mean dead air
  // on the line. After the first output, a silent upstream ends the reply with what was
  // already said.
  let stall: ReturnType<typeof setTimeout> | undefined;
  const armStall = () => {
    clearTimeout(stall);
    stall = setTimeout(() => {
      w.finish(finishReason());
      ac.abort();
    }, timing.stallMs);
  };

  try {
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(view) }, ...history];
    const stream = provider.streamChat(messages, RELAY_TOOLS, ac.signal);
    for await (const d of untilAborted(stream, ac.signal)) {
      if (w.finished) return;
      for (const tc of d.toolCalls ?? []) onToolDelta(tc);
      if (d.text) {
        buffer += d.text;
        const { complete, rest } = splitSentences(buffer);
        buffer = rest;
        for (const s of complete) if (!release(s)) break;
        if (stopped) break;
      }
      if (d.done) break;
      if (w.hasOutput) armStall();
    }
    if (!stopped && !w.finished) {
      release(buffer);
      flushHeldTools();
    }
  } catch (err) {
    // Our own abort (gate block, timeout, client gone) is expected; anything else is an
    // upstream failure: keep whatever was already said and finish cleanly.
    if (!(err instanceof Aborted) && !ac.signal.aborted) throw err;
  } finally {
    clearInterval(keepalive);
    clearTimeout(firstOutput);
    clearTimeout(hardCap);
    clearTimeout(stall);
    w.finish(finishReason());
    ac.abort();
  }
}

export function registerBrainRoute(app: FastifyInstance, deps: BrainRouteDeps): void {
  const timing: BrainTiming = { ...DEFAULT_BRAIN_TIMING, ...deps.timing };

  app.post(
    BRAIN_PATH,
    {
      bodyLimit: 4 * 1024 * 1024,
      // Body parse failures (bad JSON, wrong content type, too large) are silence, not 4xx/5xx.
      errorHandler: (err, req, reply) => {
        req.log.warn({ code: (err as { code?: string }).code }, 'brain: unusable request body');
        return reply
          .code(200)
          .headers(sseHeaders())
          .send(emptyCompletionBody(completionId(), DEFAULT_MODEL));
      },
    },
    async (req, reply) => {
      if (!authorized(req.headers.authorization, deps.cfg.brainSecret)) {
        return reply
          .code(401)
          .send({ error: { message: 'unauthorized', type: 'invalid_request_error' } });
      }

      reply.hijack();
      const res = reply.raw;
      res.on('error', () => undefined);
      res.writeHead(200, sseHeaders());
      const w = new SseWriter(res, completionId(), modelOf(req.body));
      const ac = new AbortController();
      res.on('close', () => {
        if (!w.finished) {
          // AAI abandoned this request (the other party kept talking): stop the LLM.
          w.abandon();
          ac.abort();
        }
      });

      try {
        const parsed = parseBrainRequest(req.body);
        const view = parsed.callTag ? deps.lookup(parsed.callTag.callId) : undefined;
        const decision = decide(parsed, view);
        if (decision.kind === 'verbatim') {
          w.text(decision.text);
        } else if (decision.kind === 'proxy' && view) {
          w.role(); // first bytes out right away
          await runProxy(w, view, parsed.history, deps.provider, timing, ac);
        } else {
          req.log.debug(
            { why: decision.kind === 'silence' ? decision.why : 'no-view' },
            'brain: silence',
          );
        }
      } catch (err) {
        req.log.warn({ err: (err as Error)?.message }, 'brain: failed, answering with silence');
      } finally {
        w.finish('stop');
      }
    },
  );
}
