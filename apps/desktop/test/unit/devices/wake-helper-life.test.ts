// 0.3.19 (23.11.2026): the wake helper's own life (runtime/devices/sleeper-life.ts) and wake.json kept current while the
// app runs (runtime/devices/wake-keeper.ts) – so a helper the broker starts after a Task Manager end finds a current file,
// takes a dead app for a closed one, never runs twice, and recovers recently due work missed during broker startup. Owns: these assertions. Never: a real helper, network or the broker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { appRunning, dueDelay, dueStartAt, DUE_RECOVERY_MS, DUE_SETTLE_MS, DUE_TICK_MS, launchOnce, otherHelper } from '../../../src/runtime/devices/sleeper-life.ts';
import { keepWakeFile, wakeHelperOn, WAKE_KEEP_DELAY_MS } from '../../../src/runtime/devices/wake-keeper.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import { b64url, fingerprintOf, generateEd25519, rawPublic } from '../../../src/runtime/devices/keys.ts';
import { parseWakeFile, WAKE_FILE, type WakeFile } from '../../../src/runtime/devices/wake-sign.ts';
import { Bus } from '../../../src/runtime/bus.ts';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { rpcFixture } from '../rpc/s1-helpers.ts';

test('appRunning: only a live pid is a running app – a Task Manager kill leaves "running" behind', () => {
  const alive = (pid: number) => pid === 7;
  assert.equal(appRunning({ state: 'running', at: 1, pid: 7 }, alive), true);
  assert.equal(appRunning({ state: 'running', at: 1, pid: 8 }, alive), false, 'killed: the helper waits');
  assert.equal(appRunning({ state: 'running', at: 1 }, alive), true, 'no pid (an older writer): counted as running');
  assert.equal(appRunning({ state: 'quit', at: 1, pid: 7, by: 'person' }, alive), false);
  assert.equal(appRunning(undefined, alive), false);
});

test('otherHelper: a second helper for the same data folder ends at once; its own or a dead mark does not count', () => {
  const alive = (pid: number) => pid === 5 || pid === 6;
  assert.equal(otherHelper({ pid: 5, at: 1 }, 6, alive), true);
  assert.equal(otherHelper({ pid: 6, at: 1 }, 6, alive), false, 'its own mark');
  assert.equal(otherHelper({ pid: 9, at: 1 }, 6, alive), false, 'a killed helper left it');
  assert.equal(otherHelper(undefined, 6, alive), false);
});

test('dueStartAt without a previous mark: only work due after the helper began; dueDelay caps each timer', () => {
  const began = 1_000_000;
  assert.equal(dueStartAt(null, began), undefined);
  assert.equal(dueStartAt(undefined, began), undefined);
  assert.equal(dueStartAt(began - 1, began), undefined, 'overdue work waits for the next start');
  assert.equal(dueStartAt(began, began), undefined);
  assert.equal(dueStartAt(began + 60_000, began), began + DUE_SETTLE_MS, 'a minute after a quit: moved to 5 minutes');
  assert.equal(dueStartAt(began + 3_600_000, began), began + 3_600_000);
  assert.equal(dueStartAt(Number.NaN, began), undefined);
  assert.equal(dueDelay(began + 3_600_000, began), DUE_TICK_MS);
  assert.equal(dueDelay(began + 10_000, began), 10_000);
  assert.equal(dueDelay(began - 10, began), 0);
});

test('dueStartAt: a Task Manager close does not drop work due before the broker started the helper', () => {
  const began = 1_000_000;
  const killed = { state: 'running', at: began - 3 * DUE_RECOVERY_MS, pid: 7 } as const;
  assert.equal(dueStartAt(began - 14_000, began, killed), began);
  assert.equal(dueStartAt(began + 10_000, began, killed), began + 10_000);
  assert.equal(dueStartAt(began - DUE_RECOVERY_MS - 1, began, killed), undefined);
  assert.equal(dueStartAt(began - 500, began, { ...killed, at: began - 100 }), undefined, 'stale due file from before last app start');
});

test('dueStartAt: a deliberate quit preserves settle time and does not reopen for earlier work', () => {
  const began = 1_000_000;
  const quit = { state: 'quit', by: 'person', at: began - 15_000 } as const;
  assert.equal(dueStartAt(quit.at - 1, began, quit), undefined);
  assert.equal(dueStartAt(quit.at + 1, began, quit), quit.at + DUE_SETTLE_MS);
  assert.equal(dueStartAt(began + 3_600_000, began, quit), began + 3_600_000);
});

test('launchOnce: neither a running app nor a second simultaneous wake starts another process', () => {
  let running = true;
  const launches: string[][] = [];
  const launch = launchOnce(() => running, (args: string[]) => launches.push(args));
  launch(['--company=company-2']);
  assert.deepEqual(launches, []);
  running = false;
  launch(['--background', '--company=company-2']);
  launch(['--company=company-2']);
  assert.deepEqual(launches, [['--background', '--company=company-2']]);
});

const tower = () => {
  const key = generateEd25519();
  const pub = b64url(rawPublic(key.publicKey));
  return { id: 'dev_tower0000001', name: 'Tower', kind: 'pc' as const, role: 'home' as const, fingerprint: fingerprintOf(rawPublic(key.publicKey)), publicKey: pub, addresses: [], caps: {}, status: 'offline' as const, self: false };
};

test('keepWakeFile: written at start, again after a device change (bundled, only when changed), removed when switched off', (t) => {
  const f = rpcFixture({ table: createHandlerTable() });
  t.after(f.cleanup);
  const s = f.services;
  s.settings.update({ devices: { relay: 'wss://meet.example/autark' } } as never);
  const writes: Array<WakeFile | undefined> = [];
  const timers: Array<() => void> = [];
  const bus = new Bus();
  const stop = keepWakeFile({
    s: { ...s, bus },
    write: (_dir, file) => { writes.push(file); return Boolean(file); },
    timers: { set: (fn, ms) => { assert.equal(ms, WAKE_KEEP_DELAY_MS); timers.push(fn); return timers.length; }, clear: () => undefined },
  });
  assert.deepEqual(writes, [undefined], 'nobody linked yet: no file (removed)');
  const record = tower();
  new DevicesRepo(s.db).upsert(record as never);
  bus.emit('device.upserted', record as never);
  bus.emit('device.upserted', record as never);
  assert.equal(timers.length, 1, 'a burst is one write');
  timers.shift()!();
  assert.equal(writes.length, 2);
  assert.deepEqual((writes as Array<WakeFile | undefined>)[1]?.pins.map((pin) => pin.pub), [record.publicKey]);
  bus.emit('device.upserted', record as never);
  timers.shift()!();
  assert.equal(writes.length, 2, 'nothing changed: nothing written');
  s.settings.update({ devices: { wakeHelper: false } } as never);
  assert.equal(wakeHelperOn(s.settings.get()), false);
  bus.emit('settings.updated', s.settings.get() as never);
  timers.shift()!();
  assert.deepEqual(writes.slice(2), [undefined], 'switched off: the file goes');
  stop();
  bus.emit('device.upserted', record as never);
  assert.equal(timers.length, 0, 'stopped: no more writes');
});

test('keepWakeFile with the real writer: the file on disk is the helper file', (t) => {
  const f = rpcFixture({ table: createHandlerTable() });
  t.after(f.cleanup);
  const s = f.services;
  s.settings.update({ devices: { relay: 'wss://meet.example/autark' } } as never);
  new DevicesRepo(s.db).upsert(tower() as never);
  const stop = keepWakeFile({ s });
  t.after(stop);
  const file = parseWakeFile(readFileSync(path.join(s.paths.data, WAKE_FILE), 'utf8'));
  assert.equal(file?.relay, 'wss://meet.example/autark');
});
