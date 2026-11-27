// 0.3.22 (Mika's check of 0.3.21, 27.11.2026; Konrad's decision): media.speak has its own use, Speech (routing.speech), apart
// from Text to speech, the voice that reads replies aloud and speaks in calls – unset, it follows Text to speech, so a stored
// setting does what it did. A connection whose settings.json entry names what its models are for (providers.<id>.models[].uses)
// serves only those uses while they stand on "auto": a Google key for a voice does not take images, video, music, calls or
// listening. "local" is a value of Voice: a call on this PC's speech, held while a realtime key is connected.
// Owns: these assertions only. Never: a network, a real model or a real settings file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { account, setup } from './harness.ts';
import { functionStatus } from '../../../src/runtime/models/functions.ts';
import { routesFor, type RouteServices } from '../../../src/runtime/media/generate-route.ts';
import { realtimeChoice } from '../../../src/runtime/calls/realtime/setup.ts';
import { listenOptions } from '../../../src/runtime/decision/listener.ts';
import { setUse } from '../../../src/runtime/models/set-use.ts';
import { useWrite } from '../../../src/shared/model/models-uses.ts';
import type { EngineModel } from '../../../src/runtime/engines/types.ts';

const TTS = 'gemini-3.8-flash-tts';
const GOOGLE_LIST: EngineModel[] = [
  { model: TTS, name: TTS, efforts: [] },
  { model: 'gemini-nano-banana-2.1', name: 'gemini-nano-banana-2.1', efforts: [] },
  { model: 'veo-3', name: 'veo-3', efforts: [] },
  { model: 'lyria-3.5', name: 'lyria-3.5', efforts: [] },
  { model: 'gemini-3.8-flash', name: 'gemini-3.8-flash', efforts: [] },
];

/** A Google API key written in settings.json as `providers.google`, its models as Google lists them; this PC's voice is ready. */
async function googleSetup(entry: object) {
  const h = setup();
  h.settings.update({ providers: { google: entry } } as never);
  h.accounts.upsert(account('google', 'google'), false);
  h.engine('compatible').lists.set('google', GOOGLE_LIST);
  await h.catalog.refresh({ force: true });
  Object.assign(h.services, { stt: { localModels: () => ({ engine: { ready: true }, models: [] }) }, paths: { data: '' } });
  return h;
}

const SCOPED = { models: [{ id: TTS, uses: ['tts'] }] };

test('Speech (media.speak) has its own route: Gemini for content while Text to speech keeps this PC\'s voice; unset, it follows Text to speech', async () => {
  const h = await googleSetup(SCOPED);
  const route = () => routesFor(h.services as unknown as RouteServices, 'speech').first;
  h.settings.update({ routing: { tts: 'local', speech: `google:${TTS}` } } as never);
  const made = route();
  assert.equal(made?.via, 'model', 'media.speak speaks with the Speech choice');
  assert.equal(made?.via === 'model' ? made.target.modelId : undefined, `google:${TTS}`);
  assert.equal(functionStatus(h.services, 'tts').setting, 'local', 'Text to speech itself stays this PC\'s voice');
  // nothing on Speech: it does what Text to speech says, as before
  h.settings.update({ routing: { tts: 'local', speech: 'auto' } } as never);
  assert.equal(route()?.via, 'local');
  h.settings.update({ routing: { tts: `google:${TTS}`, speech: 'auto' } } as never);
  assert.equal(route()?.via, 'model');
  h.settings.update({ routing: { tts: 'off', speech: 'auto' } } as never);
  assert.equal(route(), undefined, 'Text to speech off: media.speak off, as before');
});

test('a Google entry for a voice does not take images, video or music on "auto"; without uses it serves all, a choice still counts', async () => {
  const scoped = await googleSetup(SCOPED);
  assert.equal(functionStatus(scoped.services, 'image').choice, undefined, 'images stay where they were');
  assert.equal(functionStatus(scoped.services, 'video').choice, undefined, 'video stays where it was');
  assert.equal(functionStatus(scoped.services, 'music').choice, undefined, 'music stays where it was');
  assert.equal(functionStatus(scoped.services, 'tts').choice?.modelId, `google:${TTS}`, 'the use it names: served');
  scoped.settings.update({ routing: { image: 'google:gemini-nano-banana-2.1' } });
  assert.equal(functionStatus(scoped.services, 'image').choice?.modelId, 'google:gemini-nano-banana-2.1', 'chosen on purpose: served');
  const mixed = await googleSetup({ models: [{ id: TTS, uses: ['speech'] }, { id: 'veo-3', uses: ['video'] }] });
  assert.equal(functionStatus(mixed.services, 'tts').choice, undefined, 'a content-only model does not become the TTS model');
  assert.equal(functionStatus(mixed.services, 'tts', 'speech').choice, undefined, 'Speech on auto inherits TTS auto resolution too');
  mixed.settings.update({ routing: { speech: `google:${TTS}` } });
  assert.equal(functionStatus(mixed.services, 'tts', 'speech').choice?.modelId, `google:${TTS}`);
  assert.equal(functionStatus(mixed.services, 'video').choice?.modelId, 'google:veo-3');
  assert.equal(functionStatus(mixed.services, 'image').choice, undefined, 'the model without a declared use does not auto-serve image');
  const plain = await googleSetup({});
  assert.equal(functionStatus(plain.services, 'image').choice?.modelId, 'google:gemini-nano-banana-2.1', 'an entry that names no uses serves what its models make');
});

/** The realtime and listening reads on one Google key: what the catalog lists, the entry, the stored uses. */
function voiceServices(entry: object, routing: Record<string, string> = {}) {
  const google = account('google', 'google');
  const listed = [
    { id: 'google:gemini-3.8-live', provider: 'google', model: 'gemini-3.8-live', engine: 'compatible', accounts: ['google'], available: true, caps: {}, functions: [] },
    { id: 'google:gemini-3.8-flash', provider: 'google', model: 'gemini-3.8-flash', engine: 'compatible', accounts: ['google'], available: true, caps: {}, functions: [] },
  ];
  return {
    accounts: { list: () => [google], get: () => google, candidates: () => [google] },
    catalog: { list: () => listed, get: (id: string) => listed.find((model) => model.id === id) },
    settings: { get: () => ({ providers: { google: entry }, routing: { allowPaidFallback: true, ...routing }, voice: { realtime: 'auto' } }) },
  } as never;
}

test('a Google entry for a voice does not take calls or listening on "auto"; one that names them does', () => {
  assert.equal(realtimeChoice(voiceServices(SCOPED)), undefined, 'no realtime call on a key named for speech');
  assert.deepEqual(listenOptions(voiceServices(SCOPED)).models, [], 'media.listen does not move to it');
  assert.equal(realtimeChoice(voiceServices({ models: [{ id: 'gemini-3.8-live', uses: ['voice'] }] }))?.model, 'gemini-3.8-live');
  assert.equal(realtimeChoice(voiceServices({}))?.model, 'gemini-3.8-live', 'an entry without uses: as before');
  assert.equal(listenOptions(voiceServices({})).models.length, 1);
});

test('"local" is a value of Voice: stored, held while a realtime key is connected, and models.setUse takes it', async () => {
  assert.deepEqual(useWrite('voice', 'local', []), { routing: { voice: 'local' }, voice: { realtime: 'off' } });
  assert.equal(realtimeChoice(voiceServices({}, { voice: 'local' })), undefined, 'a call stays on this PC\'s speech');
  const h = await googleSetup({});
  const uses = await setUse(h.services, 'voice', 'local', { pull: async () => assert.fail('no download needed') });
  assert.equal(h.settings.get().routing.voice, 'local');
  assert.equal(h.settings.get().voice.realtime, 'off');
  assert.equal(uses.find((use) => use.use === 'voice')?.thisPc, true);
});
