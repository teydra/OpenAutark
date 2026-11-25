// TaskService.create (split out of tasks/service.ts): checks, the row, the anchoring 'task' message for top-level work and
// a human to-do's armed widget. A chat is only where a task is handed over: with a conversationId the chat must exist and
// the anchor is posted there (an anchor made during a run in that chat carries meta.fromRun); without one it is
// chat-free – its space from input.spaceId (runtime callers only), else the parent's, else the creating agent's; its
// origin from the input, else from the creating run, else 'todo-list' (the person) or 'system'. A to-do placed under a
// task goes into that task's quest (tasks/quests.ts: a top-level to-do that gets one becomes a quest); one without a chat
// takes its quest's when its creator is a member there. An agent receiver out of a 1:1 or a chat a person is in that it
// is not in gets it in the creator's own 1:1 with it (chat/direct.ts workRoomFor; nobody is seated there by a task); a colleague gets it where people/task-rules.ts says. The owner is resolved before (team
// goes through tasks/give.ts pickOwner – TaskService.createTo). The anchor is sent after the insert; when that send
// throws, the row is deleted again and the error re-thrown. Its owner hears of it at once (lifecycle.created). The card of a
// task an agent owns is silent (KI-Runde 17.11.2026): it stands in the chat for whoever looks, counts no unread, moves no
// row and notifies nobody; a task for a person, and the card of work a person hands an agent themselves, stays loud.
// Owns: building and inserting a new task. Never: gives a task to an unknown or archived agent, leaves it without an
// owner, or takes an origin from an agent's or a person's text (runtime code sets it).

import { HUMAN_ID, SYSTEM_ID, newId } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { Attachment, Message, MessageMeta } from '../../shared/model/chat.ts';
import type { CreateTaskInput, Task, TaskView } from '../../shared/model/tasks.ts';
import { ORIGINS, cleanOrigin, type Origin } from '../../shared/model/origin.ts';
import type { TaskServiceImpl } from './service.ts';
import { joinChat } from './owners.ts';
import { workRoomFor } from '../chat/direct.ts';
import { prepareWidget } from './timers.ts';
import { dayZone } from '../day/clock.ts';
import { isHumanActor } from '../../shared/model/people.ts';
import { checkMayGive } from '../people/task-rules.ts';
import { taskSpace } from './space.ts';
import { applyDepends, checkDepends } from './depends.ts';
import { makeQuest, questFor } from './quests.ts';

/** `anchorWith` (task center): who posts the anchor message and its files – the Inbox anchor of an agent's
 *  tasks.submit is the system's (the agent is no member there), a quick task's anchor carries its attachments,
 *  and `body` (B-041) stores the person's whole dictation once (the split rewrites the task into its parts). */
export interface CreateOptions {
  anchor?: Message; clientId?: string; runtimeWidget?: boolean;
  anchorWith?: { authorId: string; attachments?: Attachment[]; meta?: MessageMeta; body?: string };
  /** The run that caused the task (its anchor's meta.fromRun). */
  fromRun?: string;
}

/** The creating agent's running turns (none for the person or the system; a failing lookup is none). */
function runsOf(t: TaskServiceImpl, createdBy: string) {
  if (isHumanActor(createdBy) || createdBy === SYSTEM_ID) return [];
  try { return t.s.dispatcher?.activity().filter((run) => run.agentId === createdBy) ?? []; } catch { return []; }
}

/** The run the anchor belongs to: the caller's, else the creating agent's turn running in this chat. */
function runOf(t: TaskServiceImpl, options: CreateOptions, createdBy: string, conversationId: string): string | undefined {
  if (options.fromRun) return options.fromRun;
  return runsOf(t, createdBy).find((run) => run.conversationId === conversationId)?.runId;
}

/** A chat-free task's origin: the caller's, else the creating run's (or that run's task's), else the To-do area / the system. */
function originFor(t: TaskServiceImpl, input: CreateTaskInput & { createdBy: string }): Origin {
  const given = cleanOrigin(input.origin);
  if (given) return given;
  for (const run of runsOf(t, input.createdBy).filter((entry) => !entry.conversationId)) {
    const from = cleanOrigin(run.origin) ?? (run.taskId ? cleanOrigin(t.repo.get(run.taskId)?.origin) : undefined);
    if (from) return from;
  }
  return input.createdBy === HUMAN_ID ? { ...ORIGINS.todoList } : { ...ORIGINS.system };
}

/** The chat to hand the task over in: the given one, else (a sub-task) the parent's when its creator is a member there. */
function chatFor(t: TaskServiceImpl, input: CreateTaskInput & { createdBy: string }, parent: Task | undefined): string | undefined {
  if (input.conversationId) return input.conversationId;
  const inherited = parent?.conversationId;
  if (!inherited) return undefined;
  if (input.createdBy === SYSTEM_ID) return inherited;
  let member = false;
  try { member = t.s.chats.members(inherited).some((entry) => entry.memberId === input.createdBy && !entry.leftAt); } catch { member = false; }
  if (member) return inherited;
  return undefined;
}

/** D7's work room for a new agent task; a creator without a 1:1 of its own (an outside agent) keeps the given chat. */
function workRoom(t: TaskServiceImpl, given: string | undefined, by: string, agentId: string): string | undefined {
  try { return workRoomFor(t.s, given, by, agentId); } catch (error) {
    t.s.log?.warn('no work room for the new task', { by, agentId, error: String(error) });
    return given;
  }
}

export function createTask(t: TaskServiceImpl, input: CreateTaskInput & { createdBy: string }, options: CreateOptions = {}): TaskView {
  const s = t.s;
  if (input.conversationId && !s.chats.get(input.conversationId)) {
    throw new WorkforceError('not_found', 'Chat not found.', { details: { conversationId: input.conversationId } });
  }
  if (!input.title?.trim()) throw new WorkforceError('bad_request', 'A task needs a title.');
  const clientId = options.clientId ?? (input.clientId ? `cli:${input.clientId}` : undefined);
  if (clientId) {
    const existing = t.repo.byClientId(clientId);
    if (existing) return t.views([existing])[0];
  }
  const assigneeKind = input.assigneeKind ?? (input.assigneeId ? 'agent' : 'human');
  if (assigneeKind === 'team') throw new WorkforceError('bad_request', 'A task gets its owner first (TaskService.createTo picks one for "team").');
  const kind = input.kind ?? 'todo';
  if (kind === 'quest' && input.parentId) throw new WorkforceError('bad_request', 'A quest never sits in another quest.');
  const given = input.parentId ? t.repo.get(input.parentId) : undefined;
  if (input.parentId && !given) throw new WorkforceError('not_found', 'Quest not found.');
  const parent = given ? questFor(t, given) : undefined; // a to-do goes into a quest (tasks/quests.ts)
  if (parent && (parent.status === 'done' || parent.status === 'dropped')) throw new WorkforceError('conflict', 'That quest is closed; reopen it first.', { details: { taskId: parent.id } });
  if (assigneeKind === 'agent' && input.assigneeId && s.org) {
    const owner = s.org.get(input.assigneeId);
    if (!owner || owner.archivedAt !== undefined) throw new WorkforceError('not_found', 'Agent not found.');
  }
  // An agent out of a 1:1 or a person's chat it is not in gets the work in the creator's own 1:1 with it; a colleague where task-rules.ts says.
  const handed = chatFor(t, input, parent);
  const receiver = assigneeKind === 'agent' ? { kind: 'agent' as const, id: input.assigneeId! } : { kind: 'human' as const, ...(input.assigneeId && input.assigneeId !== HUMAN_ID ? { id: input.assigneeId } : {}) };
  const placed = checkMayGive(s, input.createdBy, receiver, { conversationId: handed, widget: input.widget });
  const conversationId = assigneeKind === 'agent' && input.assigneeId ? workRoom(t, placed, input.createdBy, input.assigneeId) : placed;
  const now = s.clock.now();
  const armed = input.widget && assigneeKind === 'human' ? prepareWidget(input.widget, now, options.runtimeWidget ? SYSTEM_ID : input.createdBy, dayZone(s)) : undefined;
  const task: Task = {
    id: newId('task', now), kind, title: input.title.trim(), notes: input.notes ?? '',
    status: 'open', assigneeKind, createdBy: input.createdBy, priority: input.priority ?? 0,
    ledger: { movedAt: now, ...(input.plan?.length ? { plan: input.plan.map((line) => line.trim()).filter(Boolean).slice(0, 20) } : {}), ...(input.givenIn && input.givenIn !== conversationId ? { givenIn: input.givenIn } : {}) }, // the giving chat, when the work lands elsewhere (a 1:1)
    sort: now, rev: 0, createdAt: now, updatedAt: now,
  };
  if (conversationId) {
    task.conversationId = conversationId;
    const origin = cleanOrigin(input.origin);
    if (origin) task.origin = origin;
  } else {
    const spaceId = input.spaceId ?? (parent ? taskSpace(s, parent) : s.org?.get(input.createdBy)?.spaceId);
    if (spaceId) task.spaceId = spaceId;
    task.origin = originFor(t, input);
  }
  if (input.assigneeId && input.assigneeId !== HUMAN_ID) task.assigneeId = input.assigneeId;
  if (input.at !== undefined || armed?.at !== undefined) task.at = input.at ?? armed?.at;
  if (input.minutes !== undefined) task.minutes = input.minutes;
  if (input.private) task.private = true;
  if (input.doneWhen) task.doneWhen = input.doneWhen;
  if (input.widget) task.widget = armed?.widget ?? input.widget;
  if (input.files?.length) task.files = input.files.map((file) => ({ ...file })); // a quick task's files
  if (input.waitingOn) { task.status = 'waiting'; task.waitingOn = { ...input.waitingOn, since: now }; }
  if (input.dependsOn?.length) applyDepends(t.repo, task, checkDepends(t.repo, undefined, parent?.id, input.dependsOn), now);
  if (parent) task.parentId = parent.id;
  if (options.anchor) task.messageId = options.anchor.id;
  if (assigneeKind === 'agent' && task.assigneeId) joinChat(t, task.conversationId, task.assigneeId, input.createdBy);
  t.repo.insert(task, clientId);
  // Top-level tasks handed over in a chat are anchored by a 'task' message there (pieces, block to-dos and chat-free tasks are not).
  if (!parent && !options.anchor && task.conversationId) anchorTask(t, task, input, options, task.conversationId);
  const view = t.emit(task);
  if (parent) { makeQuest(t, parent); const fresh = t.repo.get(parent.id); if (fresh) t.emit(fresh); } // its quest's to-dos changed: the page shows the new one at once
  t.life.created(task);
  return view;
}

/** Posts the anchor (after the insert: delivery side effects never fire for a row that is gone again). */
function anchorTask(t: TaskServiceImpl, task: Task, input: CreateTaskInput & { createdBy: string }, options: CreateOptions, conversationId: string): void {
  const s = t.s;
  try {
    const author = options.anchorWith?.authorId ?? input.createdBy;
    const fromRun = runOf(t, options, input.createdBy, conversationId);
    const meta = { ...(options.anchorWith?.meta ?? {}), ...(fromRun ? { fromRun } : {}) };
    const message = s.chats.send({
      // an agent's bookkeeping card is silent; the person's own hand-over of work is their act and stays loud
      conversationId, body: options.anchorWith?.body ?? task.title, kind: 'task', taskId: task.id, silent: task.assigneeKind === 'agent' && !isHumanActor(author),
      authorId: author, authorKind: isHumanActor(author) ? 'human' : author === SYSTEM_ID ? 'system' : 'agent',
      ...(options.anchorWith?.attachments?.length ? { attachments: options.anchorWith.attachments } : {}),
      ...(Object.keys(meta).length ? { meta } : {}),
    });
    task.messageId = message.id;
    t.repo.save(task, task.rev);
  } catch (error) {
    // Compensation: no task without its handover message – the row goes.
    try { t.repo.delete(task.id); } catch (cleanup) { s.log?.warn('task not removed after a failed anchor', { taskId: task.id, error: String(cleanup) }); }
    throw error;
  }
}
