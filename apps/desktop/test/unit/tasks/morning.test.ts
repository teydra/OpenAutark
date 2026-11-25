// The morning pass lists eligible standalone to-dos, with or without a quest block in the same wake.
// Owns: these assertions only. Never: real engines or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { addDays, wallOf, wallTime } from '../../../src/shared/text/when.ts';
import { profileZone } from '../../../src/runtime/context/time.ts';
import { MORNING_MINUTES } from '../../../src/runtime/tasks/morning.ts';
import { agent, harness } from '../chat/harness.ts';

function setup() {
  const h = harness();
  h.org.add(agent('ag_ida', 'Ida'));
  const todo = (title: string, extra: Partial<Parameters<typeof h.tasks.create>[0]> = {}) =>
    h.tasks.create({ title, assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID, ...extra });
  const zone = profileZone(h.services);
  const seven = wallTime(addDays(wallOf(h.clock.now(), zone).date, 1), MORNING_MINUTES, zone);
  return { ...h, todo, seven, morning: h.ownership.morning };
}

test('the morning pass wakes an agent with eligible standalone to-dos even without a quest', () => {
  const h = setup();
  const open = h.todo('Review draft');
  h.scheduler.create({ ownerId: 'ag_ida', kind: 'reminder', taskId: open.id, title: 'Ended note', spec: { at: h.seven }, payload: {}, active: false });
  const outside = h.todo('Wait for courier');
  h.tasks.update(outside.id, { status: 'waiting', waitingOn: { on: 'outside', why: 'Courier must deliver the proofs' } }, 'ag_ida');
  const who = h.todo('Get an answer');
  h.tasks.update(who.id, { status: 'waiting', waitingOn: { on: 'who', who: HUMAN_ID, why: 'Person must choose a format' } }, 'ag_ida');
  const noted = h.todo('With active reminder');
  h.scheduler.create({ ownerId: 'ag_ida', kind: 'reminder', taskId: noted.id, title: 'Look', spec: { at: h.seven + 3_600_000 }, payload: { note: 'Look' } });
  const paused = h.todo('Paused by person');
  h.tasks.pause(paused.id, HUMAN_ID);
  const blocked = h.todo('After the review', { dependsOn: [open.id] });
  const done = h.todo('Already done');
  h.tasks.finish(done.id, { status: 'done', summary: 'Finished', quiet: true }, 'ag_ida');
  const person = h.todo('The person owns this', { assigneeKind: 'human', assigneeId: HUMAN_ID });
  h.clock.set(h.seven);
  const today = h.todo('Made this morning');
  h.db.run('DELETE FROM wakes');

  h.clock.set(h.seven + 60_000);
  assert.equal(h.morning.run(), 1);
  const [wake] = h.wakeRows();
  assert.equal(h.wakeRows().length, 1);
  assert.equal(wake.agent_id, 'ag_ida');
  assert.equal(wake.reason, 'schedule');
  const note = String(wake.note);
  assert.match(note, /^These to-dos of mine have no quest and no next note:/);
  assert.ok(note.includes(`Review draft · ${open.id} · open since`));
  assert.match(note, /Wait for courier .* · waits on .*Courier must deliver the proofs/);
  assert.match(note, /Get an answer .* · waits on .*Person must choose a format/);
  for (const excluded of [noted, paused, blocked, done, person, today]) {
    assert.ok(!note.includes(excluded.id), excluded.title);
  }
  assert.equal(h.morning.run(h.seven + 3_600_000), 0, 'once per local day');
  assert.equal(h.wakeRows().length, 1);
});

test('the morning pass puts quests and standalone to-dos in separate blocks of one wake', () => {
  const h = setup();
  const quest = h.todo('Windows signing', { kind: 'quest' });
  const child = h.todo('Upload build', { parentId: quest.id });
  const loose = h.todo('Review draft');
  h.db.run('DELETE FROM wakes');

  h.clock.set(h.seven + 60_000);
  assert.equal(h.morning.run(), 1);
  assert.equal(h.wakeRows().length, 1);
  const [quests, todos] = String(h.wakeRows()[0].note).split('\n\nThese to-dos of mine have no quest and no next note:\n\n');
  assert.match(quests, /^These quests of mine have no next note:/);
  assert.ok(quests.includes(quest.id));
  assert.ok(quests.includes(child.id));
  assert.ok(!quests.includes(loose.id));
  assert.ok(todos, 'the same wake has a standalone to-do block');
  assert.ok(todos.includes(loose.id));
  assert.ok(!todos.includes(child.id));
});
