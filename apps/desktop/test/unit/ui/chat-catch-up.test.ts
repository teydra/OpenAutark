// Owner 27.11.2026: "I see the first characters of an agent's new message in the list, but the chat opens without it and
// it takes very long". The page hears message events only for the open chat (chat:<id>), the list's preview comes with
// the chat's summary – so a chat of the list whose summary says it has a line this page does not hold asks for its
// newest lines at once (lib/store.ts catchUp), and the chat opens with that line; the open's load then fills in behind
// what is shown without blanking it (takeNewest). Only chats of the main list, never the open chat (it hears its own
// lines), one ask per chat at a time, again when the summary moved on meanwhile.
// Owns: these assertions only (rpc is a fake). Never: a real socket or runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationSummary, Message } from '../../../src/shared/model/chat.ts';
import { rpc } from '../../../src/ui/lib/rpc.ts';

const asked: Array<{ conversationId: string; limit?: number }> = [];
let answer: (params: { conversationId: string; limit?: number }) => Message[] = () => [];
let hold: Promise<void> = Promise.resolve();
(rpc as unknown as { onOpen: unknown }).onOpen = () => () => undefined;
(rpc as unknown as { call: unknown }).call = async (method: string, params: { conversationId: string; limit?: number }) => {
  if (method !== 'messages.list') return { ok: true };
  asked.push(params);
  const page = answer(params); // what the PC holds when the ask arrives
  await hold;
  return page;
};
rpc.status.value = 'open';
const { catchUp, conversations, messagesFor, takeNewest } = await import('../../../src/ui/lib/store.ts');

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const line = (chat: string, seq: number, body = `#${seq}`) => ({
  id: `${chat}_${seq}`, conversationId: chat, seq, authorId: 'ag_tom', authorKind: 'agent', kind: 'text', body, attachments: [], mentions: [],
  priority: 'normal', state: 'final', silent: false, meta: {}, createdAt: seq,
}) as Message;
const summary = (id: string, lastSeq: number, extra: Partial<ConversationSummary> = {}) => ({
  id, title: id, titleNamed: true, createdBy: 'human', pinned: false, settings: {}, lastSeq, createdAt: 1, updatedAt: 1,
  members: [{ conversationId: id, memberId: 'human', kind: 'human', role: 'owner', joinedAt: 1, readSeq: 0 }],
  unread: 1, working: [], openTasks: 0, lastPreview: { authorId: 'ag_tom', text: `#${lastSeq}`, at: lastSeq }, ...extra,
}) as unknown as ConversationSummary;

test('a chat whose preview shows a line this page does not hold: its newest lines are asked at once and are there before it opens', async () => {
  asked.length = 0;
  answer = ({ conversationId }) => [line(conversationId, 4), line(conversationId, 5, 'Here is the plan')];
  const chat = summary('cv_a', 5);
  conversations.value = [chat];
  catchUp(chat);
  catchUp(chat); // a second summary while the first ask runs: one ask
  assert.deepEqual(asked, [{ conversationId: 'cv_a', limit: 10 }]);
  await flush();
  const held = messagesFor('cv_a').value;
  assert.equal(held[held.length - 1].body, 'Here is the plan', 'the chat holds the line its preview shows');
  catchUp(chat);
  assert.equal(asked.length, 1, 'nothing new: no ask');
});

test('the summary moved on while the ask ran: it is asked again once; a chat outside the main list or a closed socket is not asked', async () => {
  asked.length = 0;
  let release!: () => void;
  hold = new Promise((resolve) => { release = resolve; });
  answer = ({ conversationId }) => [line(conversationId, 1)];
  const chat = summary('cv_b', 1);
  conversations.value = [chat];
  catchUp(chat);
  conversations.value = [summary('cv_b', 2)]; // one more line came meanwhile
  answer = ({ conversationId }) => [line(conversationId, 1), line(conversationId, 2)];
  release();
  await flush();
  await flush();
  assert.equal(asked.length, 2, 'asked again for the line that came meanwhile');
  await flush();
  assert.deepEqual(messagesFor('cv_b').value.map((message) => message.seq), [1, 2]);
  hold = Promise.resolve();

  catchUp(summary('cv_team', 3, { members: [] })); // an agents' room: not in the person's list
  rpc.status.value = 'closed';
  catchUp(summary('cv_c', 3)); // the next open socket catches up (loadAll)
  rpc.status.value = 'open';
  assert.equal(asked.length, 2);
});

test('the open load fills in behind: shown lines never blank, older loaded pages stay, a page that does not join replaces', () => {
  const list = messagesFor('cv_d');
  list.value = [1, 2, 3, 4, 5].map((seq) => line('cv_d', seq));
  takeNewest('cv_d', [4, 5, 6].map((seq) => line('cv_d', seq, seq === 5 ? 'edited' : `#${seq}`)), 3);
  assert.deepEqual(list.value.map((message) => message.seq), [1, 2, 3, 4, 5, 6], 'the older held lines stay, the new one joins');
  assert.equal(list.value[4].body, 'edited', 'the page wins for what it covers');

  takeNewest('cv_d', [20, 21, 22].map((seq) => line('cv_d', seq)), 3);
  assert.deepEqual(list.value.map((message) => message.seq), [20, 21, 22], 'more new lines than a page holds: the page replaces the gap');

  takeNewest('cv_d', [21, 22].map((seq) => line('cv_d', seq)), 3);
  assert.deepEqual(list.value.map((message) => message.seq), [21, 22], 'a short page is the whole chat (line 20 was deleted)');
});
