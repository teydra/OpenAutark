// P5 checklist stage 2: old text-only plans read as items with stable ids (no loss), an older PC's line edit keeps the
// ids, owners and tasks by their words, handing an item over makes a linked task (parentId), its done ticks the item,
// and "Run again" copies a finished task with its checklist unticked and the same owners.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readChecklist, readPlan, settleItems, writePlan } from '../../../src/shared/model/task-plan.ts';
import { renderTask } from '../../../src/runtime/context/task-text.ts';
import { center, company } from '../task-center/fixture.ts';

/** The task as an agent's prompt shows it. */
const checklistBlock = (h: ReturnType<typeof center>, id: string) => renderTask(h.s, h.tasks.get(id)!, 'UTC', 'Task');

test('an old plan of lines reads as items p1, p2 … with every word and tick kept', () => {
  const items = readChecklist({ plan: ['✓ Review copy', 'Upload', 'Announce'] });
  assert.deepEqual(items, [
    { id: 'p1', text: 'Review copy', done: true },
    { id: 'p2', text: 'Upload', done: false },
    { id: 'p3', text: 'Announce', done: false },
  ]);
  assert.deepEqual(writePlan(items), ['✓ Review copy', 'Upload', 'Announce']);
});

test('an older PC that rewrites the lines keeps each item\'s id, owner and task by its words', () => {
  const known = settleItems([{ text: 'Review copy', done: false }, { text: 'Upload', done: false, owner: 'ag_lea', taskId: 'task_up' }]);
  const ledger = { plan: writePlan(known), checklist: known };
  assert.deepEqual(readChecklist(ledger), known, 'in step: the stored items');
  const old = { ...ledger, plan: ['✓ Review copy', 'upload', 'Announce'] }; // an older PC ticked, re-cased and added a line
  const items = readChecklist(old);
  assert.deepEqual(items.map((item) => [item.id, item.done, item.owner, item.taskId]), [
    ['p1', true, undefined, undefined], ['p2', false, 'ag_lea', 'task_up'], ['p3', false, undefined, undefined],
  ]);
  assert.deepEqual(readPlan(old.plan).map((item) => item.text), ['Review copy', 'upload', 'Announce']);
});

test('a stage-1 task in the database keeps its plan and gains ids when it is next changed', async () => {
  const h = center();
  company(h);
  const task = h.tasks.create({ title: 'Old task', createdBy: 'ag_tom', assigneeId: 'ag_tom', plan: ['✓ Done', 'Next'] });
  h.db.run("UPDATE tasks SET ledger = json_remove(ledger, '$.checklist') WHERE id = ?", [task.id]);
  assert.deepEqual(readChecklist(h.tasks.get(task.id)!.ledger).map((item) => [item.id, item.text, item.done]), [['p1', 'Done', true], ['p2', 'Next', false]]);
  const changed = await h.call('ag_tom', 'tasks.update', { id: task.id, plan: [{ text: 'Done', done: true }, { text: 'Next', done: true }] });
  assert.equal(changed.error, false, changed.text);
  const after = h.tasks.get(task.id)!.ledger;
  assert.deepEqual(after.plan, ['✓ Done', '✓ Next']);
  assert.deepEqual(after.checklist?.map((item) => item.id), ['p1', 'p2']);
});

test('handing an item over makes a linked task for its owner; its done ticks the item; the prompt shows both', async () => {
  const h = center();
  company(h);
  const added = await h.call('ag_tom', 'tasks.add', { title: 'Publish update', plan: [
    { text: 'Review copy', done: false }, { text: 'Upload the build', done: false, for: 'Lea' },
  ] });
  assert.equal(added.error, false, added.text);
  const id = String(added.data?.taskId);
  const holder = h.tasks.get(id)!;
  const item = readChecklist(holder.ledger)[1];
  assert.equal(item.owner, 'ag_lea');
  assert.ok(item.taskId, 'a linked task');
  const linked = h.tasks.get(item.taskId!)!;
  assert.equal(linked.assigneeId, 'ag_lea');
  assert.equal(linked.title, 'Upload the build');
  assert.deepEqual(linked.ledger.item, { of: id, id: item.id });
  assert.equal(linked.parentId, id, 'linked through parentId');
  assert.equal(h.tasks.get(id)!.kind, 'quest', 'a top-level to-do that gets a child becomes a quest (quests.ts)');
  assert.match(checklistBlock(h, id), /p2 ☐ Upload the build · Lea's, task_/);

  h.tasks.finish(linked.id, { status: 'done', summary: 'Uploaded' }, 'ag_lea');
  const ticked = readChecklist(h.tasks.get(id)!.ledger);
  assert.equal(ticked[1].done, true, 'done ticks the item');
  assert.equal(ticked[1].owner, 'ag_lea');
  assert.equal(ticked[0].done, false);
  assert.deepEqual(h.tasks.get(id)!.ledger.plan, ['Review copy', '✓ Upload the build']);
});

test('handing over an item later (tasks.update) and handing it on moves the same linked task', async () => {
  const h = center();
  company(h);
  const added = await h.call('ag_mara', 'tasks.add', { title: 'Launch page', plan: [{ text: 'Write copy', done: false }, { text: 'Cut video', done: false }] });
  const id = String(added.data?.taskId);
  const handed = await h.call('ag_mara', 'tasks.update', { id, plan: [{ text: 'Write copy', done: false }, { text: 'Cut video', done: false, for: 'Tom' }] });
  assert.equal(handed.error, false, handed.text);
  const first = readChecklist(h.tasks.get(id)!.ledger)[1];
  assert.equal(first.owner, 'ag_tom');
  const again = await h.call('ag_mara', 'tasks.update', { id, plan: [{ text: 'Write copy', done: false }, { text: 'Cut video', done: false, for: 'Lea' }] });
  assert.equal(again.error, false, again.text);
  const second = readChecklist(h.tasks.get(id)!.ledger)[1];
  assert.equal(second.owner, 'ag_lea');
  assert.equal(second.taskId, first.taskId, 'the same task, given on');
  assert.equal(h.tasks.get(first.taskId!)?.assigneeId, 'ag_lea');
});

test('"Run again" copies a finished task with its checklist unticked and the same owners', async () => {
  const h = center();
  company(h);
  const added = await h.call('ag_tom', 'tasks.add', { title: 'Weekly release', plan: [
    { text: 'Build', done: false }, { text: 'Test on the phone', done: false, for: 'Lea' },
  ] });
  const id = String(added.data?.taskId);
  const handed = readChecklist(h.tasks.get(id)!.ledger)[1];
  h.tasks.finish(handed.taskId!, { status: 'done', summary: 'Tested' }, 'ag_lea');
  await h.call('ag_tom', 'tasks.update', { id, plan: [{ text: 'Build', done: true }, { text: 'Test on the phone', done: true }] });
  h.tasks.finish(id, { status: 'done', summary: 'Released' }, 'ag_tom');

  const copy = await h.tasks.runAgain(id, 'ag_tom');
  assert.notEqual(copy.id, id);
  assert.equal(copy.status, 'open');
  assert.equal(copy.title, 'Weekly release');
  assert.equal(copy.assigneeId, 'ag_tom');
  assert.equal(copy.ledger.again, id);
  const items = readChecklist(h.tasks.get(copy.id)!.ledger);
  assert.deepEqual(items.map((item) => [item.text, item.done]), [['Build', false], ['Test on the phone', false]], 'every tick back');
  assert.equal(items[1].owner, 'ag_lea', 'the owner stays');
  assert.ok(items[1].taskId && items[1].taskId !== handed.taskId, 'a fresh linked task for this run');
  assert.equal(h.tasks.get(items[1].taskId!)?.status, 'open');

  const viaTool = await h.call('ag_tom', 'tasks.add', { title: 'Weekly release', again: id });
  assert.equal(viaTool.error, false, viaTool.text);
  await assert.rejects(h.tasks.runAgain(copy.id, 'ag_tom'), /finished/i, 'only a finished task runs again');
});
