// Call speed 27.11.2026 (Konrad: the local voice's steps become a setting, 3 or 6, the default stays 6 for now and changes
// in one line): voice.speak (runtime/voice/local/service.ts) asks the voice for `voice.localTtsSteps` steps – 3 or 6, and
// 6 (DEFAULT_TTS_STEPS) when the key is unset or holds anything else; settings.json keeps no default of its own for the
// key (so a new DEFAULT_TTS_STEPS reaches every PC), and validation takes only 3, 6 or nothing.
// Owns: these assertions only. Never: the real addon, a model file or the app's settings file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { LocalSpeechEngine } from '../../../src/runtime/voice/local/engine.ts';
import { LocalSpeech } from '../../../src/runtime/voice/local/service.ts';
import { syncedSettings } from '../../../src/runtime/devices/sync/settings.ts';
import { defaultSettings } from '../../../src/runtime/settings/defaults.ts';
import { SECTIONS } from '../../../src/runtime/settings/schema.ts';
import { validateSettings } from '../../../src/runtime/settings/validate.ts';
import type { Settings } from '../../../src/shared/model/system.ts';
import { DEFAULT_TTS_STEPS, TTS_STEPS, localSpeechModel, ttsSteps } from '../../../src/shared/model/local-speech-models.ts';
import { fakeAddon, installFake, quietLog, tempData } from './local-fixture.ts';

const VOICE = localSpeechModel('supertonic-3-int8', 'tts')!;

/** The numSteps the voice was asked for when voice.speak read `text` with these voice settings. */
async function stepsFor(voice: Record<string, unknown>): Promise<unknown[]> {
  const data = tempData();
  try {
    installFake(data.dir, VOICE);
    const { addon, state } = fakeAddon();
    const engine = new LocalSpeechEngine({ dataDir: () => data.dir, log: quietLog, addon: () => addon, freeMemoryMb: () => 4_000, idleMs: 60_000 });
    const settings = { profile: { language: 'en' }, voice: { localTts: VOICE.id, ...voice } };
    const services = { paths: { data: data.dir }, log: quietLog, settings: { get: () => settings } } as unknown as RuntimeServices;
    const local = new LocalSpeech({ services: () => services, engine, systemLocale: () => 'en-US' });
    await local.speak({ text: 'Good question, the train takes about two hours.' });
    return state.tts.flatMap((entry) => entry.requests.map((request) => request.config.numSteps));
  } finally { data.done(); }
}

test('voice.speak: the voice takes the steps of voice.localTtsSteps – 3 and 6', async () => {
  assert.deepEqual(await stepsFor({ localTtsSteps: 3 }), [3]);
  assert.deepEqual(await stepsFor({ localTtsSteps: 6 }), [6]);
});

test('voice.speak: without the key (or with a value it does not know) the default, 6 for now', async () => {
  assert.equal(DEFAULT_TTS_STEPS, 6, 'Konrad 27.11.2026: 6 until Mika heard the 3-step sample');
  assert.deepEqual(await stepsFor({}), [6]);
  assert.deepEqual(await stepsFor({ localTtsSteps: null }), [6]);
  assert.deepEqual(await stepsFor({ localTtsSteps: 4 }), [6]);
  assert.deepEqual([ttsSteps(3), ttsSteps(6), ttsSteps(undefined), ttsSteps('3'), ttsSteps(0)], [3, 6, 6, 6, 6]);
});

test('settings: voice.localTtsSteps offers 3 and 6, keeps no stored default, takes only 3, 6 or nothing and is synced', () => {
  const key = SECTIONS.find((section) => section.key === 'voice')!.keys.find((def) => def.key === 'localTtsSteps');
  assert.ok(key, 'the key is defined');
  assert.deepEqual(key.options, [...TTS_STEPS]);
  assert.equal(key.default, undefined, 'no default in settings.json: DEFAULT_TTS_STEPS decides, in one line');
  const fresh = defaultSettings();
  assert.equal('localTtsSteps' in fresh.voice, false);
  const withSteps = (localTtsSteps: unknown) => ({ ...fresh, voice: { ...fresh.voice, localTtsSteps } }) as Settings;
  for (const ok of [3, 6, undefined]) assert.doesNotThrow(() => validateSettings(withSteps(ok)), String(ok));
  for (const bad of [4, '3', 0]) assert.throws(() => validateSettings(withSteps(bad)), /voice\.localTtsSteps/, String(bad));
  const synced = syncedSettings({ ...fresh, voice: { ...fresh.voice, localTtsSteps: 3 } }) as { voice?: { localTtsSteps?: number } };
  assert.equal(synced.voice?.localTtsSteps, 3, 'the choice goes to the person\'s other PCs with the voice');
});
