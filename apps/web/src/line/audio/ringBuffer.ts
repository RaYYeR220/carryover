/**
 * A fixed-capacity FIFO of float samples. Used by the player worklet to
 * smooth the agent's audio between WebSocket frame arrivals: pushed on
 * message, read once per render quantum. Pure and allocation-free after
 * construction, so it is safe to use inside an AudioWorkletProcessor.
 */
export class RingBuffer {
  private readonly buf: Float32Array;
  private readonly capacity: number;
  private head = 0; // index of the oldest buffered sample
  private count = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.buf = new Float32Array(this.capacity);
  }

  /** Number of samples currently buffered. */
  get length(): number {
    return this.count;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  /** Appends `samples`. If that would exceed capacity, drops the oldest samples first. */
  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      const writeIndex = (this.head + this.count) % this.capacity;
      this.buf[writeIndex] = samples[i] ?? 0;
      if (this.count < this.capacity) this.count++;
      else this.head = (this.head + 1) % this.capacity; // full: the write above just replaced the oldest sample
    }
  }

  /** Fills `out` with the oldest buffered samples, consuming them. Pads any shortfall with silence. */
  read(out: Float32Array): void {
    const n = Math.min(out.length, this.count);
    for (let i = 0; i < n; i++) {
      out[i] = this.buf[(this.head + i) % this.capacity] ?? 0;
    }
    for (let i = n; i < out.length; i++) out[i] = 0;
    this.head = (this.head + n) % this.capacity;
    this.count -= n;
  }
}
