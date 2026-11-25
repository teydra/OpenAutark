import { test } from 'node:test';
import assert from 'node:assert/strict';
import { center, company } from '../task-center/fixture.ts';

test('add and update replace a to-do checklist, and list shows the next unchecked step', async () => {
  const h = center();
  company(h);
  const added = await h.call('ag_tom', 'tasks.add', { title: 'Publish update', plan: [
    { text: 'Review copy', done: true }, { text: 'Upload', done: false }, { text: 'Announce', done: false },
  ] });
  const id = String(added.data?.taskId);
  for (const args of [{ id }, {}, { who: 'all' }]) {
    const { text } = await h.call('ag_tom', 'tasks.list', args);
    assert.match(text, /☑ 1\/3.*Next: Upload/);
  }
  const updated = await h.call('ag_tom', 'tasks.update', { id, plan: [{ text: 'Ship', done: false }] });
  assert.equal(updated.error, false, updated.text);
  assert.match((await h.call('ag_tom', 'tasks.list', { id })).text, /☑ 0\/1.*Next: Ship/);
  await h.call('ag_tom', 'tasks.update', { id, plan: [] });
  assert.doesNotMatch((await h.call('ag_tom', 'tasks.list', { id })).text, /☑/);
});

test('old text-only plan rows and checkmark prefixes still read as checklist items', async () => {
  const h = center();
  company(h);
  const task = h.tasks.create({ title: 'Old task', createdBy: 'ag_tom', assigneeId: 'ag_tom', plan: ['✓ Done', 'Plain old next step'] });
  assert.match((await h.call('ag_tom', 'tasks.list', { id: task.id })).text, /☑ 1\/2.*Next: Plain old next step/);
});
