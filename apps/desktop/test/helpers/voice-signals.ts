// Test audio for the voice rule (shared/voice/voiced.ts): speech-like sound and the non-speech a dictation piece may
// hold – digital silence, steady noise, rumble, hum, a tap on the screen – as mono floats, seeded so every run is equal.
// Owns: these signals. Never: real recordings or files.

export const RATE = 16_000;

/** A seeded noise source in [-1, 1]. */
export function noiseSource(seed = 1): () => number {
  let state = seed >>> 0 || 1;
  return () => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return (state / 0xffffffff) * 2 - 1; };
}

const length = (ms: number) => Math.round(RATE * ms / 1000);

/** Digital silence. */
export const silence = (ms: number) => new Float32Array(length(ms));

/** White noise of RMS about `level`. */
export function white(ms: number, level: number, seed = 2): Float32Array {
  const next = noiseSource(seed);
  return Float32Array.from({ length: length(ms) }, () => next() * level * Math.sqrt(3));
}

/** Rumble: noise below ~15 Hz (traffic, a desk), rising and falling by itself, plus a little white noise. */
export function rumble(ms: number, level: number, seed = 3): Float32Array {
  const next = noiseSource(seed);
  let low = 0;
  return Float32Array.from({ length: length(ms) }, () => { low = 0.995 * low + 0.1 * next(); return level * (3 * low + 0.15 * next()); });
}

/** Mains hum at 50 Hz with some noise. */
export function hum(ms: number, level: number, seed = 4): Float32Array {
  const next = noiseSource(seed);
  return Float32Array.from({ length: length(ms) }, (_, i) => level * (Math.SQRT2 * Math.sin(2 * Math.PI * 50 * i / RATE) + 0.3 * next()));
}

/** A tap on the screen: a click that dies away within a few tens of ms. */
export function tap(level = 0.25, seed = 5): Float32Array {
  const next = noiseSource(seed);
  return Float32Array.from({ length: length(100) }, (_, i) => level * Math.exp(-i / 200) * (next() + Math.sin(i / 3)));
}

/** Speech-like sound of RMS about `level`: a 140 Hz voice with harmonics in syllables of ~250 ms (4 per second). */
export function speech(ms: number, level: number): Float32Array {
  return Float32Array.from({ length: length(ms) }, (_, i) => {
    const t = i / RATE;
    const syllable = Math.max(0, Math.sin(2 * Math.PI * 4 * t)) ** 2;
    const voice = Math.sin(2 * Math.PI * 140 * t) + 0.6 * Math.sin(2 * Math.PI * 280 * t) + 0.4 * Math.sin(2 * Math.PI * 420 * t) + 0.25 * Math.sin(2 * Math.PI * 1100 * t);
    return level * 1.9 * syllable * voice / 1.3;
  });
}

/** Signals one after the other. */
export function join(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** Signals laid over each other (as long as the first). */
export function mix(base: Float32Array, ...over: Float32Array[]): Float32Array {
  const out = Float32Array.from(base);
  for (const part of over) for (let i = 0; i < Math.min(out.length, part.length); i++) out[i] += part[i];
  return out;
}

/** Mono floats as PCM16 LE bytes (what the page's cutter hands on). */
export function pcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  samples.forEach((value, i) => view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(value * 32767))), true));
  return out;
}
