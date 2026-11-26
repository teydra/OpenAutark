// Settings audit 23.10.: a phone with the 'settings' tier changes preferences and notifications. The PC's own
// preferences (login item, automatic update download) change the PC: owner 12.11.2026 – my securely
// paired phone reaches all my settings, so a secure 'settings' device changes them; a plain-LAN device does not.
// B-084: on a secure transport (my phone app) such a device also writes routing, voice and devices; on plain LAN it does not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import type { ClientScope, DeviceCapability } from '../../../src/shared/api/protocol.ts';
import type { Settings } from '../../../src/shared/model/system.ts';
import { OWNER, TestClient, rpcFixture } from './s1-helpers.ts';

const FULL: DeviceCapability[] = ['todo', 'chat', 'tasks', 'settings', 'manage', 'permissions'];
const phoneScope: ClientScope = { kind: 'device', deviceId: 'dev_keys', capabilities: FULL, secure: true };

test('a plain-LAN device may not change the PC preferences; the secure phone and the owner may; other preferences stay open', async (t) => {
  const f = rpcFixture({ table: createHandlerTable() });
  t.after(f.cleanup);
  const lan = new TestClient(f.server, { ...phoneScope, deviceId: 'dev_lan_prefs', secure: false });
  const phone = new TestClient(f.server, phoneScope);
  const before = f.services.settings.get().preferences;
  for (const key of ['openAtLogin', 'autoDownloadUpdates']) {
    const refused = await lan.request('settings.update', { preferences: { theme: 'dark', [key]: !before[key as 'openAtLogin'] } });
    assert.equal(refused.error?.code, 'forbidden', key);
    assert.equal((refused.error?.details as { key?: string } | undefined)?.key, key);
  }
  assert.deepEqual(f.services.settings.get().preferences, before, 'nothing of a refused patch is stored');
  const pc = await phone.call<Settings>('settings.update', { preferences: { openAtLogin: !before.openAtLogin, autoDownloadUpdates: !before.autoDownloadUpdates } });
  assert.deepEqual([pc.preferences.openAtLogin, pc.preferences.autoDownloadUpdates], [!before.openAtLogin, !before.autoDownloadUpdates], 'my secure phone changes the PC preferences');
  const changed = await phone.call<Settings>('settings.update', { preferences: { theme: 'dark', enterSends: false }, notifications: { sound: false } });
  assert.equal(changed.preferences.theme, 'dark');
  assert.equal(changed.preferences.enterSends, false);
  assert.equal(changed.notifications.sound, false);
  const owner = new TestClient(f.server, OWNER);
  const mine = await owner.call<Settings>('settings.update', { preferences: { openAtLogin: true, autoDownloadUpdates: true } });
  assert.deepEqual([mine.preferences.openAtLogin, mine.preferences.autoDownloadUpdates], [true, true]);
});

test('B-084: a secure settings device (my phone app) may write routing, voice and devices; a LAN device and one without settings may not', async (t) => {
  const f = rpcFixture({ table: createHandlerTable() });
  t.after(f.cleanup);
  const before = f.services.settings.get();
  const patch = { routing: { allowPaidFallback: !before.routing.allowPaidFallback }, voice: { talker: before.voice.talker === false }, devices: { findable: before.devices.findable === false } };
  const lan = new TestClient(f.server, { ...phoneScope, deviceId: 'dev_lan', secure: false });
  const noSettings = new TestClient(f.server, { ...phoneScope, deviceId: 'dev_plain', capabilities: ['todo', 'chat'] });
  for (const [section, value] of Object.entries(patch)) {
    const refused = await lan.request('settings.update', { [section]: value });
    assert.equal(refused.error?.code, 'forbidden', `LAN ${section}`);
    assert.match(refused.error?.message ?? '', /may only change appearance and notification settings/);
    assert.equal((await noSettings.request('settings.update', { [section]: value })).error?.code, 'forbidden', `no settings ${section}`);
  }
  assert.equal((await lan.request('settings.update', { profile: { name: 'X' } })).error?.code, 'forbidden');
  assert.deepEqual(f.services.settings.get(), before, 'nothing of a refused patch is stored');
  assert.equal((await lan.call<Settings>('settings.update', { notifications: { sound: false } })).notifications.sound, false, 'notifications stay open on LAN');
  const phone = new TestClient(f.server, phoneScope);
  const changed = await phone.call<Settings>('settings.update', patch);
  assert.equal(changed.routing.allowPaidFallback, patch.routing.allowPaidFallback);
  assert.equal(changed.voice.talker, patch.voice.talker);
  assert.equal(changed.devices.findable, patch.devices.findable);
  const other = await phone.request('settings.update', { models: {} });
  assert.equal(other.error?.code, 'forbidden', 'unlisted sections stay the PC’s');
  assert.equal((await phone.call<Settings>('settings.update', { preferences: { openAtLogin: true } })).preferences.openAtLogin, true, 'the secure phone sets the PC login item');
  assert.equal((await lan.request('settings.update', { preferences: { openAtLogin: false } })).error?.code, 'forbidden', 'plain LAN does not');
});

test('mobile owner settings: secure settings device edits profile/day, other callers do not acquire owner authority', async (t) => {
  const f = rpcFixture({ table: createHandlerTable() });
  t.after(f.cleanup);
  const patch = { profile: { name: 'Mobile owner', company: 'Example' }, day: { workStart: '08:00', workEnd: '17:00', planAt: '07:30' }, preferences: { keepPcAwake: false } };
  for (const scope of [
    { ...phoneScope, secure: false },
    { ...phoneScope, capabilities: ['todo'] as DeviceCapability[] },
    { kind: 'person', personId: 'per_example', deviceId: 'dev_person', tokenId: 'token_example', secure: true } as ClientScope,
  ]) {
    const before = f.services.settings.get();
    const client = new TestClient(f.server, scope);
    assert.equal((await client.request('settings.update', patch)).error?.code, 'forbidden');
    assert.deepEqual(f.services.settings.get(), before, 'refused patch has no partial effect');
  }
  const phone = new TestClient(f.server, phoneScope);
  const saved = await phone.call<Settings>('settings.update', patch);
  assert.equal(saved.profile.name, patch.profile.name);
  assert.equal(saved.profile.company, patch.profile.company);
  assert.equal(saved.day?.workStart, '08:00');
  assert.equal(saved.preferences.keepPcAwake, false);
  assert.equal((await phone.request('settings.update', { day: { keepAwake: true } })).error?.code, 'bad_request', 'the legacy key is not writable');
  const before = f.services.settings.get();
  const lan = new TestClient(f.server, { ...phoneScope, deviceId: 'dev_lan_host', secure: false });
  assert.equal((await lan.request('settings.update', { preferences: { theme: 'dark', openAtLogin: !before.preferences.openAtLogin } })).error?.code, 'forbidden');
  assert.equal((await lan.request('settings.update', { preferences: { keepPcAwake: true } })).error?.code, 'forbidden');
  assert.deepEqual(f.services.settings.get(), before, 'a plain-LAN PC preference refuses the whole patch');
});

test("the global cost mode is the owner's and his secure phone's (like settings.update's routing, B-084); other devices keep agent costs and the other global fields", async (t) => {
  const f = rpcFixture({ table: createHandlerTable() });
  t.after(f.cleanup);
  const phone = new TestClient(f.server, phoneScope);
  const lan = new TestClient(f.server, { ...phoneScope, deviceId: 'dev_lan', secure: false });
  const refused = await lan.request('models.setPolicy', { policy: { costMode: 'best', effort: 'high' } });
  assert.equal(refused.error?.code, 'forbidden', 'a plain LAN browser does not set the global cost mode');
  assert.equal(f.extras.policyStore.size, 0, 'nothing of the refused policy is stored');
  await phone.call('models.setPolicy', { policy: { costMode: 'economy' } });
  assert.equal(f.extras.policyStore.get('|')?.costMode, 'economy', 'B-083/B-084: the secure phone with settings sets it like settings.update routing');
  await phone.call('models.setPolicy', { policy: { effort: 'high' } });
  await phone.call('models.setPolicy', { agentId: 'ag_01jab3k9z7mx2c4q', policy: { costMode: 'economy' } });
  assert.deepEqual(f.extras.policyStore.get('ag_01jab3k9z7mx2c4q|'), { costMode: 'economy' });
  await new TestClient(f.server, OWNER).call('models.setPolicy', { policy: { costMode: 'best' } });
  assert.equal(f.extras.policyStore.get('|')?.costMode, 'best', 'the owner may (policies.ts moves it into routing)');
});

test('General shows the PC behaviour rows on my secure phone, marked as changing the PC', () => {
  const source = readFileSync(new URL('../../../src/ui/settings/GeneralPage.tsx', import.meta.url), 'utf8');
  assert.ok(source.includes('const remote = !bridge && !locked;'), 'only an owner-capable phone without the desktop bridge');
  assert.ok(source.includes('{(bridge || remote) && ('));
  assert.ok(source.includes('On your PC: '), 'the phone rows say they change the PC');
  assert.ok(source.includes("systemInfo.value?.platform === 'win32'"), 'the label follows the PC, not the phone');
  // W2UI (20.11.2026): the update download toggle sits in About beside the version, on every device.
  const about = readFileSync(new URL('../../../src/ui/settings/AboutPage.tsx', import.meta.url), 'utf8');
  assert.ok(about.includes('updatePreferences({ autoDownloadUpdates })'), 'the update download toggle is reachable from the phone');
  assert.ok(about.includes("'On your PC: restarts only when you are idle'"), 'on the phone it says it changes the PC');
});
