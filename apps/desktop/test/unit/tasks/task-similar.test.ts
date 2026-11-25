import { test } from 'node:test';
import assert from 'node:assert/strict';
import { center, company } from '../task-center/fixture.ts';

test('a related title for the same owner is a hint, not a block; unrelated and closed work do not count', async () => {
  const h = center();
  company(h);
  const a = await h.call('ag_tom', 'tasks.add', { title: 'Haken: Nachricht angekommen und gelesen' });
  const id = String(a.data?.taskId);
  assert.ok(id.startsWith('task_'));
  const b = await h.call('ag_tom', 'tasks.add', { title: 'Nachricht angekommen/gelesen anzeigen' });
  assert.equal(b.error, false, b.text);
  assert.notEqual(b.data?.taskId, id);
  assert.match(String(b.data?.similar), new RegExp(`Similar open: ${id}.*Haken: Nachricht angekommen und gelesen.*Tom.*checklist`));
  const free = await h.call('ag_tom', 'tasks.add', { title: 'Fahrstuhl in der Werkstatt prüfen' });
  assert.equal(free.data?.similar, undefined);
  const peer = await h.call('ag_lea', 'tasks.add', { title: 'Nachricht angekommen/gelesen anzeigen' });
  assert.equal(peer.data?.similar, undefined, 'unrelated owners with no shared quest');
  for (const taskId of [id, b.data?.taskId]) {
    await h.call('ag_tom', 'tasks.update', { id: taskId, status: 'dropped', result: 'replaced' });
  }
  const fresh = await h.call('ag_tom', 'tasks.add', { title: 'Haken: Nachricht angekommen und gelesen' });
  assert.equal(fresh.data?.similar, undefined, 'closed, or belongs to a different owner');
});

test('a shared quest is sufficient even when the owners differ', async () => {
  const h = center();
  company(h);
  const quest = await h.call('ag_tom', 'tasks.add', { title: 'Statusanzeige', quest: 'new' });
  const first = await h.call('ag_tom', 'tasks.add', { title: 'Haken: Nachricht angekommen und gelesen', quest: quest.data?.taskId });
  const second = await h.call('ag_tom', 'tasks.add', { title: 'Nachricht angekommen/gelesen anzeigen', for: 'Lea', quest: quest.data?.taskId });
  assert.equal(second.error, false, second.text);
  assert.match(String(second.data?.similar), new RegExp(`Similar open: ${first.data?.taskId}`));
});
