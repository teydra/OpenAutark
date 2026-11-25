// 25.11.2026: the anonymous usage count's switch (settings.usage.count): on where a settings file has none, the first run's
// tick writes only what changed, the section is in settings.json's schema with default on, and the wording says what goes out.
// Owns: these assertions. Never: renders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { USAGE_TEXT, usageOn, usagePatch } from '../../../src/ui/settings/usage-count.ts';
import { SECTIONS } from '../../../src/runtime/settings/schema.ts';
import { SECTIONS as PAGES } from '../../../src/ui/settings/sections.ts';

test('absent counts as on; the first run\'s tick writes only a change', () => {
  assert.equal(usageOn(undefined), true);
  assert.equal(usageOn(null), true);
  assert.equal(usageOn({}), true);
  assert.equal(usageOn({ usage: { count: false } }), false);
  assert.equal(usagePatch(undefined, true), undefined, 'left ticked on a new PC: nothing is written');
  assert.deepEqual(usagePatch(undefined, false), { count: false });
  assert.deepEqual(usagePatch({ count: false }, true), { count: true });
  assert.equal(usagePatch({ count: true }, true), undefined);
});

test('settings.json: section usage, key count, default on – and nothing else in it', () => {
  const section = SECTIONS.find((item) => item.key === 'usage');
  assert.deepEqual(section?.keys.map((key) => [key.key, key.type, key.default]), [['count', 'boolean', true]]);
});

test('the words say what goes out and how to stop it; Settings › Security finds the switch by its names', () => {
  for (const word of ['once an hour', 'platform', 'no ID', 'no version', 'no content', 'IP address', 'Off']) assert.ok(USAGE_TEXT.includes(word), word);
  const security = PAGES.find((page) => page.id === 'security');
  for (const word of ['usage count', 'anonymous', 'telemetry', 'analytics']) assert.ok(security?.keywords.includes(word), word);
});
