// Konrad 24.11.2026 (task_p539an77, task_pvw81gvy – Stanislaus: red banners "The page did not take that · Connection to
// the runtime was lost" and "Reconnecting" on every short drop): a drop under 5 s shows nothing; a longer one shows
// exactly one quiet line (the status line's connection line, tone info), never a toast per failed action; the line goes
// when the connection is back. Input made during the drop waits in order and goes once it is back (rpc.ts holds calls
// up to QUEUE_LIMIT_MS, the input sender drops nothing behind an input the drop took with it); what waited longer is
// not sent and is said once, quietly, afterwards.
// Owns: these assertions only. Never: a real socket, browser or runtime.

import { mock, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { signal } from '@preact/signals';
import type { BrowserInput } from '../../../src/shared/model/browser.ts';
import { LOST_TEXT, NOT_SENT_DESKTOP, NOT_SENT_PHONE, RpcError, connectionFailure } from '../../../src/ui/lib/rpc-error.ts';
import { QUEUE_LIMIT_MS } from '../../../src/ui/lib/rpc-queue.ts';
import type { ConnectionStatus } from '../../../src/ui/lib/rpc.ts';
import { toastError, toasts, unsent } from '../../../src/ui/lib/toasts.ts';
import { resetNativePort } from '../../../src/ui/pwa/native-port.ts';
import { DOWN_GRACE_MS, down, downSince, unsentToast, watchConnection } from '../../../src/ui/shell/connection-line.ts';
import { connectionNotice } from '../../../src/ui/shell/notices.ts';
import { createInputSender } from '../../../src/ui/workspace/browser-input.ts';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const lost = () => new RpcError({ code: 'unavailable', message: LOST_TEXT });

function reset(): void {
  toasts.value = [];
  unsent.value = [];
  down.value = false;
  downSince.value = null;
}

/** Runs a drop of `ms` (the retries flip connecting/closed every second, the failed actions of the screenshot fail
 *  with the lost connection) and returns every line the person saw each second: the connection line and the toasts. */
function drop(t: TestContext, ms: number): { seen: string[][]; after: string[] } {
  reset();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const status = signal<ConnectionStatus>('open');
  const stop = watchConnection(status);
  const lines = () => {
    const notice = connectionNotice({ status: status.value, loaded: true, loadError: null });
    return [...(notice ? [`${notice.tone}: ${notice.text}`] : []), ...toasts.value.map((toast) => `${toast.tone ?? 'info'}: ${toast.title}`)];
  };
  const seen: string[][] = [];
  try {
    status.value = 'closed';
    toastError(lost(), 'The page did not take that');
    toastError(lost(), 'The PC did not take that tab change');
    for (let at = 1000; at <= ms; at += 1000) {
      t.mock.timers.tick(1000);
      status.value = status.value === 'closed' ? 'connecting' : 'closed';
      seen.push(lines());
    }
    status.value = 'open';
    return { seen, after: lines() };
  } finally {
    stop();
    reset();
  }
}

test('Schwelle: a 4 s drop shows nothing at all – no line, no toast', (t) => {
  const { seen, after } = drop(t, 4000);
  assert.ok(DOWN_GRACE_MS >= 5000, `the grace is 5 s (${DOWN_GRACE_MS})`);
  assert.deepEqual(seen.flat(), [], 'nothing while it is away');
  assert.deepEqual(after, [], 'nothing once it is back (what was on its way may have arrived: nothing to say)');
});

test('Schwelle: a 6 s drop shows exactly one quiet line from 5 s on, never red; it goes when the connection is back', (t) => {
  const { seen, after } = drop(t, 6000);
  assert.deepEqual(seen.slice(0, 4).flat(), [], 'nothing in the first 4 s');
  assert.equal(seen.slice(4).length, 2);
  for (const lines of seen.slice(4)) {
    assert.equal(lines.length, 1, `exactly one line: ${JSON.stringify(lines)}`);
    assert.match(lines[0]!, /^info: .*not reachable · reconnecting by itself/, 'quiet: info, not warn or error');
  }
  assert.deepEqual(after, [], 'the line goes with the reconnect');
});

test('a failure that only says the connection was away is never a toast; "not sent" is said once, quietly, afterwards', (t) => {
  reset();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const status = signal<ConnectionStatus>('closed');
  const stop = watchConnection(status);
  try {
    assert.equal(connectionFailure(lost()), 'lost');
    assert.equal(connectionFailure(new RpcError({ code: 'unavailable', message: NOT_SENT_PHONE })), 'unsent');
    assert.equal(connectionFailure(new Error(NOT_SENT_DESKTOP)), 'unsent');
    assert.equal(connectionFailure(new RpcError({ code: 'unavailable', message: 'office-pc is offline.' })), null, 'a far PC\'s own answer is not this window\'s connection');
    toastError(new Error(NOT_SENT_PHONE), 'Message not sent');
    toastError(new Error(NOT_SENT_PHONE), 'Message not sent');
    toastError(new Error(NOT_SENT_PHONE), 'The page did not take that');
    toastError(lost(), 'The PC did not take that tab change');
    assert.equal(toasts.value.length, 0, 'no toast while it is away');
    status.value = 'open';
    assert.equal(toasts.value.length, 1, 'one toast once it is back');
    assert.equal(toasts.value[0]!.tone, 'info');
    assert.equal(toasts.value[0]!.body, 'Message not sent · The page did not take that', 'each title once; the lost one is not counted');
    assert.deepEqual(unsent.value, []);
    toastError(new Error('Something else broke.'), 'Action failed');
    assert.equal(toasts.value.at(-1)!.tone, 'error', 'any other failure is a toast as before');
    assert.equal(unsentToast([]), null);
    assert.match(unsentToast(['a', 'b'])!.title, /^2 things not sent/);
  } finally {
    stop();
    reset();
  }
});

// ---- the buffer: the remote tab's input path (BrowserSurface's sender → rpc.call 'side.input') on a phone page ----

class FakeSocket {
  static all: FakeSocket[] = [];
  readonly sent: Array<{ id?: number; method?: string; params?: { input?: BrowserInput } }> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor() { FakeSocket.all.push(this); }
  send(data: string) {
    const frame = JSON.parse(data) as FakeSocket['sent'][number];
    // the version ask right behind the Hello (lib/rpc.ts): a fitting PC answers at once
    if (frame.method === 'system.info') { this.onmessage?.({ data: JSON.stringify({ id: frame.id, result: { version: '0.3.21', deviceName: 'PC' } }) }); return; }
    this.sent.push(frame);
  }
  close() { /* the fake never closes by itself */ }
}

type RpcModule = typeof import('../../../src/ui/lib/rpc.ts');
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
  reset();
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => {
    mock.timers.reset();
    resetNativePort();
    reset();
    for (const [key, value] of saved) {
      if (value === undefined) delete globals[key];
      else globals[key] = value;
    }
  });
  const mod = (await import(new URL(`../../../src/ui/lib/rpc.ts?quiet-${instance++}`, import.meta.url).href)) as RpcModule;
  mod.rpc.start();
  return mod;
}

const key = (name: string): BrowserInput => ({ kind: 'key', type: 'down', key: name, code: '' });
const tap = (type: 'down' | 'up'): BrowserInput => ({ kind: 'mouse', type, x: 10, y: 20, width: 400, height: 300, button: 'left', clicks: 1 });
const sentInputs = (socket: FakeSocket) => socket.sent.filter((frame) => frame.method === 'side.input').map((frame) => {
  const input = frame.params!.input!;
  return input.kind === 'key' ? input.key : `${input.kind} ${'type' in input ? input.type : ''}`;
});

/** The remote tab's sender as BrowserSurface makes it (window 8, `lost`), sending through this page's rpc. */
function remoteSender(mod: RpcModule, failed: unknown[]) {
  const call = mod.rpc.call as unknown as (method: string, params: unknown) => Promise<unknown>;
  return createInputSender((tab, input) => call('side.input', { tab, input }), (error) => { failed.push(error); toastError(error, 'The page did not take that'); },
    { window: 8, lost: (error) => connectionFailure(error) === 'lost' });
}

test('Puffer: input made during a 3 s drop goes out in order once the connection is back; the one the drop took is not sent twice', async (t) => {
  const mod = await phonePage(t);
  const first = FakeSocket.all[0]!;
  first.onopen!();
  await flush();
  const failed: unknown[] = [];
  const sender = remoteSender(mod, failed);
  sender.push('web-1', key('a'));
  await flush();
  assert.deepEqual(sentInputs(first), ['a']);
  first.onclose!({ code: 1006 }); // the drop: 'a' was on its way (it may have arrived)
  await flush();
  for (const input of [key('b'), key('c'), tap('down'), tap('up'), key('d')]) sender.push('web-1', input);
  await flush();
  mock.timers.tick(3000);
  const next = FakeSocket.all.at(-1)!;
  assert.notEqual(next, first, 'a new socket');
  next.onopen!();
  await flush();
  assert.deepEqual(sentInputs(next), ['b', 'c', 'mouse down', 'mouse up', 'd'], 'in order, none dropped, \'a\' not again');
  assert.deepEqual(failed, [], 'nothing reported');
  assert.equal(toasts.value.length, 0);
});

test('Puffer: the limit – input that waited longer than QUEUE_LIMIT_MS is never sent later and is said once, quietly, after the reconnect', async (t) => {
  const mod = await phonePage(t);
  const stop = watchConnection(mod.rpc.status);
  t.after(stop);
  FakeSocket.all[0]!.onopen!();
  await flush();
  FakeSocket.all[0]!.onclose!({ code: 1006 });
  await flush();
  const failed: unknown[] = [];
  const sender = remoteSender(mod, failed);
  for (const name of 'abcdefghijkl') sender.push('web-1', key(name)); // 12: 8 wait in rpc, 4 behind them in the sender
  await flush();
  assert.equal(sender.pending(), 4);
  mock.timers.tick(QUEUE_LIMIT_MS);
  await flush();
  assert.equal(failed.length, 1, 'one report for the whole lot');
  assert.equal(sender.pending(), 0, 'what waited behind them goes too (keys meant for a page that may have changed)');
  assert.equal(toasts.value.length, 0, 'no toast while it is away');
  const next = FakeSocket.all.at(-1)!;
  next.onopen!();
  await flush();
  assert.deepEqual(sentInputs(next), [], 'nothing replayed');
  assert.equal(toasts.value.length, 1, 'said once after the reconnect');
  assert.equal(toasts.value[0]!.tone, 'info');
  assert.equal(toasts.value[0]!.body, 'The page did not take that');
});
