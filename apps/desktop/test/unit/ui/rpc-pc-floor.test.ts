// The one rule between the phone app's own interface and a PC (owner 27.11.2026, lib/pc-floor.ts): a socket's first ask
// is the PC's version; the connection is open only for a PC at least OLDEST_PC. An older PC gets nothing else – no
// queued call, no subscription, no load – its name is `outdated` (the quiet state says "Update Autark on <PC>"), it
// counts as sent off (`turnedAway`: the phone app moves on) and is asked again after 10 s, not in fast steps.
// Owns: these assertions only. Never: a real socket, browser or runtime.

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { OLDEST_PC, pcFits } from '../../../src/ui/lib/pc-floor.ts';

test('pcFits: the floor and newer fit; older, unreadable or missing versions do not', () => {
  assert.equal(pcFits(OLDEST_PC), true);
  assert.equal(pcFits('0.3.22-local.1'), true, 'a local build of the next release');
  assert.equal(pcFits('1.0.0'), true);
  assert.equal(pcFits('0.3.20', '0.3.21'), false);
  assert.equal(pcFits('0.3.21-local.4', '0.3.21'), false, 'a build before its release');
  assert.equal(pcFits(''), false);
  assert.equal(pcFits(undefined), false);
  assert.equal(pcFits('dev'), false);
});

interface Frame { id?: number; method?: string; protocol?: number }

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
  version(version: string, deviceName = 'Laptop') {
    const ask = this.sent.find((frame) => frame.method === 'system.info');
    this.onmessage?.({ data: JSON.stringify({ id: ask?.id, result: { version, deviceName } }) });
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const last = () => FakeSocket.all[FakeSocket.all.length - 1]!;

test('rpc: an older PC gets nothing but the version ask; a fitting one opens the connection', async (t) => {
  const globals = globalThis as Record<string, unknown>;
  const saved = { window: globals.window, document: globals.document, location: globals.location, history: globals.history, WebSocket: globals.WebSocket };
  globals.window = { addEventListener: () => undefined };
  globals.document = { addEventListener: () => undefined, visibilityState: 'visible' };
  globals.location = { protocol: 'http:', host: '127.0.0.1:7', hash: '', pathname: '/', search: '' };
  globals.history = { replaceState: () => undefined };
  globals.WebSocket = FakeSocket;
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    mock.timers.reset();
    for (const key of ['window', 'document', 'location', 'history', 'WebSocket'] as const) {
      if (saved[key] === undefined) delete globals[key];
      else globals[key] = saved[key];
    }
  });
  const { rpc } = (await import(new URL('../../../src/ui/lib/rpc.ts?pc-floor', import.meta.url).href)) as typeof import('../../../src/ui/lib/rpc.ts');

  rpc.subscribe(['chats']);
  const chats = rpc.call('chats.list');
  chats.catch(() => undefined);
  const old = last();
  old.onopen!();
  assert.deepEqual(old.sent.map((frame) => frame.method ?? 'hello'), ['hello', 'system.info'], 'the version is the first ask');
  assert.equal(rpc.status.value, 'connecting', 'not open before the PC said its version');

  old.version('0.3.20');
  await flush();
  assert.deepEqual(old.sent.map((frame) => frame.method ?? 'hello'), ['hello', 'system.info'], 'nothing else went to the older PC');
  assert.equal(old.closed, true);
  assert.equal(rpc.outdated.value, 'Laptop');
  assert.equal(rpc.turnedAway.value, 1, 'the phone app hears it was sent off');
  assert.equal(rpc.status.value, 'closed');

  const count = FakeSocket.all.length;
  mock.timers.tick(9_999);
  assert.equal(FakeSocket.all.length, count, 'no fast steps against a PC that is too old');
  mock.timers.tick(1);
  assert.equal(FakeSocket.all.length, count + 1, 'asked again after 10 s: it may be updated meanwhile');

  const fresh = last();
  fresh.onopen!();
  fresh.version(OLDEST_PC, 'Office-PC');
  await flush();
  assert.equal(rpc.status.value, 'open');
  assert.equal(rpc.outdated.value, null, 'a fitting PC clears the state');
  assert.ok(fresh.sent.some((frame) => frame.method === 'events.subscribe'), 'subscriptions go out once it fits');
  assert.equal(rpc.turnedAway.value, 1);
});

test('rpc: a refusal after a PC that was too old is the newest word – the old PC\'s name is no longer said', async (t) => {
  const globals = globalThis as Record<string, unknown>;
  const saved = { window: globals.window, document: globals.document, location: globals.location, history: globals.history, WebSocket: globals.WebSocket };
  globals.window = { addEventListener: () => undefined };
  globals.document = { addEventListener: () => undefined, visibilityState: 'visible' };
  globals.location = { protocol: 'http:', host: '127.0.0.1:7', hash: '', pathname: '/', search: '' };
  globals.history = { replaceState: () => undefined };
  globals.WebSocket = FakeSocket;
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    mock.timers.reset();
    for (const key of ['window', 'document', 'location', 'history', 'WebSocket'] as const) {
      if (saved[key] === undefined) delete globals[key];
      else globals[key] = saved[key];
    }
  });
  const { rpc } = (await import(new URL('../../../src/ui/lib/rpc.ts?pc-then-refused', import.meta.url).href)) as typeof import('../../../src/ui/lib/rpc.ts');
  rpc.start();
  const old = last();
  old.onopen!();
  old.version('0.3.20', 'Old-PC');
  await flush();
  assert.equal(rpc.outdated.value, 'Old-PC');
  mock.timers.tick(10_000);
  const next = last();
  next.onopen!();
  next.onclose!({ code: 4401 });
  await flush();
  assert.equal(rpc.refused.value, 4401);
  assert.equal(rpc.outdated.value, null, 'the line and the chat header speak of the PC that refused, not the old one');
  assert.equal(rpc.turnedAway.value, 2);
});

test('rpc: a PC that opens but never says its version is replaced like one that never opens', async (t) => {
  const globals = globalThis as Record<string, unknown>;
  const saved = { window: globals.window, document: globals.document, location: globals.location, history: globals.history, WebSocket: globals.WebSocket };
  globals.window = { addEventListener: () => undefined };
  globals.document = { addEventListener: () => undefined, visibilityState: 'visible' };
  globals.location = { protocol: 'http:', host: '127.0.0.1:7', hash: '', pathname: '/', search: '' };
  globals.history = { replaceState: () => undefined };
  globals.WebSocket = FakeSocket;
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    mock.timers.reset();
    for (const key of ['window', 'document', 'location', 'history', 'WebSocket'] as const) {
      if (saved[key] === undefined) delete globals[key];
      else globals[key] = saved[key];
    }
  });
  const { rpc } = (await import(new URL('../../../src/ui/lib/rpc.ts?pc-silent', import.meta.url).href)) as typeof import('../../../src/ui/lib/rpc.ts');
  rpc.start();
  const mute = last();
  mute.onopen!();
  const count = FakeSocket.all.length;
  mock.timers.tick(3_000);
  await flush();
  assert.equal(mute.closed, true, 'given up after 3 s without a version');
  assert.equal(rpc.outdated.value, null, 'silence is not "too old"');
  mock.timers.tick(0);
  assert.equal(FakeSocket.all.length, count + 1, 'the next attempt goes out at once');
});
