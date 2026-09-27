import { dtmfMulaw } from '../audio/dtmf.js';

// One side of a phone call: the other party (a browser practice line, a simulated
// business, or a real phone number). Audio is G.711 μ-law 8 kHz mono both ways.
export interface PhoneLeg {
  readonly label: string; // "Riverside Pharmacy (simulated)", "Practice line ABC123", "+1 555…"
  readonly kind: 'line' | 'scenario' | 'pstn';
  start(): Promise<void>; // dial / ring; resolves when connected (answered)
  onAudio(cb: (mu: Buffer) => void): void; // inbound audio from the other party (any frame size)
  sendAudio(mu: Buffer): void; // outbound (agent speech, DTMF)
  sendDtmf(digits: string): void; // default impl: defaultSendDtmf
  onEnded(cb: (reason: string) => void): void;
  hangup(reason: string): Promise<void>;
}

// In-band DTMF: the tones go down the same audio path as speech. Legs without an
// out-of-band keypad use this as their sendDtmf.
export function defaultSendDtmf(leg: Pick<PhoneLeg, 'sendAudio'>, digits: string): void {
  const keys = digits.replace(/[^0-9*#]/g, '');
  if (keys) leg.sendAudio(dtmfMulaw(keys));
}
