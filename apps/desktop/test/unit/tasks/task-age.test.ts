import { test } from 'node:test';
import assert from 'node:assert/strict';
import { center, company } from '../task-center/fixture.ts';
import { dueText, profileZone } from '../../../src/runtime/context/time.ts';

test('list separates the original creation instant from the last movement after wait and reopen', async () => {
  const h = center();
  company(h);
  let now = h.s.clock.now();
  h.s.clock.now = () => now;
  const task = h.tasks.create({ title: 'Old rollout', createdBy: 'ag_tom', assigneeId: 'ag_tom' });
  now += 24 * 3600_000;
  await h.call('ag_tom', 'tasks.update', { id: task.id, waiting: 'Supplier response' });
  now += 24 * 3600_000;
  await h.call('ag_tom', 'tasks.update', { id: task.id, status: 'open' });
  const zone = profileZone(h.s);
  for (const args of [{ id: task.id }, { who: 'all' }, {}]) {
    const { text } = await h.call('ag_tom', 'tasks.list', args);
    assert.ok(text.toLowerCase().includes(`created on ${dueText(task.createdAt, zone, now)}`.toLowerCase()), text);
    assert.ok(text.toLowerCase().includes(`stuck since ${dueText(now, zone, now)}`.toLowerCase()), text);
  }
  assert.equal(h.tasks.get(task.id)?.createdAt, task.createdAt);
});
