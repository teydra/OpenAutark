// One liveness rule for every socket (lib/rpc.ts, Fest round 22.11.2026, owner 27.11.2026): the PC sends a page's socket a
// frame at least every 15 s (its beat, runtime/http/keepalive.ts), so an idle open socket that hears nothing for SILENT_MS
// (shared/api/protocol.ts, a minute) is replaced at once and the new socket reloads everything (rpc.open); every frame
// starts the wait over, the beat itself is passed over like any frame that is neither an answer nor an event; a socket
// that closed leaves no wait behind. A call that heard no frame at all for ANSWER_QUIET_MS (4 s) since it went out sends
// the one probe: no answer within 3 more seconds replaces the socket – a call on a half-open socket is found out within
// seconds, never after minutes. The probe on a return to the page: rpc-alive.test.ts; the desktop port has no wait
// (rpc-alive-desktop.test.ts).
// Owns: these assertions only. Never: a real socket, browser or runtime.

import { mock, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { SILENT_MS } from '../../../src/shared/api/protocol.ts';

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
  beat() { this.onmessage?.({ data: '{}' }); }
  probes(): Frame[] { return this.sent.filter((frame) => frame.method === 'session.info'); }
  answer(method: string, result: unknown) {
    const request = [...this.sent].reverse().find((frame) => frame.method === method);
    this.onmessage?.({ data: JSON.stringify({ id: request?.id, result }) });
  }
}

type RpcModule = typeof import('../../../src/ui/lib/rpc.ts');

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const last = () => FakeSocket.all[FakeSocket.all.length - 1];
let instance = 0;

async function page(t: TestContext) {
  const globals = globalThis as Record<string, unknown>;
  const keys = ['window', 'document', 'location', 'history', 'WebSocket'] as const;
  const saved = keys.map((key) => [key, globals[key]] as const);
  globals.window = { addEventListener: () => undefined };
  globals.document = { visibilityState: 'visible', addEventListener: () => undefined };
  globals.location = { protocol: 'https:', host: 'phone.test', hash: '', pathname: '/', search: '' };
  globals.history = { replaceState: () => undefined };
  globals.WebSocket = FakeSocket;
  FakeSocket.all = [];
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => {
    mock.timers.reset();
    for (const [key, value] of saved) {
      if (value === undefined) delete globals[key];
      else globals[key] = value;
    }
  });
  const mod = (await import(new URL(`../../../src/ui/lib/rpc.ts?silence-${instance++}`, import.meta.url).href)) as RpcModule;
  const opened = async () => { const socket = last(); socket.onopen!(); socket.beat(); await flush(); return socket; };
  let reloads = 0;
  mod.rpc.onOpen(() => { reloads += 1; });
  mod.rpc.start();
  return { mod, rpc: mod.rpc, opened, reloads: () => reloads };
}

test('a minute without any frame and no call waiting: the socket is replaced at once, the new one reloads everything', async (t) => {
  const { rpc, opened, reloads } = await page(t);
  assert.equal(SILENT_MS, 60_000, 'four beats of the PC missed');
  const quiet = await opened();
  assert.equal(reloads(), 1);

  mock.timers.tick(59_999);
  assert.equal(FakeSocket.all.length, 1, 'still within the minute');
  assert.equal(quiet.closed, false);
  mock.timers.tick(1);
  assert.equal(quiet.closed, true, 'the silent socket is closed');
  assert.equal(quiet.onmessage, null, 'and a late frame from it is dropped');
  assert.equal(FakeSocket.all.length, 2, 'a new socket at once, no backoff wait');

  await opened();
  assert.equal(reloads(), 2, 'onOpen → store.loadAll and every view (lib/use-load.ts) load again');
  assert.equal(rpc.status.value, 'open');
});

test('the beat every 15 s keeps a quiet socket open for as long as it comes; the beat itself is passed over', async (t) => {
  const { rpc, opened } = await page(t);
  const socket = await opened();
  let heard = 0;
  rpc.on('update.state', () => { heard += 1; });

  for (let round = 0; round < 20; round++) { mock.timers.tick(15_000); socket.beat(); } // five minutes
  await flush();
  assert.equal(FakeSocket.all.length, 1, 'never replaced while the PC beats');
  assert.equal(socket.closed, false);
  assert.equal(heard, 0, 'a beat is no event');

  socket.onmessage!({ data: JSON.stringify({ event: 'update.state', data: {} }) });
  mock.timers.tick(59_999);
  assert.equal(FakeSocket.all.length, 1, 'any frame starts the wait over');
  mock.timers.tick(1);
  assert.equal(FakeSocket.all.length, 2);
});

test('a call on a half-open socket: probed after 4 s without any frame, replaced 3 s later – seconds, not minutes', async (t) => {
  const { rpc, opened, reloads } = await page(t);
  const socket = await opened();
  const stuck = rpc.call('devices.list');
  let failed = false;
  void stuck.catch(() => { failed = true; });

  mock.timers.tick(3_999);
  assert.equal(socket.probes().length, 0, 'within 4 s nothing is asked');
  mock.timers.tick(1);
  assert.equal(socket.probes().length, 1, 'no frame of any kind since the call went out: one probe');
  mock.timers.tick(2_999);
  assert.equal(socket.closed, false);
  mock.timers.tick(1);
  assert.equal(socket.closed, true, '7 s after the call the dead socket is gone');
  assert.equal(FakeSocket.all.length, 2, 'and a new one connects at once');
  await flush();
  assert.equal(failed, true, 'the call rejects (unavailable): its caller decides, nothing repeats it here');
  await opened();
  assert.equal(reloads(), 2, 'the new socket reloads what the screen shows');
});

test('a slow answer on a live socket: frames keep coming or the probe answers – the socket stays', async (t) => {
  const { rpc, opened } = await page(t);
  const socket = await opened();
  const slow = rpc.call('files.read', { path: 'C:/big.mp4' } as never);
  let answered = false;
  void slow.then(() => { answered = true; }, () => undefined);

  mock.timers.tick(2_000);
  socket.onmessage!({ data: JSON.stringify({ event: 'update.state', data: {} }) }); // an event: the socket lives
  mock.timers.tick(2_000);
  assert.equal(socket.probes().length, 0, 'a frame came after the call went out: no probe');

  const second = rpc.call('devices.list');
  mock.timers.tick(4_000);
  assert.equal(socket.probes().length, 1, 'a call that heard nothing probes');
  socket.answer('session.info', { kind: 'device', capabilities: [], secure: true, allowedMethods: [] });
  await flush();
  mock.timers.tick(10_000);
  assert.equal(socket.closed, false, 'the probe answered: the socket stays while the calls wait');
  assert.equal(FakeSocket.all.length, 1);

  socket.answer('files.read', { text: 'x' });
  socket.answer('devices.list', []);
  await flush();
  assert.equal(answered, true);
  await second;
});

test('a socket that closed leaves no wait behind: the next socket keeps its own minute', async (t) => {
  const { opened } = await page(t);
  const first = await opened();
  mock.timers.tick(30_000);
  first.onclose!({ code: 1006 }); // the OS reported the drop: the first attempt goes out at once
  mock.timers.tick(0);
  assert.equal(FakeSocket.all.length, 2);
  const second = await opened();
  mock.timers.tick(30_000); // the first socket's minute is over now
  assert.equal(FakeSocket.all.length, 2, 'the closed socket\'s wait is gone');
  assert.equal(second.closed, false);
  mock.timers.tick(30_000);
  assert.equal(second.closed, true, 'the second one\'s own minute');
  assert.equal(FakeSocket.all.length, 3);
});
