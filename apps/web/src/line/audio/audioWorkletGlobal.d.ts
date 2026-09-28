// Ambient declarations for the small slice of the AudioWorkletGlobalScope API
// used by micWorklet.ts / playerWorklet.ts. TypeScript's "DOM" lib (this
// project's lib) does not include these -- they belong to a separate global
// scope that normally comes from the "webworker" lib, which can't be added
// alongside "DOM" for the rest of the app in one tsconfig. These worklet
// files are the only ones that ever see this scope at runtime.
interface AudioWorkletProcessor {
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare const AudioWorkletProcessor: {
  prototype: AudioWorkletProcessor;
  new (options?: AudioWorkletNodeOptions): AudioWorkletProcessor;
};

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;

/** The owning AudioContext's sample rate, in Hz. Worklet-global-scope only. */
declare const sampleRate: number;
