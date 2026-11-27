// B-084 reconnect on the phone (src/ui/lib/rpc.ts): a socket that does not open within 5 s (OPEN_LIMIT_MS) is given up (a
// dead tunnel would keep it 'connecting' for minutes and block every resume check); a page coming back replaces a connect
// attempt older than that even when a sleeping phone froze its timer; refresh() (pull-down) connects at once when not open and,
// on an open socket, reloads everything (rpc.open) once the probe answers; window.autarkResume and the Android app's
// native `resume` message run the same check. The older liveness rules: rpc-alive.test.ts.
// Owns: these assertions only. Never: a real socket, browser, phone or runtime.

import { mock, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { adoptPort, resetNativePort } from '../../../src/ui/pwa/native-port.ts';

interface Frame { id?: number; method?: string }

class FakeSocket {
  static all: FakeSocket[] = [];
  readonly sent: Frame[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor() { FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data) as Frame); }
  close() { this.closed = true; }
  probes(): Frame[] { return this.sent.filter((frame) => frame.method === 'session.info'); }
  answer(id: number | undefined) { this.onmessage?.({ data: JSON.stringify({ id, result: { kind: 'device', capabilities: [], secure: true, allowedMethods: [] } }) }); }
}

type RpcModule = typeof import('../../../src/ui/lib/rpc.ts');

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const last = () => FakeSocket.all[FakeSocket.all.length - 1];
let instance = 0;

async function page(t: TestContext) {
  const globals = globalThis as Record<string, unknown>;
  const keys = ['window', 'document', 'location', 'history', 'WebSocket'] as const;
  const saved = keys.map((key) => [key, globals[key]] as const);
  const win: Record<string, unknown> = { addEventListener: () => undefined };
  globals.window = win;
  globals.document = { visibilityState: 'visible', addEventListener: () => undefined };
  globals.location = { protocol: 'https:', host: 'phone.test', hash: '', pathname: '/', search: '' };
  globals.history = { replaceState: () => undefined };
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
  const mod = (await import(new URL(`../../../src/ui/lib/rpc.ts?reconnect-${instance++}`, import.meta.url).href)) as RpcModule;
  const opened = async () => { const socket = last(); socket.onopen!(); await flush(); return socket; };
  let reloads = 0;
  mod.rpc.onOpen(() => { reloads += 1; });
  mod.rpc.start();
  return { mod, rpc: mod.rpc, win, opened, reloads: () => reloads };
}

test('a socket that does not open within 5 s is given up; the next try goes out at once', async (t) => {
  const { rpc } = await page(t);
  const stuck = last();
  mock.timers.tick(4_999);
  assert.equal(stuck.closed, false);
  assert.equal(rpc.status.value, 'connecting');
  mock.timers.tick(1);
  await flush();
  assert.equal(stuck.closed, true, 'given up after 5 s (OPEN_LIMIT_MS)');
  assert.equal(stuck.onopen, null, 'a late open of it changes nothing');
  assert.equal(rpc.status.value, 'closed');
  mock.timers.tick(0);
  assert.equal(FakeSocket.all.length, 2, 'the next try without a wait');
});

test('a page coming back replaces an attempt older than 5 s whose timer a sleeping phone froze; a young one stays', async (t) => {
  const { mod, rpc, opened } = await page(t);
  const first = last();
  mock.timers.setTime(3_000); // no timer fires: the phone slept
  mod.checkAlive();
  assert.equal(FakeSocket.all.length, 1, 'a 3 s old attempt goes on');
  mock.timers.setTime(6_000);
  mod.checkAlive();
  assert.equal(FakeSocket.all.length, 2, 'a 6 s old attempt is replaced at once');
  assert.equal(first.closed, true);
  await flush();
  assert.equal(rpc.status.value, 'connecting', 'the given-up attempt settling late changes nothing');
  await opened();
  assert.equal(rpc.status.value, 'open');
  mock.timers.tick(10_000);
  assert.equal(FakeSocket.all.length, 2, 'no timer of the old attempt fires later');
});

test('refresh: not open connects at once (also over a young attempt); open probes and reloads once it answers', async (t) => {
  const { mod, rpc, opened, reloads } = await page(t);
  mod.refresh();
  assert.equal(FakeSocket.all.length, 2, 'a pull while connecting starts over now');
  const socket = await opened();
  assert.equal(reloads(), 1, 'the fresh open reloads');

  mod.refresh();
  assert.equal(socket.probes().length, 1);
  socket.answer(socket.probes()[0].id);
  await flush();
  assert.equal(reloads(), 2, 'the answer reloads everything (rpc.open → loadAll)');
  assert.equal(FakeSocket.all.length, 2, 'a live socket stays');

  mod.checkAlive(); // a resume probe is running when the pull comes: one probe, its answer reloads
  mod.refresh();
  assert.equal(socket.probes().length, 2);
  socket.answer(socket.probes()[1].id);
  await flush();
  assert.equal(reloads(), 3);

  mod.checkAlive(); // a plain resume check reloads nothing
  socket.answer(socket.probes()[2].id);
  await flush();
  assert.equal(reloads(), 3);

  socket.onclose!({ code: 1006 });
  assert.equal(rpc.status.value, 'closed');
  mod.refresh();
  assert.equal(FakeSocket.all.length, 3, 'closed: a new socket right away');
});

test('window.autarkResume and the app\'s native resume run the liveness check', async (t) => {
  const { mod, win, opened } = await page(t);
  const socket = await opened();
  assert.equal(win.autarkResume, mod.checkAlive);
  const port = { onmessage: null as ((event: { data: string }) => void) | null, postMessage: () => undefined, close: () => undefined };
  adoptPort(port as unknown as MessagePort);
  port.onmessage!({ data: JSON.stringify({ t: 'resume' }) });
  assert.equal(socket.probes().length, 1, 'resume probes the open socket');
  mock.timers.tick(3_000);
  assert.equal(FakeSocket.all.length, 2, 'no answer: replaced');
});
