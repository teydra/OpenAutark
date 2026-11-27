// The stuck escalation (E4, Konrad 25.11.2026): an agent's unfinished work on which nothing moved for a day is brought to
// its manager; after three days to the head above that manager (the next one up the chain). Each step once per standstill:
// the mark (ledger.escalated) holds the standstill's start, so a real move (a new movedAt or wait) starts it over.
// No escalation reaches a person – work the person owns, and an agent whose manager is the person, escalates nowhere; an
// agent with only a manager gets only the first step. Not escalated: paused work (the person stopped it), work whose time
// (`at`) or wait date (`waitingOn.until`) is still ahead, work waiting on tasks that are still unfinished (those escalate
// themselves), work an owner's turn runs on right now, and a quest whose to-dos moved since.
// Where: in the watcher's hourly pass, for the tasks watched on this PC (tasks/watch.ts).
// Owns: that rule, its wake and its mark. Never: changes a task's status or owner, or tells a person.

import { HUMAN_ID } from '../../shared/ids.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { isFinished, isPaused, type Task } from '../../shared/model/tasks.ts';
import { movedAt } from '../../shared/model/task-stuck.ts';
import { dueText } from '../context/time.ts';
import { dayZone } from '../day/clock.ts';
import { tell } from './give.ts';
import type { TaskServiceImpl } from './service.ts';

const DAY_MS = 24 * 3600_000;
/** First step: the owner's manager hears of it after this long. */
export const ESCALATE_MANAGER_MS = DAY_MS;
/** Second step: the head above that manager hears of it after this long. */
export const ESCALATE_HEAD_MS = 3 * DAY_MS;

/** Since when an agent's work stands still in the escalation's sense (undefined: it does not, or it never escalates). */
export function standstillSince(t: TaskServiceImpl, task: Task, now: number): number | undefined {
  if (isFinished(task.status) || task.assigneeKind !== 'agent' || !task.assigneeId || task.assigneeId === HUMAN_ID) return undefined;
  if (isPaused(task)) return undefined;
  if (task.at !== undefined && task.at > now) return undefined;
  const wait = task.status === 'waiting' ? task.waitingOn : undefined;
  if (wait?.until !== undefined && wait.until > now) return undefined;
  if (wait?.on === 'task' && (wait.ids ?? []).some((id) => { const other = t.repo.get(id); return other !== undefined && !isFinished(other.status); })) return undefined;
  if (t.isRunning(task.id)) return undefined;
  let since = Math.max(movedAt(task), wait?.since ?? 0);
  if (task.kind === 'quest') for (const step of t.repo.children(task.id)) since = Math.max(since, movedAt(step));
  return since;
}

/** One pass: wakes the manager or head for each due step not yet told; returns how many wakes went out. */
export function escalationPass(t: TaskServiceImpl, here: (task: Task) => boolean): number {
  const { s } = t;
  const now = s.clock.now();
  let told = 0;
  const rows = s.db.all<{ id: string }>(`SELECT id FROM tasks WHERE assignee_kind = 'agent' AND status IN ('open', 'waiting') AND assignee_id IS NOT NULL`);
  for (const { id } of rows) {
    try {
      const task = t.repo.get(id);
      if (!task || !here(task)) continue;
      const since = standstillSince(t, task, now);
      if (since === undefined || now - since < ESCALATE_MANAGER_MS) continue;
      const mark = task.ledger.escalated;
      const done = mark?.since === since ? mark.level : 0;
      const due = now - since >= ESCALATE_HEAD_MS ? 2 : 1;
      if (done >= due) continue;
      const chain = (s.org?.managers(task.assigneeId!) ?? []).filter((boss) => boss.id !== task.assigneeId);
      if (!chain.length) continue; // reports to the person: nobody to tell, nothing to mark
      for (let level = done + 1; level <= due; level++) {
        const to = chain[level - 1];
        if (!to) continue; // no head above the manager: only the step that exists
        tell(s, to.id, { reason: 'task', taskId: task.id, conversationId: task.conversationId, key: `stuck:${task.id}:${level}`, note: escalationNote(t, task, since, now, level, chain) });
        told++;
      }
      t.emit(t.mutate(task.id, (draft) => { draft.ledger = { ...draft.ledger, escalated: { since, level: due } }; }));
    } catch (error) {
      s.log?.warn('stuck escalation failed for a task', { taskId: id, error: String(error) });
    }
  }
  return told;
}

/** The line the manager (level 1) or the head (level 2) reads: what, whose, since when, the next step. */
export function escalationNote(t: TaskServiceImpl, task: Task, since: number, now: number, level: 1 | 2 | number, chain: ReadonlyArray<{ name: string }>): string {
  const owner = t.s.org?.get(task.assigneeId!)?.name ?? task.assigneeId!;
  const days = Math.floor((now - since) / DAY_MS);
  const kind = task.kind === 'quest' ? 'Quest' : 'To-do';
  const who = level === 1 ? `${owner} reports to me` : `${owner} reports to ${chain[0]?.name ?? 'my report'}, who reports to me`;
  return [
    `Stuck for ${days} day${days === 1 ? '' : 's'}: ${kind} "${excerpt(task.title, 120)}" (${task.id}), owner ${owner}, nothing moved since ${dueText(since, dayZone(t.s), now)}.`,
    `Next step: ${nextStep(task)}`,
    `${who}; I help it move – ask, unblock, re-plan, give it to someone else or drop it with a reason – without asking the person for a hand.`,
  ].join('\n');
}

/** The first open step of its plan, else what it waits on, else its notes. */
function nextStep(task: Task): string {
  const open = task.ledger.checklist?.find((item) => !item.done)?.text ?? task.ledger.plan?.find((line) => !line.startsWith('✓'));
  if (open) return excerpt(open, 160);
  if (task.status === 'waiting' && task.waitingOn?.why) return `waiting – ${excerpt(task.waitingOn.why, 160)}`;
  return excerpt(task.notes, 160) || 'none written down';
}
