// A deadline on a wait is a one-shot follow-up, not an appointment or an automatic reopening.
import { HUMAN_ID } from '../../shared/ids.ts';
import type { Task } from '../../shared/model/tasks.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { addDays, wallOf, wallTime } from '../../shared/text/when.ts';
import { dayZone } from '../day/clock.ts';
import { recoverDepends } from './depends.ts';
import { tell } from './give.ts';
import type { TaskServiceImpl } from './service.ts';

export function nextFollowUp(now: number, zone: string): number {
  return wallTime(addDays(wallOf(now, zone).date, 1), 9 * 60, zone);
}

/** Recover old waits, enqueue each owner's due work, and return the next instant to check. */
export function followUpPass(t: TaskServiceImpl, here: (task: Task) => boolean, repair = false): number | undefined {
  const { s } = t;
  const now = s.clock.now();
  const rows = s.db.all<{ id: string }>("SELECT id FROM tasks WHERE status = 'waiting' AND waiting_on IS NOT NULL");
  const groups = new Map<string, Task[]>();
  let next: number | undefined;
  for (const { id } of rows) {
    let task = t.repo.get(id);
    if (!task?.waitingOn || !here(task)) continue;
    try {
      if (repair) recoverDepends(t, task);
      task = t.repo.get(id);
      const wait = task?.waitingOn;
      if (!task || task.status !== 'waiting' || !wait || wait.followedUp) continue;
      let at = wait.until;
      if (at === undefined && wait.on === 'outside') {
        const until = nextFollowUp(now, dayZone(s));
        t.emit(t.mutate(id, (draft) => { draft.waitingOn = { ...wait, until }; }));
        at = until;
      }
      if (at === undefined) continue;
      if (at > now) { next = Math.min(next ?? at, at); continue; }
      const owner = task.assigneeKind === 'human' ? task.assigneeId ?? HUMAN_ID : task.assigneeId;
      if (!owner) continue;
      if (task.assigneeKind === 'agent' && s.org?.get(owner)?.archivedAt !== undefined) continue;
      const group = groups.get(owner) ?? [];
      group.push(task);
      groups.set(owner, group);
    } catch (error) {
      s.log?.warn('could not check a task wait', { taskId: id, error: String(error) });
    }
  }
  for (const [owner, tasks] of groups) {
    try {
      const [first] = tasks;
      const single = tasks.length === 1;
      const note = 'Follow up on ' + tasks.map((task) => `"${excerpt(task.title, 80)}" (${task.id}): ${excerpt(task.waitingOn!.why, 100)}`).join('; ');
      // Record the delivery and the durable wake in the same SQLite transaction; a restart cannot enqueue it again.
      const marked = s.db.tx(() => {
        const changes = tasks.map((task) => t.mutate(task.id, (draft) => { draft.waitingOn = { ...draft.waitingOn!, followedUp: true }; }));
        if (first.assigneeKind === 'agent') tell(s, owner, { reason: 'schedule', key: `wait-follow-up:${now}`, ...(single ? { taskId: first.id, conversationId: first.conversationId } : {}), note });
        return changes;
      });
      for (const task of marked) t.emit(task);
      if (first.assigneeKind === 'human') tell(s, owner, { kind: 'todo', title: 'Task follow-up', body: excerpt(note, 240), ...(single ? { taskId: first.id } : {}) });
    } catch (error) {
      s.log?.warn('could not deliver a task follow-up', { owner, error: String(error) });
      next = Math.min(next ?? now + 60_000, now + 60_000);
    }
  }
  return next;
}
