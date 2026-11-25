// B-078 (D6): phone use through the Android app – AppPhones sends one request per step on the bus and takes only the
// asked phone's answer (20 s timeout, the run's cancel); drivers.ts sends a step to the app phone or to ADB.
// Feedback 16.11.2026 F16: `by` names the agent, op 'say' (75 s for a question), the old-app text. Chat sweep 16.11.:
// an attached app phone comes before ADB, and a type step brings back the field's text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppPhones, FIELD_MAX, OLD_APP_OPEN, OLD_APP_SAY, PHONE_USE_OFF, safeNode } from '../../../src/runtime/phone/app-driver.ts';
import { mergedPhones } from '../../../src/runtime/phone/drivers.ts';
import type { PhoneUseRequest } from '../../../src/shared/api/methods-phone.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { HandTimers } from '../remote/rig.ts';
import { recordingBus } from '../devices/fakes.ts';

function rig(idleMs?: number) {
  const { bus } = recordingBus();
  const timers = new HandTimers();
  const phones = new AppPhones({ bus, devices: () => [{ id: 'dev_phone0000001', name: 'Pixel 8' } as never], timers, ...(idleMs ? { idleMs } : {}) });
  const requests: PhoneUseRequest[] = [];
  bus.on('phoneUse.request', (request) => requests.push(request));
  const reply = (deviceId: string, id: string, body: { result?: unknown; error?: { code: string; message: string } }) => bus.emit('phoneUse.reply', { deviceId, id, ...body });
  bus.emit('phoneUse.attached', { deviceId: 'dev_phone0000001', on: true, model: 'Pixel 8', ready: true });
  return { bus, phones, requests, reply, timers };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a step goes to the attached phone and comes back with its answer only', async () => {
  const { phones, requests, reply } = rig();
  assert.deepEqual(await phones.devices(), [{ serial: 'dev_phone0000001', state: 'device', model: 'Pixel 8', transport: 'autark-app' }]);
  const tap = phones.tap(undefined, 10.4, 20.6);
  await tick();
  assert.deepEqual(requests[0].op, 'tap');
  assert.deepEqual(requests[0].args, { x: 10, y: 21 });
  reply('dev_other000001', requests[0].id, { result: {} }); // another phone cannot answer it
  reply('dev_phone0000001', requests[0].id, { result: {} });
  await tap;

  const tree = phones.uiTree();
  await tick();
  reply('dev_phone0000001', requests[1].id, { result: { nodes: [
    { depth: 0, parent: -1, cls: 'FrameLayout', bounds: [0, 0, 1080, 2400] },
    { depth: 1, parent: 0, cls: 'Button', text: 'Send', clickable: true, bounds: [100, 200, 300, 260], extra: 'x' },
  ], screen: { width: 1080, height: 2400 } } });
  const read = await tree;
  assert.equal(read.serial, 'dev_phone0000001');
  assert.match(read.text, /Button "Send" \(tap\) @200,230/);
  assert.deepEqual(read.screen, { width: 1080, height: 2400 });
});

test('phone use off, a pause on the phone, the timeout and the run\'s cancel each end a step', async () => {
  const { phones, requests, reply, timers } = rig();
  const off = phones.key(undefined, 'back');
  await tick();
  reply('dev_phone0000001', requests[0].id, { error: { code: 'off', message: 'Phone use is off on this phone.' } });
  await assert.rejects(off, (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable' && error.message === PHONE_USE_OFF);

  const paused = phones.type(undefined, 'hi');
  await tick();
  reply('dev_phone0000001', requests[1].id, { error: { code: 'paused', message: 'The person paused phone use for 30 s.' } });
  await assert.rejects(paused, /paused phone use/);

  const slow = phones.open(undefined, { package: 'com.whatsapp' });
  await tick();
  timers.fire(20_000);
  await assert.rejects(slow, (error: unknown) => error instanceof WorkforceError && error.code === 'timeout');

  const abort = new AbortController();
  const cancelled = phones.swipe(undefined, { x: 1, y: 2 }, { x: 3, y: 4 }, 300, { signal: abort.signal });
  abort.abort();
  await assert.rejects(cancelled, (error: unknown) => error instanceof WorkforceError && error.code === 'cancelled');
});

test('a phone that goes offline ends its open steps and leaves the list', async () => {
  const { bus, phones } = rig();
  const shot = phones.screenshot();
  await tick();
  bus.emit('phoneUse.attached', { deviceId: 'dev_phone0000001', on: false });
  await assert.rejects(shot, /went offline/);
  assert.deepEqual(await phones.devices(), []);
  await assert.rejects(phones.tap(undefined, 1, 1), (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable');
});

test('drivers: a step without a serial goes to the app phone while ADB has none ready; a serial picks its phone', async () => {
  const { phones } = rig();
  const adbCalls: string[] = [];
  const adb = {
    available: async () => true,
    devices: async () => [] as never[],
    screenshot: async () => { adbCalls.push('screenshot'); return {} as never; },
    uiTree: async () => ({}) as never,
    tap: async (serial: string | undefined) => { adbCalls.push(`tap ${serial}`); },
    swipe: async () => undefined, type: async () => undefined, key: async () => 'KEYCODE_BACK', open: async () => '',
    say: async () => { adbCalls.push('say'); return { serial: '' }; },
    pair: async () => ({ address: '' }), connect: async () => ({ address: '', already: false }), disconnect: async () => ({ serial: '', was: false }), discover: async () => [], attached: () => [], installed: () => false,
  };
  const merged = mergedPhones(adb, phones);
  assert.deepEqual((await merged.devices()).map((device) => device.serial), ['dev_phone0000001']);
  await merged.tap('192.168.1.20:5555', 1, 1);
  assert.deepEqual(adbCalls, ['tap 192.168.1.20:5555'], 'an ADB serial goes to ADB');
  assert.equal(await merged.available(), true);
});

// Chat sweep 16.11.2026 (owner 10.11.: "Mach das über das Remote-System"): the paired Autark app comes first.
test('drivers: without a serial a step goes to the attached app phone even while ADB has a ready phone; an ADB serial goes to ADB; no app phone → ADB', async () => {
  const { bus, phones, requests, reply } = rig();
  const adbCalls: string[] = [];
  const adb = {
    available: async () => true,
    devices: async () => [{ serial: '192.168.1.20:5555', state: 'device' }] as never[],
    screenshot: async () => ({}) as never, uiTree: async () => ({}) as never,
    tap: async (serial: string | undefined) => { adbCalls.push(`tap ${serial}`); },
    swipe: async () => undefined, type: async () => undefined, key: async () => 'KEYCODE_BACK', open: async () => '',
    say: async () => ({ serial: '' }),
    pair: async () => ({ address: '' }), connect: async () => ({ address: '', already: false }), disconnect: async () => ({ serial: '', was: false }), discover: async () => [], attached: () => [], installed: () => false,
  };
  const merged = mergedPhones(adb, phones);
  const tap = merged.tap(undefined, 5, 6);
  await tick();
  assert.equal(requests[0]?.op, 'tap', 'the app phone got the step');
  reply('dev_phone0000001', requests[0].id, { result: {} });
  await tap;
  assert.deepEqual(adbCalls, []);
  await merged.tap('192.168.1.20:5555', 1, 1);
  assert.deepEqual(adbCalls, ['tap 192.168.1.20:5555'], 'an ADB serial goes to ADB');
  bus.emit('phoneUse.attached', { deviceId: 'dev_phone0000001', on: false });
  await merged.tap(undefined, 2, 2);
  assert.deepEqual(adbCalls, ['tap 192.168.1.20:5555', 'tap undefined'], 'without an app phone the step goes to ADB');
});

test('KI-Runde 17.11.2026: here() names the phones on this PC – app phones by device id, ADB phones as the driver last saw them', () => {
  const { bus, phones } = rig();
  let seen: string[] = [];
  const adb = { attached: () => seen } as unknown as Parameters<typeof mergedPhones>[0];
  const merged = mergedPhones(adb, phones);
  assert.deepEqual(merged.here(), { app: ['dev_phone0000001'], adb: [] });
  seen = ['R5CT1234'];
  bus.emit('phoneUse.attached', { deviceId: 'dev_phone0000001', on: false });
  assert.deepEqual(merged.here(), { app: [], adb: ['R5CT1234'] });
});

test('type: the app\'s answer brings back what the field reads (cut to FIELD_MAX); an older app answers nothing', async () => {
  const { phones, requests, reply } = rig();
  const typed = phones.type(undefined, 'Hallo');
  await tick();
  reply('dev_phone0000001', requests[0].id, { result: { text: 'MessageHallo' } });
  assert.equal(await typed, 'MessageHallo');
  const long = phones.type(undefined, 'x');
  await tick();
  reply('dev_phone0000001', requests[1].id, { result: { text: 'y'.repeat(400) } });
  assert.equal((await long)?.length, FIELD_MAX);
  const old = phones.type(undefined, 'x');
  await tick();
  reply('dev_phone0000001', requests[2].id, { result: {} });
  assert.equal(await old, undefined);
});

test('safeNode keeps order and parents honest and drops what uiautomator does not know', () => {
  assert.deepEqual(safeNode({ parent: 5, text: 'a'.repeat(400), bounds: [0, 0, 10, 10], clickable: 'yes' }, 2), { index: 2, depth: 0, parent: -1, text: 'a'.repeat(300), bounds: [0, 0, 10, 10] });
  assert.deepEqual(safeNode(null, 0), { index: 0, depth: 0, parent: -1 });
});

test('an off answer keeps the phone\'s own reason; only a bare "off" becomes the generic enable text', async () => {
  const { phones, requests, reply } = rig();
  const consent = phones.key(undefined, 'back');
  await tick();
  reply('dev_phone0000001', requests[0].id, { error: { code: 'off', message: 'The person has not yet agreed to the phone-use disclosure in the app.' } });
  await assert.rejects(consent, (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable' && error.message === 'The person has not yet agreed to the phone-use disclosure in the app.');
  const bare = phones.key(undefined, 'back');
  await tick();
  reply('dev_phone0000001', requests[1].id, { error: { code: 'off', message: '' } });
  await assert.rejects(bare, (error: unknown) => error instanceof WorkforceError && error.message === PHONE_USE_OFF);
});

test('each step names its run as job, so the phone ✕ ends exactly that job; paused and ended keep the phone\'s words', async () => {
  const { phones, requests, reply } = rig();
  const tap = phones.tap(undefined, 1, 1, { job: 'run_abc' });
  await tick();
  assert.equal(requests[0].job, 'run_abc');
  reply('dev_phone0000001', requests[0].id, { error: { code: 'paused', message: 'The person touched the phone, so phone use paused before this step (it did not run). The task stays.' } });
  await assert.rejects(tap, (error: unknown) => error instanceof WorkforceError && error.code === 'conflict' && error.message.includes('The task stays.'));
  const tree = phones.uiTree(undefined, { job: 'run_abc' });
  await tick();
  reply('dev_phone0000001', requests[1].id, { error: { code: 'ended', message: 'The person ended phone use for this task with ✕.' } });
  await assert.rejects(tree, (error: unknown) => error instanceof WorkforceError && error.message.includes('✕'));
  const bare = phones.tap(undefined, 2, 2);
  await tick();
  assert.equal('job' in requests[2], false, 'without a run no job field');
  reply('dev_phone0000001', requests[2].id, { result: {} });
  await bare;
});

// Feedback 16.11.2026 F16: the bubble names the agent, shows the AI's line and asks its question (✓ / ✕).
test('each step names its agent as by (folded, at most 60 characters); without one there is no by field', async () => {
  const { phones, requests, reply } = rig();
  const tap = phones.tap(undefined, 1, 1, { job: 'run_abc', by: '  Felix\n Weber ' });
  await tick();
  assert.equal(requests[0].by, 'Felix Weber');
  reply('dev_phone0000001', requests[0].id, { result: {} });
  await tap;
  const long = phones.key(undefined, 'back', { by: 'x'.repeat(80) });
  await tick();
  assert.equal(requests[1].by, 'x'.repeat(60));
  reply('dev_phone0000001', requests[1].id, { result: { key: 'back' } });
  await long;
  const bare = phones.key(undefined, 'back', { job: 'run_abc' });
  await tick();
  assert.equal('by' in requests[2], false);
  reply('dev_phone0000001', requests[2].id, { result: {} });
  await bare;
});

test('say: a line goes as op say within the step limit; a question waits up to 75 s and brings back yes, no or none', async () => {
  const { phones, requests, reply, timers } = rig(1_000_000); // the idle end has its own test
  const line = phones.say(undefined, '  Sending Anna\nthe photo ', undefined, { job: 'run_abc', by: 'Felix' });
  await tick();
  assert.deepEqual({ op: requests[0].op, args: requests[0].args, job: requests[0].job, by: requests[0].by }, { op: 'say', args: { text: 'Sending Anna the photo' }, job: 'run_abc', by: 'Felix' });
  reply('dev_phone0000001', requests[0].id, { result: { ok: true } });
  assert.deepEqual(await line, { serial: 'dev_phone0000001' });

  const long = phones.say(undefined, 'y'.repeat(200), undefined);
  await tick();
  assert.equal((requests[1].args.text as string).length, 120, 'one bubble line at most');
  assert.ok((requests[1].args.text as string).endsWith('…'));
  timers.fire(20_000);
  await assert.rejects(long, (error: unknown) => error instanceof WorkforceError && error.code === 'timeout' && /within 20 s/.test(error.message));

  const asked = phones.say(undefined, 'May I use the phone for 2 minutes?', ['✓'], { job: 'run_abc' });
  await tick();
  assert.deepEqual(requests[2].args, { text: 'May I use the phone for 2 minutes?', ask: true });
  timers.fire(60_000);
  reply('dev_phone0000001', requests[2].id, { result: { answer: 'yes' } }); // still waiting after the step limit
  assert.deepEqual(await asked, { serial: 'dev_phone0000001', answer: 'yes' });

  const no = phones.say(undefined, 'Now?', ['✓']);
  await tick();
  reply('dev_phone0000001', requests[3].id, { result: { answer: 'no' } });
  assert.equal((await no).answer, 'no');
  const odd = phones.say(undefined, 'Now?', ['✓']);
  await tick();
  reply('dev_phone0000001', requests[4].id, { result: { answer: 'Later' } });
  assert.equal((await odd).answer, 'Later', 'a button of mine answers with its label');

  const silent = phones.say(undefined, 'Now?', ['✓']);
  await tick();
  timers.fire(74_999);
  timers.fire(75_000);
  await assert.rejects(silent, (error: unknown) => error instanceof WorkforceError && error.code === 'timeout' && /within 75 s/.test(error.message));
  await assert.rejects(phones.say(undefined, ' \n ', undefined), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request');
});

test('say on an app older than 0.3.15 ("Unknown step say.") reads as OLD_APP_SAY; the phone\'s other refusals pass through', async () => {
  const { phones, requests, reply } = rig();
  const old = phones.say(undefined, 'Hello', ['✓']);
  await tick();
  reply('dev_phone0000001', requests[0].id, { error: { code: 'bad_request', message: 'Unknown step say.' } });
  await assert.rejects(old, (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable' && error.message === OLD_APP_SAY);
  const ended = phones.say(undefined, 'Hello', undefined, { job: 'run_abc' });
  await tick();
  reply('dev_phone0000001', requests[1].id, { error: { code: 'ended', message: 'The person ended my phone use for this task with ✕.' } });
  await assert.rejects(ended, (error: unknown) => error instanceof WorkforceError && error.message.includes('✕'));
});

test('drivers: say goes to the app phone even while ADB has a ready phone; an ADB serial hears that ADB has no bubble', async () => {
  const { phones, requests, reply } = rig();
  const adbCalls: string[] = [];
  const adb = {
    available: async () => true,
    devices: async () => [{ serial: '192.168.1.20:5555', state: 'device' }] as never[],
    screenshot: async () => ({}) as never, uiTree: async () => ({}) as never, tap: async () => undefined, swipe: async () => undefined,
    type: async () => undefined, key: async () => 'KEYCODE_BACK', open: async () => '',
    say: async (serial: string | undefined) => { adbCalls.push(`say ${serial}`); return { serial: serial ?? '' }; },
    pair: async () => ({ address: '' }), connect: async () => ({ address: '', already: false }), disconnect: async () => ({ serial: '', was: false }), discover: async () => [], attached: () => [], installed: () => false,
  };
  const merged = mergedPhones(adb, phones);
  const said = merged.say(undefined, 'Hello', undefined);
  await tick();
  assert.equal(requests[0].op, 'say');
  reply('dev_phone0000001', requests[0].id, { result: { ok: true } });
  await said;
  await merged.say('192.168.1.20:5555', 'Hello', undefined);
  assert.deepEqual(adbCalls, ['say 192.168.1.20:5555']);
});

// Owner 19.11.2026: my own buttons in the bubble, and the bubble goes when my run is over.
test('say with buttons sends my labels (folded, distinct, at most 8) with ask for older apps, and brings back the tapped one', async () => {
  const { phones, requests, reply } = rig();
  const asked = phones.say(undefined, 'Send now?', ['  Send  now ', 'Send now', 'Later', ...'abcdefgh'.split('')], { job: 'run_abc' });
  await tick();
  assert.deepEqual(requests[0].args, { text: 'Send now?', ask: true, buttons: ['Send now', 'Later', 'a', 'b', 'c', 'd', 'e', 'f'] });
  reply('dev_phone0000001', requests[0].id, { result: { answer: 'Later' } });
  assert.equal((await asked).answer, 'Later');
  const yes = phones.say(undefined, 'May I?', ['✓']);
  await tick();
  assert.deepEqual(requests[1].args, { text: 'May I?', ask: true }, '✓ alone is the plain ask');
  reply('dev_phone0000001', requests[1].id, { result: {} });
  assert.equal((await yes).answer, 'none', 'no label is no answer');
});

test('a run that used the phone sends done once when it ends; other runs and running states send nothing', async () => {
  const { bus, phones, requests, reply } = rig();
  const step = phones.key(undefined, 'back', { job: 'run_abc' });
  await tick();
  reply('dev_phone0000001', requests[0].id, { result: { key: 'back' } });
  await step;
  bus.emit('run.upserted', { id: 'run_abc', status: 'running' } as never);
  bus.emit('run.upserted', { id: 'run_other', status: 'done' } as never);
  assert.equal(requests.length, 1);
  bus.emit('run.upserted', { id: 'run_abc', status: 'done' } as never);
  assert.equal(requests.length, 2);
  assert.deepEqual({ deviceId: requests[1].deviceId, op: requests[1].op, args: requests[1].args, job: requests[1].job }, { deviceId: 'dev_phone0000001', op: 'done', args: {}, job: 'run_abc' });
  bus.emit('run.upserted', { id: 'run_abc', status: 'done' } as never);
  assert.equal(requests.length, 2, 'once');
  reply('dev_phone0000001', requests[1].id, { error: { code: 'bad_request', message: 'Unknown step done.' } }); // an older app: nobody waits
});

test('a run without a phone step for the idle time sends done; a new step or a waiting step holds it back', async () => {
  const { phones, requests, reply, timers } = rig();
  const first = phones.key(undefined, 'back', { job: 'run_idle' });
  await tick();
  timers.fire(15_000);
  assert.equal(requests.length, 1, 'a step in flight is not idle');
  reply('dev_phone0000001', requests[0].id, { result: { key: 'back' } });
  await first;
  const second = phones.key(undefined, 'home', { job: 'run_idle' }); // before the idle time: the first timer is gone
  await tick();
  timers.fire(15_000);
  assert.equal(requests.length, 2);
  reply('dev_phone0000001', requests[1].id, { result: { key: 'home' } });
  await second;
  timers.fire(15_000);
  assert.equal(requests.length, 3);
  assert.deepEqual({ op: requests[2].op, job: requests[2].job }, { op: 'done', job: 'run_idle' });
  timers.fire(15_000);
  assert.equal(requests.length, 3, 'once');
  const again = phones.key(undefined, 'back', { job: 'run_idle' }); // the next step brings the bubble back and counts anew
  await tick();
  reply('dev_phone0000001', requests[3].id, { result: {} });
  await again;
  timers.fire(15_000);
  assert.equal(requests.length, 5);
});

// Konrad 19.11.2026 guessed SimplySign's package twice and never opened it: an app opens by the name under its icon.
test('open with app sends the name; an app that knows only packages says so in my words', async () => {
  const { phones, requests, reply } = rig();
  const named = phones.open(undefined, { app: 'SimplySign' });
  await tick();
  assert.equal(requests[0].op, 'open');
  assert.deepEqual(requests[0].args, { app: 'SimplySign' });
  reply('dev_phone0000001', requests[0].id, { result: { opened: 'com.assecods.certum.simplysign' } });
  assert.equal(await named, 'com.assecods.certum.simplysign');

  const old = phones.open(undefined, { app: 'SimplySign' });
  await tick();
  reply('dev_phone0000001', requests[1].id, { error: { code: 'bad_request', message: 'Give an http(s) link or a package name.' } });
  await assert.rejects(old, (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable' && error.message === OLD_APP_OPEN);

  const missing = phones.open(undefined, { app: 'Banking' });
  await tick();
  reply('dev_phone0000001', requests[2].id, { error: { code: 'not_found', message: 'No app named "Banking" is on this phone. Its apps: Chrome, WhatsApp.' } });
  await assert.rejects(missing, (error: unknown) => error instanceof WorkforceError && error.code === 'not_found' && /Its apps: Chrome/.test(error.message));
});
