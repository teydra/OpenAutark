// Sicher-Runde 19.11.2026 (D2): when main starts the wake helper (src/main/sleeper.ts) and where the quit says goodbye
// (src/main/shutdown.ts quitSteps): the goodbye before the runtime stops, the helper after it – only after the person's
// own quit with the runtime's yes; at a launcher start that stays quit while the helper's file is there; the helper is the
// app's own executable as Node with its script and the app's start arguments.
// Owns: these assertions only. Never: spawns a process or touches the person's data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { quitSteps } from '../../../src/main/shutdown.ts';
import { quitWake, sleeperAtLaunch, sleeperAtQuit, sleeperScript, startSleeper, wakeHelperExe, WAKE_FILE } from '../../../src/main/sleeper.ts';

test('the helper after a quit: only the person\'s, only when the runtime wrote its file', () => {
  assert.equal(sleeperAtQuit('person', { sleeper: true }), true);
  assert.equal(sleeperAtQuit('person', { sleeper: false }), false);
  assert.equal(sleeperAtQuit('person', undefined), false, 'no answer from the runtime');
  assert.equal(sleeperAtQuit('system', { sleeper: true }), false, 'the session ends: the helper would end with it');
  assert.equal(sleeperAtQuit('update', { sleeper: true }), false, 'an update starts the app again itself');
});

test('the helper at a launcher start: one that stays quit because the person had quit, with the file there', () => {
  assert.equal(sleeperAtLaunch({ start: false, reason: 'quit' }, 'task', true), true);
  assert.equal(sleeperAtLaunch({ start: false, reason: 'quit' }, 'task', false), false);
  assert.equal(sleeperAtLaunch({ start: true, reason: 'signin' }, 'task', true), false, 'the app itself starts');
  assert.equal(sleeperAtLaunch({ start: false, reason: 'capped' }, 'task', true), false);
  assert.equal(sleeperAtLaunch({ start: false, reason: 'quit' }, 'person', true), false);
});

test('the quit order: drafts, updates, goodbye, runtime, then the helper (when the goodbye said so), power, tray', async () => {
  const order: string[] = [];
  const base = {
    drained: false, flushDrafts: () => order.push('drafts'), disposeUpdates: () => order.push('updates'), stopRuntime: () => order.push('runtime'),
    releasePower: () => order.push('power'), destroyTray: () => order.push('tray'), startSleeper: () => order.push('helper'),
  };
  const steps = quitSteps({ ...base, by: 'person', bye: async () => { order.push('bye'); return { sleeper: true }; } });
  assert.deepEqual(steps.map((step) => step.name), ['drafts', 'updates', 'bye', 'runtime', 'wake helper', 'power', 'tray']);
  for (const step of steps) await step.run();
  assert.deepEqual(order, ['drafts', 'updates', 'bye', 'runtime', 'helper', 'power', 'tray']);
  order.length = 0;
  for (const step of quitSteps({ ...base, by: 'person', bye: async () => ({ sleeper: false }) })) await step.run();
  assert.ok(!order.includes('helper'), 'no file, no helper');
  assert.deepEqual(quitSteps({ ...base, drained: true }).map((step) => step.name), ['updates', 'power', 'tray'], 'an update drained already');
  assert.deepEqual(quitSteps({ drained: false, flushDrafts: () => 0, disposeUpdates: () => 0, stopRuntime: () => 0, releasePower: () => 0, destroyTray: () => 0 }).map((step) => step.name),
    ['drafts', 'updates', 'runtime', 'power', 'tray'], 'without the new actions: as before');
});

test('the helper: the app\'s own executable as Node, its unpacked script, the wake file, the app\'s start arguments', () => {
  const appDir = path.join('C:', 'Program Files', 'Autark', 'resources', 'app.asar', 'app');
  const script = sleeperScript(appDir, (file) => file.includes('app.asar.unpacked'));
  assert.equal(script, path.join('C:', 'Program Files', 'Autark', 'resources', 'app.asar.unpacked', 'app', 'sleeper.mjs'));
  assert.equal(sleeperScript(appDir, () => false), undefined, 'a build without it');
  const calls: Array<{ exe: string; args: readonly string[]; options: { env?: NodeJS.ProcessEnv; detached?: boolean } }> = [];
  const spawn = ((exe: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; detached?: boolean }) => {
    calls.push({ exe, args, options });
    return Object.assign(new EventEmitter(), { unref: () => undefined });
  }) as unknown as NonNullable<Parameters<typeof startSleeper>[0]['spawn']>;
  const dataDir = path.join('C:', 'Users', 'me', 'AppData', 'Roaming', 'Autark');
  const started = startSleeper({ exe: 'Autark.exe', script, dataDir, args: ['--company=co_1'], spawn, exists: () => true });
  assert.equal(started, true);
  assert.deepEqual(calls[0].args, [script, path.join(dataDir, WAKE_FILE), '--', '--company=co_1']);
  assert.equal(calls[0].options.env?.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(calls[0].options.detached, true);
  assert.equal(startSleeper({ exe: 'Autark.exe', script, dataDir, args: [], spawn, exists: () => false }), false, 'no wake file: nobody could wake it');
  assert.equal(startSleeper({ exe: 'Autark.exe', script: undefined, dataDir, args: [], spawn, exists: () => true }), false);
});

test('the slim native helper (0.3.22): Windows only, unpacked beside the broker, started without ELECTRON_RUN_AS_NODE with the app path and the app\'s arguments; the Node helper takes over when it does not start', () => {
  const root = 'C:\\Program Files\\Autark\\resources\\app.asar';
  const helper = wakeHelperExe(root, 'win32', (file) => file.includes('app.asar.unpacked'));
  assert.equal(helper, 'C:\\Program Files\\Autark\\resources\\app.asar.unpacked\\resources\\broker\\AutarkWakeHelper.exe');
  assert.equal(wakeHelperExe(root, 'win32', () => false), undefined, 'a build without it');
  assert.equal(wakeHelperExe(root, 'darwin', () => true), undefined, 'Mac keeps the Node helper');
  assert.equal(wakeHelperExe(root, 'linux', () => true), undefined, 'Linux keeps the Node helper');
  const calls: Array<{ exe: string; args: readonly string[]; options: { env?: NodeJS.ProcessEnv; detached?: boolean }; child: EventEmitter }> = [];
  const spawn = ((exe: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; detached?: boolean }) => {
    const child = Object.assign(new EventEmitter(), { unref: () => undefined });
    calls.push({ exe, args, options, child });
    return child;
  }) as unknown as NonNullable<Parameters<typeof startSleeper>[0]['spawn']>;
  const dataDir = path.join('C:', 'Users', 'me', 'AppData', 'Roaming', 'Autark');
  const script = 'C:\\Program Files\\Autark\\resources\\app.asar.unpacked\\app\\sleeper.mjs';
  const before = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = '1';
  try {
    assert.equal(startSleeper({ exe: 'C:\\Autark.exe', script, helper, dataDir, args: ['--company=co_1'], spawn, exists: () => true }), true);
  } finally {
    if (before === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = before;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].exe, helper);
  assert.deepEqual(calls[0].args, [path.join(dataDir, WAKE_FILE), '--app', 'C:\\Autark.exe', '--', '--company=co_1']);
  assert.equal(calls[0].options.env?.ELECTRON_RUN_AS_NODE, undefined, 'the app a wake starts must not inherit Node mode');
  assert.equal(calls[0].options.env?.COMPlus_gcConcurrent, '0', 'plain GC: no background thread');
  assert.equal(calls[0].options.env?.COMPlus_GCgen0size, '100000', 'a 1 MB youngest generation (hex)');
  assert.equal(calls[0].options.detached, true);
  // refused or damaged (Smart App Control, missing runtime): the Node helper starts instead
  calls[0].child.emit('error', new Error('spawn UNKNOWN'));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].exe, 'C:\\Autark.exe');
  assert.deepEqual(calls[1].args, [script, path.join(dataDir, WAKE_FILE), '--', '--company=co_1']);
  assert.equal(calls[1].options.env?.ELECTRON_RUN_AS_NODE, '1');
  // without the native helper nothing changes; with only the native helper there is nothing to fall back to
  assert.equal(startSleeper({ exe: 'C:\\Autark.exe', script, helper: undefined, dataDir, args: [], spawn, exists: () => true }), true);
  assert.equal(calls[2].exe, 'C:\\Autark.exe');
  assert.equal(startSleeper({ exe: 'C:\\Autark.exe', script: undefined, helper, dataDir, args: [], spawn, exists: () => true }), true);
  calls[3].child.emit('error', new Error('x'));
  assert.equal(calls.length, 4);
  assert.equal(startSleeper({ exe: 'C:\\Autark.exe', script, helper, dataDir, args: [], spawn, exists: () => false }), false, 'no wake file');
});

test('quitWake: the goodbye names why (the session ending, else the quit) and the helper starts with the app\'s data', async () => {
  const asked: unknown[] = [];
  const call = async (method: 'devices.bye', params: { reason: string }) => { asked.push([method, params.reason]); return { sleeper: true }; };
  const start = { exe: 'Autark.exe', script: undefined, dataDir: 'D', args: [] };
  assert.deepEqual(await quitWake({ by: 'person', call, start }).bye(), { sleeper: true });
  await quitWake({ by: 'system', call, start }).bye();
  assert.deepEqual(asked, [['devices.bye', 'quit'], ['devices.bye', 'session-end']]);
  assert.equal(quitWake({ by: 'person', call, start }).startSleeper(), false, 'a build without the helper');
});
