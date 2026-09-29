import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dtmfMulaw } from '../../src/audio/dtmf.js';
import {
  ANSWER_TIMEOUT_MS,
  BrowserLeg,
  CALL_ENDED_DISPLAY_MS,
  MAX_FRAME_BYTES,
} from '../../src/legs/browserLeg.js';
import { LineCodes, type LineHandle } from '../../src/legs/lineCodes.js';
import { FakeSocket } from '../fakes/fakeSocket.js';

const CALLER = 'Carryover relay for Maya';

function setup() {
  const lines = new LineCodes();
  const line = lines.create();
  const page = new FakeSocket();
  line.attachSocket(page.asWs());
  const leg = new BrowserLeg(line, CALLER);
  const ended: string[] = [];
  const heard: Buffer[] = [];
  leg.onEnded((r) => ended.push(r));
  leg.onAudio((mu) => heard.push(mu));
  return { lines, line, page, leg, ended, heard };
}

async function answered() {
  const t = setup();
  const started = t.leg.start();
  t.page.pageJson({ t: 'line.answer' });
  await started;
  return t;
}

function statuses(page: FakeSocket): string[] {
  return (page.json as { t: string; status?: string }[])
    .filter((m) => m.t === 'line.status')
    .map((m) => m.status ?? '');
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('BrowserLeg', () => {
  it('rings the page with the caller label and connects when the page answers', async () => {
    const { leg, line, page } = setup();
    expect(leg.kind).toBe('line');
    expect(leg.label).toBe(`Practice line ${line.code}`);
    expect(page.json[0]).toEqual({ t: 'line.status', status: 'waiting' });

    let resolved = false;
    const started = leg.start().then(() => {
      resolved = true;
    });
    expect(line.status).toBe('ringing');
    expect(page.json.at(-1)).toEqual({ t: 'line.status', status: 'ringing', callerLabel: CALLER });
    await vi.advanceTimersByTimeAsync(5000);
    expect(resolved).toBe(false);

    page.pageJson({ t: 'line.answer' });
    await started;
    expect(resolved).toBe(true);
    expect(line.status).toBe('connected');
    expect(page.json.at(-1)).toEqual({
      t: 'line.status',
      status: 'connected',
      callerLabel: CALLER,
    });
  });

  it('passes binary frames both ways once connected, as sent', async () => {
    const { leg, page, heard } = await answered();
    const fromPage = Buffer.alloc(160, 0x12);
    page.pageAudio(fromPage);
    page.pageAudio(Buffer.alloc(160, 0x13));
    expect(heard).toEqual([fromPage, Buffer.alloc(160, 0x13)]);

    const toPage = Buffer.alloc(800, 0x21);
    leg.sendAudio(toPage);
    expect(page.audio).toEqual([toPage]);
    expect(page.sent.at(-1)?.binary).toBe(true);
  });

  it('drops oversized frames from the page', async () => {
    const { page, heard } = await answered();
    page.pageAudio(Buffer.alloc(MAX_FRAME_BYTES + 1));
    page.pageAudio(Buffer.alloc(MAX_FRAME_BYTES, 0x12));
    expect(heard.map((b) => b.length)).toEqual([MAX_FRAME_BYTES]);
  });

  it('drops audio before the answer', () => {
    const { leg, page, heard } = setup();
    void leg.start().catch(() => undefined);
    page.pageAudio(Buffer.alloc(160, 0x12));
    leg.sendAudio(Buffer.alloc(800, 0x21));
    expect(heard).toEqual([]);
    expect(page.audio).toEqual([]);
  });

  it('plays keypad tones down the line', async () => {
    const { leg, page } = await answered();
    leg.sendDtmf('1#');
    expect(page.audio).toEqual([dtmfMulaw('1#')]);
  });

  it('the page closing ends the call with line-closed, then frees the line once "Call ended." has had a moment to show', async () => {
    const { page, line, ended } = await answered();
    page.pageGone();
    expect(ended).toEqual(['line-closed']);
    expect(line.leg).toBeUndefined();
    expect(line.status).toBe('ended');
    await vi.advanceTimersByTimeAsync(CALL_ENDED_DISPLAY_MS);
    expect(line.status).toBe('waiting');
  });

  it('the page hanging up ends the call with line-hangup', async () => {
    const { page, line, ended } = await answered();
    page.pageJson({ t: 'line.hangup' });
    expect(ended).toEqual(['line-hangup']);
    expect(statuses(page).at(-1)).toBe('ended');
    expect(line.status).toBe('ended');
    await vi.advanceTimersByTimeAsync(CALL_ENDED_DISPLAY_MS);
    expect(statuses(page).at(-1)).toBe('waiting');
    expect(line.status).toBe('waiting');
  });

  it('no answer within 60 s ends the call with no-answer and rejects start()', async () => {
    const { leg, line, ended } = setup();
    const started = leg.start();
    const outcome = started.then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS - 1);
    expect(ended).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ended).toEqual(['no-answer']);
    expect(await outcome).toBe('no answer');
    expect(line.status).toBe('ended');
    await vi.advanceTimersByTimeAsync(CALL_ENDED_DISPLAY_MS);
    expect(line.status).toBe('waiting');
  });

  it('keeps ringing until a page connects late, then it can answer', async () => {
    const lines = new LineCodes();
    const line = lines.create();
    const leg = new BrowserLeg(line, CALLER);
    const started = leg.start();
    await vi.advanceTimersByTimeAsync(10_000);
    const page = new FakeSocket();
    line.attachSocket(page.asWs());
    expect(page.json[0]).toEqual({ t: 'line.status', status: 'ringing', callerLabel: CALLER });
    page.pageJson({ t: 'line.answer' });
    await started;
    expect(line.status).toBe('connected');
  });

  it('hangup from our side tells the page, frees the line, and does not report an end', async () => {
    const { leg, line, page, ended } = await answered();
    await leg.hangup('user-hangup');
    expect(ended).toEqual([]);
    expect(statuses(page).at(-1)).toBe('ended');
    expect(line.status).toBe('ended');
    leg.sendAudio(Buffer.alloc(800));
    expect(page.audio).toEqual([]);

    await vi.advanceTimersByTimeAsync(CALL_ENDED_DISPLAY_MS);
    expect(statuses(page).at(-1)).toBe('waiting');
    expect(line.status).toBe('waiting');

    // the same line takes the next call
    const next = new BrowserLeg(line, CALLER);
    const started = next.start();
    page.pageJson({ t: 'line.answer' });
    await started;
    expect(line.status).toBe('connected');
  });

  it('hanging up while it rings rejects start()', async () => {
    const { leg } = setup();
    const started = leg.start();
    const outcome = started.then(
      () => 'resolved',
      () => 'rejected',
    );
    await leg.hangup('user-hangup');
    expect(await outcome).toBe('rejected');
  });

  it('a busy line refuses a second call', async () => {
    const { line } = await answered();
    const other = new BrowserLeg(line, CALLER);
    await expect(other.start()).rejects.toThrow(/not free/);
    expect(line.status).toBe('connected');
  });

  it('refuses a second page with 4409 while connected; the call and the original page carry on', async () => {
    const { line, page, leg, ended, heard } = await answered();
    const page2 = new FakeSocket();
    line.attachSocket(page2.asWs());
    expect(page2.closed?.code).toBe(4409);
    expect(page.closed).toBeUndefined();
    expect(ended).toEqual([]);
    expect(line.status).toBe('connected');

    page.pageAudio(Buffer.alloc(160, 0x44));
    expect(heard).toHaveLength(1);
    leg.sendAudio(Buffer.alloc(800, 0x45));
    expect(page.audio).toHaveLength(1);
    expect(page2.audio).toHaveLength(0);
  });

  it('still lets a second page take over while only waiting or ringing (not yet connected)', async () => {
    const { leg, line, page } = setup();
    const started = leg.start();
    expect(line.status).toBe('ringing');

    const page2 = new FakeSocket();
    line.attachSocket(page2.asWs());
    expect(page.closed?.code).toBe(4000);
    expect(page2.closed).toBeUndefined();

    page2.pageJson({ t: 'line.answer' });
    await started;
    expect(line.status).toBe('connected');
  });

  it('ignores malformed page messages', async () => {
    const { page, line, ended } = await answered();
    page.pageText('not json');
    page.pageJson({ t: 'line.dance' });
    page.pageJson({ t: 'line.answer' });
    expect(ended).toEqual([]);
    expect(line.status).toBe('connected');
  });

  it('drops frames when the page falls behind instead of queueing them', async () => {
    const { leg, page } = await answered();
    page.bufferedAmount = 100_000;
    leg.sendAudio(Buffer.alloc(800));
    expect(page.audio).toEqual([]);
  });
});

describe('LineCodes', () => {
  it('makes 6-character codes without 0, O, 1 or I', () => {
    const lines = new LineCodes();
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const { code } = lines.create();
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
      seen.add(code);
    }
    expect(seen.size).toBe(300);
  });

  it('finds a line by code, any case', () => {
    const lines = new LineCodes();
    const line = lines.create();
    expect(lines.get(line.code)).toBe(line);
    expect(lines.get(line.code.toLowerCase())).toBe(line);
    expect(lines.get('ZZZZZZ')).toBeUndefined();
    expect(line.status).toBe('waiting');
  });

  it('expires lines after 30 minutes and closes their page', () => {
    let now = 1_000_000;
    const lines = new LineCodes({ now: () => now });
    const line = lines.create();
    const page = new FakeSocket();
    line.attachSocket(page.asWs());
    now += 29 * 60_000;
    expect(lines.get(line.code)).toBe(line);
    now += 2 * 60_000;
    expect(lines.get(line.code)).toBeUndefined();
    expect(line.status).toBe('ended');
    expect(statuses(page).at(-1)).toBe('ended');
    expect(page.closed?.code).toBe(4410);

    // a page that shows up for an expired handle is turned away
    const late = new FakeSocket();
    line.attachSocket(late.asWs());
    expect(late.json).toEqual([{ t: 'line.status', status: 'ended' }]);
    expect(late.closed?.code).toBe(4410);
  });

  it('does not expire a line in the middle of a call', async () => {
    let now = 1_000_000;
    const lines = new LineCodes({ now: () => now });
    const line: LineHandle = lines.create();
    const page = new FakeSocket();
    line.attachSocket(page.asWs());
    const leg = new BrowserLeg(line, CALLER);
    const started = leg.start();
    page.pageJson({ t: 'line.answer' });
    await started;
    now += 31 * 60_000;
    lines.expireOlderThan(30 * 60_000);
    expect(lines.get(line.code)).toBe(line);
    expect(line.status).toBe('connected');
    await leg.hangup('done');
    lines.expireOlderThan(30 * 60_000);
    expect(lines.get(line.code)).toBeUndefined();
  });
});
