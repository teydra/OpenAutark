// 25.11.2026: the anonymous usage count (runtime/usage) – README › What Autark counts, stated as assertions: at most one
// count per UTC hour, none without use, none with the switch off, `dev` only on the first count of a UTC day, a request
// that carries only the allowed fields and no identifier, nothing from a build that is not packaged, a lost count is not
// retried, and two companies of one PC are one device.
// Owns: these assertions. Never: contacts Google (fetch is a fake; the shipped receiver.json names the real project).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bus } from '../../../src/runtime/bus.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { UsageCount, USAGE_FILE } from '../../../src/runtime/usage/service.ts';
import { commitBody, documentId, firstOfDay, hourKey, platformOf, readHour } from '../../../src/runtime/usage/signal.ts';
import type { Settings } from '../../../src/shared/model/system.ts';

const RESOURCES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../resources');
const T0 = Date.UTC(2026, 10, 25, 15, 20); // 25.11.2026 15:20 UTC

interface Call { url: URL; init: RequestInit | undefined; body: { writes: Array<{ transform: { document: string; fieldTransforms: Array<{ fieldPath: string; increment: { integerValue: string } }> } }> } }

function rig(options: { packaged?: boolean; on?: boolean; status?: number; folder?: string } = {}) {
  const folder = options.folder ?? mkdtempSync(path.join(tmpdir(), 'usage-count-'));
  const bus = new Bus();
  let now = T0;
  let usage: Settings['usage'] = options.on === false ? { count: false } : undefined;
  const calls: Call[] = [];
  const fake: typeof fetch = async (url, init) => {
    calls.push({ url: new URL(String(url)), init, body: JSON.parse(String(init?.body)) });
    return new Response('{}', { status: options.status ?? 200 });
  };
  const services = {
    bus, clock: { now: () => now },
    settings: { get: () => ({ usage }) as Settings },
    paths: { data: folder, resources: RESOURCES },
    host: { app: { packaged: options.packaged ?? true, companies: { first: folder, dir: folder } } },
  } as unknown as RuntimeServices;
  const count = new UsageCount({ services: () => services, run: fake, platform: 'win32' });
  const stop = count.start();
  return {
    count, calls, folder, bus, stop,
    at: (time: number) => { now = time; },
    setSwitch: (on: boolean) => { usage = { count: on }; bus.emit('settings.updated', { usage } as Settings); },
    file: () => path.join(folder, USAGE_FILE),
    settle: () => new Promise((resolve) => setTimeout(resolve, 20)),
    clean: () => { stop(); rmSync(folder, { recursive: true, force: true }); },
  };
}

test('one count per UTC hour: many lines and turns in the hour send one request, the next hour sends the next', async () => {
  const r = rig();
  for (let i = 0; i < 20; i++) r.count.touch();
  await r.settle();
  assert.equal(r.calls.length, 1);
  assert.equal(readFileSync(r.file(), 'utf8'), '2026-11-25T15');
  r.at(T0 + 30 * 60_000); // 15:50 – still the same hour
  r.count.touch(); await r.settle();
  assert.equal(r.calls.length, 1);
  r.at(T0 + 41 * 60_000); // 16:01
  r.count.touch(); r.count.touch(); await r.settle();
  assert.equal(r.calls.length, 2);
  assert.match(r.calls[1].body.writes[0].transform.document, /\/use\/2026-11-25-windows-16$/);
  r.clean();
});

test('no use, no count: starting the service and letting hours pass sends nothing – nothing runs by itself', async () => {
  const r = rig();
  r.at(T0 + 5 * 3_600_000);
  await r.settle();
  assert.equal(r.calls.length, 0);
  assert.equal(existsSync(r.file()), false);
  r.clean();
});

test('switch off: nothing is sent, and switching off drops the stored hour at once; on again counts again', async () => {
  const r = rig();
  r.count.touch(); await r.settle();
  assert.equal(existsSync(r.file()), true);
  r.setSwitch(false);
  assert.equal(existsSync(r.file()), false, 'the one remembered string is dropped');
  r.at(T0 + 2 * 3_600_000);
  r.count.touch(); r.count.touch(); await r.settle();
  assert.equal(r.calls.length, 1, 'off sends nothing');
  r.setSwitch(true);
  r.count.touch(); await r.settle();
  assert.equal(r.calls.length, 2);
  r.clean();
  const off = rig({ on: false });
  off.count.touch(); await off.settle();
  assert.equal(off.calls.length, 0);
  off.clean();
});

test('`dev` is added only on the first count of a UTC day', async () => {
  const r = rig();
  const dev = (call: Call) => call.body.writes[0].transform.fieldTransforms.map((t) => t.fieldPath);
  r.count.touch(); await r.settle();
  r.at(T0 + 3_600_000); r.count.touch(); await r.settle();
  r.at(T0 + 2 * 3_600_000); r.count.touch(); await r.settle();
  r.at(Date.UTC(2026, 10, 26, 8, 5)); r.count.touch(); await r.settle();
  assert.deepEqual(r.calls.map(dev), [['n', 'dev'], ['n'], ['n'], ['n', 'dev']]);
  r.clean();
});

test('the request is exactly the interface: one POST to Firestore\'s commit with the shipped key, n +1 (and dev +1), nothing else', async () => {
  const r = rig();
  r.count.touch(); await r.settle();
  const [call] = r.calls;
  assert.equal(`${call.url.origin}${call.url.pathname}`, 'https://firestore.googleapis.com/v1/projects/autark-feedback-7/databases/(default)/documents:commit');
  assert.deepEqual([...call.url.searchParams.keys()], ['key']);
  assert.equal(call.init?.method, 'POST');
  assert.deepEqual(call.init?.headers, { 'content-type': 'application/json' }, 'no cookie, no authorization, no user agent of ours');
  assert.equal(call.init?.credentials, 'omit');
  assert.equal(call.init?.redirect, 'error');
  assert.deepEqual(call.body, { writes: [{ transform: {
    document: 'projects/autark-feedback-7/databases/(default)/documents/use/2026-11-25-windows-15',
    fieldTransforms: [{ fieldPath: 'n', increment: { integerValue: '1' } }, { fieldPath: 'dev', increment: { integerValue: '1' } }],
  } }] });
  const text = String(call.init?.body);
  for (const forbidden of [r.folder, 'version', 'device', 'install', 'locale', 'language', 'company', 'agent', 'user']) assert.ok(!text.toLowerCase().includes(forbidden.toLowerCase()), `the body has no "${forbidden}"`);
  r.clean();
});

test('a build that is not packaged (a developer\'s, a test, headless) never reaches Google', async () => {
  const r = rig({ packaged: false });
  r.count.touch(); await r.settle();
  assert.equal(r.calls.length, 0);
  r.clean();
});

test('a failed count is dropped: no retry in the same hour, nothing remembered, the next hour tries again', async () => {
  const r = rig({ status: 403 });
  for (let i = 0; i < 5; i++) r.count.touch();
  await r.settle();
  assert.equal(r.calls.length, 1);
  assert.equal(existsSync(r.file()), false);
  r.at(T0 + 3_600_000); r.count.touch(); await r.settle();
  assert.equal(r.calls.length, 2);
  const broken = rig();
  const throwing = new UsageCount({ services: () => ({ bus: broken.bus } as unknown as RuntimeServices), run: async () => { throw new Error('offline'); } });
  assert.doesNotThrow(() => throwing.touch(), 'a damaged environment never disturbs the app');
  broken.clean(); r.clean();
});

test('two companies of one PC are one device: the second finds the hour counted and the day started', async () => {
  const a = rig();
  const b = rig({ folder: a.folder });
  a.count.touch(); await a.settle();
  b.count.touch(); await b.settle();
  assert.equal(a.calls.length + b.calls.length, 1);
  b.at(T0 + 3_600_000); b.count.touch(); await b.settle();
  assert.deepEqual(b.calls[0].body.writes[0].transform.fieldTransforms.map((t) => t.fieldPath), ['n'], 'same day: no second `dev`');
  b.stop(); a.clean();
});

test('signal.ts: hour key, document id, platform words, day rule, stored hour shape', () => {
  assert.equal(hourKey(Date.UTC(2026, 0, 2, 3, 59, 59)), '2026-01-02T03');
  assert.equal(documentId('2026-11-25T07', 'mac'), '2026-11-25-mac-07');
  assert.deepEqual(['win32', 'darwin', 'linux', 'freebsd'].map(platformOf), ['windows', 'mac', 'linux', undefined]);
  assert.equal(firstOfDay('2026-11-25T07', undefined), true);
  assert.equal(firstOfDay('2026-11-25T07', '2026-11-24T23'), true);
  assert.equal(firstOfDay('2026-11-25T07', '2026-11-25T01'), false);
  assert.equal(readHour(' 2026-11-25T07\n'), '2026-11-25T07');
  assert.equal(readHour('hello'), undefined);
  assert.deepEqual(Object.keys(JSON.parse(commitBody('p', '2026-11-25T07', 'linux', false))), ['writes']);
});
