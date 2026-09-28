// Runs inside AudioWorkletGlobalScope. Receives mu-law 8 kHz frames from the
// line socket (posted to this worklet's port on the main thread), decodes
// and upsamples them to the AudioContext's own rate, and feeds a ring buffer
// that `process()` drains once per render quantum. Capped at 1.5 s so a
// network stall does not build unbounded latency; on underrun it plays
// silence rather than stalling or repeating audio.
import { decodeMulaw } from './mulaw';
import { createUpsampleState, type UpsampleState, upsampleFrom8k } from './resample';
import { RingBuffer } from './ringBuffer';

const MAX_BUFFER_SECONDS = 1.5;

class PlayerProcessor extends AudioWorkletProcessor {
  private resampleState: UpsampleState = createUpsampleState();
  private readonly ring: RingBuffer;

  constructor() {
    super();
    this.ring = new RingBuffer(Math.ceil(sampleRate * MAX_BUFFER_SECONDS));
    this.port.onmessage = (ev: MessageEvent<ArrayBuffer | Uint8Array>) => {
      const mu = ev.data instanceof Uint8Array ? ev.data : new Uint8Array(ev.data);
      const pcm = decodeMulaw(mu);
      const { output, state } = upsampleFrom8k(pcm, sampleRate, this.resampleState);
      this.resampleState = state;
      this.ring.push(output);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channel = outputs[0]?.[0];
    if (channel) this.ring.read(channel);
    return true;
  }
}

registerProcessor('carryover-player', PlayerProcessor);
