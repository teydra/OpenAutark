// 17.11.2026 (the owner: three stacked "Due: …" cards that stay far too long): the worker keeps one notice under the tag "due" for what falls due – one title keeps
// its own text, more say how many and list the titles –, replaces the earlier one instead of stacking and closes it by itself after DUE_SHOW_MS (a newer Due
// notice has its own timer; other notices are not touched). due-notice.ts decides the text, sw-notify.ts shows and closes.
// Owns: these assertions only. Never: a real browser or push service.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildSync } from 'esbuild';
import { groupDue, isDuePush } from '../../../src/ui/pwa/due-notice.ts';

interface Notice { title?: string; body?: string; tag?: string; data?: { url?: string; due?: boolean; items?: string[]; stamp?: number }; close(): void }

function worker() {
  const code = buildSync({ entryPoints: ['src/ui/pwa/sw.ts'], bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent' }).outputFiles[0].text;
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const tray: Notice[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const registration = {
    scope: 'https://phone.example/', getNotifications: async (filter?: { tag?: string }) => tray.filter((notice) => !filter?.tag || notice.tag === filter.tag),
    showNotification: async (title: string, options: Notice) => { const notice = { ...options, title, close: () => { const at = tray.indexOf(notice); if (at >= 0) tray.splice(at, 1); } }; tray.push(notice); },
    pushManager: { getSubscription: async () => null },
  };
  const scope = { registration, navigator: {}, location: new URL('https://phone.example/sw.js'), clients: { matchAll: async () => [], openWindow: async () => undefined }, addEventListener: (type: string, fn: (event: Record<string, unknown>) => void) => { handlers.set(type, fn); } };
  vm.runInNewContext(code, { self: scope, URL, Promise, Date: { now: () => 1_700_000_000_000 }, console, setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; } });
  const send = async (payload: unknown) => {
    const pending: Promise<unknown>[] = [];
    handlers.get('push')!({ data: { json: () => payload }, waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
    return pending;
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { tray, timers, send, flush };
}

const due = (title: string, taskId = title) => ({ kind: 'todo', title: `Due: ${title}`, body: 'notes', tag: `todo:${taskId}`, url: '/#/tasks', id: `n_${taskId}` });

test('what is a Due push, and how the notice reads: one title as it is, more say how many and list them (each once, the newest five)', () => {
  assert.equal(isDuePush(due('Call')), true);
  assert.equal(isDuePush({ kind: 'todo', title: 'Ida: Check the login' }), false);
  assert.equal(isDuePush({ kind: 'reply', title: 'Due: not a to-do' }), false);
  assert.equal(isDuePush({ kind: 'todo', title: 'Due: x', clear: 'todo:x' }), false, 'a clear is no notice');
  const one = groupDue(due('Call the tax office'), [], 10);
  assert.deepEqual([one.payload.tag, one.payload.title, one.payload.body], ['due', 'Due: Call the tax office', 'notes']);
  const two = groupDue(due('Recording'), one.data.items, 11);
  assert.deepEqual([two.payload.title, two.payload.body], ['2 to-dos due', 'Call the tax office · Recording']);
  assert.deepEqual(groupDue(due('Recording'), two.data.items, 12).data.items, ['Call the tax office', 'Recording'], 'the same title counts once');
  const many = ['a', 'b', 'c', 'd', 'e'].reduce<string[]>((items, title) => groupDue(due(title), items, 1).data.items, []);
  assert.deepEqual(groupDue(due('f'), many, 2).data.items, ['b', 'c', 'd', 'e', 'f']);
});

test('three to-dos fall due in the same millisecond: one notice stays in the tray, saying 3 to-dos due; it closes by itself after DUE_SHOW_MS', async () => {
  const sw = worker();
  for (const title of ['2 minutes at the PC', 'Recording', 'At the server']) await Promise.all(await sw.send({ ...due(title), url: undefined }).then((pending) => pending.slice(0, 0)));
  await sw.flush();
  assert.equal(sw.tray.length, 1, 'not three cards');
  assert.equal(sw.tray[0]!.tag, 'due');
  assert.equal(sw.tray[0]!.title, '3 to-dos due');
  assert.equal(sw.tray[0]!.body, '2 minutes at the PC · Recording · At the server');
  assert.equal(sw.tray[0]!.data?.url, '/#/tasks', 'a tap opens Tasks');
  assert.deepEqual(sw.timers.map((timer) => timer.ms), [6_000, 6_000, 6_000]);
  sw.timers[0]!.fn(); // the first push's timer: a newer notice stands, so it stays
  await sw.flush();
  assert.equal(sw.tray.length, 1);
  sw.timers[2]!.fn(); // the newest push's timer closes it
  await sw.flush();
  assert.equal(sw.tray.length, 0, 'gone by itself');
});

test('other notices are left alone: a chat message stays when the Due notice closes', async () => {
  const sw = worker();
  await sw.send({ kind: 'reply', title: 'Ida', body: 'Hello', tag: 'chat:one', id: 'm1', url: '/#/chat/one' });
  await sw.send(due('Call'));
  await sw.flush();
  assert.deepEqual(sw.tray.map((notice) => notice.tag).sort(), ['chat:one', 'due']);
  sw.timers[0]!.fn();
  await sw.flush();
  assert.deepEqual(sw.tray.map((notice) => notice.tag), ['chat:one']);
});
