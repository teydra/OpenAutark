// The quest commands (tools/builtin/tasks.ts, tasks-list.ts, tasks-util.ts – Quests round 20.11.2026, CONTRACT "AI" and
// "Against forgetting and invented dates"): a time on agent work is refused in code, the person's to-do takes the one
// their words this turn name or their assistant sets (FIXREAL 1) – one to-do per quest, outside a quest one per turn
// (FIXREAL2 1); a quest starts with quest "new" and holds no time
// (FIXREAL 2); a line in a chat names no quest by default (FIXREAL 4); a to-do made in a turn a person's line started
// carries that line whole in its thread; a wait
// line names a person, a to-do or something outside; tasks.list shows my quests, one quest whole with its thread, the open
// work a text is about, the person's to-dos and what ended; a close can be quiet and carry its side work, its follow-ups
// are what I set up in the same turn, and add/update take a priority (R2.13); an "Only me" to-do is read and helped
// around, never given to an agent or closed by me, nor its quest while it is open.
// Owns: these assertions only. Never: real engines or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { taskTools } from '../../../src/runtime/tools/builtin/tasks.ts';
import { AGENT_TIME, DAY_LENGTH, NO_TURN_TASK, PERSON_TIME, QUEST_TIME } from '../../../src/runtime/tools/builtin/tasks-util.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { threadOf } from '../../../src/runtime/tasks/thread.ts';
import { onlyMeLine } from '../../../src/runtime/tasks/service.ts';
import { agent, harness } from '../chat/harness.ts';

function setup() {
  const h = harness(); // Sat 17 Oct 2026 09:00 UTC
  h.org.add(agent('ag_ida', 'Ida'));
  h.org.add(agent('ag_jonas', 'Jonas'));
  h.services.runs = { item: () => undefined } as never;
  (h.services as RuntimeServices).settings = new SettingsStore({ db: h.db, bus: h.bus, clock: h.clock, env: { locale: 'en-US', timezone: 'UTC' } });
  const chat = h.chats.create({ agentIds: ['ag_ida'], createdBy: HUMAN_ID });
  const ctx = (taskId?: string, agentId = 'ag_ida'): ToolContext => ({
    agent: h.org.get(agentId)!, runId: 'run_1', conversationId: chat.id, mode: 'general', ...(taskId ? { taskId } : {}),
    services: h.services as RuntimeServices, signal: new AbortController().signal, status: () => {},
  });
  const run = async (name: string, args: Record<string, unknown>, context = ctx()) => {
    const out = await taskTools.find((tool) => tool.name === name)!.run(args as never, context);
    const text = String((out.content[0] as { text?: string }).text);
    return { error: out.isError === true, text, data: (() => { try { return JSON.parse(text) as Record<string, string>; } catch { return {} as Record<string, string>; } })() };
  };
  return { ...h, chat, ctx, run };
}

test('agent work has no time – refused in code on add and update; the person\'s to-do takes the time their line names; "" clears an old one', async () => {
  const h = setup();
  const refused = await h.run('tasks.add', { title: 'Build the installer', for: 'Jonas', at: 'tomorrow 15:00' });
  assert.deepEqual([refused.error, refused.text], [true, AGENT_TIME]);
  const mine = await h.run('tasks.add', { title: 'Write the notes', at: '+2d' });
  assert.equal(mine.text, AGENT_TIME);
  h.chats.send({ conversationId: h.chat.id, authorId: HUMAN_ID, body: 'Ich muss Gerlinde am Dienstag um 11 Uhr anrufen.' });
  const call = await h.run('tasks.add', { title: 'Gerlinde anrufen', for: 'person', at: '2026-10-20T11:00', minutes: 20 });
  assert.equal(call.error, false, call.text);
  assert.equal(h.tasks.get(call.data.taskId)!.at, Date.parse('2026-10-20T11:00:00Z'));
  const work = h.tasks.create({ title: 'Old dated work', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID, at: h.clock.now() + 86_400_000 });
  assert.equal((await h.run('tasks.update', { id: work.id, at: 'Friday 10:00' })).text, AGENT_TIME);
  await h.run('tasks.update', { id: work.id, at: '' });
  assert.equal(h.tasks.get(work.id)!.at, undefined, '"" clears it');
  assert.equal((await h.run('tasks.update', { id: work.id, for: 'person', at: 'Tuesday 11:00' })).error, false, 'given to the person, it takes the time their words name');
});

test('FIXREAL 1: a time on the person\'s to-do comes from their words this turn or from their assistant – a day alone stays a day, a clock is that clock; my suggestion goes into the notes', async () => {
  const h = setup(); // Sat 17 Oct 2026 09:00 UTC
  const line = h.chats.send({ conversationId: h.chat.id, authorId: HUMAN_ID, body: 'Ich muss morgen um 9 Uhr beim Zahnarzt anrufen – trag mir das ein. Und bis Freitag die Steuererklärung abgeben.' });
  const dentist = await h.run('tasks.add', { title: 'Zahnarzt anrufen', for: 'person', at: '2026-10-18T09:00', minutes: 5 });
  assert.equal(dentist.error, false, dentist.text);
  const tax = await h.run('tasks.add', { title: 'Steuererklärung abgeben', for: 'person', at: '2026-10-23' });
  assert.equal(tax.error, false, `the deadline day, day only: ${tax.text}`);
  const slot = await h.run('tasks.add', { title: 'Belege bereitlegen', for: 'person', at: '2026-10-19T18:00', minutes: 90 });
  assert.deepEqual([slot.error, slot.text], [true, `${PERSON_TIME} Their words name "morgen um 9 Uhr" = Sun 18 Oct 09:00, "Freitag" = Fri 23 Oct (the day).`]);
  assert.equal((await h.run('tasks.add', { title: 'Steuer am Mittag', for: 'person', at: '2026-10-23T12:00' })).error, true, 'a day they named gets no clock of mine');
  const late = await h.run('tasks.update', { id: dentist.data.taskId, at: '2026-10-18T10:00' });
  assert.equal(late.error, true, 'a clock they named is that clock');
  assert.equal(h.tasks.get(dentist.data.taskId)!.at, Date.parse('2026-10-18T09:00:00Z'), 'refused before anything changed');
  assert.equal((await h.run('tasks.update', { id: dentist.data.taskId, at: '2026-10-18T09:00', notes: 'Praxis Weber' })).error, false, 'the time it has stands');
  h.chats.markRead(h.chat.id, 'ag_ida', line.seq); // my next turn, no new line of theirs
  const moved = await h.run('tasks.update', { id: tax.data.taskId, at: '2026-10-22' });
  assert.deepEqual([moved.error, moved.text], [true, PERSON_TIME]);
  h.org.add(agent('ag_sara', 'Sara', { template: 'secretary' })); // their assistant plans their day
  const planned = await h.run('tasks.update', { id: tax.data.taskId, at: '2026-10-22T16:00' }, h.ctx(undefined, 'ag_sara'));
  assert.equal(planned.error, false, planned.text);
  assert.equal(h.tasks.get(tax.data.taskId)!.at, Date.parse('2026-10-22T16:00:00Z'));
});

test('FIXREAL2 1: a time from the person\'s words is one to-do\'s – one per quest, outside a quest one per turn; their assistant plans freely', async () => {
  const h = setup(); // Sat 17 Oct 2026 09:00 UTC
  const run = { trigger: 'message', startedAt: h.clock.now() };
  h.services.runs = { item: () => undefined, get: () => run } as never;
  h.chats.send({ conversationId: h.chat.id, authorId: HUMAN_ID, body: 'Ich muss bis Freitag die Steuererklärung abgeben – mach daraus eine Quest.' });
  const quest = await h.run('tasks.add', { title: 'Steuererklärung bis Freitag abgeben', quest: 'new', for: 'person' });
  const papers = await h.run('tasks.add', { title: 'Unterlagen zusammentragen', for: 'person', quest: quest.data.taskId, at: '2026-10-23' });
  assert.equal(papers.error, false, papers.text);
  const twice = await h.run('tasks.add', { title: 'Unterlagen zusammentragen', for: 'person', quest: quest.data.taskId, at: '2026-10-23' });
  assert.deepEqual([twice.error, twice.data.taskId, twice.data.already], [false, papers.data.taskId, true], 'the same ask again is the one that stands');
  const taken = 'Fri 23 Oct already stands on "Unterlagen zusammentragen"; the steps before it carry no time unless their words give one – my suggestion goes into the notes.';
  const again = await h.run('tasks.add', { title: 'Erklärung abschicken', for: 'person', quest: quest.data.taskId, at: '2026-10-23' });
  assert.deepEqual([again.error, again.text], [true, taken], 'the deadline day stands on one step of the quest');
  const send = await h.run('tasks.add', { title: 'Erklärung abschicken', for: 'person', quest: quest.data.taskId, notes: 'Vorschlag: Do 22.10.' });
  assert.deepEqual([(await h.run('tasks.update', { id: send.data.taskId, at: '2026-10-23' })).text], [taken], 'update: the same check');
  assert.equal((await h.run('tasks.update', { id: papers.data.taskId, at: '' })).error, false);
  assert.equal((await h.run('tasks.update', { id: send.data.taskId, at: '2026-10-23' })).error, false, 'moved onto the hand-in step');
  assert.equal(h.tasks.get(send.data.taskId)!.at, Date.parse('2026-10-23T00:00:00Z'));
  assert.equal((await h.run('tasks.update', { id: send.data.taskId, at: '2026-10-23', notes: 'Online' })).error, false, 'the time it holds stands');

  const copy = await h.run('tasks.add', { title: 'Belege kopieren', for: 'person', at: 'Friday' });
  assert.equal(copy.error, false, `outside a quest, the first this turn: ${copy.text}`);
  const file = await h.run('tasks.add', { title: 'Belege abheften', for: 'person', at: 'Friday' });
  assert.deepEqual([file.error, file.text], [true, taken.replace('Unterlagen zusammentragen', 'Belege kopieren')], 'outside a quest, one per turn');
  run.startedAt = h.clock.now() + 60_000; // my next turn, their line still unread
  assert.equal((await h.run('tasks.add', { title: 'Belege abheften', for: 'person', at: 'Friday' })).error, false, 'another turn\'s ask');

  h.org.add(agent('ag_sara', 'Sara', { template: 'secretary' })); // their assistant plans their day
  const planned = await h.run('tasks.add', { title: 'Belege sortieren', for: 'person', quest: quest.data.taskId, at: '2026-10-23' }, h.ctx(undefined, 'ag_sara'));
  assert.equal(planned.error, false, planned.text);
});

test('FIXREAL 2: a quest holds no time – quest "new" with at or minutes is refused, and so is a time on a quest; its to-dos carry the times', async () => {
  const h = setup();
  h.chats.send({ conversationId: h.chat.id, authorId: HUMAN_ID, body: 'Bis Freitag die Steuererklärung abgeben – mach daraus eine Quest.' });
  const timed = await h.run('tasks.add', { title: 'Steuererklärung', quest: 'new', for: 'person', at: '2026-10-23' });
  assert.deepEqual([timed.error, timed.text], [true, QUEST_TIME]);
  assert.equal((await h.run('tasks.add', { title: 'Steuererklärung', quest: 'new', minutes: 90 })).text, QUEST_TIME);
  const quest = await h.run('tasks.add', { title: 'Steuererklärung abgeben', quest: 'new', for: 'person', doneWhen: 'Beim Finanzamt eingegangen' });
  assert.equal(h.tasks.get(quest.data.taskId)!.at, undefined);
  const step = await h.run('tasks.add', { title: 'Steuererklärung abgeben', for: 'person', quest: quest.data.taskId, at: '2026-10-23' });
  assert.equal(step.error, false, step.text);
  assert.equal(step.data.quest, quest.data.taskId);
  assert.equal((await h.run('tasks.update', { id: quest.data.taskId, at: '2026-10-23' })).text, QUEST_TIME);
  assert.equal((await h.run('tasks.update', { id: quest.data.taskId, minutes: 30 })).text, QUEST_TIME);
  assert.equal((await h.run('tasks.update', { id: quest.data.taskId, at: '' })).error, false, '"" clears an old one');
});

test('FIXREAL 4: a line in a chat names no quest by default – not the quest delivery tied my turn to; a turn in the quest\'s thread or from a note on it fills that quest', async () => {
  const h = setup();
  const quest = h.tasks.create({ kind: 'quest', title: 'Steuer', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID });
  const step = h.tasks.create({ title: 'Belege', parentId: quest.id, assigneeKind: 'human', createdBy: 'ag_ida' });
  const run = { trigger: 'message' };
  h.services.runs = { item: () => undefined, get: () => run } as never;
  const asked = await h.run('tasks.add', { title: 'geschenke.txt anlegen' }, h.ctx(quest.id));
  assert.equal(asked.data.quest, undefined, 'a new ask in a chat is not the waiting quest\'s');
  assert.equal((await h.run('tasks.add', { title: 'Belege scannen', quest: quest.id }, h.ctx(quest.id))).data.quest, quest.id, 'named, it goes there');
  threadOf(h.services as RuntimeServices, step.id);
  const inThread = await h.run('tasks.add', { title: 'Beleg nachreichen' }, { ...h.ctx(step.id), conversationId: step.id });
  assert.equal(inThread.data.quest, quest.id, 'a line in a to-do\'s thread: its quest');
  run.trigger = 'schedule';
  assert.equal((await h.run('tasks.add', { title: 'Nachsehen' }, h.ctx(quest.id))).data.quest, quest.id, 'a note on the quest: that quest');
});

test('a quest starts with quest "new"; a to-do goes into it, or into the quest of the to-do it names', async () => {
  const h = setup();
  const quest = await h.run('tasks.add', { title: 'Windows signing', quest: 'new', doneWhen: 'Every installer is signed' });
  assert.equal(h.tasks.get(quest.data.taskId)!.kind, 'quest');
  const first = await h.run('tasks.add', { title: 'Activate the certificate', for: 'Jonas', quest: quest.data.taskId });
  assert.equal(first.data.quest, quest.data.taskId);
  const second = await h.run('tasks.add', { title: 'Sign the first build', quest: first.data.taskId });
  assert.equal(second.data.quest, quest.data.taskId, 'a to-do\'s id means its quest');
  const lone = await h.run('tasks.add', { title: 'Answer the bank', quest: 'none' }, h.ctx(quest.data.taskId));
  assert.equal(lone.data.quest, undefined);
});

test('a to-do made in a turn a person\'s line started carries that line whole as a quoted entry of its thread', async () => {
  const h = setup();
  const dictation = `Bitte baue das. ${'Und noch etwas dazu. '.repeat(1200)}Und am Ende: der Sicherheits-Tab.`;
  const line = h.chats.send({ conversationId: h.chat.id, authorId: HUMAN_ID, body: dictation });
  const added = await h.run('tasks.add', { title: 'Sicherheits-Tab in den Einstellungen' });
  const thread = h.chats.messages(added.data.taskId, { limit: 50 });
  const quoted = thread.find((message) => message.meta.status?.details?.quote);
  assert.ok(quoted, 'the line stands in the thread');
  assert.equal(quoted!.meta.status?.text, dictation, 'whole – 25,000 characters, the last ask included');
  assert.deepEqual((quoted!.meta.status?.details as { quote: { messageId: string; conversationId: string } }).quote.messageId, line.id);
  h.chats.markRead(h.chat.id, 'ag_ida', line.seq);
  const later = await h.run('tasks.add', { title: 'Something of my own' });
  assert.ok(!h.chats.messages(later.data.taskId, { limit: 50 }).some((message) => message.meta.status?.details?.quote), 'no new line of the person: nothing quoted');
});

test('a wait line: a name first waits on them, a to-do\'s id on that to-do, else on something outside', async () => {
  const h = setup();
  const work = h.tasks.create({ title: 'Release 0.3.16', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID });
  const build = h.tasks.create({ title: 'Signed build', assigneeKind: 'agent', assigneeId: 'ag_jonas', createdBy: HUMAN_ID });
  await h.run('tasks.update', { id: work.id, waiting: 'Jonas: the signed installer' });
  assert.deepEqual([h.tasks.get(work.id)!.waitingOn?.on, h.tasks.get(work.id)!.waitingOn?.who], ['who', 'ag_jonas']);
  await h.run('tasks.update', { id: work.id, waiting: `${build.id}: the release build` });
  assert.deepEqual(h.tasks.get(work.id)!.waitingOn?.ids, [build.id]);
  await h.run('tasks.update', { id: work.id, waiting: 'Certum activates the certificate' });
  assert.equal(h.tasks.get(work.id)!.waitingOn?.on, 'outside');
  await h.run('tasks.update', { id: work.id, status: 'open' });
  assert.equal(h.tasks.get(work.id)!.status, 'open');
});

test('tasks.list: my quests; one quest whole with its to-dos and thread; the open work a text is about; the person\'s; what ended', async () => {
  const h = setup();
  const quest = h.tasks.create({ kind: 'quest', title: 'Windows signing', doneWhen: 'Every installer is signed', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID });
  const sign = h.tasks.create({ title: 'Sign on the phone', parentId: quest.id, assigneeKind: 'human', createdBy: 'ag_ida' });
  h.tasks.create({ title: 'Release build with signing', parentId: quest.id, assigneeKind: 'agent', assigneeId: 'ag_jonas', createdBy: 'ag_ida' });
  threadOf(h.services as RuntimeServices, quest.id);
  h.chats.send({ conversationId: quest.id, authorId: HUMAN_ID, body: 'Certum is active now.' });
  assert.match((await h.run('tasks.list', {})).text, new RegExp(`^## My quests\\n- Windows signing · ${quest.id} · person: 1 open`));
  const whole = (await h.run('tasks.list', { id: quest.id })).text;
  assert.ok(whole.startsWith(`## Quest\n${quest.id} · open`), whole);
  assert.ok(whole.includes(`  - "Sign on the phone" · ${sign.id} · open since Sat 17 Oct`), whole);
  assert.match(whole, /Thread \(<chat to="task_\S+"> writes there\):\n(?:.*\n)*\[task_\S+ [^\n]*\] Certum is active now\./);
  const found = (await h.run('tasks.list', { search: 'Signierung des Windows-Installers' }, h.ctx(undefined, 'ag_jonas'))).text;
  assert.ok(found.includes(`Windows signing · ${quest.id}`), found);
  assert.match((await h.run('tasks.list', { who: 'person' })).text, /Windows signing/);
  await h.run('tasks.update', { id: sign.id, status: 'done', result: 'Signed' });
  assert.match((await h.run('tasks.list', { done: true, who: 'all' })).text, /Sign on the phone · in task_\S+ – Signed/);
});

test('tasks.list: every view shows the quest\'s next note, whoever set it – who=all, search, the id view and my own list (27.11.2026: always "no next note")', async () => {
  const h = setup();
  const quest = h.tasks.create({ kind: 'quest', title: 'Windows signing', doneWhen: 'Every installer is signed', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID });
  const build = h.tasks.create({ title: 'Release build with signing', parentId: quest.id, assigneeKind: 'agent', assigneeId: 'ag_jonas', createdBy: 'ag_ida' });
  const bare = h.tasks.create({ kind: 'quest', title: 'Blog relaunch', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID });
  h.tasks.create({ title: 'Draft the post', parentId: bare.id, assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: 'ag_ida' });
  // Jonas's note on his to-do (the earlier one) and Ida's on the quest; a paused one and one about another task do not count.
  h.scheduler.create({ ownerId: 'ag_jonas', kind: 'reminder', taskId: build.id, title: 'Build', spec: { at: Date.parse('2026-10-18T09:00:00Z') }, payload: { note: 'Look at the build' } });
  h.scheduler.create({ ownerId: 'ag_ida', kind: 'reminder', taskId: quest.id, title: 'Look', spec: { at: Date.parse('2026-10-19T09:00:00Z') }, payload: { note: 'Look at Certum' } });
  const paused = h.scheduler.create({ ownerId: 'ag_jonas', kind: 'reminder', taskId: bare.id, title: 'Old', spec: { at: Date.parse('2026-10-18T08:00:00Z') }, payload: { note: 'Old' } });
  h.scheduler.update(paused.id, { active: false }, 'ag_jonas');

  const jonasNote = 'next note Sun 18 Oct 09:00 (Jonas\'s)';
  const all = (await h.run('tasks.list', { who: 'all' })).text;
  assert.ok(all.includes(`Windows signing · ${quest.id} · Jonas 1 · ${jonasNote}`), all);
  assert.ok(all.includes(`Blog relaunch · ${bare.id} · me: 1 · no next note`), all);
  const found = (await h.run('tasks.list', { search: 'Windows signing' })).text;
  assert.ok(found.includes(`Windows signing · ${quest.id} · Jonas 1 · ${jonasNote}`), found);
  assert.ok((await h.run('tasks.list', {})).text.includes(`Windows signing · ${quest.id} · Jonas 1 · ${jonasNote}`), 'my own list too: a colleague\'s note counts');
  const whole = (await h.run('tasks.list', { id: quest.id })).text;
  assert.ok(whole.includes('\nNext note Sun 18 Oct 09:00 (Jonas\'s).\n'), whole);
  assert.ok((await h.run('tasks.list', { id: build.id })).text.includes(`\nNext note Sun 18 Oct 09:00 (Jonas's) (on ${quest.id}).\n`), 'a to-do shows its quest\'s next note');
  assert.ok((await h.run('tasks.list', { id: bare.id })).text.includes('\nNo next note.\n'), 'a paused note is no next note');
  // Jonas reads Ida's quest: his own note stands without a name.
  assert.ok((await h.run('tasks.list', { who: 'all' }, h.ctx(undefined, 'ag_jonas'))).text.includes(`Windows signing · ${quest.id} · Ida's · me: 1 · next note Sun 18 Oct 09:00 ·`));
});

test('R2.13: a close is quiet and carries its side work on request; its follow-ups are what I set up in this turn; priority on add and update', async () => {
  const h = setup();
  const given = h.tasks.create({ title: 'Fix the login', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: 'ag_jonas' });
  const before = h.tasks.create({ title: 'Older work of mine', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: 'ag_ida' });
  const started = h.clock.advance(60_000);
  h.services.runs = { item: () => undefined, get: (id: string) => (id === 'run_1' ? { startedAt: started } : undefined) } as never;
  const next = await h.run('tasks.add', { title: 'Watch the login errors', priority: 'high' });
  assert.equal(h.tasks.get(next.data.taskId)!.priority, 1);
  const note = h.scheduler.create({ ownerId: 'ag_ida', kind: 'reminder', taskId: next.data.taskId, title: 'Look at the error rate', spec: { at: started + 86_400_000 }, payload: { note: 'Look at the error rate' } });
  h.db.run('DELETE FROM wakes');
  const done = await h.run('tasks.update', { id: given.id, status: 'done', result: 'Login works again', quiet: true, alsoHandled: ['Renewed the session secret', ' '] });
  assert.equal(done.error, false, done.text);
  const result = h.tasks.get(given.id)!.result!;
  assert.equal(result.quiet, true);
  assert.deepEqual(result.alsoHandled, ['Renewed the session secret']);
  assert.deepEqual(result.followUps, [{ taskId: next.data.taskId, label: 'Watch the login errors' }, { scheduleId: note.id, label: 'Look at the error rate' }], 'what this turn set up – not older work');
  assert.ok(!result.followUps!.some((item) => item.taskId === before.id));
  assert.equal(h.wakeRows().filter((row) => row.agent_id === 'ag_jonas').length, 0, 'quiet: the giver gets no notice');

  const ask = await h.run('tasks.add', { title: 'Approve the invoice', for: 'person', priority: 'urgent' });
  assert.equal(h.tasks.get(ask.data.taskId)!.priority, 2);
  await h.run('tasks.update', { id: ask.data.taskId, priority: 'normal' });
  assert.equal(h.tasks.get(ask.data.taskId)!.priority, 0);
  const loud = await h.run('tasks.update', { id: before.id, status: 'dropped', result: 'Not needed' }, h.ctx(undefined));
  assert.equal(loud.error, false, loud.text);
  assert.equal(h.tasks.get(before.id)!.result?.quiet, undefined, 'not quiet unless asked');
});

test('"Only me" (owner 20.11.2026): I read it and add notes, a time, its quest – but never give it to an agent or close it, nor its quest while it is open', async () => {
  const h = setup();
  const quest = h.tasks.create({ kind: 'quest', title: 'Health', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID });
  const own = h.tasks.create({ title: 'Call the doctor', parentId: quest.id, assigneeKind: 'human', createdBy: HUMAN_ID, private: true });
  h.chats.send({ conversationId: h.chat.id, authorId: HUMAN_ID, body: 'I call the doctor on Monday at 08:30.' });
  const notes = await h.run('tasks.update', { id: own.id, notes: 'Dr. Weber: 030 1234 – mornings 8–10.', at: 'Monday 08:30' });
  assert.equal(notes.error, false, notes.text);
  assert.equal(h.tasks.get(own.id)!.notes, 'Dr. Weber: 030 1234 – mornings 8–10.');
  for (const args of [{ for: 'me' }, { for: 'Jonas' }, { for: 'team' }, { status: 'done', result: 'Called' }, { status: 'dropped', result: 'Not needed' }]) {
    const refused = await h.run('tasks.update', { id: own.id, ...args });
    assert.deepEqual([refused.error, refused.text], [true, onlyMeLine()], JSON.stringify(args));
  }
  const closing = await h.run('tasks.update', { id: quest.id, status: 'done', result: 'All set', notes: 'changed' });
  assert.deepEqual([closing.error, closing.text], [true, onlyMeLine('Call the doctor')], 'its quest stays open while it is');
  assert.equal(h.tasks.get(quest.id)!.notes, '', 'refused before anything changed');
  assert.equal(h.tasks.get(own.id)!.status, 'open');
  await assert.rejects(() => h.tasks.give(own.id, 'ag_jonas', 'ag_ida'), (error: Error) => error.message === onlyMeLine(), 'the service says the same');
  assert.throws(() => h.tasks.finish(own.id, { status: 'done', summary: 'x' }, 'ag_ida'), (error: Error) => error.message === onlyMeLine());
  assert.equal((await h.run('tasks.update', { id: own.id, for: 'person' })).error, false, 'to a person it may go');
  h.tasks.finish(own.id, { status: 'done', summary: 'Called' }, HUMAN_ID);
  assert.equal(h.tasks.get(own.id)!.status, 'done', 'the person closes it');
  assert.equal((await h.run('tasks.update', { id: quest.id, status: 'done', result: 'All set' })).error, false, 'then the quest closes');
});

test('FIXREAL second round 1: without an id, tasks.update and tasks.remind take the task my turn is about – a chat line\'s turn names one, a note "none"', async () => {
  const h = setup();
  const quest = h.tasks.create({ kind: 'quest', title: 'Steuer', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID });
  const run = { trigger: 'message' };
  h.services.runs = { item: () => undefined, get: () => run } as never;
  await assert.rejects(() => h.run('tasks.update', { notes: 'Belege fehlen' }, h.ctx(quest.id)),
    (error: Error) => error.message.startsWith(NO_TURN_TASK) && error.message.includes(`${quest.id} "Steuer"`), 'asks for the id, naming my open work');
  assert.equal(h.tasks.get(quest.id)!.notes, '', 'the quest delivery tied the turn to stays as it was');
  const unnamed = await h.run('tasks.remind', { text: 'Nachsehen', at: '+1h' }, h.ctx(quest.id));
  assert.equal(unnamed.error, true);
  assert.ok(unnamed.text.startsWith(NO_TURN_TASK), unnamed.text);
  const free = await h.run('tasks.remind', { text: 'Kaffee holen', at: '+1h', about: 'none' }, h.ctx(quest.id));
  assert.deepEqual([free.error, free.data.about], [false, undefined], '"none": a note about nothing');
  assert.equal((await h.run('tasks.remind', { text: 'Freie Notiz', at: '+1h' })).error, false, 'a turn about no task: a note about nothing, as before');
  run.trigger = 'schedule';
  assert.equal((await h.run('tasks.update', { notes: 'Belege fehlen' }, h.ctx(quest.id))).data.taskId, quest.id, 'a note on it: its task');
  assert.equal((await h.run('tasks.remind', { text: 'Wieder nachsehen', at: '+1d' }, h.ctx(quest.id))).data.about, quest.id);
});

test('FIXREAL second round 2: a day without a clock takes no length – with it, or later on a to-do that stands as a day; a day replaces a clock time and its length', async () => {
  const h = setup(); // Sat 17 Oct 2026 09:00 UTC
  h.chats.send({ conversationId: h.chat.id, authorId: HUMAN_ID, body: 'Bis Freitag die Steuer abgeben, am Montag um 10 Uhr zur Bank.' });
  const day = await h.run('tasks.add', { title: 'Steuer abgeben', for: 'person', at: 'Friday', minutes: 60 });
  assert.deepEqual([day.error, day.text], [true, DAY_LENGTH]);
  const tax = await h.run('tasks.add', { title: 'Steuer abgeben', for: 'person', at: '2026-10-23' });
  assert.equal((await h.run('tasks.update', { id: tax.data.taskId, minutes: 30 })).text, DAY_LENGTH, 'a to-do that stands as a day');
  const bank = await h.run('tasks.add', { title: 'Zur Bank', for: 'person', at: '2026-10-19T10:00', minutes: 30 });
  assert.equal(bank.error, false, bank.text);
  const moved = await h.run('tasks.update', { id: bank.data.taskId, at: '2026-10-23' });
  assert.equal(moved.error, false, moved.text);
  const stored = h.tasks.get(bank.data.taskId)!;
  assert.deepEqual([stored.at, stored.minutes], [Date.parse('2026-10-23T00:00:00Z'), undefined], 'the day replaces the clock time and its length');
  assert.equal((await h.run('tasks.update', { id: bank.data.taskId, at: '', minutes: 30 })).error, false, 'a length without a time stands');
});
