// Web Audio glue for the practice line: creates the AudioContext, loads the
// mic/player worklets, opens the mic and wires everything together. Kept
// separate from LinePage so the page's render logic stays free of Web Audio
// specifics, and so the pure math in ./mulaw and ./resample (used inside the
// worklets) can be unit-tested without any of this.
import micWorkletUrl from './micWorklet.ts?worker&url';
import playerWorkletUrl from './playerWorklet.ts?worker&url';

export interface LineAudioHandlers {
  /** One 20 ms / 160-byte mu-law frame of mic audio, ready to send over the socket. */
  onAudioFrame: (mu: Uint8Array) => void;
  /** Rough 0..1 mic input level, sampled a few times a second, for the level meter. */
  onLevel: (level: number) => void;
}

export interface LineAudio {
  /** Feed one incoming mu-law frame (from the socket) to the speaker. */
  playFrame: (mu: Uint8Array) => void;
  setMuted: (muted: boolean) => void;
  /** Stops the mic, disconnects the graph and closes the AudioContext. Safe to call more than once. */
  stop: () => void;
}

const LEVEL_FFT_SIZE = 512;
const LEVEL_HZ = 12;

/**
 * Must be called synchronously at the top of a user-gesture handler (the
 * Answer tap) -- Mobile Safari only allows creating/resuming an AudioContext
 * inside the gesture itself, not after an `await`.
 */
export function createLineAudioContext(): AudioContext {
  return new AudioContext();
}

/** Loads the worklets, opens the mic and wires the audio graph. Throws if either step fails. */
export async function startLineAudio(
  ctx: AudioContext,
  handlers: LineAudioHandlers,
): Promise<LineAudio> {
  if (ctx.state === 'suspended') await ctx.resume();

  await Promise.all([
    ctx.audioWorklet.addModule(micWorkletUrl),
    ctx.audioWorklet.addModule(playerWorkletUrl),
  ]);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  const source = ctx.createMediaStreamSource(stream);

  const micNode = new AudioWorkletNode(ctx, 'carryover-mic', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
  });
  micNode.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
    handlers.onAudioFrame(new Uint8Array(ev.data));
  };
  source.connect(micNode);

  const playerNode = new AudioWorkletNode(ctx, 'carryover-player', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  playerNode.connect(ctx.destination);

  const analyser = ctx.createAnalyser();
  analyser.fftSize = LEVEL_FFT_SIZE;
  analyser.smoothingTimeConstant = 0.6;
  source.connect(analyser);
  const levelData = new Float32Array(analyser.fftSize);
  const levelTimer = setInterval(() => {
    analyser.getFloatTimeDomainData(levelData);
    let sumSquares = 0;
    for (const v of levelData) sumSquares += v * v;
    const rms = Math.sqrt(sumSquares / levelData.length);
    // A comfortable speaking voice sits well under full scale; scale up so
    // the meter reads as more than a sliver, then clamp.
    handlers.onLevel(Math.min(1, rms * 4));
  }, 1000 / LEVEL_HZ);

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(levelTimer);
    for (const track of stream.getTracks()) track.stop();
    for (const node of [source, micNode, playerNode, analyser]) {
      try {
        node.disconnect();
      } catch {
        // already disconnected or never connected; nothing to clean up
      }
    }
    micNode.port.onmessage = null;
    ctx.close().catch(() => {
      // the context may already be closing/closed; nothing more to do
    });
  };

  return {
    playFrame: (mu) => playerNode.port.postMessage(mu),
    setMuted: (muted) => {
      for (const track of stream.getAudioTracks()) track.enabled = !muted;
    },
    stop,
  };
}
