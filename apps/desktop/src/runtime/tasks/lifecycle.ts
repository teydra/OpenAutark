// Who hears of a task change (the TaskService writes the rows, this decides the rest). Every status line goes into the
// task's own thread (tasks/thread.ts) – a to-do's into its own, a quest's into the quest's:
// - created: its owner hears at once ("<giver> gave me …", tasks/give.ts tellGiven) – a person by a notification or push;
// - changed: every change stands in the thread (FIXREAL 3, real run 20.11.: the assistant set a time and notes and the
//   to-do had no thread at all) – one quiet line per update for its words, time, quest, done-when or notes, with who did
//   it (the person's own drag in the calendar too; not the runtime's own upkeep, by the system) – no "(by …)" when the line
//   stands as that agent's own in the thread (REAL-2 S4: it only repeated its author); owner and end have their
//   own lines (give, finish); a quiet status line for a wait, a reopen; a wait whose reason changed replaces the task's last wait line
//   instead of adding one (KI-Runde 17.11.2026: one line per wait); an agent owner hears when someone else opened its
//   work again; the agent a wait names (`on: 'who'`, not the owner, not the one who set it) hears it at once; a quest
//   open again brings back the to-dos its close ended (tasks/quests.ts) – a line each, one word to each agent owner;
// - finished (done or dropped): a quiet line (none for an answered ask or one its maker dropped – withdrawn –, done by
//   its maker has one; a quest's says how many open to-dos ended with it), queued wakes and a running turn end, a closed quest ends its open to-dos (tasks/quests.ts), whoever
//   gave it hears how it ended ("I had asked: …"; the person by a notification, a colleague by a push – nobody when it
//   ends quietly), the owner of its quest hears the to-do ended (the last one: the quest is ready to close,
//   tasks/transitions.ts), what waits on it goes on (tasks/depends.ts), the one verification step runs;
// - removed: wakes, schedules and mini-app takes go; the anchor message becomes a tombstone line.
// An answered or declined ask ends quietly: the person's own line in the chat says it (answer-receipt.ts).
// Owns: wakes, notifications and status lines that follow a task change.
// Never: shows unchecked work as verified, wakes the one who made the change, or wakes archived agents.

import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { isFinished, isPaused, type Task } from '../../shared/model/tasks.ts';
import { isHumanActor, isPersonId } from '../../shared/model/people.ts';
import type { TaskServiceImpl } from './service.ts';
import { stopRuns } from './owners.ts';
import { releaseAppFiles } from './app-files.ts';
import { TaskVerification } from './verification.ts';
import { waitsEnded } from './depends.ts';
import { nameOf, tell, tellGiven } from './give.ts';
import { giverOf } from './names.ts';
import { endNote, endWaitOn, pieceEnded } from './transitions.ts';
import { closeTodos, openTodos, reopenTodos } from './quests.ts';
import { isDayOnly } from '../../shared/model/day-settings.ts';
import { dayZone } from '../day/clock.ts';
import { dayName, dueText } from '../context/time.ts';
import { threadOf } from './thread.ts';

export { uncheckedNote } from './verification.ts';

export class TaskLifecycle {
  private readonly t: TaskServiceImpl;
  private readonly verification: TaskVerification;
  constructor(tasks: TaskServiceImpl) { this.t = tasks; this.verification = new TaskVerification(tasks); }

  created(task: Task): void {
    if (task.status === 'waiting' && (task.waitingOn?.on !== 'task' || !task.dependsOn?.length)) {
      this.changed({ ...task, status: 'open', waitingOn: undefined }, task, task.createdBy);
      if (task.assigneeKind === 'agent') return; // work created in an explicit wait doesn't start now
    }
    tellGiven(this.t, task, task.createdBy);
  }

  /** After update(): its changed words, time or quest as one line; the status line of a wait or a reopen; an agent owner hears when someone else opened its work. */
  changed(before: Task, task: Task, by: string): void {
    const change = by === SYSTEM_ID ? undefined : changeText(this.t, before, task);
    if (change) this.t.line(task, { type: 'note', text: ownLine(this.t, task.id, by) ? change : `${change} (by ${nameOf(this.t.s, by)})`, details: { taskId: task.id } }, by);
    if (before.status === task.status && before.waitingOn?.why === task.waitingOn?.why) return;
    if (before.status === 'waiting' && task.status === 'waiting') dropWaitLine(this.t, task); // only the why changed
    const text = task.status === 'waiting' ? `Waiting: ${excerpt(task.title, 60)}${task.waitingOn ? ` · ${excerpt(task.waitingOn.why, 80)}` : ''}`
      : isFinished(before.status) ? `Reopened: ${excerpt(task.title, 60)}` : `Open again: ${excerpt(task.title, 60)}`;
    this.t.line(task, { type: 'note', text, details: { taskId: task.id, status: task.status } }, by);
    // 20.11.2026 (feedback FCMWNRKJ): Felix waited on Konrad and asked him in a quiet line – nobody heard it for 3 h 20 min.
    // The agent a wait names hears it at once, like a task given to it; the owner's line in the chat stays as it was.
    const awaits = task.status === 'waiting' && task.waitingOn?.on === 'who' ? task.waitingOn.who : undefined;
    if (awaits && !isPaused(task) && !isHumanActor(awaits) && !isPersonId(awaits) && awaits !== task.assigneeId && awaits !== by
      && (before.status !== 'waiting' || before.waitingOn?.who !== awaits || before.waitingOn?.why !== task.waitingOn?.why)) {
      const where = this.whereOf(task, awaits); // never inside the other's task: my turn runs where my own work lives
      tell(this.t.s, awaits, { reason: where.taskId ? 'task' : 'message', ...where, key: `waits:${task.id}`, note: `${nameOf(this.t.s, task.assigneeId ?? by)} waits on me for "${excerpt(task.title, 120)}": ${excerpt(task.waitingOn?.why ?? '', 240)}` });
    }
    // The one a wait named ending it wakes the owner too: a status change writes no line of theirs that would (24.11.2026,
    // task_1rv87q8g – the Developer handed round 2 back by tasks.update alone, the Reviewer slept 6 min).
    const awaited = before.status === 'waiting' && before.waitingOn?.on === 'who' && before.waitingOn.who === by;
    if (task.status === 'open' && before.status !== 'open' && task.assigneeKind === 'agent' && task.assigneeId && by !== task.assigneeId) {
      const what = awaited ? `ended my wait on them in "${excerpt(task.title, 120)}" – it is mine to move again.`
        : `${isFinished(before.status) ? 'reopened' : 'opened'} my task "${excerpt(task.title, 120)}" again.`;
      tell(this.t.s, task.assigneeId, { reason: 'task', taskId: task.id, conversationId: task.conversationId, note: `${nameOf(this.t.s, by)} ${what}` });
    }
    if (task.kind === 'quest' && isFinished(before.status) && !isFinished(task.status)) this.questReopened(task, before.completedAt, by);
  }

  /** A quest open again: the to-dos its close ended open with it (tasks/quests.ts) – a line each, one word to each agent owner. */
  private questReopened(quest: Task, closedAt: number | undefined, by: string): void {
    const back = reopenTodos(this.t, quest, closedAt, by);
    const owners = new Map<string, Task[]>();
    for (const todo of back) {
      this.t.emit(todo);
      this.t.line(todo, { type: 'note', text: `Open again with its quest: ${excerpt(todo.title, 60)}`, details: { taskId: todo.id, status: todo.status } }, by);
      if (todo.assigneeKind === 'agent' && todo.assigneeId && todo.assigneeId !== by) owners.set(todo.assigneeId, [...(owners.get(todo.assigneeId) ?? []), todo]);
    }
    if (back.length) this.t.emit(this.t.repo.get(quest.id) ?? quest);
    for (const [owner, todos] of owners) {
      const list = todos.map((todo) => `"${excerpt(todo.title, 80)}" (${todo.id})`).join(', ');
      tell(this.t.s, owner, { reason: 'task', taskId: quest.id, conversationId: quest.conversationId, note: `${nameOf(this.t.s, by)} opened the quest "${excerpt(quest.title, 120)}" again; my to-dos in it are open again: ${list}.` });
    }
  }

  /** Done or dropped (see the header). */
  finished(task: Task, by: string): void {
    const s = this.t.s;
    const closing = task.kind === 'quest' ? openTodos(this.t, task.id).length : 0; // the open to-dos that end with the quest
    if (!answeredTodo(task) && !withdrawnAsk(task, by)) {
      const done = task.status === 'done';
      const ended = closing ? ` · ${closing} open to-do${closing === 1 ? '' : 's'} ended` : '';
      this.t.line(task, { type: done ? 'task_done' : 'note', text: `${done ? 'Done' : 'Dropped'}: ${excerpt(task.title, 60)}${ended}`, details: { taskId: task.id, status: task.status, verification: task.result?.verification } }, by);
    }
    s.wakes.cancelTask(task.id, ['retry', 'review', 'task']);
    stopRuns(this.t, task, by);
    if (task.assigneeKind === 'human' && task.status === 'dropped') releaseAppFiles(s, task.widget, []);
    if (closing) closeTodos(this.t, task);
    // an answered ask: the person's own line reaches whoever asked (answer-receipt.ts) – no second word
    const answered = answeredTodo(task);
    const told = !answered && pieceEnded(this.t, task, by);
    if (answered && task.parentId) endWaitOn(this.t, this.t.repo.get(task.parentId), task, by); // the asked person's answer ends the wait on them
    this.tellGiver(task, by, told ? this.parentOwner(task) : undefined);
    waitsEnded(this.t, task, task.status === 'dropped' ? 'dropped' : 'done', answered ? task.createdBy : undefined);
    if (task.parentId) { const parent = this.t.repo.get(task.parentId); if (parent) this.t.emit(parent); }
    if (task.status === 'done') this.verification.start(task, by);
  }

  /** Whoever gave the work hears how it ended – not the one who ended it, not its owner, nobody for a quiet end. */
  private tellGiver(task: Task, by: string, alreadyTold?: string): void {
    const giver = giverOf(task);
    const owner = task.assigneeId ?? HUMAN_ID;
    if (task.result?.quiet || giver === by || giver === owner || giver === SYSTEM_ID || giver === alreadyTold) return;
    if (answeredTodo(task) && giver === task.createdBy) return; // the asker reads the person's own line
    const title = excerpt(task.title, 120);
    const word = task.status === 'done' ? 'done' : 'dropped';
    if (isHumanActor(giver)) {
      tell(this.t.s, isPersonId(giver) ? giver : HUMAN_ID, { kind: 'done', title: `${task.status === 'done' ? 'Done' : 'Dropped'}: ${excerpt(task.title, 80)}`, body: excerpt(task.result?.summary ?? '', 160), conversationId: task.conversationId, taskId: task.id });
      return;
    }
    const found = this.whereOf(task, giver);
    const where = found.taskId || found.conversationId ? found : { taskId: task.id }; // else the task itself
    const onParent = found.taskId ? { id: found.taskId } : undefined;
    const lines = [`"${title}", which I gave ${nameOf(this.t.s, owner)}, is ${word}.`, ...endNote(task, true)];
    tell(this.t.s, giver, { reason: 'child', ...where, key: onParent ? `task:${onParent.id}` : `child:${task.id}`, note: lines.join('\n') });
  }

  /**
   * Where another agent's turn about `task` runs – where its own work lives: its own open parent task, else the chat it
   * gave the task from (its giver), else the task's chat when it is in it; else nowhere in particular.
   */
  private whereOf(task: Task, agentId: string): { taskId?: string; conversationId?: string } {
    const parent = task.parentId ? this.t.repo.get(task.parentId) : undefined;
    if (parent && parent.assigneeKind === 'agent' && parent.assigneeId === agentId && !isFinished(parent.status)) return { taskId: parent.id, conversationId: parent.conversationId };
    const inChat = task.conversationId && this.t.s.chats.members(task.conversationId).some((member) => member.memberId === agentId && !member.leftAt);
    const chat = (giverOf(task) === agentId ? task.ledger.givenIn : undefined) ?? (inChat ? task.conversationId : undefined);
    return chat ? { conversationId: chat } : {};
  }

  private parentOwner(task: Task): string | undefined {
    return task.parentId ? this.t.repo.get(task.parentId)?.assigneeId : undefined;
  }

  /** Removed (with `parts`, the tasks under it, gone with it): nothing of them stays planned; the anchor message becomes a quiet tombstone line. */
  removed(task: Task, by: string, parts: Task[] = []): void {
    const s = this.t.s;
    for (const gone of [task, ...parts]) {
      this.verification.forget(gone.id);
      s.wakes.cancelTask(gone.id);
      for (const schedule of s.scheduler?.list({ taskId: gone.id }) ?? []) s.scheduler!.remove(schedule.id);
      releaseAppFiles(s, gone.widget, []); // a removed mini-app to-do's takes go to the clean-up
    }
    stopRuns(this.t, task, by);
    for (const gone of [task, ...parts]) waitsEnded(this.t, gone, 'removed');
    if (task.messageId && task.conversationId && !task.parentId) { // its card in the chat it was handed over in becomes a tombstone line (its own thread goes with it)
      const anchor = s.chats.message(task.messageId);
      if (anchor?.kind === 'task') s.chats.removeMessage(task.messageId, SYSTEM_ID);
      if (anchor) {
        try { s.chats.status(task.conversationId, { type: 'note', text: `Task removed: ${excerpt(task.title, 60)}`, details: { taskId: task.id } }, { authorId: by, taskId: task.id }); } catch (error) {
          s.log?.warn('task removed line failed', { taskId: task.id, error: String(error) });
        }
      }
    }
  }
}

/**
 * What one update changed that a reader of the thread acts on – its words, its time, its quest, its done-when, its notes –
 * in one line ("Time: Sat 21 Nov 09:00 · Notes updated"; changed() adds who did it); undefined when none of them changed.
 */
function changeText(t: TaskServiceImpl, before: Task, task: Task): string | undefined {
  const zone = dayZone(t.s);
  const now = t.s.clock.now();
  const parts: string[] = [];
  if (task.title !== before.title) parts.push(`Title: "${excerpt(task.title, 80)}"`);
  if (task.at !== before.at || task.minutes !== before.minutes) {
    const length = task.minutes ? `, ${task.minutes} min` : '';
    parts.push(task.at === undefined ? (task.minutes ? `Length: ${task.minutes} min` : 'Time removed')
      : isDayOnly(task, zone) ? `Day: ${dayName(task.at, zone, now)}` : `Time: ${dueText(task.at, zone, now)}${length}`);
  }
  if (task.parentId !== before.parentId) {
    parts.push(task.parentId ? `Moved to quest "${excerpt(t.repo.get(task.parentId)?.title ?? task.parentId, 60)}"` : 'Taken out of its quest');
  }
  const doneWhen = task.doneWhen?.trim() ?? '';
  if (doneWhen !== (before.doneWhen?.trim() ?? '')) parts.push(doneWhen ? `Done when: ${excerpt(doneWhen, 80)}` : 'Done-when cleared');
  if (task.notes !== before.notes) parts.push('Notes updated');
  return parts.length ? parts.join(' · ') : undefined;
}

/**
 * The change line stands as `by`'s own in the task's thread (made now when missing): `by` is an agent of that thread –
 * chats.status shows anyone else's line as the system's. Then "(by …)" would only repeat its author (REAL-2 S4: "Day:
 * Sat 21 Nov · Notes updated (by Manager)" by the Manager, its own line about the day right after).
 */
function ownLine(t: TaskServiceImpl, taskId: string, by: string): boolean {
  try {
    threadOf({ ...t.s, tasks: t }, taskId);
    return t.s.chats.members(taskId).some((member) => member.memberId === by && member.kind === 'agent');
  } catch {
    return false;
  }
}

/** The task's newest status line in its thread, when it is its wait line, goes – the line about the new reason stands for it (a change line between them counts as none). */
function dropWaitLine(t: TaskServiceImpl, task: Task): void {
  if (!t.s.chats.get(task.id)) return;
  try {
    const last = t.s.chats.messages(task.id, { limit: 50 }).reverse()
      .find((message) => message.kind === 'status' && message.meta.status?.details?.taskId === task.id && message.meta.status.details.status !== undefined);
    if (last?.meta.status?.details?.status === 'waiting') t.s.chats.removeMessage(last.id, SYSTEM_ID);
  } catch (error) {
    t.s.log?.warn('the last wait line was not replaced', { taskId: task.id, error: String(error) });
  }
}

/** A to-do the person answered through its widget or declined: their own line in the chat says it (answer-receipt.ts). */
function answeredTodo(task: Task): boolean {
  if (task.assigneeKind !== 'human' || task.result?.answer === undefined) return false;
  return task.widget !== undefined || task.status === 'dropped';
}

/**
 * An ask the agent that made it drops itself – withdrawn, it leaves the person's list quietly. Done is no withdrawal
 * (REAL-2 S2Q-C: the to-do Tessa closed on the person's word had no line saying so): it gets its line.
 */
function withdrawnAsk(task: Task, by: string): boolean {
  return task.status === 'dropped' && task.assigneeKind === 'human' && by === task.createdBy && !isHumanActor(by);
}
