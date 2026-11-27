// The model uses (shared/model/models-uses.ts, 01.11.2026): one fixed list, each "auto" or a model of any connection;
// which models serve which use; settings.json's Models section (routing/uses-settings.ts: the check).
// Owns: nothing in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_USES, chosenFor, isProviderChoice, modelsFor, servesUse, useValue } from '../../../src/shared/model/models-uses.ts';
import { validateRouting } from '../../../src/runtime/routing/uses-settings.ts';
import { defaultSettings } from '../../../src/runtime/settings/defaults.ts';
import { settingsText } from '../../../src/runtime/settings/schema.ts';
import type { ModelInfo } from '../../../src/shared/model/providers.ts';
import type { RoutingSettings } from '../../../src/shared/model/system.ts';

const defaults = defaultSettings({ locale: 'en-US', timezone: 'UTC' });
const pc = { language: 'en', timezone: 'UTC' };

const model = (id: string, patch: Partial<ModelInfo> = {}): ModelInfo => {
  const [provider, name] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  return { id, provider: provider as ModelInfo['provider'], model: name, name, engine: 'compatible', efforts: [], caps: {}, tier: 'strong', strengths: {}, available: true, accounts: ['acc_1'], ...patch };
};

test('the uses: one fixed list, every one "auto" by default in settings.json', () => {
  assert.deepEqual([...MODEL_USES], ['work', 'decision', 'voice', 'stt', 'tts', 'speech', 'image', 'video', 'music', 'sound', 'embeddings']);
  for (const use of MODEL_USES) assert.equal(defaults.routing[use], 'auto', use);
  const text = settingsText(defaults, pc);
  assert.match(text, /\/\/ Work – every agent turn[^\n]*"auto"[^\n]*a plan such as "codex"/);
  assert.match(text, /\/\/ Speech to text – [^\n]*, or "off"/);
  assert.match(text, /"decision": "auto"/);
  assert.doesNotMatch(text, /decisionModel|"functions"|"helper"|workPlan|realtimeModel/);
});

test('reading a use: "auto" when unset, "off" only for media', () => {
  assert.equal(useValue(undefined, 'work'), 'auto');
  assert.equal(useValue({ stt: 'off' }, 'stt'), 'off');
  assert.equal(useValue({ work: 'off' }, 'work'), 'auto', 'work cannot be off');
  assert.equal(chosenFor({ image: 'openai:gpt-image-2' }, 'image'), 'openai:gpt-image-2');
  assert.equal(chosenFor({ image: 'off' }, 'image'), undefined);
  assert.equal(isProviderChoice('codex'), true);
  assert.equal(isProviderChoice('whisper-1'), false, 'a bare model name is no plan');
  assert.equal(isProviderChoice('codex:gpt-6'), false);
});

test('which models serve which use', () => {
  const chat = model('codex:gpt-6.1-sol', { strengths: { chat: 0.5 } });
  const never = model('local:tev1', { strengths: { chat: -1 } });
  const whisper = model('openai:whisper-1', { functions: ['stt'] });
  const image = model('openai:gpt-image-2', { functions: ['image'] });
  const realtime = model('openai:gpt-realtime');
  const off = model('openai:gpt-6', { available: false });
  const all = [chat, never, whisper, image, realtime, off];
  assert.deepEqual(modelsFor('work', all).map((entry) => entry.id), ['codex:gpt-6.1-sol']);
  assert.deepEqual(modelsFor('decision', all).map((entry) => entry.id), ['codex:gpt-6.1-sol']);
  assert.deepEqual(modelsFor('voice', all).map((entry) => entry.id), ['openai:gpt-realtime']);
  assert.deepEqual(modelsFor('stt', all).map((entry) => entry.id), ['openai:whisper-1']);
  assert.deepEqual(modelsFor('image', all).map((entry) => entry.id), ['openai:gpt-image-2']);
  assert.equal(servesUse(realtime, 'work'), false, 'a realtime stream is no work model');
});

test('settings.json: the check of the Models section', () => {
  const bad = (path: string, expected: string): never => { throw new Error(`${path}: ${expected}`); };
  const ok: RoutingSettings = { ...defaults.routing, work: 'codex', stt: 'off', image: 'openai:gpt-image-2' };
  validateRouting(ok, bad);
  assert.throws(() => validateRouting({ ...ok, work: 'off' }, bad), /routing.work/);
  assert.throws(() => validateRouting({ ...ok, decision: 'two words' }, bad), /routing.decision/);
  assert.throws(() => validateRouting({ ...ok, voice: '' }, bad), /routing.voice/);
  assert.throws(() => validateRouting({ ...ok, costMode: 'cheap' as never }, bad), /routing.costMode/);
});
