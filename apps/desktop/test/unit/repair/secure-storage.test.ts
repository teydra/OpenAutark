import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { DeviceIdentity, DeviceKeyUnavailable } from '../../../src/runtime/devices/identity.ts';
import { verifyEd25519 } from '../../../src/runtime/devices/keys.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import type { Host } from '../../../src/runtime/host.ts';
import { createNodeHost } from '../../../src/runtime/host-node.ts';
import { VapidKeys, VapidKeyUnavailable } from '../../../src/runtime/pwa/vapid.ts';
import { SecretVault } from '../../../src/runtime/secrets/service.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { ManualClock } from '../fakes.ts';

function profile() {
  const db = new Db(':memory:');
  migrate(db);
  const clock = new ManualClock();
  const kv = new KvRepo(db);
  const host = (marker: number, kind: Host['kind'] = 'electron'): Host => ({
    kind,
    encrypt: async (value: string) => Uint8Array.from([marker, ...Buffer.from(value)]),
    decrypt: async (cipher: Uint8Array) => {
      if (cipher[0] !== marker) throw new Error('Old key unavailable');
      return Buffer.from(cipher.subarray(1)).toString();
    },
    notify: async () => false, openExternal: async () => {}, openPath: async () => {},
    onPower: () => () => {}, idleSeconds: async () => 0, keepAwake: () => () => {},
    app: { packaged: false, version: 'test', resourcesDir: '', dataDir: '', executable: '' },
  });
  return { db, clock, kv, old: { db, clock, host: host(1) }, next: { db, clock, host: host(2) }, host };
}

test('unpaired device keeps its ID and replaces only its unreadable signing key', async (t) => {
  const { db, old, next, kv } = profile();
  t.after(() => db.close());
  const first = await DeviceIdentity.load(old);
  const oldRow = kv.get('device', 'identity');
  const recovered = await DeviceIdentity.load(next);
  assert.equal(recovered.deviceId, first.deviceId);
  assert.notEqual(recovered.fingerprint, first.fingerprint);
  const message = Buffer.from('test');
  assert.ok(verifyEd25519(recovered.publicKey, message, recovered.sign(message)));
  assert.equal((await DeviceIdentity.load(next)).fingerprint, recovered.fingerprint);
  assert.deepEqual(kv.get('device', 'identity-before-recovery'), [oldRow]);
  assert.equal(new DevicesRepo(db).list().length, 1);
});

test('linked profile preserves its identity and changing host never rotates it', async (t) => {
  const { db, old, next, kv, host } = profile();
  t.after(() => db.close());
  const first = await DeviceIdentity.load(old);
  const oldRow = kv.get('device', 'identity');
  await assert.rejects(() => DeviceIdentity.load({ ...next, host: host(2, 'node') }), { wrongHost: true });
  const repo = new DevicesRepo(db);
  repo.upsert({ ...repo.get(first.deviceId)!, id: 'dev_test_peer', name: 'Peer', self: false, fingerprint: 'test-peer' });
  await assert.rejects(() => DeviceIdentity.load(next), DeviceKeyUnavailable);
  assert.deepEqual(kv.get('device', 'identity'), oldRow);
  assert.equal(repo.self()?.id, first.deviceId);
  const reopened = await DeviceIdentity.load(old);
  assert.equal(reopened.deviceId, first.deviceId);
  assert.equal(reopened.fingerprint, first.fingerprint);
});

test('failed replacement read-back leaves the original identity untouched', async (t) => {
  const { db, old, next, kv } = profile();
  t.after(() => db.close());
  await DeviceIdentity.load(old);
  const oldRow = kv.get('device', 'identity');
  await assert.rejects(() => DeviceIdentity.load({ ...next, host: { ...next.host, decrypt: async () => { throw new Error("Key unavailable"); } } }), DeviceKeyUnavailable);
  assert.deepEqual(kv.get('device', 'identity'), oldRow);
});

test('headless startup does not create a rival key in an Electron profile', (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'wf-wrong-host-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  writeFileSync(path.join(dataDir, 'Local State'), '{}');
  assert.throws(() => createNodeHost({ dataDir, resourcesDir: '', version: 'test' }), /separate --data folder/);
  assert.equal(existsSync(path.join(dataDir, 'runtime.key')), false);
});

test('VAPID changes only when no subscriptions depend on the old key', async (t) => {
  const { db, old, next, kv } = profile();
  t.after(() => db.close());
  const first = await VapidKeys.load(old);
  const oldRow = kv.get('pwa', 'vapid');
  db.run("INSERT INTO push_subscriptions (id, endpoint, data, created_at) VALUES ('test', 'https://example.test', '{}', 1)");
  await assert.rejects(() => VapidKeys.load(next), VapidKeyUnavailable);
  assert.deepEqual(kv.get('pwa', 'vapid'), oldRow);
  db.run('DELETE FROM push_subscriptions');
  const recovered = await VapidKeys.load(next);
  assert.notEqual(recovered.publicKey, first.publicKey);
  assert.deepEqual(kv.get('pwa', 'vapid-before-recovery'), [oldRow]);
  assert.equal((await VapidKeys.load(next)).publicKey, recovered.publicKey);
});

test('vault leaves unreadable ciphertext in place, logs once, and accepts a replacement', async (t) => {
  const { db, old, next } = profile();
  t.after(() => db.close());
  const id = (await new SecretVault(old).save({ label: 'Fixture login', kind: 'password', value: 'old-test-value' })).id;
  const warnings: string[] = [];
  const vault = new SecretVault({ ...next, log: { info() {}, warn(message) { warnings.push(message); }, error() {}, debug() {} } });
  await vault.init();
  assert.equal(vault.list()[0].unreadable, true);
  await assert.rejects(() => vault.use(id, 'human'), /Re-enter its value/);
  await assert.rejects(() => vault.use(id, 'human'), /Re-enter its value/);
  assert.equal(warnings.length, 1);
  assert.equal(await new SecretVault(old).use(id, 'human'), 'old-test-value');
  await vault.save({ id, label: 'Fixture login', kind: 'password', value: 'new-test-value' });
  assert.equal(vault.list()[0].unreadable, undefined);
  assert.equal(await vault.use(id, 'human'), 'new-test-value');
});

test('a portable import with peer records but deliberately no self identity provisions a new key', async (t) => {
  const { db, old, next, kv } = profile();
  t.after(() => db.close());
  const first = await DeviceIdentity.load(old);
  const repo = new DevicesRepo(db);
  repo.upsert({ ...repo.get(first.deviceId)!, id: 'dev_test_peer', name: 'Peer', self: false, fingerprint: 'test-peer' });
  kv.delete('device', 'identity');
  db.run('DELETE FROM devices WHERE self = 1');
  const imported = await DeviceIdentity.load(next);
  assert.notEqual(imported.deviceId, first.deviceId);
  assert.equal(repo.get('dev_test_peer')?.name, 'Peer');
});

test('a second automatic recovery keeps both previous ciphertexts', async (t) => {
  const { db, old, next, kv, host } = profile();
  t.after(() => db.close());
  const final = { ...next, host: host(3) };
  for (const [ns, key, load] of [['device', 'identity', DeviceIdentity.load], ['pwa', 'vapid', VapidKeys.load]] as const) {
    await load(old);
    const first = kv.get(ns, key);
    await load(next);
    const second = kv.get(ns, key);
    await load(final);
    assert.deepEqual(kv.get(ns, key + '-before-recovery'), [first, second]);
  }
});
