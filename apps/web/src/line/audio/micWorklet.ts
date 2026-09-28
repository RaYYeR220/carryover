// Runs inside AudioWorkletGlobalScope (loaded via
// `audioContext.audioWorklet.addModule(...)`, see lineAudio.ts). Captures the
// mic input at the AudioContext's own sample rate, downsamples it to 8 kHz,
// encodes it as mu-law, and posts each 20 ms / 160-byte frame to the main
// thread over the worklet port. Pure math lives in ./resample and ./mulaw so
// it stays unit-testable; this file is just the Web Audio glue.
import { encodeMulaw } from './mulaw';
import { createDownsampleState, type DownsampleState, downsampleTo8k } from './resample';

const FRAME_SAMPLES = 160; // 20 ms at 8 kHz mono

class MicProcessor extends AudioWorkletProcessor {
  private resampleState: DownsampleState = createDownsampleState();
  private pending: number[] = [];

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (channel && channel.length > 0) {
      const { output, state } = downsampleTo8k(channel, sampleRate, this.resampleState);
      this.resampleState = state;
      for (let i = 0; i < output.length; i++) this.pending.push(output[i] ?? 0);

      while (this.pending.length >= FRAME_SAMPLES) {
        const frame = Int16Array.from(this.pending.splice(0, FRAME_SAMPLES));
        const mu = encodeMulaw(frame);
        this.port.postMessage(mu, [mu.buffer]);
      }
    }
    // Keep the processor alive for the whole call; the node is torn down
    // explicitly on hang-up/unmount, not by returning false here.
    return true;
  }
}

registerProcessor('carryover-mic', MicProcessor);
