// The one mapping of a use's value onto settings (shared/model/models-uses.ts useWrite, what Settings' selects and models.setUse
// write), the plan-first rule of Speech to text (planHears) and the fit notes of local models (local-speech-models.ts).
// Owns: nothing in production.

import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { planHears, useWrite } from '../../../src/shared/model/models-uses.ts';
import { fitLocalSpeech, localChatRamMb, memoryFit } from '../../../src/shared/model/local-speech-models.ts';
import { setUse } from '../../../src/runtime/models/set-use.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';

const OFFERS = [{ id: 'canary', purpose: 'stt', installed: true }, { id: 'parakeet', purpose: 'stt', installed: false }, { id: 'supertonic', purpose: 'tts', installed: true }] as const;

test('useWrite: each value becomes the settings that make it real', () => {
  assert.deepEqual(useWrite('stt', 'codex', OFFERS), { routing: { stt: 'codex' } });
  assert.deepEqual(useWrite('stt', 'canary', OFFERS), { routing: { stt: 'local' }, voice: { localStt: 'canary' } });
  assert.deepEqual(useWrite('stt', 'parakeet', OFFERS), { routing: { stt: 'local' }, download: 'parakeet' });
  assert.deepEqual(useWrite('stt', 'groq:whisper-large-v3', OFFERS), { routing: { stt: 'groq:whisper-large-v3' }, voice: { localStt: '' } });
  assert.deepEqual(useWrite('stt', 'off', OFFERS), { routing: { stt: 'off' }, voice: { localStt: '' } });
  assert.deepEqual(useWrite('stt', 'auto', OFFERS), { routing: { stt: 'auto' } });
  assert.deepEqual(useWrite('tts', 'supertonic', OFFERS), { routing: { tts: 'local' }, voice: { localTts: 'supertonic' } });
  assert.deepEqual(useWrite('voice', 'local', OFFERS), { routing: { voice: 'local' }, voice: { realtime: 'off' } });
  assert.deepEqual(useWrite('voice', 'canary', OFFERS), { routing: { stt: 'local', voice: 'local' }, voice: { localStt: 'canary', realtime: 'off' } });
  assert.deepEqual(useWrite('speech', 'local', OFFERS), { routing: { speech: 'local' } });
  assert.deepEqual(useWrite('speech', 'supertonic', OFFERS), { routing: { speech: 'local' }, voice: { localTts: 'supertonic' } });
  assert.deepEqual(useWrite('speech', 'google:gemini-3.8-flash-tts', OFFERS), { routing: { speech: 'google:gemini-3.8-flash-tts' } });
  assert.deepEqual(useWrite('voice', 'gem:gemini-3.8-live', OFFERS), { routing: { voice: 'gem:gemini-3.8-live' }, voice: { realtime: 'auto' } });
  assert.deepEqual(useWrite('embeddings', 'local', OFFERS), { routing: { embeddings: 'local' } });
  assert.deepEqual(useWrite('work', 'codex', OFFERS), { routing: { work: 'codex' } });
});

test('planHears: the plan first while nothing or the plan is picked', () => {
  assert.equal(planHears(undefined), true);
  assert.equal(planHears({ stt: 'auto' }), true);
  assert.equal(planHears({ stt: 'codex' }), true);
  assert.equal(planHears({ stt: 'local' }), false);
  assert.equal(planHears({ stt: 'openai:gpt-4o-transcribe' }), false);
  assert.equal(planHears({ stt: 'off' }), false);
});

test('fit notes: the usual memory against this PC\'s RAM, the speech fit unchanged', () => {
  assert.equal(memoryFit(500, 8_192), 'good');
  assert.equal(memoryFit(3_000, 8_192), 'tight');
  assert.equal(memoryFit(5_000, 8_192), 'too-big');
  assert.equal(localChatRamMb('llama3.1:8b'), 5_300);
  assert.equal(localChatRamMb('qwen3-30b-a3b'), 18_500);
  assert.equal(localChatRamMb('deepseek-r1:1.5b'), 1_400);
  assert.equal(localChatRamMb('phi4'), undefined, 'no size in the name: no note');
  const fits = fitLocalSpeech({ totalRamMb: 8_192, freeRamMb: 1_000, cpuCores: 4 }, 'de');
  assert.deepEqual(fits.map((row) => [row.id, row.fit]), [['fastconformer-de-int8', 'good'], ['canary-180m-flash-int8', 'good'], ['parakeet-tdt-0.6b-v3-int8', 'tight'], ['supertonic-3-int8', 'good']]);
});

test('models.setUse: one call writes the use and starts a missing local model\'s download', async () => {
  const written: unknown[] = [];
  const pulled: string[] = [];
  const s = {
    settings: { get: () => ({ routing: {}, voice: {} }), update: (patch: unknown) => { written.push(patch); } },
    stt: { localModels: () => ({ engine: { ready: true }, models: [{ id: 'parakeet-tdt-0.6b-v3-int8', purpose: 'stt', installed: false }] }) },
    log: { warn: () => {} },
  } as unknown as RuntimeServices;
  await setUse(s, 'stt', 'parakeet-tdt-0.6b-v3-int8', { pull: async (id) => { pulled.push(id); } }).catch(() => undefined); // the answer reads services this stub leaves out
  assert.deepEqual([written, pulled], [[{ routing: { stt: 'local' } }], ['parakeet-tdt-0.6b-v3-int8']]);
  await assert.rejects(setUse(s, 'work', 'off', { pull: async () => {} }), /cannot be turned off/);
  await assert.rejects(setUse(s, 'talking', 'x', { pull: async () => {} }), /use is one of/);
});

test('the AI\'s guide names the one call that sets a use and the plan\'s dictation', () => {
  const skill = readFileSync(path.join(process.cwd(), 'resources', 'skills', 'ai-providers', 'SKILL.md'), 'utf8');
  assert.match(skill, /`wf call models\.setUse '\{"use":"stt","value":"codex"\}'` sets one use to one value in one call/);
  assert.match(skill, /on `routing\.stt` the plan's dictation/);
});
