// Waits on tasks: a task that comes after other tasks (Task.dependsOn) waits on them (waitingOn on 'task'), and so does a
// task its owner set waiting on tasks (tasks.update on: task). When the last of them is done, dropped or removed it is
// open again – a quiet "Ready: …" line, its agent owner hears how it ended (once for all of its tasks that one end opened:
// fifteen asks after a release are one turn, not fifteen). It orders work and holds nothing back: anyone
// may open such a task at any time.
// Owns: the checks of a list, the wait it causes and its end. Never: replaces another wait or a pause, or wakes anyone for
// a task that was finished meanwhile.

import { SYSTEM_ID } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { isFinished, isPaused, type Task } from '../../shared/model/tasks.ts';
import type { TaskServiceImpl } from './service.ts';
import { tell } from './give.ts';

export const MAX_DEPENDS = 20;
const MAX_WALK = 1000;

type Repo = Pick<TaskServiceImpl['repo'], 'get'>;

/** The list to store for task `id` (undefined: not created yet) under `parentId`: known tasks, none it is part of, no loop. */
export function checkDepends(repo: Repo, id: string | undefined, parentId: string | undefined, ids: readonly string[]): string[] {
  const list = [...new Set(ids)];
  if (list.length > MAX_DEPENDS) throw new WorkforceError('bad_request', `A task can come after at most ${MAX_DEPENDS} tasks.`);
  for (const given of list) if (!repo.get(given)) throw new WorkforceError('not_found', `Task ${given} not found.`, { details: { taskId: given } });
  const seen = new Set<string>();
  const queue = [...list];
  while (queue.length) {
    const next = queue.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    if (seen.size > MAX_WALK) throw new WorkforceError('bad_request', 'This chain of tasks is too long to check.');
    if (next === id || next === parentId) throw new WorkforceError('bad_request', 'A task cannot come after itself or after a task it is part of.');
    queue.push(...(repo.get(next)?.dependsOn ?? []));
  }
  return list;
}

/** What is still unfinished of `ids`. */
function unfinished(repo: Repo, ids: readonly string[]): Task[] {
  return ids.flatMap((id) => { const task = repo.get(id); return task && !isFinished(task.status) ? [task] : []; });
}

const waitsOnTasks = (task: Pick<Task, 'status' | 'waitingOn'>): boolean => task.status === 'waiting' && task.waitingOn?.on === 'task';

/** Sets the list on a task about to be written: an open one waits while one is unfinished; a list with nothing left ends that wait. */
export function applyDepends(repo: Repo, draft: Task, ids: readonly string[], now: number): void {
  const waited = waitsOnTasks(draft) ? (draft.waitingOn!.ids ?? []).filter((id) => !draft.dependsOn?.includes(id)) : []; // tasks waited on stay waited on
  if (ids.length) draft.dependsOn = [...ids]; else delete draft.dependsOn;
  const left = unfinished(repo, [...new Set([...ids, ...waited])]);
  if (left.length) {
    if (draft.status !== 'open' && !waitsOnTasks(draft)) return;
    draft.status = 'waiting';
    draft.waitingOn = { on: 'task', ids: left.map((task) => task.id), why: `After: ${left.map((task) => excerpt(task.title, 60)).join(', ')}`, since: draft.waitingOn?.since ?? now };
    return;
  }
  if (!waitsOnTasks(draft)) return;
  draft.status = 'open';
  delete draft.waitingOn;
}

/**
 * `ended` finished or went: every task that waits on it waits for one less, or is open again – and the agent owner of
 * those that opened hears it once, all of its opened tasks in one word (R1.10), unless that owner already heard the answer.
 */
export function waitsEnded(t: TaskServiceImpl, ended: Task, how: 'done' | 'dropped' | 'removed', alreadyTold?: string): void {
  const rows = t.s.db.all<{ id: string }>(
    `SELECT id FROM tasks WHERE status IN ('open', 'waiting') AND (depends_on LIKE ? OR (status = 'waiting' AND waiting_on LIKE ?))`,
    [`%"${ended.id}"%`, `%"${ended.id}"%`]);
  const owners = new Map<string, Task[]>();
  for (const { id } of rows) {
    try {
      const opened = stepOn(t, id, ended);
      if (opened?.assigneeKind === 'agent' && opened.assigneeId) owners.set(opened.assigneeId, [...(owners.get(opened.assigneeId) ?? []), opened]);
    } catch (error) {
      t.s.log?.warn('a task waiting on another was not released', { taskId: id, after: ended.id, error: String(error) });
    }
  }
  for (const [owner, opened] of owners) if (owner !== alreadyTold) tellOpened(t, owner, ended, how, opened);
}

/** A synced completion may bypass local finish(); let the waiting task's home repair that edge. */
export function recoverDepends(t: TaskServiceImpl, task: Task): void {
  if (!waitsOnTasks(task)) return;
  const ids = [...new Set([...(task.dependsOn ?? []), ...(task.waitingOn?.ids ?? [])])];
  const predecessors = ids.map((id) => t.repo.get(id));
  if (!predecessors.length || !predecessors.every((item) => item && isFinished(item.status))) return;
  const ended = predecessors.at(-1)!;
  const opened = stepOn(t, task.id, ended);
  if (opened?.assigneeKind === 'agent' && opened.assigneeId) tellOpened(t, opened.assigneeId, ended, ended.status === 'dropped' ? 'dropped' : 'done', [opened]);
}

/** One step on: a shorter wait, or – after the last one – the task open again (returned). */
function stepOn(t: TaskServiceImpl, id: string, ended: Task): Task | undefined {
  const task = t.repo.get(id);
  if (!task || isPaused(task) || !waitsOnTasks(task)) return undefined; // a pause, or a wait on something else, stays
  const left = unfinished(t.repo, [...new Set([...(task.dependsOn ?? []), ...(task.waitingOn!.ids ?? [])])]).filter((item) => item.id !== ended.id);
  const now = t.s.clock.now();
  if (left.length) {
    t.emit(t.mutate(id, (draft) => { draft.waitingOn = { ...draft.waitingOn!, ids: left.map((item) => item.id) }; }));
    return undefined;
  }
  const opened = t.mutate(id, (draft) => {
    draft.status = 'open';
    delete draft.waitingOn;
    draft.ledger = { ...draft.ledger, movedAt: now };
  });
  t.line(opened, { type: 'note', text: `Ready: ${excerpt(opened.title, 60)}`, details: { taskId: id } }, SYSTEM_ID);
  t.emit(opened);
  return opened;
}

/** The owner hears how `ended` went and which of its tasks are free now: one task – with that task; several – in one wake. */
function tellOpened(t: TaskServiceImpl, owner: string, ended: Task, how: 'done' | 'dropped' | 'removed', opened: Task[]): void {
  const word = how === 'done' ? `done${ended.result?.summary ? `: ${excerpt(ended.result.summary, 400)}` : ''}` : how;
  const [first] = opened;
  if (opened.length === 1) {
    tell(t.s, owner, { reason: 'child', taskId: first.id, conversationId: first.conversationId, note: `"${excerpt(ended.title, 80)}", which my task "${excerpt(first.title, 80)}" waited on, is ${word}. Nothing else is ahead of it.` });
    return;
  }
  const quest = opened.every((task) => task.parentId && task.parentId === first.parentId) ? first.parentId : undefined; // their one quest, else none
  const list = opened.map((task) => `"${excerpt(task.title, 80)}" (${task.id})`).join(', ');
  tell(t.s, owner, { reason: 'child', key: `after:${ended.id}`, ...(quest ? { taskId: quest } : {}), note: `"${excerpt(ended.title, 80)}", which ${opened.length} of my tasks waited on, is ${word}. Nothing else is ahead of them: ${list}.` });
}
