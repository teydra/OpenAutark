// The stuck escalation (E4, 25.11.2026): a day still → the owner's manager once; three days → the head above once; a move
// starts it over; no person hears of it; a wait whose date is still ahead does not escalate (src/runtime/tasks/stuck-escalation.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, center, company } from '../task-center/fixture.ts';
import { TaskWatcher } from '../../../src/runtime/tasks/watch.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Mara (reports to the person) ← Tom ← Kai: Kai's manager is Tom, the head above is Mara. */
function setup() {
  const h = center();
  company(h);
  h.org.add(agent('ag_kai', 'Kai', { role: 'Editor', managerId: 'ag_tom', createdAt: 4 }));
  let now = h.s.clock.now();
  h.s.clock.now = () => now;
  const start = now;
  const watcher = new TaskWatcher(h.s);
  const stuckWakes = () => h.wakeRows().filter((row) => String(row.note ?? '').startsWith('Stuck for'));
  const at = (ms: number) => { now = start + ms; return watcher.escalate(); };
  return { ...h, watcher, stuckWakes, at, start };
}

test('a day still: the manager hears once; three days: the head above hears once', () => {
  const h = setup();
  const task = h.tasks.create({ title: 'Cut the trailer', notes: 'Rough cut first', createdBy: 'ag_kai', assigneeId: 'ag_kai' });
  h.db.run('DELETE FROM wakes');
  assert.equal(h.at(DAY - HOUR), 0, 'not yet a day');
  assert.equal(h.at(DAY), 1);
  assert.deepEqual(h.stuckWakes().map((row) => [row.agent_id, row.task_id]), [['ag_tom', task.id]]);
  assert.match(String(h.stuckWakes()[0]!.note), /Stuck for 1 day: To-do "Cut the trailer" \(task_\w+\), owner Kai/);
  assert.match(String(h.stuckWakes()[0]!.note), /Next step: Rough cut first/);
  assert.equal(h.at(DAY + 5 * HOUR), 0, 'the manager hears it once');
  assert.equal(h.at(3 * DAY), 1);
  const head = h.stuckWakes().filter((row) => row.agent_id === 'ag_mara');
  assert.equal(head.length, 1);
  assert.match(String(head[0]!.note), /Stuck for 3 days/);
  assert.equal(h.at(5 * DAY), 0, 'each step once per standstill');
  assert.equal(h.stuckWakes().length, 2);
});

test('a real move starts the standstill over', () => {
  const h = setup();
  const task = h.tasks.create({ title: 'Color grade', createdBy: 'ag_kai', assigneeId: 'ag_kai' });
  assert.equal(h.at(DAY), 1);
  h.at(2 * DAY);
  h.tasks.update(task.id, { plan: ['Grade scene 1', 'Grade scene 2'] }, 'ag_kai');
  assert.equal(h.at(2 * DAY + 20 * HOUR), 0, 'moved under a day ago');
  assert.equal(h.at(3 * DAY + HOUR), 1, 'a day after the move: the manager again, not the head');
  const last = h.stuckWakes().at(-1)!;
  assert.equal(last.agent_id, 'ag_tom');
  assert.match(String(last.note), /Next step: Grade scene 1/);
});

test('work of the person, or of an agent who reports to the person, escalates nowhere', () => {
  const h = setup();
  h.tasks.create({ title: 'Sign the contract', createdBy: 'ag_mara', assigneeId: HUMAN_ID, assigneeKind: 'human' });
  h.tasks.create({ title: 'Plan the quarter', createdBy: 'ag_mara', assigneeId: 'ag_mara' });
  assert.equal(h.at(4 * DAY), 0);
  assert.equal(h.notified.filter((item) => /stuck/i.test(JSON.stringify(item))).length, 0, 'the person gets nothing');
});

test('an agent whose manager reports to the person: only the manager step exists', () => {
  const h = setup();
  const task = h.tasks.create({ title: 'Edit the vlog', createdBy: 'ag_tom', assigneeId: 'ag_tom' });
  assert.equal(h.at(4 * DAY), 1);
  assert.deepEqual(h.stuckWakes().map((row) => [row.agent_id, row.task_id]), [['ag_mara', task.id]]);
  assert.equal(h.at(6 * DAY), 0);
});

test('a wait whose date is still ahead does not escalate; once the date passed it does', () => {
  const h = setup();
  const task = h.tasks.create({ title: 'Wait for the music license', createdBy: 'ag_kai', assigneeId: 'ag_kai' });
  h.tasks.update(task.id, { status: 'waiting', waitingOn: { on: 'outside', why: 'Label answers', until: h.start + 5 * DAY } }, 'ag_kai');
  assert.equal(h.at(4 * DAY), 0);
  assert.equal(h.at(5 * DAY + HOUR), 2, 'past its date and four days still: manager and head');
});

test('a to-do whose time is ahead, or waiting on an unfinished task, does not escalate', () => {
  const h = setup();
  h.tasks.create({ title: 'Publish on Friday', createdBy: 'ag_kai', assigneeId: 'ag_kai', at: h.start + 10 * DAY });
  const first = h.tasks.create({ title: 'Render', createdBy: 'ag_lea', assigneeId: 'ag_lea' });
  h.tasks.create({ title: 'Upload', createdBy: 'ag_kai', assigneeId: 'ag_kai', dependsOn: [first.id] });
  h.at(2 * DAY);
  assert.deepEqual(h.stuckWakes().map((row) => [row.agent_id, row.task_id]), [['ag_mara', first.id]], 'only the blocking task escalates');
});
