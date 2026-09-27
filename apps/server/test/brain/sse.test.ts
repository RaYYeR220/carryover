import { describe, expect, it } from 'vitest';
import { chunk, keepalive, sseHeaders, writeEmpty, writeText } from '../../src/brain/sse.js';

class Sink {
  out = '';
  ended = false;
  write(s: string): boolean {
    if (this.ended) throw new Error('write after end');
    this.out += s;
    return true;
  }
  end(): void {
    this.ended = true;
  }
}

interface Parsed {
  frames: Record<string, unknown>[];
  done: boolean;
  comments: number;
}

function parse(out: string): Parsed {
  const res: Parsed = { frames: [], done: false, comments: 0 };
  for (const block of out.split('\n\n')) {
    if (!block) continue;
    if (block.startsWith(':')) res.comments++;
    else if (block === 'data: [DONE]') res.done = true;
    else res.frames.push(JSON.parse(block.slice('data: '.length)));
  }
  return res;
}

// biome-ignore lint/suspicious/noExplicitAny: test helper over loose JSON
const delta = (f: any) => f.choices[0].delta;
// biome-ignore lint/suspicious/noExplicitAny: test helper over loose JSON
const finish = (f: any) => f.choices[0].finish_reason;

describe('sse', () => {
  it('headers are an event stream without caching or proxy buffering', () => {
    const h = sseHeaders();
    expect(h['Content-Type']).toMatch(/^text\/event-stream/);
    expect(h['Cache-Control']).toBe('no-cache');
    expect(h['X-Accel-Buffering']).toBe('no');
  });

  it('chunk is one OpenAI chat.completion.chunk data frame', () => {
    const s = chunk('id1', 'm', { content: 'hi' });
    expect(s.startsWith('data: ')).toBe(true);
    expect(s.endsWith('\n\n')).toBe(true);
    const f = JSON.parse(s.slice(6));
    expect(f).toMatchObject({
      id: 'id1',
      object: 'chat.completion.chunk',
      model: 'm',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
    });
    expect(JSON.parse(chunk('id1', 'm', {}, 'stop').slice(6)).choices[0].finish_reason).toBe(
      'stop',
    );
  });

  it('writeText streams ~24-char chunks that reassemble exactly, then stop + [DONE]', () => {
    const text =
      'Hi 👋🏽 this is Carryover — calling for Maya about a refill, reference 4471. Ça va? 👨‍👩‍👧';
    const sink = new Sink();
    writeText(sink, 'id', 'm', text);
    const p = parse(sink.out);
    expect(p.done).toBe(true);
    expect(sink.ended).toBe(true);
    expect(delta(p.frames[0])).toEqual({ role: 'assistant', content: '' });
    const contents = p.frames.map((f) => delta(f).content ?? '').filter((c: string) => c !== '');
    expect(contents.join('')).toBe(text);
    expect(contents.length).toBeGreaterThan(2);
    for (const c of contents) {
      expect(Array.from(c).length).toBeLessThanOrEqual(24);
      // never split a surrogate pair
      expect(c).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
    expect(finish(p.frames.at(-1))).toBe('stop');
  });

  it('writeEmpty is a role chunk + finish stop + [DONE] with no content', () => {
    const sink = new Sink();
    writeEmpty(sink, 'id', 'm');
    const p = parse(sink.out);
    expect(p.frames).toHaveLength(2);
    expect(delta(p.frames[0])).toEqual({ role: 'assistant', content: '' });
    expect(finish(p.frames[1])).toBe('stop');
    expect(p.done).toBe(true);
    expect(sink.ended).toBe(true);
  });

  it('writeText with an empty string is the same as writeEmpty', () => {
    const a = new Sink();
    writeText(a, 'id', 'm', '');
    const p = parse(a.out);
    expect(p.frames.every((f) => !delta(f).content)).toBe(true);
    expect(p.done).toBe(true);
  });

  it('keepalive is an SSE comment', () => {
    const sink = new Sink();
    keepalive(sink);
    expect(sink.out).toBe(': keepalive\n\n');
  });
});
