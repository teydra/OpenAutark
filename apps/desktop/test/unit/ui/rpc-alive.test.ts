// Socket liveness on return (lib/rpc.ts checkAlive): a phone back from the background can hold a
// half-open WebSocket – events stop, calls hang. When the page comes back (visible, pageshow,
// online, a push via pwa/install.ts), a socket that is not open connects at once; an open one only
// probes `session.info`; no answer in 3 s closes it and connects again with the backoff reset;
// one probe at a time. The desktop port: rpc-alive-desktop.test.ts.
// Owns: these assertions only. Never: a real socket, browser or runtime.

import { mock, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';

interface Frame { id?: number; method?: string }

class FakeSocket {
  static all: FakeSocket[] = [];
  readonly sent: Frame[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  readonly url: string;
  constructor(url: string) { this.url = url; FakeSocket.all.push(this); }
  send(data: string) {
    const frame = JSON.parse(data) as Frame;
    // the version ask right behind the Hello (lib/rpc.ts): a fitting PC answers at once
    if (frame.method === 'system.info') { this.onmessage?.({ data: JSON.stringify({ id: frame.id, result: { version: '0.3.21', deviceName: 'PC' } }) }); return; }
    this.sent.push(frame);
  }
  close() { this.closed = true; }
  probes(): Frame[] { return this.sent.filter((frame) => frame.method === 'session.info'); }
  answer(id: number | undefined) { this.onmessage?.({ data: JSON.stringify({ id, result: { kind: 'device', capabilities: [], secure: true, allowedMethods: [] } }) }); }
}

type RpcModule = typeof import('../../../src/ui/lib/rpc.ts');

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const last = () => FakeSocket.all[FakeSocket.all.length - 1];
let instance = 0;

/** A fresh client on a fake page; `fire` sends a page event, `opened` opens the newest socket. */
async function page(t: TestContext) {
  const globals = globalThis as Record<string, unknown>;
  const keys = ['window', 'document', 'location', 'history', 'WebSocket'] as const;
  const saved = keys.map((key) => [key, globals[key]] as const);
  const windowListeners = new Map<string, () => void>();
  const doc = { visibilityState: 'visible', listeners: new Map<string, () => void>(), addEventListener(type: string, fn: () => void) { this.listeners.set(type, fn); } };
  globals.window = { addEventListener: (type: string, fn: () => void) => { windowListeners.set(type, fn); } };
  globals.document = doc;
  globals.location = { protocol: 'https:', host: 'phone.test', hash: '', pathname: '/', search: '' };
  globals.history = { replaceState: () => undefined };
  globals.WebSocket = FakeSocket;
  FakeSocket.all = [];
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    mock.timers.reset();
    for (const [key, value] of saved) {
      if (value === undefined) delete globals[key];
      else globals[key] = value;
    }
  });
  const mod = (await import(new URL(`../../../src/ui/lib/rpc.ts?alive-${instance++}`, import.meta.url).href)) as RpcModule;
  const fire = (type: 'visibilitychange' | 'pageshow' | 'online') => (type === 'visibilitychange' ? doc.listeners : windowListeners).get(type)!();
  const opened = async () => { const socket = last(); socket.onopen!(); await flush(); return socket; };
  mod.rpc.start();
  return { mod, rpc: mod.rpc, doc, fire, opened };
}

test('the reconnect steps: none after a close, then 250 ms doubling to 2 s in front – 10 s at most while hidden or refused', async (t) => {
  const { mod } = await page(t);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((failed) => mod.retryDelay(failed, false)), [0, 250, 500, 1_000, 2_000, 2_000, 2_000]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((failed) => mod.retryDelay(failed, true)), [0, 500, 1_000, 2_000, 4_000, 8_000, 10_000]);
});

test('a close: the first attempt goes out at once; visible with a dead socket connects at once, the steps start over', async (t) => {
  const { rpc, doc, fire, opened } = await page(t);
  const first = await opened();
  first.onclose!({ code: 1006 }); // the OS finally reported the drop
  assert.equal(rpc.status.value, 'closed');
  mock.timers.tick(0);
  assert.equal(FakeSocket.all.length, 2, 'the first attempt after a close waits for nothing');
  last().onclose!({ code: 1006 }); // that attempt failed before it opened: the next one waits a short step (250 ms)
  await flush();
  assert.equal(FakeSocket.all.length, 2);

  doc.visibilityState = 'hidden';
  fire('visibilitychange');
  assert.equal(FakeSocket.all.length, 2, 'hidden: nothing happens');

  doc.visibilityState = 'visible';
  fire('visibilitychange');
  assert.equal(FakeSocket.all.length, 3, 'visible: a new socket right away, no waiting for the timer');
  assert.equal(last().url, 'wss://phone.test/ws');
  assert.equal(first.probes().length, 0, 'a closed socket is never probed');

  const second = await opened();
  assert.equal(rpc.status.value, 'open');
  second.onclose!({ code: 1006 });
  mock.timers.tick(0);
  assert.equal(FakeSocket.all.length, 4, 'the steps started over: the first attempt at once again');
});

test('visible with a live socket: only a probe, the socket stays', async (t) => {
  const { mod, rpc, fire, opened } = await page(t);
  const socket = await opened();
  let reloads = 0;
  rpc.onOpen(() => { reloads += 1; });

  fire('visibilitychange');
  assert.equal(socket.probes().length, 1);
  socket.answer(socket.probes()[0].id);
  await flush();
  mock.timers.tick(3_000);
  assert.equal(FakeSocket.all.length, 1, 'answered: no new socket');
  assert.equal(socket.closed, false);
  assert.equal(rpc.status.value, 'open');
  assert.equal(reloads, 0, 'no reload for a live socket');

  for (const check of [() => fire('pageshow'), () => fire('online'), () => mod.checkAlive()]) { // a push ('wf.wake') runs checkAlive
    const before = socket.probes().length;
    check();
    assert.equal(socket.probes().length, before + 1, 'each return probes again once the last one answered');
    socket.answer(socket.probes()[before].id);
    await flush();
  }
  mock.timers.tick(3_000);
  assert.equal(FakeSocket.all.length, 1);
});

test('a probe without an answer in 3 s: the socket counts as dead, calls reject, a new one connects at once', async (t) => {
  const { rpc, fire, opened } = await page(t);
  const first = await opened();
  first.onclose!({ code: 1006 });
  mock.timers.tick(0);
  const half = await opened(); // never answers anything: the steps stay grown (next 250 ms)
  let reloads = 0;
  rpc.onOpen(() => { reloads += 1; });
  const hanging = rpc.call('devices.list');

  fire('pageshow');
  assert.equal(half.probes().length, 1);
  mock.timers.tick(2_999);
  assert.equal(FakeSocket.all.length, 2, 'still within 3 s');
  assert.equal(half.closed, false);
  mock.timers.tick(1);
  assert.equal(half.closed, true, 'the stale socket is closed');
  assert.equal(half.onmessage, null, 'and late frames from it are dropped');
  assert.equal(FakeSocket.all.length, 3, 'a new socket at once');
  assert.equal(rpc.status.value, 'connecting');
  await assert.rejects(hanging, (error: { code?: string }) => error.code === 'unavailable', 'the hanging call rejects instead of hanging');

  const fresh = await opened();
  assert.equal(reloads, 1, 'onOpen → store.loadAll brings the screen up to date');
  half.onclose?.({ code: 1006 }); // the OS reports the old one late: nothing changes
  assert.equal(rpc.status.value, 'open');
  fresh.onclose!({ code: 1006 });
  mock.timers.tick(0);
  assert.equal(FakeSocket.all.length, 4, 'the steps were reset: the first attempt at once (else 250 ms)');
});

test('one probe at a time: visible, pageshow, online and a push together send one probe and reconnect once', async (t) => {
  const { mod, fire, opened } = await page(t);
  const socket = await opened();
  fire('visibilitychange');
  fire('pageshow');
  fire('online');
  mod.checkAlive();
  assert.equal(socket.probes().length, 1);
  mock.timers.tick(3_000);
  assert.equal(FakeSocket.all.length, 2, 'one reconnect');
  fire('visibilitychange');
  mock.timers.tick(3_000);
  assert.equal(FakeSocket.all.length, 2, 'while the new socket connects, nothing more starts');
});
