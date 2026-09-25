import { describe, expect, it } from 'vitest';
import { dtmfMulaw } from '../../src/audio/dtmf.js';
import { DtmfDetector } from '../../src/audio/goertzel.js';
import { holdMusicMulaw } from '../../src/audio/holdMusic.js';
import { encodeMulaw } from '../../src/audio/mulaw.js';

function detect(buf: Buffer) {
  const got: string[] = [];
  const d = new DtmfDetector((x) => got.push(x));
  for (let i = 0; i < buf.length; i += 160) d.push(buf.subarray(i, i + 160));
  return got.join('');
}

describe('dtmf', () => {
  it('detects every generated digit through μ-law', () => {
    expect(detect(dtmfMulaw('0123456789*#'))).toBe('0123456789*#');
  });
  it('detects repeated digits separately', () => {
    expect(detect(dtmfMulaw('22'))).toBe('22');
  });
  it('does not fire on speech-like noise or hold music', () => {
    const noise = encodeMulaw(
      Int16Array.from({ length: 16000 }, () => Math.round((Math.random() - 0.5) * 12000)),
    );
    expect(detect(noise)).toBe('');
    expect(detect(holdMusicMulaw(5))).toBe('');
  });
});
