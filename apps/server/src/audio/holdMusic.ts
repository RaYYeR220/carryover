import { encodeMulaw } from './mulaw.js';

const SAMPLE_RATE = 8000;
const CHORD_MS = 2000;
const NOTE_MS = 250;
const ATTACK_MS = 10;
const ARP_PEAK = 0.18 * 32767;
const BASS_PEAK = 0.05 * 32767;

type NoteName = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
const NOTE_SEMITONE: Record<NoteName, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function noteFreq(note: NoteName, octave: number): number {
  const midi = 12 * (octave + 1) + NOTE_SEMITONE[note];
  return 440 * 2 ** ((midi - 69) / 12);
}

// Bounds-checked element access for arrays whose length is guaranteed by
// construction (fixed-size musical tables), so callers don't need `!`.
function at<T>(arr: readonly T[], index: number): T {
  const v = arr[index];
  if (v === undefined) throw new RangeError(`index ${index} out of range`);
  return v;
}

interface Chord {
  bass: readonly [NoteName, number];
  arpeggio: ReadonlyArray<readonly [NoteName, number]>;
}

// C - Am - F - G, two seconds each, arpeggiated root-third-fifth-octave.
const PROGRESSION: readonly Chord[] = [
  {
    bass: ['C', 2],
    arpeggio: [
      ['C', 4],
      ['E', 4],
      ['G', 4],
      ['C', 5],
    ],
  },
  {
    bass: ['A', 2],
    arpeggio: [
      ['A', 3],
      ['C', 4],
      ['E', 4],
      ['A', 4],
    ],
  },
  {
    bass: ['F', 2],
    arpeggio: [
      ['F', 3],
      ['A', 3],
      ['C', 4],
      ['F', 4],
    ],
  },
  {
    bass: ['G', 2],
    arpeggio: [
      ['G', 3],
      ['B', 3],
      ['D', 4],
      ['G', 4],
    ],
  },
];

// Deterministic PRNG (mulberry32) so a given seed always reproduces the same
// note-to-note velocity variation.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Triangle wave, 0..1 phase in, -1..1 out. Soft harmonic content by design
// (unlike a square/saw) so it stays well clear of the DTMF detector.
function triangle(phase: number): number {
  const x = phase - Math.floor(phase);
  return x < 0.5 ? 4 * x - 1 : 3 - 4 * x;
}

function noteEnvelope(msIntoNote: number): number {
  if (msIntoNote < ATTACK_MS) return msIntoNote / ATTACK_MS;
  const decayMs = msIntoNote - ATTACK_MS;
  const decayDuration = NOTE_MS - ATTACK_MS;
  const decayRate = -Math.log(0.05) / decayDuration;
  return Math.exp(-decayRate * decayMs);
}

export function holdMusicMulaw(seconds: number, seed = 42): Buffer {
  const totalSamples = Math.max(0, Math.round(seconds * SAMPLE_RATE));
  const pcm = new Int16Array(totalSamples);
  const rand = mulberry32(seed);

  const noteCount = Math.floor((seconds * 1000) / NOTE_MS) + 1;
  const velocities = Array.from({ length: noteCount }, () => 0.85 + rand() * 0.3);

  for (let n = 0; n < totalSamples; n++) {
    const tSec = n / SAMPLE_RATE;
    const tMs = tSec * 1000;

    const chordIndex = Math.floor(tMs / CHORD_MS) % PROGRESSION.length;
    const chord = at(PROGRESSION, chordIndex);
    const msIntoChord = tMs % CHORD_MS;
    const noteSlot = Math.floor(msIntoChord / NOTE_MS) % chord.arpeggio.length;
    const msIntoNote = msIntoChord % NOTE_MS;

    const [noteName, noteOctave] = at(chord.arpeggio, noteSlot);
    const freq = noteFreq(noteName, noteOctave);
    const velocity = at(velocities, Math.floor(tMs / NOTE_MS) % velocities.length);
    const envelope = noteEnvelope(msIntoNote);
    const arp = ARP_PEAK * envelope * velocity * triangle(freq * tSec);

    const bassFreq = noteFreq(chord.bass[0], chord.bass[1]);
    const bass = BASS_PEAK * Math.sin(2 * Math.PI * bassFreq * tSec);

    pcm[n] = Math.max(-32768, Math.min(32767, Math.round(arp + bass)));
  }

  return encodeMulaw(pcm);
}
