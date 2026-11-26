// Chat-side handlers (R3-S1) against the real chat/task/schedule services: chats, messages
// (sticky composer choice, stop, retry, schedule), blocks (answer/state/appHtml/sandboxUrl/event),
// settings scope limits and UI state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { uiBlocksOf } from '../../../src/shared/blocks/parse.ts';
import type { Conversation, Message } from '../../../src/shared/model/chat.ts';
import type { Schedule } from '../../../src/shared/model/tasks.ts';
import { SANDBOX_URL_TTL_MS, sandboxTokens } from '../../../src/runtime/http/sandbox-token.ts';
import { OWNER, PHONE, TODO_ONLY, TestClient, rpcFixture, settle } from './s1-helpers.ts';

function setup() {
  const f = rpcFixture();
  f.org.add(agent('ag_ava', 'Ava'));
  f.org.add(agent('ag_ben', 'Ben'));
  return { ...f, owner: new TestClient(f.server, OWNER), phone: new TestClient(f.server, PHONE) };
}

test('chats.create with a first message sends it as the human and remembers the chat', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const chat = await f.phone.call<Conversation>('chats.create', { agentIds: ['ag_ava'], firstMessage: 'Plan the launch video' });
  const list = await f.phone.call<Message[]>('messages.list', { conversationId: chat.id });
  assert.equal(list.length, 1);
  assert.equal(list[0].authorId, 'human');
  assert.equal(list[0].authorKind, 'human');
  assert.equal(chat.title, 'Plan the launch video', 'title derived from the first message');
  const state = await f.owner.call<{ lastConversationId?: string }>('ui.state');
  assert.equal(state.lastConversationId, chat.id);
  assert.ok(f.wakeRows().some((wake) => wake.agent_id === 'ag_ava' && wake.reason === 'message'));
  assert.equal((await f.phone.request('chats.create', { agentIds: ['ag_nobody'] })).error?.code, 'not_found');
  assert.equal((await new TestClient(f.server, TODO_ONLY).request('chats.archive', { id: chat.id })).error?.code, 'forbidden', 'archiving needs the chat capability');
  assert.deepEqual((await f.phone.request('chats.archive', { id: chat.id })).result, { ok: true }, 'a chat device may archive (DEV2 tiers)');
});

// B-050 K6 (deliberate change): `model` is a hint for the addressed agent and the message's tag; pin: true pins it.
// 26.11.2026 (owner): it applies to that one message – the line carries it, the chat is on Auto again (chat/sticky-model.ts).
test('messages.send: model is the addressed agent\'s hint and the message\'s tag for that message only, pin: true pins it for the tag, auto clears', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const chat = f.chats.create({ agentIds: ['ag_ava', 'ag_ben'], createdBy: 'human' });
  const lead = f.chats.lead(chat.id)!;
  const settings = () => f.chats.get(chat.id)!.settings;
  const first = await f.owner.call<Message>('messages.send', { conversationId: chat.id, body: 'Draft the post', model: 'claude:claude-opus-5-5', effort: 'high' });
  assert.equal(first.authorKind, 'human');
  assert.deepEqual(first.meta.modelHint, { modelId: 'claude:claude-opus-5-5', effort: 'high' });
  assert.deepEqual([settings().modelHints, settings().models, settings().efforts], [undefined, undefined, undefined], 'one message only: the chat is on Auto again');
  assert.equal(f.extras.policyStore.size, 0, 'no second writer (the policy store is untouched)');
  const low = await f.owner.call<Message>('messages.send', { conversationId: chat.id, body: '@Ben check this', effort: 'low' });
  assert.deepEqual(low.meta.modelHint, { effort: 'low' }, 'the mentioned agent gets the choice');
  assert.equal(settings().efforts, undefined);
  const pinned = await f.owner.call<Message>('messages.send', { conversationId: chat.id, body: '@Ben always', model: 'codex:gpt-6-luna', pin: true });
  assert.deepEqual(pinned.meta.modelHint, { modelId: 'codex:gpt-6-luna', pinned: true });
  assert.equal(settings().models, undefined, 'a pin does not stay either');
  assert.notEqual(lead, 'ag_ben');
  const auto = await f.owner.call<Message>('messages.send', { conversationId: chat.id, body: 'back to auto', model: 'auto', effort: 'auto' });
  assert.equal(auto.meta.modelHint, undefined);
  assert.equal((await f.owner.request('messages.send', { conversationId: chat.id, body: 'x', model: 'use opus\nnow' })).error?.code, 'bad_request', 'a model id only (it reaches prompts)');
  assert.equal((await f.owner.request('messages.send', { conversationId: chat.id, body: 'x', pin: true })).error?.code, 'bad_request', 'pin: true needs a model');
  assert.equal((await f.owner.request('messages.send', { conversationId: chat.id, body: 'x', effort: 'turbo' })).error?.code, 'bad_request');
  assert.equal((await f.owner.request('messages.send', { conversationId: chat.id, body: '  ' })).error?.code, 'bad_request');
  assert.equal((await f.owner.request('messages.send', { conversationId: chat.id, body: 'x', attachments: [{ fileId: 'f'.repeat(64) }] })).error?.code, 'bad_request');
});

test('messages.stop interrupts agents running in that chat only', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const chat = f.chats.create({ agentIds: ['ag_ava', 'ag_ben'], createdBy: 'human' });
  f.dispatcher.active = [
    { agentId: 'ag_ava', runId: 'run_1', conversationId: chat.id, note: '', startedAt: 0 },
    { agentId: 'ag_ben', runId: 'run_2', conversationId: 'ch_other', note: '', startedAt: 0 },
  ];
  await f.phone.call('messages.stop', { conversationId: chat.id });
  assert.deepEqual(f.dispatcher.interrupts, [{ agentId: 'ag_ava', conversationId: chat.id }]);
  f.dispatcher.interrupts = [];
  await f.phone.call('messages.stop', { conversationId: chat.id, agentId: 'ag_ben' });
  assert.deepEqual(f.dispatcher.interrupts, [{ agentId: 'ag_ben', conversationId: chat.id }]);
});

test('messages.retry re-wakes the author of a failed or stopped answer', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const failed = f.chats.postAgentMessage(chat.id, 'ag_ava', 'run_1', { body: 'half', state: 'failed', meta: { error: 'Rate limited' } });
  f.db.run('DELETE FROM wakes');
  await f.phone.call('messages.retry', { messageId: failed.id });
  const wakes = f.wakeRows();
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].agent_id, 'ag_ava');
  assert.equal(wakes[0].reason, 'manual', 'a turn the human asked for');
  assert.equal(wakes[0].task_id, null, 'the run had no task');
  assert.match(wakes[0].note ?? '', /failed \(Rate limited\)/);
  // A stopped answer of a task turn: the retry is a turn on that task (T03).
  f.services.runs.start({ id: 'run_task', agentId: 'ag_ava', conversationId: chat.id, taskId: 'task_x', trigger: 'task' });
  const stopped = f.chats.postAgentMessage(chat.id, 'ag_ava', 'run_task', { body: 'half', state: 'stopped' });
  f.db.run('DELETE FROM wakes');
  await f.phone.call('messages.retry', { messageId: stopped.id });
  assert.deepEqual(f.wakeRows().map((wake) => [wake.reason, wake.task_id]), [['manual', 'task_x']]);
  const fine = f.chats.postAgentMessage(chat.id, 'ag_ava', 'run_2', { body: 'ok', state: 'final' });
  assert.equal((await f.phone.request('messages.retry', { messageId: fine.id })).error?.code, 'conflict');
});

test('messages.schedule creates a human message schedule', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const at = f.clock.now() + 3_600_000;
  const schedule = await f.phone.call<Schedule>('messages.schedule', { conversationId: chat.id, body: 'Post the recap', spec: { at }, mentions: ['ag_ava'] });
  assert.equal(schedule.ownerId, 'human');
  assert.equal(schedule.kind, 'message');
  assert.equal(schedule.nextAt, at);
  assert.deepEqual(schedule.payload, { body: 'Post the recap', mentions: ['ag_ava'] });
  assert.equal((await f.phone.request('messages.schedule', { conversationId: chat.id, body: 'x', spec: { everyMs: 5 } })).error?.code, 'bad_request');
});

test('blocks.answer answers an agent ask block: to-do done, receipt posted, author woken', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const body = 'Need your OK:\n```ui\n{"type":"approve","id":"pay-canva","action":"Buy Canva Pro","important":true}\n```';
  const message = f.chats.postAgentMessage(chat.id, 'ag_ava', 'run_1', { body, state: 'final' });
  const [todo] = f.tasks.ingestBlocks(message, uiBlocksOf(body).map((entry) => entry.block));
  assert.equal(todo.assigneeKind, 'human');
  f.db.run('DELETE FROM wakes');
  const result = await f.phone.call<{ ok: true; taskId?: string }>('blocks.answer', { messageId: message.id, blockIndex: 0, answer: { approved: true } });
  assert.equal(result.taskId, todo.id);
  assert.equal(f.tasks.get(todo.id)?.status, 'done');
  const receipt = f.chats.messages(chat.id).find((m) => m.kind === 'answer');
  assert.equal(receipt?.body, 'Yes', 'B-078: an approve card is a yes/no quick reply');
  assert.deepEqual(f.wakeRows().filter((wake) => wake.agent_id === 'ag_ava').map((wake) => [wake.reason, wake.conversation_id, wake.task_id]), [['message', chat.id, null]], 'woken once, as for a typed line (B-076) – no second word about the to-do');
  assert.ok(!f.chats.messages(chat.id).some((m) => m.kind === 'status' && m.taskId === todo.id), 'the to-do completes quietly: no "Done: …" line');
  assert.ok(f.wakeRows().every((wake) => !wake.note), 'no [ui-answer] note: the line is the news');
});

test('blocks.state stores per-block state; blocks.appHtml serves the app fence', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const body = 'Calculator:\n```app title="Calc"\n<button>1</button>\n```';
  const message = f.chats.postAgentMessage(chat.id, 'ag_ava', 'run_1', { body, state: 'final' });
  assert.deepEqual(await f.phone.call('blocks.state', { messageId: message.id, blockIndex: 0 }), { state: null });
  await f.phone.call('blocks.state', { messageId: message.id, blockIndex: 0, state: { volume: 0.4 } });
  assert.deepEqual(await f.owner.call('blocks.state', { messageId: message.id, blockIndex: 0 }), { state: { volume: 0.4 } });
  assert.deepEqual(await f.phone.call('blocks.appHtml', { messageId: message.id, blockIndex: 0 }), { html: '<button>1</button>' });
  assert.equal((await f.phone.request('blocks.appHtml', { messageId: message.id, blockIndex: 1 })).error?.code, 'not_found');
  assert.equal((await f.phone.request('blocks.state', { messageId: 'msg_missing', blockIndex: 0 })).error?.code, 'not_found');
});

test('blocks.sandboxUrl returns a 10-minute capability path for an app fence, verifiable by the HTTP route', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const body = 'Calculator:\n```app title="Calc"\n<button>1</button>\n```';
  const message = f.chats.postAgentMessage(chat.id, 'ag_ava', 'run_1', { body, state: 'final' });
  const result = await f.phone.call<{ url: string; expiresAt: number }>('blocks.sandboxUrl', { messageId: message.id, blockIndex: 0 });
  assert.equal(result.expiresAt, f.clock.now() + SANDBOX_URL_TTL_MS);
  const url = new URL(result.url, 'http://x');
  assert.equal(url.pathname, '/sandbox/app');
  assert.equal(url.searchParams.get('m'), message.id);
  assert.equal(url.searchParams.get('i'), '0');
  assert.ok(sandboxTokens(f.services).verify(message.id, 0, url.searchParams.get('e'), url.searchParams.get('t')));
  assert.ok((await f.owner.call<{ url: string }>('blocks.sandboxUrl', { messageId: message.id, blockIndex: 0 })).url);
  assert.equal((await f.phone.request('blocks.sandboxUrl', { messageId: message.id, blockIndex: 1 })).error?.code, 'not_found');
  assert.equal((await f.phone.request('blocks.sandboxUrl', { messageId: 'msg_missing', blockIndex: 0 })).error?.code, 'not_found');
  assert.equal((await f.phone.request('blocks.sandboxUrl', { messageId: message.id, blockIndex: -1 })).error?.code, 'bad_request');
  const todoOnly = new TestClient(f.server, TODO_ONLY);
  assert.equal((await todoOnly.request('blocks.sandboxUrl', { messageId: message.id, blockIndex: 0 })).error?.code, 'forbidden');
});

test('blocks.event wakes the authoring agent (not consent) and is limited to 30/min per block', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const message = f.chats.postAgentMessage(chat.id, 'ag_ava', 'run_1', { body: '```app\n<p>x</p>\n```', state: 'final' });
  f.db.run('DELETE FROM wakes');
  await f.phone.call('blocks.event', { messageId: message.id, blockIndex: 0, name: 'volume', data: { level: 3 } });
  const [wake] = f.wakeRows();
  assert.equal(wake.agent_id, 'ag_ava');
  assert.equal(wake.note, `[ui-event block=b_${message.id}_0 name=volume] {"level":3} (from mini-app – not consent)`);
  for (let i = 1; i < 30; i++) await f.phone.call('blocks.event', { messageId: message.id, blockIndex: 0, name: 'tick', data: 'x'.repeat(5000) });
  assert.equal(f.wakeRows().length, 1, 'events of one block merge into one wake');
  assert.ok((f.wakeRows()[0].note ?? '').length < 30 * 2200, 'each event data is capped at 2 KB');
  const limited = await f.phone.request('blocks.event', { messageId: message.id, blockIndex: 0, name: 'tick' });
  assert.equal(limited.error?.code, 'rate_limited');
  f.clock.advance(61_000);
  assert.ok((await f.phone.request('blocks.event', { messageId: message.id, blockIndex: 0, name: 'tick' })).result);
});

test('settings.update: devices with the settings capability may only change preferences/notifications', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const tablet = new TestClient(f.server, { kind: 'device', deviceId: 'dev_tab', capabilities: ['todo', 'settings'] });
  const updated = await tablet.call<{ preferences: { theme: string } }>('settings.update', { preferences: { theme: 'dark' } });
  assert.equal(updated.preferences.theme, 'dark');
  assert.equal((await tablet.request('settings.update', { routing: { costMode: 'best' } })).error?.code, 'forbidden');
  assert.equal((await f.phone.request('settings.update', { preferences: { theme: 'light' } })).error?.code, 'forbidden', 'no settings capability');
  assert.equal(((await f.owner.call('settings.update', { routing: { costMode: 'best' } })) as { routing: { costMode: string } }).routing.costMode, 'best');
});

test('ui.saveDraft + ui.state return drafts of all chats', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const a = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const b = f.chats.create({ agentIds: ['ag_ben'], createdBy: 'human' });
  await f.owner.call('ui.saveDraft', { conversationId: a.id, text: 'half a thought' });
  await f.owner.call('ui.saveDraft', { conversationId: b.id, text: 'other' });
  await f.owner.call('ui.saveDraft', { conversationId: b.id, text: '' });
  const state = await f.owner.call<{ drafts: Record<string, string>; lastConversationId?: string }>('ui.state');
  assert.deepEqual(state.drafts, { [a.id]: 'half a thought' });
  assert.equal(state.lastConversationId, b.id);
});

// task_cxs4s3pt (26.11.2026): the phone's bubble sends its line into ui.state's lastConversationId, so only the person
// moves it – an agent's own wf or a plain launch token reading another chat leaves it where the person was.
test('lastConversationId: the person opening a chat sets it, an agent or a shell reading another chat does not', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const mine = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const other = f.chats.create({ agentIds: ['ag_ben'], createdBy: 'human' });
  await f.owner.call('chats.markRead', { id: mine.id, seq: 0 });
  const last = async () => (await f.owner.call<{ lastConversationId?: string }>('ui.state')).lastConversationId;
  assert.equal(await last(), mine.id, 'the person opened it in their window');
  const agentWf = new TestClient(f.server, { kind: 'owner', agentId: 'ag_ben' });
  await agentWf.request('messages.list', { conversationId: other.id });
  await agentWf.request('chats.markRead', { id: other.id, seq: 0 });
  await agentWf.request('ui.saveDraft', { conversationId: other.id, text: '' });
  await agentWf.request('chats.direct', { memberId: 'ag_ben' });
  await agentWf.request('messages.send', { conversationId: other.id, body: 'read it' });
  assert.equal(await last(), mine.id, "an agent's own wf reading or writing another chat leaves it");
  const shell = new TestClient(f.server, { kind: 'owner' });
  await shell.request('chats.markRead', { id: other.id, seq: 0 });
  await shell.request('chats.direct', { memberId: 'ag_ben' });
  assert.equal(await last(), mine.id, 'a plain launch token (any shell) leaves it');
  await f.phone.call('chats.markRead', { id: other.id, seq: 0 });
  assert.equal(await last(), other.id, "the person's phone opening a chat moves it");
});

// task_cxs4s3pt (26.11.2026): the bubble's path on the PC – the phone uploads the screenshot, asks ui.state and chats.get
// for the chat the person used last and sends one line there: a chat line with the picture, no to-do on the Tasks page.
test('bubble line: a screenshot and a question from the phone become one chat line with the image, never a to-do', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  await f.owner.call('chats.markRead', { id: chat.id, seq: 0 });
  const tasksBefore = f.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')?.n ?? 0;
  const last = (await f.phone.call<{ lastConversationId?: string }>('ui.state')).lastConversationId;
  assert.equal(last, chat.id);
  const summary = await f.phone.call<{ id: string; members: Array<{ memberId: string; kind: string }> }>('chats.get', { id: last });
  assert.ok(summary.members.some((member) => member.kind === 'agent' && member.memberId === 'ag_ava'), 'the bubble finds the agent in that chat');
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);
  const name = 'Screenshot of the page the person was on when asking.jpg';
  const ref = await f.phone.call<{ id: string }>('files.upload', { name, mime: 'image/jpeg', dataBase64: jpeg.toString('base64') });
  const sent = await f.phone.call<Message>('messages.send', { conversationId: chat.id, body: 'Was steht auf dieser Seite?', attachments: [{ fileId: ref.id, name }], clientId: 'bubble:c1' });
  const again = await f.phone.call<Message>('messages.send', { conversationId: chat.id, body: 'Was steht auf dieser Seite?', attachments: [{ fileId: ref.id, name }], clientId: 'bubble:c1' });
  assert.equal(again.id, sent.id, 'a retry with the same client id answers the first line');
  const lines = await f.owner.call<Message[]>('messages.list', { conversationId: chat.id });
  const line = lines.find((message) => message.id === sent.id);
  assert.ok(line && line.authorId === 'human' && line.kind === 'text' && line.body === 'Was steht auf dieser Seite?');
  assert.deepEqual(line.attachments?.map((file) => [file.fileId, file.name, file.mime]), [[ref.id, name, 'image/jpeg']], 'the picture stands in the line');
  assert.equal(lines.filter((message) => message.authorId === 'human').length, 1, 'one line, not two');
  assert.equal(f.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')?.n ?? 0, tasksBefore, 'no to-do was made');
  assert.ok(f.wakeRows().some((wake) => wake.agent_id === 'ag_ava' && wake.reason === 'message'), 'the agent of that chat is woken by the line');
});

test('chat events reach a phone subscribed to the chat topic', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  await f.phone.call('events.subscribe', { topics: ['chats', `chat:${chat.id}`] });
  await f.owner.call('messages.send', { conversationId: chat.id, body: 'hello' });
  await settle();
  assert.equal(f.phone.events('message.created').length, 1);
  assert.ok(f.phone.events('conversation.upserted').length >= 1);
});
