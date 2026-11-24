// 24.11.2026 (owner: "Colearning Salzburg" stood at the end of a dictated message he never said – the name of the
// ChatGPT login that heard it): a recognizer given a piece with no speech in it – the pause before Stop, the tap on the
// button, room noise – may write words of its own, and a model with the account behind it writes the account's name.
// The request carried only the file and the language (plan-transcribe.ts, the app's PlanHearing.java), so the cure is
// on our side of it: a dictation piece without voice goes to no recognizer and counts as heard with no words.
// The rule, one for the page (ui/lib/dictation.ts), the runtime (voice/transcribe.ts) and the Android bubble
// (SpokenAudio.voicedMs, same numbers): the piece high-passed at 100 Hz (rumble rises and falls by itself and is no
// speech), in 32 ms frames; a frame is voice when its RMS is at least
// VOICE_MIN_LEVEL and VOICE_FLOOR_RATIO times the piece's own floor (the 20th percentile of its frames), or
// VOICE_LOUD outright; a piece with VOICE_MIN_MS of such frames holds voice. Steady noise, hum and digital silence
// have no frame that rises over their own floor, a tap is shorter than VOICE_MIN_MS; quiet speech over room noise
// (0.008 over 0.004, the take-pieces.ts case) rises by more than the ratio and stays voice.
// Owns: that rule. Never: decides what was said, or touches audio a person keeps (attachments keep every piece).

import { parseWav } from './wav.ts';

/** Below this the audio is rumble, not speech: it is filtered out before the frames are measured. */
export const VOICE_HIGH_PASS_HZ = 100;
/** One frame: 32 ms. */
export const VOICE_FRAME_MS = 32;
/** A frame quieter than this (RMS of full scale, about −48 dBFS) is never voice. */
export const VOICE_MIN_LEVEL = 0.004;
/** A voiced frame rises this far over the piece's floor. */
export const VOICE_FLOOR_RATIO = 1.8;
/** A frame this loud (about −26 dBFS) is voice whatever the floor. */
export const VOICE_LOUD = 0.05;
/** A piece holds voice from this much voiced audio on (a tap on the screen is shorter, the shortest word is longer). */
export const VOICE_MIN_MS = 160;

/** The voiced milliseconds of mono samples in [-1, 1] at `rate` (see the header). */
export function voicedMs(samples: ArrayLike<number>, rate: number): number {
  const frame = Math.max(1, Math.round(rate * VOICE_FRAME_MS / 1000));
  const filtered = highPass(samples, rate);
  const levels: number[] = [];
  const raw: number[] = [];
  for (let start = 0; start + frame <= filtered.length; start += frame) {
    let sum = 0;
    let rawSum = 0;
    for (let index = start; index < start + frame; index++) { sum += filtered[index] * filtered[index]; rawSum += samples[index] * samples[index]; }
    levels.push(Math.sqrt(sum / frame));
    raw.push(Math.sqrt(rawSum / frame));
  }
  if (!levels.length) return 0;
  const floor = [...levels].sort((a, b) => a - b)[Math.floor((levels.length - 1) * 0.2)];
  const bar = Math.max(VOICE_MIN_LEVEL, floor * VOICE_FLOOR_RATIO);
  // loud audio is heard whatever it is (never lose a word to the filter); the ratio is measured above the rumble
  const voiced = levels.filter((level, index) => raw[index] >= VOICE_LOUD || level >= bar).length;
  return voiced * frame * 1000 / rate;
}

/** Rumble below speech (traffic, a desk, wind) rises and falls by itself: two one-pole high-passes at VOICE_HIGH_PASS_HZ take it out. */
function highPass(samples: ArrayLike<number>, rate: number): Float32Array {
  const rc = 1 / (2 * Math.PI * VOICE_HIGH_PASS_HZ);
  const a = rc / (rc + 1 / rate);
  const out = Float32Array.from(samples);
  for (let pass = 0; pass < 2; pass++) {
    let previousIn = out[0] ?? 0;
    let previousOut = 0;
    for (let index = 0; index < out.length; index++) {
      const input = out[index];
      previousOut = a * (previousOut + input - previousIn);
      previousIn = input;
      out[index] = previousOut;
    }
  }
  return out;
}

/** PCM16 LE bytes (one or several chunks, 16 kHz unless said) as mono floats. */
export function pcm16Samples(chunks: Uint8Array | readonly Uint8Array[]): Float32Array {
  const list = chunks instanceof Uint8Array ? [chunks] : chunks;
  const out = new Float32Array(list.reduce((total, chunk) => total + (chunk.byteLength >> 1), 0));
  let at = 0;
  for (const chunk of list) {
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength & ~1);
    for (let index = 0; index < view.byteLength; index += 2) out[at++] = view.getInt16(index, true) / 32768;
  }
  return out;
}

/** Whether 16 kHz PCM16 LE audio holds voice. */
export function pcmHasVoice(chunks: Uint8Array | readonly Uint8Array[], rate = 16_000): boolean {
  return voicedMs(pcm16Samples(chunks), rate) >= VOICE_MIN_MS;
}

/** Whether a WAV file holds voice; undefined when it is no WAV this can read (then nobody knows: hear it). */
export function wavHasVoice(bytes: Uint8Array): boolean | undefined {
  try {
    const audio = parseWav(bytes);
    return voicedMs(audio.samples, audio.sampleRate) >= VOICE_MIN_MS;
  } catch {
    return undefined;
  }
}
