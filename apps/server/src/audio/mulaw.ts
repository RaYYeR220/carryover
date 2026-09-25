// G.711 mu-law codec: 16-bit linear PCM <-> 8-bit mu-law, per ITU-T G.711.
const BIAS = 0x84;
const CLIP = 32635;

export function linearToMulaw(sample: number): number {
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {}
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function mulawToLinear(byte: number): number {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const s = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -s : s;
}

export function encodeMulaw(pcm: Int16Array): Buffer {
  const out = Buffer.alloc(pcm.length);
  let i = 0;
  for (const sample of pcm) {
    out[i++] = linearToMulaw(sample);
  }
  return out;
}

export function decodeMulaw(mu: Buffer): Int16Array {
  const out = new Int16Array(mu.length);
  let i = 0;
  for (const byte of mu) {
    out[i++] = mulawToLinear(byte);
  }
  return out;
}
