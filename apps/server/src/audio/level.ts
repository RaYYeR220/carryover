import { decodeMulaw } from './mulaw.js';

export function rmsDbfs(mu: Buffer): number {
  const pcm = decodeMulaw(mu);
  let sumSquares = 0;
  for (const sample of pcm) {
    const normalized = sample / 32768;
    sumSquares += normalized * normalized;
  }
  const rms = pcm.length > 0 ? Math.sqrt(sumSquares / pcm.length) : 0;
  return 20 * Math.log10(Math.max(rms, 1e-9));
}
