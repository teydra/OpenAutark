import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from './harness.ts';
import { chatTitleFor } from '../../../src/runtime/chat/titles.ts';

function setup() {
  const h = harness();
  h.org.add(agent('ag_mara', 'Mara', { mode: 'manager' }));
  h.org.add(agent('ag_tom', 'Tom', { managerId: 'ag_mara' }));
  h.org.add(agent('ag_lea', 'Lea Sophie', { managerId: 'ag_mara' }));
  return h;
}

test('create: 1 agent → 1:1 with that agent as lead, untitled (B-050 K2: each viewer sees the other member\'s name)', () => {
  const h = setup();
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  assert.equal(chat.title, '');
  assert.equal(chatTitleFor(h.services, chat.id, 'human'), 'Tom');
  assert.equal(chat.titleNamed, false);
  const members = h.chats.members(chat.id);
  assert.deepEqual(members.map(m => [m.memberId, m.role]), [['human', 'owner'], ['ag_tom', 'lead']]);
  assert.equal(h.of('conversation.upserted').length, 1);
});

test('create: group lead is the manager member; explicit lead wins; unknown agent rejected', () => {
  const h = setup();
  const group = h.chats.create({ title: 'Launch', agentIds: ['ag_tom', 'ag_mara', 'ag_lea'], createdBy: 'human' });
  assert.equal(h.chats.lead(group.id), 'ag_mara');
  assert.equal(group.titleNamed, true);
  const other = h.chats.create({ title: 'X', agentIds: ['ag_tom', 'ag_lea'], createdBy: 'human', lead: 'ag_lea' });
  assert.equal(h.chats.lead(other.id), 'ag_lea');
  const byAgent = h.chats.create({ title: 'Y', agentIds: ['ag_tom', 'ag_lea'], createdBy: 'ag_lea', humans: false });
  assert.equal(h.chats.lead(byAgent.id), 'ag_lea');
  assert.throws(() => h.chats.create({ agentIds: ['ag_nobody'], createdBy: 'human' }), /Agent not found/);
});

test('send: per-conversation monotonic seq, ordering across chats, events, preview, unread', () => {
  const h = setup();
  const a = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const b = h.chats.create({ agentIds: ['ag_lea'], createdBy: 'human' });
  const seqs: number[] = [];
  for (let i = 0; i < 5; i++) {
    seqs.push(h.chats.send({ conversationId: a.id, body: `hi ${i}`, authorId: 'human' }).seq);
    h.chats.send({ conversationId: b.id, body: `other ${i}`, authorId: 'human' });
  }
  assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
  assert.equal(h.chats.get(b.id)!.lastSeq, 5);
  // Agent replies → unread for the human; status lines and own messages do not count.
  h.clock.advance(1000);
  h.chats.send({ conversationId: a.id, body: 'Reply **one**\nsecond line', authorId: 'ag_tom' });
  h.chats.status(a.id, { type: 'note', text: 'Switched model' });
  const summary = h.chats.summary(a.id);
  assert.equal(summary.unread, 1);
  assert.equal(summary.lastPreview?.text, 'Reply one');
  assert.equal(summary.lastPreview?.authorId, 'ag_tom');
  h.chats.markRead(a.id, 'human', 7);
  assert.equal(h.chats.summary(a.id).unread, 0);
  // Human writing marks the chat read.
  h.chats.send({ conversationId: a.id, body: 'thanks', authorId: 'ag_tom' });
  h.chats.send({ conversationId: a.id, body: 'ok', authorId: 'human' });
  assert.equal(h.chats.summary(a.id).unread, 0);
  assert.ok(h.of('message.created').length >= 13);
});

test('send: clientId double-send guard returns the same message without new events', () => {
  const h = setup();
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const first = h.chats.send({ conversationId: chat.id, body: 'once', authorId: 'human', clientId: 'c1' });
  const created = h.of('message.created').length;
  const again = h.chats.send({ conversationId: chat.id, body: 'once', authorId: 'human', clientId: 'c1' });
  assert.equal(again.id, first.id);
  assert.equal(first.clientId, 'c1');
  assert.equal(again.clientId, 'c1');
  assert.equal(h.of('message.created').length, created);
  assert.equal(h.chats.messages(chat.id)[0].clientId, 'c1');
  assert.equal(h.chats.messages(chat.id).length, 1);
  assert.equal(h.wakeRows().length, 1);
});

test('send: non-member agents cannot post; human joins agent-only rooms when writing', () => {
  const h = setup();
  const room = h.chats.create({ title: 'Team', agentIds: ['ag_tom', 'ag_lea'], createdBy: 'ag_tom', humans: false });
  assert.throws(() => h.chats.send({ conversationId: room.id, body: 'x', authorId: 'ag_mara' }), /Only members/);
  assert.equal(h.chats.list().some(c => c.id === room.id), false, 'agent-only rooms are hidden by default');
  assert.equal(h.chats.list({ includeHidden: true }).some(c => c.id === room.id), true);
  h.chats.send({ conversationId: room.id, body: 'I am here', authorId: 'human' });
  assert.ok(h.chats.members(room.id).some(m => m.memberId === 'human'));
});

test('title: unnamed chat takes the first human message as title once; mentions parsed by name', () => {
  const h = setup();
  const chat = h.chats.create({ agentIds: ['ag_tom', 'ag_lea'], createdBy: 'human' });
  const m = h.chats.send({ conversationId: chat.id, body: '## Plan the launch video\n@Lea Sophie please help', authorId: 'human' });
  assert.equal(h.chats.get(chat.id)!.title, 'Plan the launch video');
  assert.deepEqual(m.mentions, ['ag_lea']);
  h.chats.send({ conversationId: chat.id, body: 'Something else', authorId: 'human' });
  assert.equal(h.chats.get(chat.id)!.title, 'Plan the launch video');
  h.chats.update(chat.id, { title: 'Launch' }, 'human');
  assert.equal(h.chats.get(chat.id)!.titleNamed, true);
  assert.equal(h.chats.messages(chat.id).at(-1)!.kind, 'status');
});

test('members: add/remove posts quiet status lines; lead is reassigned when removed', () => {
  const h = setup();
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.chats.setMembers(chat.id, { add: ['ag_mara', 'ag_lea'] }, 'human');
  let lines = h.chats.messages(chat.id).filter(m => m.kind === 'status');
  assert.deepEqual(lines.map(l => l.body), ['Added Mara', 'Added Lea Sophie']);
  assert.ok(lines.every(l => l.silent));
  assert.equal(h.chats.summary(chat.id).unread, 0);
  assert.equal(h.chats.lead(chat.id), 'ag_tom');
  h.chats.setMembers(chat.id, { remove: ['ag_tom'] }, 'human');
  assert.equal(h.chats.lead(chat.id), 'ag_mara');
  lines = h.chats.messages(chat.id).filter(m => m.kind === 'status');
  assert.equal(lines.at(-1)!.body, 'Removed Tom');
  // Re-adding works and keeps history authors.
  h.chats.setMembers(chat.id, { add: ['ag_tom'], lead: 'ag_tom' }, 'human');
  assert.equal(h.chats.lead(chat.id), 'ag_tom');
});

test('chats.send: an agent who left a chat posts nothing there – the rule of its run answers and <chat to> blocks', () => {
  const h = setup();
  const chat = h.chats.create({ title: 'Launch', agentIds: ['ag_tom', 'ag_mara'], createdBy: 'human' });
  h.chats.send({ conversationId: chat.id, body: 'Still here', authorId: 'ag_tom', authorKind: 'agent' });
  h.chats.setMembers(chat.id, { remove: ['ag_tom'] }, 'ag_tom');
  assert.throws(() => h.chats.send({ conversationId: chat.id, body: 'After leaving', authorId: 'ag_tom', authorKind: 'agent' }), /Only members can post/);
  assert.throws(() => h.chats.postAgentMessage(chat.id, 'ag_tom', 'run_1', { body: 'After leaving' }), /Only members can post/);
  assert.equal(h.chats.messages(chat.id).filter((m) => m.authorId === 'ag_tom' && m.kind === 'text').length, 1);
});

test('B-047 D4: postAgentMessage posts an answer at the end; a quiet one stays quiet unless it mentions the person; chat.send posts carry runId', () => {
  const h = setup();
  const chat = h.chats.create({ agentIds: ['ag_tom', 'ag_lea'], createdBy: 'human' });
  const quiet = h.chats.postAgentMessage(chat.id, 'ag_tom', 'run_1', { body: '@Lea Sophie please check the grade', silent: true });
  assert.deepEqual([quiet.state, quiet.runId, quiet.silent, quiet.mentions], ['final', 'run_1', true, ['ag_lea']], 'a colleague mention keeps it quiet');
  assert.deepEqual(h.wakeRows().map((row) => row.agent_id), ['ag_lea'], 'and still reaches the colleague');
  assert.equal(h.chats.summary(chat.id).unread, 0);
  const loud = h.chats.postAgentMessage(chat.id, 'ag_tom', 'run_2', { body: '@CEO please sign this', silent: true });
  assert.equal(loud.silent, false, 'a mention of the person is loud');
  assert.equal(h.notified.at(-1)?.kind, 'reply', 'KI-Runde 17.11.2026: an @mention by an agent addresses, only push rings');
  assert.throws(() => h.chats.postAgentMessage(chat.id, 'ag_mara', 'run_3', { body: 'Not a member' }), /Only members/);
  assert.equal(h.chats.send({ conversationId: chat.id, authorId: 'ag_tom', body: 'Update', runId: 'run_4' }).runId, 'run_4');
  assert.deepEqual([...h.chats.mentionsOf(chat.id, 'ag_tom', 'Ask @Lea Sophie and @CEO')].sort(), ['ag_lea', 'human'], 'nothing is posted');
  assert.equal(h.chats.messages(chat.id).at(-1)!.body, 'Update');
});


test('search: German folding (ß/umlauts/case), bm25 order, snippet from the original text', () => {
  const h = setup();
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.chats.send({ conversationId: chat.id, body: 'Die Straße zum Büro ist gesperrt, bitte Umweg über die Brücke nehmen.', authorId: 'human' });
  h.chats.send({ conversationId: chat.id, body: 'Ganz anderes Thema', authorId: 'ag_tom' });
  const hits = h.chats.search('strasse buro');
  assert.equal(hits.length, 1);
  assert.match(hits[0].snippet, /Straße zum Büro/);
  assert.equal(h.chats.search('BRÜCK').length, 1, 'prefix + case + diacritics');
  assert.equal(h.chats.search('"; DROP TABLE messages; --').length, 0, 'operators are neutralized');
  assert.equal(h.chats.search('thema', { memberId: 'ag_lea' }).length, 0);
  const edited = h.chats.messages(chat.id)[1];
  h.chats.edit(edited.id, 'Neues Thema Kaffee', 'ag_tom');
  assert.equal(h.chats.search('kaffee').length, 1);
  h.chats.removeMessage(edited.id, 'human');
  assert.equal(h.chats.search('kaffee').length, 0);
});

test('drafts, pin, archive, remove, list search', () => {
  const h = setup();
  const chat = h.chats.create({ title: 'Büro Umzug', agentIds: ['ag_tom'], createdBy: 'human' });
  h.chats.saveDraft(chat.id, 'half typed');
  assert.equal(h.chats.draft(chat.id)?.text, 'half typed');
  assert.equal(h.chats.summary(chat.id).draft, 'half typed');
  h.chats.saveDraft(chat.id, '');
  assert.equal(h.chats.draft(chat.id), undefined);
  assert.equal(h.chats.list({ search: 'buro' }).length, 1);
  assert.equal(h.chats.list({ search: 'tom' }).length, 1, 'member names are searchable');
  assert.equal(h.chats.list({ search: 'nothing' }).length, 0);
  h.chats.archive(chat.id);
  assert.equal(h.chats.list().length, 0);
  h.chats.remove(chat.id);
  assert.equal(h.chats.get(chat.id), undefined);
  assert.equal(h.of('conversation.removed').length, 1);
});

// B-050 K6 (deliberate change): a message's model is the addressed agent's hint, only pin: true pins it.
test('model per chat from a human message: a hint for the addressed agent, a pin only with pin: true; auto clears', () => {
  const h = setup();
  const chat = h.chats.create({ agentIds: ['ag_tom', 'ag_lea'], createdBy: 'human' });
  h.chats.send({ conversationId: chat.id, body: '@Tom do it', authorId: 'human', model: 'gpt-6.1', effort: 'high' });
  assert.deepEqual(h.chats.get(chat.id)!.settings.modelHints, { ag_tom: 'gpt-6.1' });
  assert.equal(h.chats.get(chat.id)!.settings.models, undefined, 'no pin without pin: true');
  assert.deepEqual(h.chats.get(chat.id)!.settings.efforts, { ag_tom: 'high' });
  h.chats.send({ conversationId: chat.id, body: '@Tom always', authorId: 'human', model: 'gpt-6.1', pin: true });
  assert.deepEqual(h.chats.get(chat.id)!.settings.models, { ag_tom: 'gpt-6.1' });
  assert.equal(h.chats.get(chat.id)!.settings.modelHints, undefined, 'the pin replaces the hint');
  h.chats.send({ conversationId: chat.id, body: '@Tom again', authorId: 'human', model: 'auto' });
  assert.equal(h.chats.get(chat.id)!.settings.models, undefined);
  assert.equal(h.chats.get(chat.id)!.settings.modelHints, undefined);
});

test('summary: importantUnread counts the unread messages marked important (B-041 Home and briefing); left out when none', () => {
  const h = setup();
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.chats.send({ conversationId: chat.id, body: 'Draft ready', authorId: 'ag_tom' });
  assert.equal(h.chats.summary(chat.id).unread, 1);
  assert.equal('importantUnread' in h.chats.summary(chat.id), false);
  h.chats.send({ conversationId: chat.id, body: 'The server is down', authorId: 'ag_tom', priority: 'important' });
  h.chats.send({ conversationId: chat.id, body: 'Please look now', authorId: 'human', priority: 'important' });
  const summary = h.chats.summary(chat.id);
  assert.deepEqual([summary.unread, summary.importantUnread], [0, undefined], 'the person writing read the chat');
  h.chats.send({ conversationId: chat.id, body: 'Still down', authorId: 'ag_tom', priority: 'important' });
  h.chats.send({ conversationId: chat.id, body: 'Logs attached', authorId: 'ag_tom' });
  const after = h.chats.summary(chat.id);
  assert.deepEqual([after.unread, after.importantUnread], [2, 1]);
  assert.equal(h.chats.list().find((row) => row.id === chat.id)?.importantUnread, 1, 'the chat list carries it too');
});
