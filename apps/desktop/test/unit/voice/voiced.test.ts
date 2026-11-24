// 24.11.2026 ("Colearning Salzburg" at the end of a dictation): the voice rule (shared/voice/voiced.ts) – what a
// dictation piece without voice is (silence, steady noise, rumble, hum, a tap, the pause before Stop) and that every
// kind of speech, quiet speech over room noise and a single short word too, holds voice; the WAV form and its limits.
// Owns: these assertions. Never: a recognizer, a microphone or files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pcmHasVoice, VOICE_MIN_MS, voicedMs, wavHasVoice } from '../../../src/shared/voice/voiced.ts';
import { encodeWav } from '../../../src/shared/voice/wav.ts';
import { hum, join, mix, pcm16, RATE, rumble, silence, speech, tap, white } from '../../helpers/voice-signals.ts';

const voiced = (samples: Float32Array) => voicedMs(samples, RATE) >= VOICE_MIN_MS;

test('a piece without voice: digital silence, steady noise, rumble, hum, a tap, a very short piece', () => {
  const cases: Record<string, Float32Array> = {
    'digital silence 8 s': silence(8000),
    'white noise −60 dB': white(3000, 0.001),
    'white noise −45 dB': white(6000, 0.0056),
    'white noise −35 dB': white(10_000, 0.018),
    'rumble −50 dB': rumble(1500, 0.0032),
    'rumble −45 dB': rumble(4000, 0.0056),
    'hum −40 dB': hum(4000, 0.01),
    'room noise and the tap on Stop': join(rumble(4000, 0.0056), tap()),
    'a tap alone': join(white(200, 0.0032), tap()),
    'shorter than a frame': speech(20, 0.1),
  };
  for (const [name, samples] of Object.entries(cases)) assert.equal(voiced(samples), false, `${name}: ${voicedMs(samples, RATE)} ms`);
});

test('speech holds voice: loud, quiet, over room noise, with a long pause after it, one short word', () => {
  const cases: Record<string, Float32Array> = {
    'speech 3 s': speech(3000, 0.1),
    'quiet speech (−40 dB)': speech(3000, 0.01),
    'quiet speech over room noise (0.008 over 0.004)': mix(speech(4000, 0.008), white(4000, 0.004)),
    'speech, then 8 s of silence': join(speech(2000, 0.1), silence(8000)),
    'speech, then 8 s of noise': join(speech(2000, 0.1), white(8000, 0.0056)),
    'one word ("Ja", 300 ms) in a quiet piece': join(white(1000, 0.003), mix(speech(300, 0.05), white(300, 0.003)), white(1000, 0.003)),
    'speech over hum': mix(speech(3000, 0.05), hum(3000, 0.01)),
  };
  for (const [name, samples] of Object.entries(cases)) assert.equal(voiced(samples), true, `${name}: ${voicedMs(samples, RATE)} ms`);
});

test('loud audio is always heard, whatever its shape (a word is never lost to the filter)', () => {
  assert.equal(voiced(new Float32Array(RATE).fill(0.25)), true, 'a steady loud level');
});

test('PCM16 chunks and WAV files read the same; a file the rule cannot read is undefined (heard as before)', () => {
  const words = join(speech(1500, 0.1), silence(500));
  const quiet = join(rumble(2000, 0.0056), tap());
  const bytes = pcm16(words);
  assert.equal(pcmHasVoice([bytes.subarray(0, 1001), bytes.subarray(1001)]), true, 'chunks of any size');
  assert.equal(pcmHasVoice(pcm16(quiet)), false);
  assert.equal(wavHasVoice(encodeWav(words, RATE)), true);
  assert.equal(wavHasVoice(encodeWav(quiet, RATE)), false);
  assert.equal(wavHasVoice(encodeWav(join(speech(1500, 0.1)), 48_000)), true, 'another rate');
  assert.equal(wavHasVoice(new Uint8Array([1, 2, 3, 4, 5])), undefined);
  assert.equal(wavHasVoice(new TextEncoder().encode('OggS not a wav')), undefined);
});
