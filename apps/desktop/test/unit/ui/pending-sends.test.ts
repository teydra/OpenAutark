// Owner 24.11.2026 (task_ec8e4ztn, "zehn Sekunden steht nichts da"): a sent line stands in its chat at once – before
// messages.send answers – and the stored message takes its place without a double, whether its event comes before or
// after the answer; a failed send stays as a failed line with Send again (same clientId) and its text back if the field is untouched.
// Owns: these assertions (src/ui/chat/composer/send.ts, pending-sends.ts, receipts.ts unsentLines). Never: a real runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../../../src/shared/model/chat.ts';
import { rpc } from '../../../src/ui/lib/rpc.ts';

const calls: Array<Record<string, unknown>> = [];
let currentPC: string | undefined;
let answer: (params: Record<string, unknown>) => Promise<unknown> = async () => ({});
(rpc as unknown as { call: unknown }).call = async (method: string, params: Record<string, unknown>) => {
  if (method === 'system.info') return { deviceId: currentPC };
  if (method !== 'messages.send') return { ok: true };
  calls.push(params);
  return answer(params);
};
const { draftFor, updateDraft } = await import('../../../src/ui/chat/composer/draft.ts');
const { sendDraft, resendPending } = await import('../../../src/ui/chat/composer/send.ts');
const { pendingSends, unsentLines } = await import('../../../src/ui/chat/pending-sends.ts');
const { messagesFor, putMessage, systemInfo } = await import('../../../src/ui/lib/store.ts');
const { session } = await import('../../../src/ui/lib/session.ts');
session.value = { kind: 'owner', capabilities: [], secure: true, allowedMethods: [] };

function stored(conversationId: string, seq: number, body: string, extra: Partial<Message> = {}): Message {
  return {
    id: `msg_${conversationId}_${seq}`, conversationId, seq, authorId: 'human', authorKind: 'human', kind: 'text', body, attachments: [],
    mentions: [], priority: 'normal', state: 'final', silent: false, meta: {}, createdAt: 1000 + seq, ...extra,
  };
}

/** What the chat shows now: its stored messages' bodies, then its unsent lines' (state in brackets). */
function shown(conversationId: string): string[] {
  const list = messagesFor(conversationId).peek();
  const lines = unsentLines(pendingSends.peek().filter((line) => line.conversationId === conversationId), list);
  return [...list.map((message) => message.body), ...lines.map((line) => `${line.body} [${line.state}]`)];
}

test('the line shows before messages.send answers – nothing is awaited first', async () => {
  messagesFor('ch_now').value = [stored('ch_now', 1, 'earlier', { authorId: 'ag_1', authorKind: 'agent' })];
  let release!: (value: unknown) => void;
  answer = () => new Promise((resolve) => { release = resolve; });
  updateDraft('ch_now', { text: 'hello there' });
  const sending = sendDraft({ conversationId: 'ch_now', body: 'hello there', level: 'normal', mentions: () => [] });
  // Synchronously after the call: the line is in the chat, the field is empty.
  assert.deepEqual(shown('ch_now'), ['earlier', 'hello there [sending]']);
  assert.equal(draftFor('ch_now').peek().text, '');
  release(stored('ch_now', 2, 'hello there'));
  assert.equal(await sending, true);
  assert.deepEqual(shown('ch_now'), ['earlier', 'hello there'], 'the stored message took its place – once');
});

test('the event with the stored message before the answer: no double while the answer is on its way', async () => {
  messagesFor('ch_echo').value = [];
  let release!: (value: unknown) => void;
  answer = () => new Promise((resolve) => { release = resolve; });
  updateDraft('ch_echo', { text: 'ping' });
  const sending = sendDraft({ conversationId: 'ch_echo', body: 'ping', level: 'normal', mentions: () => [] });
  const message = stored('ch_echo', 1, 'server rewrote the text', { clientId: String(calls.at(-1)!.clientId) });
  putMessage(message); // message.created arrives first
  assert.deepEqual(shown('ch_echo'), ['server rewrote the text']);
  release(message);
  await sending;
  assert.deepEqual(shown('ch_echo'), ['server rewrote the text']);
  assert.equal(pendingSends.peek().some((line) => line.conversationId === 'ch_echo'), false);
});

test('an unrelated identical message never hides a line, even if it arrived later', () => {
  const list = [stored('ch_same', 3, 'ok'), stored('ch_same', 4, 'ok', { clientId: 'req_other' })];
  const line = { clientId: 'req_1', conversationId: 'ch_same', body: 'ok', attachments: [], createdAt: 2000, state: 'sending' as const };
  assert.deepEqual(unsentLines([line], list), [line]);
  assert.deepEqual(unsentLines([line], [...list, stored('ch_same', 6, 'anything', { clientId: 'req_1' })]), []);
});

test('a failed send stays visible as failed, its text is back in the draft, and Send again uses the same clientId', async () => {
  messagesFor('ch_fail2').value = [];
  answer = async () => { throw new Error('offline'); };
  updateDraft('ch_fail2', { text: 'do not lose me' });
  assert.equal(await sendDraft({ conversationId: 'ch_fail2', body: 'do not lose me', level: 'normal', mentions: () => [] }), false);
  assert.deepEqual(shown('ch_fail2'), ['do not lose me [failed]']);
  assert.equal(draftFor('ch_fail2').peek().text, 'do not lose me', 'the text is in the field again');
  const line = pendingSends.peek().find((item) => item.conversationId === 'ch_fail2')!;
  assert.match(line.error ?? '', /offline/);
  const first = calls.at(-1)!;
  answer = async (params) => stored('ch_fail2', 1, String(params.body));
  assert.equal(await resendPending(line.clientId), true);
  assert.equal(calls.at(-1)!.clientId, first.clientId, 'the runtime answers a send that did arrive with the stored message');
  assert.deepEqual(shown('ch_fail2'), ['do not lose me']);
  assert.equal(draftFor('ch_fail2').peek().text, '', 'sent: the field holds it no more');
});

test('sent again from the field, the failed line goes', async () => {
  messagesFor('ch_fail3').value = [];
  answer = async () => { throw new Error('offline'); };
  updateDraft('ch_fail3', { text: 'again' });
  await sendDraft({ conversationId: 'ch_fail3', body: 'again', level: 'normal', mentions: () => [] });
  answer = async () => stored('ch_fail3', 1, 'again');
  await sendDraft({ conversationId: 'ch_fail3', body: 'again', level: 'normal', mentions: () => [] });
  assert.equal(calls.at(-1)!.clientId, calls.at(-2)!.clientId);
  assert.deepEqual(shown('ch_fail3'), ['again']);
});

test('a line still being transcribed shows even beside an equal stored text, and takes the send\'s clientId', async () => {
  const { addPending } = await import('../../../src/ui/chat/pending-sends.ts');
  messagesFor('ch_take').value = [];
  addPending({ clientId: 'req_take', conversationId: 'ch_take', body: '', attachments: [], state: 'transcribing' });
  assert.deepEqual(shown('ch_take'), [' [transcribing]']);
  let release!: (value: unknown) => void;
  answer = () => new Promise((resolve) => { release = resolve; });
  updateDraft('ch_take', { text: 'heard words' });
  const sending = sendDraft({ conversationId: 'ch_take', body: 'heard words', level: 'normal', mentions: () => [], clientId: 'req_take' });
  assert.deepEqual(shown('ch_take'), ['heard words [sending]'], 'the same line, now with its words');
  assert.equal(calls.at(-1)!.clientId, 'req_take');
  release(stored('ch_take', 1, 'heard words'));
  await sending;
  assert.deepEqual(shown('ch_take'), ['heard words']);
});


test('a slow failed send and its later retry never overwrite a newer draft', async () => {
  let reject!: (error: Error) => void;
  answer = () => new Promise((_resolve, fail) => { reject = fail; });
  updateDraft('ch_newer', { text: 'first note' });
  const sending = sendDraft({ conversationId: 'ch_newer', body: 'first note', level: 'normal', mentions: () => [] });
  updateDraft('ch_newer', { text: 'new draft' });
  reject(new Error('offline'));
  assert.equal(await sending, false);
  assert.deepEqual(shown('ch_newer'), ['first note [failed]']);
  assert.equal(draftFor('ch_newer').peek().text, 'new draft');
  const line = pendingSends.peek().find((item) => item.conversationId === 'ch_newer')!;
  answer = async () => stored('ch_newer', 1, 'first note');
  assert.equal(await resendPending(line.clientId), true);
  assert.equal(draftFor('ch_newer').peek().text, 'new draft');
});

test('a stored-message event settles a send even if the RPC answer was lost', async () => {
  let reject!: (error: Error) => void;
  answer = () => new Promise((_resolve, fail) => { reject = fail; });
  messagesFor('ch_lost').value = [];
  updateDraft('ch_lost', { text: 'after the event' });
  const sending = sendDraft({ conversationId: 'ch_lost', body: 'after the event', level: 'normal', mentions: () => [] });
  putMessage(stored('ch_lost', 1, 'after the event', { clientId: String(calls.at(-1)!.clientId) }));
  reject(new Error('connection dropped'));
  assert.equal(await sending, true);
  assert.equal(draftFor('ch_lost').peek().text, '');
  assert.deepEqual(shown('ch_lost'), ['after the event']);
});


test('a retry cannot create a second message on a different PC', async () => {
  rpc.status.value = 'open';
  systemInfo.value = { deviceId: 'pc_original' } as NonNullable<typeof systemInfo.value>;
  currentPC = 'pc_other';
  try {
    answer = async () => { throw new Error('answer lost'); };
    updateDraft('ch_pc', { text: 'unsure whether it arrived' });
    await sendDraft({ conversationId: 'ch_pc', body: 'unsure whether it arrived', level: 'normal', mentions: () => [] });
    const line = pendingSends.peek().find((item) => item.conversationId === 'ch_pc')!;
    const count = calls.length;
    assert.equal(await resendPending(line.clientId), false);
    assert.equal(calls.length, count, 'never replay a PC-local idempotency key on another PC');
    assert.match(pendingSends.peek().find((item) => item.clientId === line.clientId)!.error!, /another PC/);
    currentPC = 'pc_original';
    answer = async () => stored('ch_pc', 1, 'unsure whether it arrived');
    assert.equal(await resendPending(line.clientId), true);
    assert.equal(calls.at(-1)!.clientId, line.clientId);
  } finally {
    currentPC = undefined;
    systemInfo.value = null;
    rpc.status.value = 'closed';
  }
});
