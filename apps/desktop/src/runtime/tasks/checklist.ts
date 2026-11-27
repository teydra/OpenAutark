// Checklist stage 2 (P5; the items: shared/model/task-plan.ts):
// - handOverItem: an item handed to someone becomes a task of its own, linked both ways – the new task sits in the
//   holder's quest through the parent link (tasks/quests.ts: a top-level to-do that gets one becomes a quest, a to-do in a
//   quest gets a sibling) and names its item (ledger.item); the item names its task and owner. Handing a linked item to
//   someone else gives its task to them.
// - itemEnded: when that task is done its item is ticked; when it is dropped the item is back on the holder's list as a
//   plain open one. A line in the holder's thread says so.
// - runAgain ("Run again"): a finished task as a new one – same title unless given, notes, done-when, owner, its quest
//   while open, and its checklist with every tick reset; an item that was handed over goes to the same owner again.
// Owns: those three. Never: ticks an item for a task that only ended with its quest, or touches a finished holder.

import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { isFinished, type ChecklistItem, type Task, type TaskView } from '../../shared/model/tasks.ts';
import { readChecklist } from '../../shared/model/task-plan.ts';
import type { TaskServiceImpl } from './service.ts';

const ownerOf = (task: Pick<Task, 'assigneeKind' | 'assigneeId'>): string => task.assigneeKind === 'agent' ? task.assigneeId ?? '' : task.assigneeId ?? HUMAN_ID;

/** Hands item `itemId` of task `holderId` to `to` (an agent id, 'human' or a colleague's id); returns the item's task. */
export async function handOverItem(t: TaskServiceImpl, holderId: string, itemId: string, to: string, by: string, options: { givenIn?: string } = {}): Promise<TaskView> {
  const holder = t.require(holderId);
  if (isFinished(holder.status)) throw new WorkforceError('conflict', 'This task is finished; its checklist stays as it is.', { details: { taskId: holderId } });
  const items = readChecklist(holder.ledger);
  const item = items.find((entry) => entry.id === itemId);
  if (!item) throw new WorkforceError('not_found', `Checklist item ${itemId} not found.`, { details: { taskId: holderId, itemId } });
  const linked = item.taskId ? t.repo.get(item.taskId) : undefined;
  if (linked && !isFinished(linked.status)) {
    const moved = ownerOf(linked) === to ? t.get(linked.id)! : await t.give(linked.id, to, by, options.givenIn ? { givenIn: options.givenIn } : {});
    setItem(t, holder.id, item.id, { owner: ownerOf(moved), taskId: moved.id }, by);
    return moved;
  }
  const task = await t.createTo({
    title: item.text, createdBy: by, parentId: holder.id, item: { of: holder.id, id: item.id },
    notes: `Checklist item of "${excerpt(holder.title, 120)}" (${holder.id}); when this is done, the item there is ticked.`,
    ...(options.givenIn ? { givenIn: options.givenIn } : {}),
  }, to);
  setItem(t, holder.id, item.id, { owner: ownerOf(task), taskId: task.id }, by);
  return t.get(task.id) ?? task;
}

/** Writes one item's fields on the holder (by id; the rest of the list as it is). */
function setItem(t: TaskServiceImpl, holderId: string, itemId: string, fields: Partial<ChecklistItem>, by: string): void {
  const holder = t.require(holderId);
  const items = readChecklist(holder.ledger).map((entry) => (entry.id === itemId ? { ...entry, ...fields } : entry));
  t.update(holder.id, { checklist: items }, by);
}

/** After finish(): the item this task is gets ticked (done) or comes back as an open item (dropped). */
export function itemEnded(t: TaskServiceImpl, task: Task): void {
  const link = task.ledger.item;
  if (!link) return;
  const holder = t.repo.get(link.of);
  if (!holder || isFinished(holder.status)) return;
  const items = readChecklist(holder.ledger);
  const item = items.find((entry) => entry.id === link.id && entry.taskId === task.id) ?? items.find((entry) => entry.taskId === task.id);
  if (!item) return;
  const done = task.status === 'done';
  if (done && item.done) return;
  const next = items.map((entry): ChecklistItem => {
    if (entry !== item) return entry;
    return done ? { ...entry, done: true } : { id: entry.id, text: entry.text, done: false, owner: undefined, taskId: undefined }; // undefined clears (settleItems)
  });
  try {
    t.update(holder.id, { checklist: next }, SYSTEM_ID);
    const text = done ? `Checklist: ticked "${excerpt(item.text, 80)}" – its task is done` : `Checklist: "${excerpt(item.text, 80)}" is back on the list – its task was dropped`;
    t.line(holder, { type: 'note', text, details: { taskId: holder.id } }, SYSTEM_ID);
  } catch (error) {
    t.s.log?.warn('a handed-over checklist item was not updated', { taskId: holder.id, itemTask: task.id, error: String(error) });
  }
}

/** "Run again" (see the header): the copy, with its handed-over items given again. */
export async function runAgain(t: TaskServiceImpl, id: string, by: string, input: { title?: string } = {}): Promise<TaskView> {
  const source = t.require(id);
  if (!isFinished(source.status)) throw new WorkforceError('conflict', 'Only a finished task runs again; this one is still open.', { details: { taskId: id } });
  const items = readChecklist(source.ledger);
  const owner = ownerOf(source);
  const quest = source.kind !== 'quest' && source.parentId ? t.repo.get(source.parentId) : undefined;
  const copy = await t.createTo({
    title: input.title?.trim() || source.title, notes: source.notes, createdBy: by, again: source.id,
    ...(source.kind === 'quest' ? { kind: 'quest' as const } : {}), ...(quest && !isFinished(quest.status) ? { parentId: quest.id } : {}),
    ...(source.doneWhen ? { doneWhen: source.doneWhen } : {}), ...(source.priority ? { priority: source.priority } : {}),
    ...(items.length ? { checklist: items.map(({ taskId: _previous, ...item }) => ({ ...item, done: false })) } : {}),
  }, owner || HUMAN_ID);
  for (const item of items) {
    if (!item.owner || !item.taskId) continue;
    try { await handOverItem(t, copy.id, item.id, item.owner, by); } catch (error) {
      t.s.log?.warn('a checklist item was not handed over again', { taskId: copy.id, itemId: item.id, error: String(error) });
    }
  }
  t.line(copy, { type: 'note', text: `Run again from "${excerpt(source.title, 80)}" (${source.id})`, details: { taskId: copy.id } }, by);
  return t.get(copy.id) ?? copy;
}
