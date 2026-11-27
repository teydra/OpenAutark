// B-081: the status line's call lines (src/ui/chat/call/call-notices.ts, pure provider): a ring gives Accept (primary –
// it opens the chat first when another one is open) and Decline; a call running on another device gives Take over and
// Join (owner 19.11.2026: this device joins beside the others – it opens the chat first when another one is open); a call
// this device talks in and a ring whose time is over give nothing; never more than the line's two actions.
// Owns: these assertions only. Never: audio or a runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LiveCall } from '../../../src/shared/model/call.ts';
import { callNotices, ringingHere } from '../../../src/ui/chat/call/call-notices.ts';
import { MAX_NOTICE_ACTIONS, NOTICE_PRIORITY } from '../../../src/ui/shell/notices.ts';

const NOW = 1_000_000;
const ring: LiveCall = { callId: 'call_r', rowId: 'm_r', conversationId: 'ch_a', state: 'ringing', agentName: 'Ava', why: 'Logo decision', until: NOW + 30_000 };
const running: LiveCall = { callId: 'call_x', rowId: 'm_x', conversationId: 'ch_b', state: 'running', device: 'Pixel', last: { name: 'Ava', text: 'Das Budget reicht.' } };

function actions() {
  const done: string[] = [];
  return { done, actions: { answer: (chat: string, call: string, join?: boolean) => done.push(`${join ? 'join' : 'answer'} ${chat} ${call}`), decline: (call: string) => done.push(`decline ${call}`), open: (chat: string) => done.push(`open ${chat}`) } };
}

test('a ring: "<Agent> calls · AI voice (machine-generated) · <why>" with Accept (primary, opens its chat first) and Decline, above the voice lines', async () => {
  const { done, actions: run } = actions();
  const [notice] = callNotices([ring], { now: NOW, open: 'ch_other', talking: () => false }, run);
  assert.equal(notice.text, 'Ava calls · AI voice (machine-generated) · Logo decision', 'Konrad 27.11.2026: the voice is said to be machine-generated');
  assert.equal(callNotices([{ ...ring, why: undefined }], { now: NOW, open: 'ch_other', talking: () => false }, run)[0].text, 'Ava calls · AI voice (machine-generated)');
  assert.equal(notice.priority, NOTICE_PRIORITY.ring);
  assert.ok(NOTICE_PRIORITY.ring > NOTICE_PRIORITY.voice);
  assert.deepEqual(notice.actions?.map((action) => [action.label, action.primary ?? false]), [['Accept', true], ['Decline', false]]);
  await notice.actions![0].run();
  await notice.actions![1].run();
  assert.deepEqual(done, ['open ch_a', 'answer ch_a call_r', 'decline call_r']);
  const [inChat] = callNotices([ring], { now: NOW, open: 'ch_a', talking: () => false }, actions().actions);
  const here = actions();
  await callNotices([ring], { now: NOW, open: 'ch_a', talking: () => false }, here.actions)[0].actions![0].run();
  assert.deepEqual(here.done, ['answer ch_a call_r'], 'its chat is open: it only answers');
  assert.equal(inChat.id, 'ring:call_r');
});

test('a call on another device: "Call on <device> · <name>: <line>" with Take over and Join; Join opens its chat first when another one is open', async () => {
  const { done, actions: run } = actions();
  const [notice] = callNotices([running], { now: NOW, open: 'ch_a', talking: () => false }, run);
  assert.equal(notice.text, 'Call on Pixel · Ava: Das Budget reicht.');
  assert.equal(notice.priority, NOTICE_PRIORITY.call);
  assert.deepEqual(notice.actions?.map((action) => action.label), ['Take over', 'Join']);
  await notice.actions![0].run();
  await notice.actions![1].run();
  assert.deepEqual(done, ['answer ch_b call_x', 'open ch_b', 'join ch_b call_x']);
  const here = actions();
  await callNotices([running], { now: NOW, open: 'ch_b', talking: () => false }, here.actions)[0].actions![1].run();
  assert.deepEqual(here.done, ['join ch_b call_x'], 'its chat is open: it only joins');
  assert.equal(callNotices([{ ...running, device: 'Pixel and laptop' }], { now: NOW, open: null, talking: () => false }, run)[0].text, 'Call on Pixel and laptop · Ava: Das Budget reicht.');
});

test('nothing for a call this device talks in or a ring whose time is over; at most two actions', () => {
  const talkingHere = (id: string) => id === 'ch_a' || id === 'ch_b';
  assert.deepEqual(callNotices([ring, running], { now: NOW, open: null, talking: talkingHere }, actions().actions), []);
  assert.deepEqual(ringingHere([ring], { now: NOW + 30_000, talking: () => false }), [], 'rang out');
  assert.deepEqual(callNotices([{ ...ring, why: undefined, agentName: undefined }], { now: NOW, open: null, talking: () => false }, actions().actions).map((notice) => notice.text), ['An agent calls · AI voice (machine-generated)']);
  for (const notice of callNotices([ring, running], { now: NOW, open: null, talking: () => false }, actions().actions)) assert.ok((notice.actions?.length ?? 0) <= MAX_NOTICE_ACTIONS);
});

test('Team-Call: another person\'s call says who is in and offers Join only (primary) – it opens the chat first', async () => {
  const { done, actions: run } = actions();
  const others: LiveCall = { ...running, callId: 'call_o', device: 'Dominik', others: true };
  const [notice] = callNotices([others], { now: NOW, open: 'ch_other', talking: () => false }, run);
  assert.equal(notice.text, 'Call with Dominik · Ava: Das Budget reicht.');
  assert.deepEqual(notice.actions?.map((action) => [action.label, action.primary ?? false]), [['Join', true]]);
  await notice.actions![0].run();
  assert.deepEqual(done, ['open ch_b', 'join ch_b call_o']);
});
