// Calls made while the connection is down (src/ui/lib/rpc-queue.ts behind lib/rpc.ts, Sicher-Runde 19.11.2026 D6): they
// wait in order up to QUEUE_LIMIT_MS and go out when the socket opens; one that waited longer leaves the queue, nothing of
// it is sent later, and its caller hears a clear 'unavailable' text instead of a button spinning until the PC is back.
// Owns: these assertions only. Never: a real socket, browser or runtime.

import { mock, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { CallQueue, QUEUE_LIMIT_MS } from '../../../src/ui/lib/rpc-queue.ts';
import { resetNativePort } from '../../../src/ui/pwa/native-port.ts';

function fakeTimers() {
  const armed = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    armed,
    timers: { set: (fn: () => void, ms: number) => { armed.set(next, { fn, ms }); return next++; }, clear: (handle: unknown) => { armed.delete(handle as number); } },
    fire: (handle: number) => { const entry = armed.get(handle); armed.delete(handle); entry?.fn(); },
  };
}

test('CallQueue: in order, one timer each; an expired call leaves the queue; take() clears every timer', () => {
  const clock = fakeTimers();
  const queue = new CallQueue(QUEUE_LIMIT_MS, clock.timers);
  const expired: number[] = [];
  queue.add({ id: 1, method: 'todos.list' }, () => expired.push(1));
  queue.add({ id: 2, method: 'chats.list' }, () => expired.push(2));
  queue.add({ id: 3, method: 'tasks.list' }); // waits without a limit (the desktop window before its runtime answered)
  assert.equal(queue.size, 3);
  assert.deepEqual([...clock.armed.values()].map((entry) => entry.ms), [QUEUE_LIMIT_MS, QUEUE_LIMIT_MS]);
  clock.fire(1);
  assert.deepEqual(expired, [1]);
  assert.deepEqual(queue.take().map((request) => request.id), [2, 3], 'the expired one is never sent');
  assert.equal(clock.armed.size, 0, 'no timer is left');
  assert.equal(queue.size, 0);
  assert.deepEqual(expired, [1]);
});

class FakeSocket {
  static all: FakeSocket[] = [];
  readonly sent: Array<{ id?: number; method?: string }> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor() { FakeSocket.all.push(this); }
  send(data: string) {
    const frame = JSON.parse(data) as { id?: number; method?: string };
    // the version ask right behind the Hello (lib/rpc.ts): a fitting PC answers at once
    if (frame.method === 'system.info') { this.onmessage?.({ data: JSON.stringify({ id: frame.id, result: { version: '0.3.21', deviceName: 'PC' } }) }); return; }
    this.sent.push(frame);
  }
  close() { /* the fake never closes by itself */ }
}

type RpcModule = typeof import('../../../src/ui/lib/rpc.ts');
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
let instance = 0;

async function phonePage(t: TestContext): Promise<RpcModule> {
  const globals = globalThis as Record<string, unknown>;
  const keys = ['window', 'document', 'location', 'WebSocket'] as const;
  const saved = keys.map((key) => [key, globals[key]] as const);
  globals.window = { addEventListener: () => undefined };
  globals.document = { visibilityState: 'visible', addEventListener: () => undefined };
  globals.location = { protocol: 'https:', host: 'phone.test', hash: '', pathname: '/', search: '' };
  globals.WebSocket = FakeSocket;
  FakeSocket.all = [];
  resetNativePort();
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => {
    mock.timers.reset();
    resetNativePort();
    for (const [key, value] of saved) {
      if (value === undefined) delete globals[key];
      else globals[key] = value;
    }
  });
  const mod = (await import(new URL(`../../../src/ui/lib/rpc.ts?queue-${instance++}`, import.meta.url).href)) as RpcModule;
  mod.rpc.start();
  return mod;
}

test('a call made while the PC is away rejects after 8 s with a clear text, and is never sent later', async (t) => {
  const mod = await phonePage(t);
  const seen: { error?: unknown } = {};
  const call = mod.rpc.call('todos.list').catch((caught: unknown) => { seen.error = caught; });
  mock.timers.tick(QUEUE_LIMIT_MS - 1);
  await flush();
  assert.equal(seen.error, undefined, 'still waiting');
  mock.timers.tick(1);
  await call;
  const error = seen.error as unknown; // set by the rejection (assert.equal above narrowed it to undefined)
  assert.ok(error instanceof mod.RpcError);
  assert.equal((error as InstanceType<RpcModule['RpcError']>).code, 'unavailable');
  assert.equal((error as Error).message, mod.NOT_SENT);
  assert.match(mod.NOT_SENT, /not reachable.*nothing was sent/);
  mock.timers.tick(500); // the backoff's next socket
  const socket = FakeSocket.all[FakeSocket.all.length - 1];
  socket.onopen!();
  await flush();
  assert.ok(!socket.sent.some((frame) => frame.method === 'todos.list'), 'the expired call does not replay on reconnect');
});

test('a call made while connecting goes out when the socket opens within the limit', async (t) => {
  const mod = await phonePage(t);
  void mod.rpc.call('chats.list').catch(() => undefined);
  mock.timers.tick(1_000);
  const socket = FakeSocket.all[0];
  socket.onopen!();
  await flush();
  assert.deepEqual(socket.sent.filter((frame) => frame.method === 'chats.list').length, 1);
});
