// The task system end to end on the chat harness: the four commands (tools/builtin/tasks.ts – Quests round 20.11.2026:
// tasks.add, tasks.update, tasks.list, tasks.remind), the one give path (tasks/give.ts – the receiver told at once, the
// giver hearing the end, "team" picked now), waits and the person's line, pause and resume, to-dos waking their quest's
// owner, and the watcher (tasks/watch.ts – no look on a timer of its own; the person's ring at a to-do's `at`, an
// archived owner's work handed on, outage retries).
// Owns: these assertions only. Never: real engines or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { PAUSED_REASON } from '../../../src/shared/model/tasks.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { taskTools } from '../../../src/runtime/tools/builtin/tasks.ts';
import { buildVolatile } from '../../../src/runtime/context/prompt-volatile.ts';
import { agent, harness } from '../chat/harness.ts';

const DAY = 24 * 3600_000;

function setup() {
  const h = harness();
  h.org.add(agent('ag_ida', 'Ida', { role: 'QA' }));
  h.org.add(agent('ag_jonas', 'Jonas', { role: 'Dev' }));
  const chat = h.chats.create({ agentIds: ['ag_ida'], createdBy: HUMAN_ID });
  const ctx = (agentId = 'ag_ida', taskId?: string): ToolContext => ({
    agent: h.org.get(agentId)!, runId: 'run_1', conversationId: chat.id, mode: 'general', ...(taskId ? { taskId } : {}),
    services: h.services as RuntimeServices, signal: new AbortController().signal, status: () => {},
  });
  const run = async (name: string, args: Record<string, unknown>, context: ToolContext) => {
    const out = await taskTools.find((tool) => tool.name === name)!.run(args as never, context);
    const text = String((out.content[0] as { text?: string }).text);
    try { return JSON.parse(text); } catch { return text; }
  };
  const wakesOf = (agentId: string) => h.wakeRows().filter((row) => row.agent_id === agentId);
  return { ...h, chat, ctx, run, wakesOf };
}

test('four commands are offered directly; the descriptions start verb-first, in my own voice, and stand alone', () => {
  for (const tool of taskTools) {
    const first = tool.description.split(/(?<=\.) /)[0];
    assert.ok(first.length <= 90, `${tool.name}: "${first}" is ${first.length} characters`);
    assert.match(first, /^[A-Z][a-z]+s /, `${tool.name} starts verb-first`);
    assert.doesNotMatch(tool.description, /\byou\b|\bmay\b|\ballowed\b|only if/i, `${tool.name} speaks as me`);
  }
  assert.deepEqual(taskTools.map((tool) => tool.name), ['tasks.add', 'tasks.update', 'tasks.list', 'tasks.remind']);
});

test('tasks.add for a colleague: they hear it at once, it goes into the quest of my turn\'s work, it stands in my quests', async () => {
  const h = setup();
  const mine = h.tasks.create({ conversationId: h.chat.id, title: 'Montagstest', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID });
  const out = await h.run('tasks.add', { title: 'Login-Bug nachstellen', for: 'Jonas', doneWhen: 'Der Bug ist reproduziert' }, h.ctx('ag_ida', mine.id));
  assert.equal(out.owner, 'Jonas (ag_jonas)');
  const todo = h.tasks.get(out.taskId)!;
  assert.equal(todo.parentId, mine.id);
  assert.equal(h.tasks.get(mine.id)!.kind, 'quest', 'my lone to-do that got a to-do is a quest');
  const wake = h.wakesOf('ag_jonas').find((row) => row.task_id === todo.id);
  assert.equal(wake?.reason, 'task');
  assert.match(wake?.note ?? '', /^Ida gave me "Login-Bug nachstellen"\./);
  assert.equal(h.tasks.get(mine.id)!.status, 'open', 'giving a to-do holds my own work back in nothing');
  const live = buildVolatile(h.services as RuntimeServices, { agent: h.org.get('ag_ida')!, route: {} as never });
  assert.match(live, new RegExp(`## My quests\\n- Montagstest · ${mine.id} · Jonas 1 · no next note`));
});

test('the giver hears the end with what it asked; the last to-do\'s end wakes the owner of its quest', async () => {
  const h = setup();
  const mine = h.tasks.create({ conversationId: h.chat.id, title: 'Montagstest', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID });
  const out = await h.run('tasks.add', { title: 'Testdaten', for: 'ag_jonas', doneWhen: 'Zehn Konten' }, h.ctx('ag_ida', mine.id));
  const done = await h.run('tasks.update', { id: out.taskId, status: 'done', result: 'Zehn Konten angelegt' }, h.ctx('ag_jonas', out.taskId));
  assert.equal(done.status, 'done');
  const wake = h.wakesOf('ag_ida').find((row) => row.task_id === mine.id && /a to-do of my quest/.test(row.note ?? ''));
  assert.ok(wake, 'Ida is woken on her own quest');
  assert.match(wake!.note ?? '', /Every to-do of "Montagstest" is done\.\nJonas finished \(claimed, not checked yet\) "Testdaten", a to-do of my quest "Montagstest"\.\nI had asked: Zehn Konten\nResult: Zehn Konten angelegt/);
  assert.match(String(await h.run('tasks.update', { id: mine.id, status: 'done' }, h.ctx('ag_ida', mine.id))), /result/, 'closing says what came out');
});

test('asking the person is a to-do for them: an ask without for goes to the person, the same open ask comes back once', async () => {
  const h = setup();
  const ask = { title: 'Welche Geräte?', ask: { type: 'choice', options: ['PC', 'Android'] } };
  const first = await h.run('tasks.add', ask, h.ctx());
  assert.match(first.owner, / \(human\)$/);
  const todo = h.tasks.get(first.taskId)!;
  assert.equal(todo.assigneeKind, 'human');
  assert.equal(todo.widget?.question, 'Welche Geräte?');
  assert.ok(h.notified.some((note) => note.kind === 'todo' && note.taskId === todo.id), 'the person is told');
  const again = await h.run('tasks.add', ask, h.ctx());
  assert.deepEqual([again.taskId, again.already], [todo.id, true]);
});

test('a wait on the person: their line in the task\'s chat wakes its owner with it and leaves it waiting; a pause holds until they resume', async () => {
  const h = setup();
  const task = h.tasks.create({ conversationId: h.chat.id, title: 'Handy-Test', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID });
  const out = await h.run('tasks.update', { waiting: 'person: 7:30 oder nachmittags?' }, h.ctx('ag_ida', task.id));
  assert.equal(out.status, 'waiting');
  assert.deepEqual([h.tasks.get(task.id)!.waitingOn?.on, h.tasks.get(task.id)!.waitingOn?.who], ['who', HUMAN_ID]);
  h.chats.send({ conversationId: h.chat.id, body: 'Nachmittags, 15 Uhr.', authorId: HUMAN_ID });
  assert.equal(h.tasks.get(task.id)!.status, 'waiting', 'KI-Runde 17.11.2026: its owner moves it');
  assert.ok(h.wakesOf('ag_ida').some((row) => row.task_id === task.id), 'its owner is woken with the task');
  h.tasks.pause(task.id, HUMAN_ID);
  const paused = h.tasks.get(task.id)!;
  assert.deepEqual([paused.status, paused.waitingOn?.why], ['waiting', PAUSED_REASON]);
  h.tasks.update(task.id, { status: 'open' }, HUMAN_ID);
  assert.equal(h.tasks.get(task.id)!.status, 'open');
});

test('tasks.update for: the new owner hears of it, the notes go with it; "me" takes it back', async () => {
  const h = setup();
  const task = h.tasks.create({ conversationId: h.chat.id, title: 'Release-Notes', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID });
  const out = await h.run('tasks.update', { id: task.id, for: 'Jonas', notes: 'Die Liste liegt in notes/release.md' }, h.ctx('ag_ida', task.id));
  assert.equal(out.owner, 'Jonas (ag_jonas)');
  const given = h.tasks.get(task.id)!;
  assert.equal(given.assignedBy, 'ag_ida');
  assert.equal(given.notes, 'Die Liste liegt in notes/release.md');
  assert.ok(h.wakesOf('ag_jonas').some((row) => row.task_id === task.id && /Ida gave me "Release-Notes"/.test(row.note ?? '')));
  const back = await h.run('tasks.update', { id: task.id, for: 'me' }, h.ctx('ag_ida'));
  assert.equal(back.owner, 'me');
});

test('"team" with no decision model: the giver keeps it when no manager exists', async () => {
  const h = setup();
  const out = await h.run('tasks.add', { title: 'Pakete zur Post', for: 'team' }, h.ctx());
  assert.equal(out.owner, 'me');
});

test('"team" with the decision model: it sees who fits and who is free right now; a paused colleague is no choice (task_3d1wvxtq 4)', async () => {
  const asked: Array<{ question: string; options: string[] }> = [];
  const decisions = {
    available: () => true,
    decide: async (request: { question: string; options: string[] }) => {
      asked.push(request);
      return { choice: request.options.find((option) => option.startsWith('Mara')), confidence: 0.9, by: 'test' };
    },
  };
  const h = harness({ decisions: decisions as never });
  h.org.add(agent('ag_ida', 'Ida', { role: 'QA' }));
  h.org.add(agent('ag_jonas', 'Jonas', { role: 'Dev', status: 'working' }));
  h.org.add(agent('ag_mara', 'Mara', { role: 'Dev' }));
  h.org.add(agent('ag_paul', 'Paul', { role: 'Dev', status: 'paused' }));
  const chat = h.chats.create({ agentIds: ['ag_ida'], createdBy: HUMAN_ID });
  const ctx: ToolContext = { agent: h.org.get('ag_ida')!, runId: 'run_1', conversationId: chat.id, mode: 'general', services: h.services as RuntimeServices, signal: new AbortController().signal, status: () => {} };
  const out = await taskTools.find((tool) => tool.name === 'tasks.add')!.run({ title: 'Login-Bug beheben', for: 'team' } as never, ctx);
  const result = JSON.parse(String((out.content[0] as { text?: string }).text));
  assert.equal(result.owner, 'Mara (ag_mara)');
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].options, ['Jonas (Dev) · 0 open · busy right now', 'Mara (Dev) · 0 open · free'], 'never the giver, never a paused colleague');
  assert.match(asked[0].question, /a free one before a busy one/);
});

test('the watcher wakes nobody on a timer of its own: open work and a person\'s untouched to-do stay quiet for days', () => {
  const h = setup();
  h.tasks.create({ conversationId: h.chat.id, title: 'Wochenbericht', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: 'ag_ida' });
  h.tasks.create({ conversationId: h.chat.id, title: 'Vertrag unterschreiben', assigneeKind: 'human', createdBy: 'ag_ida' });
  h.db.run('DELETE FROM wakes');
  h.clock.advance(3 * DAY);
  h.ownership.pass();
  assert.equal(h.wakesOf('ag_ida').length, 0, 'no look, no stall retry, no two-day nudge');
});

test('an archived owner with no successor: the person hears it once, however often the watcher looks', () => {
  const h = setup();
  const task = h.tasks.create({ conversationId: h.chat.id, title: 'Rechnungen', assigneeKind: 'agent', assigneeId: 'ag_jonas', createdBy: HUMAN_ID });
  h.org.get('ag_jonas')!.archivedAt = h.clock.now();
  h.db.run('DELETE FROM wakes');
  for (let pass = 0; pass < 3; pass++) { h.clock.advance(3 * DAY); h.ownership.pass(); }
  const blockers = h.notified.filter((note) => note.kind === 'blocker' && note.taskId === task.id);
  assert.equal(blockers.length, 1);
  const after = h.tasks.get(task.id)!;
  assert.deepEqual([after.status, after.waitingOn?.who], ['waiting', HUMAN_ID]);
});

test('a wait on a colleague ends with their line – in the task chat or in our 1:1', async () => {
  const h = setup();
  const room = h.chats.create({ agentIds: ['ag_ida', 'ag_jonas'], createdBy: HUMAN_ID });
  const direct = h.chats.create({ agentIds: ['ag_ida', 'ag_jonas'], createdBy: HUMAN_ID, settings: { direct: true } });
  const here = h.tasks.create({ conversationId: room.id, title: 'Build prüfen', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID });
  h.tasks.update(here.id, { status: 'waiting', waitingOn: { on: 'who', who: 'ag_jonas', why: 'Build-Nummer' } }, 'ag_ida');
  h.chats.send({ conversationId: room.id, body: 'Build 412.', authorId: 'ag_jonas', authorKind: 'agent' });
  assert.equal(h.tasks.get(here.id)!.status, 'open', 'his line in the task chat');
  const elsewhere = h.tasks.create({ conversationId: h.chat.id, title: 'Release-Datum', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID });
  h.tasks.update(elsewhere.id, { status: 'waiting', waitingOn: { on: 'who', who: 'ag_jonas', why: 'Datum' } }, 'ag_ida');
  h.chats.send({ conversationId: direct.id, body: 'Freitag.', authorId: 'ag_jonas', authorKind: 'agent' });
  assert.equal(h.tasks.get(elsewhere.id)!.status, 'open', 'his line in our 1:1');
});

test('a piece end merged into a queued task wake keeps the piece rank (child wins)', () => {
  const h = setup();
  h.wakes.wake({ agentId: 'ag_ida', reason: 'task', coalesceKey: 'task:task_x', note: 'go on' });
  h.wakes.wake({ agentId: 'ag_ida', reason: 'child', coalesceKey: 'task:task_x', note: 'a piece ended' });
  assert.deepEqual(h.wakesOf('ag_ida').map((row) => row.reason), ['child']);
});

test('the watcher rings the person once when a to-do\'s time comes; a time moved later rings again then', () => {
  const h = setup();
  const watcher = h.ownership as unknown as { ring(): number };
  const todo = h.tasks.create({ title: 'Zahnarzt anrufen', assigneeKind: 'human', createdBy: 'ag_ida', at: h.clock.now() + 3600_000 });
  assert.equal(watcher.ring(), 0, 'the first pass only marks where the rings start');
  h.clock.advance(3600_000 + 1000);
  const before = h.notified.length;
  assert.equal(watcher.ring(), 1);
  assert.deepEqual(h.notified.slice(before).map((note) => [note.kind, note.title, note.taskId]), [['todo', 'Due: Zahnarzt anrufen', todo.id]]);
  assert.equal(watcher.ring(), 0, 'once');
  h.tasks.snooze(todo.id, h.clock.now() + 2 * 3600_000);
  h.clock.advance(2 * 3600_000 + 1000);
  assert.equal(watcher.ring(), 1, '"Later" rings at its new time');
});

test('the watcher: an outage gets one retry wake later, brought forward when an account comes back', () => {
  const h = setup();
  const task = h.tasks.create({ conversationId: h.chat.id, title: 'Export', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID });
  h.db.run('DELETE FROM wakes');
  h.ownership.afterTurn({ agentId: 'ag_ida', taskId: task.id, runId: 'run_x', outcome: 'limit', progressed: false });
  const wake = h.wakesOf('ag_ida').find((row) => row.task_id === task.id);
  assert.ok(wake && Number(wake.due_at) > h.clock.now(), 'a retry later, not now');
  assert.match(String(wake!.note), /did not run \(a usage limit\)/);
  h.ownership.afterTurn({ agentId: 'ag_ida', taskId: task.id, runId: 'run_y', outcome: 'done', progressed: true });
  assert.equal(h.wakesOf('ag_ida').filter((row) => row.task_id === task.id).length, 1, 'a finished turn plans nothing');
});

test('FIXREAL 6a: a quest I make for myself wakes me never; a to-do I give myself still gets its bare wake', async () => {
  const h = setup();
  h.db.run('DELETE FROM wakes');
  const quest = await h.run('tasks.add', { title: 'Einkauf prüfen', quest: 'new', doneWhen: 'einkauf.txt ist noch da' }, h.ctx());
  assert.deepEqual(h.wakesOf('ag_ida'), [], 'my own quest is no news to me');
  const todo = await h.run('tasks.add', { title: 'Datei ansehen', quest: quest.taskId }, h.ctx());
  assert.deepEqual(h.wakesOf('ag_ida').map((row) => [row.task_id, row.reason, row.note]), [[todo.taskId, 'task', null]]);
  const given = await h.run('tasks.add', { title: 'Release-Quest', quest: 'new', for: 'Jonas', doneWhen: 'Released' }, h.ctx());
  assert.equal(h.wakesOf('ag_jonas').filter((row) => row.task_id === given.taskId).length, 1, 'a quest I give a colleague tells them');
});
