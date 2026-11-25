import { test } from 'node:test';
import assert from 'node:assert/strict';
import { center, company } from '../task-center/fixture.ts';
import { TaskWatcher } from '../../../src/runtime/tasks/watch.ts';
import { addDays, wallOf, wallTime } from '../../../src/shared/text/when.ts';
import { dayZone } from '../../../src/runtime/day/clock.ts';

function setup() {
  const h = center();
  company(h);
  let now = h.s.clock.now();
  h.s.clock.now = () => now;
  const zone = dayZone(h.s);
  const tomorrow = wallTime(addDays(wallOf(now, zone).date, 1), 540, zone);
  const watcher = () => new TaskWatcher(h.s);
  const legacy = (title: string) => {
    const task = h.tasks.create({ title, createdBy: 'ag_tom', assigneeId: 'ag_tom' });
    h.tasks.update(task.id, { status: 'waiting', waitingOn: { on: 'outside', why: title } }, 'ag_tom');
    return task.id;
  };
  return { ...h, tomorrow, watcher, legacy, advance: (at: number) => { now = at; } };
}

test('outside waits default to tomorrow at 09:00 local; update accepts the same dates as at', async () => {
  const h = setup();
  const added = await h.call('ag_tom', 'tasks.add', { title: 'Wait for the supplier', waiting: 'Supplier quote' });
  assert.equal(added.error, false, added.text);
  const id = String(added.data?.taskId);
  assert.match(added.text, /default/i);
  assert.equal(h.tasks.get(id)?.waitingOn?.until, h.tomorrow);
  const changed = await h.call('ag_tom', 'tasks.update', { id, until: '+3h' });
  assert.equal(changed.error, false, changed.text);
  assert.equal(h.tasks.get(id)?.waitingOn?.until, h.s.clock.now() + 3 * 3600_000);
});

test('a due follow-up wakes once, even after the wake ran and the watcher restarted', async () => {
  const h = setup();
  const added = await h.call('ag_tom', 'tasks.add', { title: 'Wait for the supplier', waiting: 'Supplier quote', until: '+1h' });
  const id = String(added.data?.taskId);
  assert.equal(h.tasks.get(id)?.waitingOn?.until, h.s.clock.now() + 3600_000);
  h.db.run('DELETE FROM wakes');
  h.watcher().recover();
  assert.equal(h.wakeRows().length, 0);
  h.advance(h.s.clock.now() + 3600_000);
  h.watcher().recover();
  assert.equal(h.wakeRows().filter((row) => row.task_id === id).length, 1);
  h.db.run('DELETE FROM wakes');
  h.watcher().recover();
  assert.equal(h.wakeRows().length, 0);
  assert.equal(h.tasks.get(id)?.status, 'waiting', 'the owner decides whether the outside wait is over');
});

test('legacy outside waits get one persisted deadline and one grouped wake per owner', () => {
  const h = setup();
  const ids = [h.legacy('Build'), h.legacy('Review')];
  h.db.run('DELETE FROM wakes');
  h.watcher().recover();
  assert.deepEqual(ids.map((id) => h.tasks.get(id)?.waitingOn?.until), [h.tomorrow, h.tomorrow]);
  h.advance(h.tomorrow);
  h.watcher().recover();
  const wakes = h.wakeRows().filter((row) => row.agent_id === 'ag_tom');
  assert.equal(wakes.length, 1);
  for (const id of ids) assert.ok(String(wakes[0]?.note).includes(id));
});

test('a waiter left behind by a synced completion resumes at recovery', () => {
  const h = setup();
  const first = h.tasks.create({ title: 'Sign package', assigneeId: 'ag_lea', createdBy: 'ag_lea' });
  const next = h.tasks.create({ title: 'Publish package', assigneeId: 'ag_tom', createdBy: 'ag_tom', dependsOn: [first.id] });
  h.db.run("UPDATE tasks SET status = 'done' WHERE id = ?", [first.id]);
  h.db.run('DELETE FROM wakes');
  h.watcher().recover();
  assert.equal(h.tasks.get(next.id)?.status, 'open');
  assert.ok(h.wakeRows().some((row) => row.agent_id === 'ag_tom' && row.task_id === next.id));
});
