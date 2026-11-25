// TaskService ("simplified Asana", Quests round 20.11.2026): one task model – a quest holds to-dos (one level), a to-do
// is one thing one owner does; the person's work is a to-do owned by 'human' (or a colleague's per_… id). Tasks are rows
// of their own (a chat is only where one was handed over – its anchoring 'task' message). Four stored states: open,
// waiting, done, dropped; "working" is a live run on it (TaskView.running). Writes: create (tasks/create.ts), update
// (fields, its time, its quest, a wait set or ended, the plan and facts), give (tasks/give.ts), finish (done or dropped,
// with a result – a quest's end ends its open to-dos, tasks/quests.ts), pause / resume (the person's Stop), remove.
// Nothing plans a look: who hears of a change hears it at once (tasks/lifecycle.ts), and an agent's own "look again
// later" is a reminder (schedules). Human widget flows live in tasks/human.ts; owner moves (archived agents, pause) in
// tasks/owners.ts. "Only me" (Task.private, owner 20.11.2026) hides nothing: it marks a task the person does themselves –
// an agent never gives it to an agent or ends it (onlyMeLine); everyone reads it as any other.
// Owns: every write to `tasks`/`tasks_fts` and the task events.
// Never: shows unverified work as verified, stores "working", or keeps a second copy of the task text outside its row.

import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { UiBlock } from '../../shared/blocks/catalog.ts';
import type { Message, StatusLine } from '../../shared/model/chat.ts';
import { isFinished, isPaused, type CreateTaskInput, type Task, type TaskFilter, type TaskResult, type TaskView, type TaskWait, type TodoRepeat } from '../../shared/model/tasks.ts';
import type { RuntimeServices, TaskService } from '../contracts.ts';
import { ActivityTracker } from '../chat/activity.ts';
import { chatTitleFor } from '../chat/titles.ts';
import { TaskRepo } from './repo.ts';
import { HumanTodos } from './human.ts';
import { handOver, onPersonLine, pauseTask, resumeTask } from './owners.ts';
import { TaskLifecycle } from './lifecycle.ts';
import { prepareWidget } from './timers.ts';
import { dayZone } from '../day/clock.ts';
import { createTask, type CreateOptions } from './create.ts';
import { taskViews } from './views.ts';
import { isHumanActor, isPersonId } from '../../shared/model/people.ts';
import { applyDepends, checkDepends } from './depends.ts';
import { answerByReply } from './reply-answer.ts';
import { giveTask, nameOf, pickOwner, receiverOf, type GiveInput } from './give.ts';
import { applyUndo, recordChange, undoable } from './changes.ts';
import { checkKind, checkMove, checkReopen } from './quests.ts';
import { dropThread, threadEvent } from './thread.ts';
import type { Effort } from '../../shared/model/providers.ts';
import { setTaskRoute } from '../agents/next-route.ts';
import '../contracts/people.ts';

export type TaskDeps = Pick<RuntimeServices, 'db' | 'bus' | 'clock' | 'chats' | 'wakes'>
  & Partial<Pick<RuntimeServices, 'org' | 'subconscious' | 'scheduler' | 'notifications' | 'log' | 'dispatcher' | 'catalog' | 'people' | 'settings' | 'decisions'>>;

/** A wait as a caller gives it (since is set here). */
export type WaitInput = Omit<TaskWait, 'since'>;

/**
 * What update() takes: the fields, its time (`at`/`minutes`, null clears), its quest (`parentId`, null takes it out), its
 * kind, a wait (status 'waiting' + waitingOn) or its end (status 'open'), the plan and a fact.
 */
export type TaskPatch = Partial<Pick<Task, 'title' | 'notes' | 'priority' | 'doneWhen' | 'sort' | 'widget' | 'dependsOn' | 'status' | 'private' | 'kind'>>
  & { at?: number | null; minutes?: number | null; parentId?: string | null; waitingOn?: WaitInput; plan?: string[]; fact?: string; facts?: string[]; doneCount?: number };

/** What finish() takes. */
export interface FinishInput {
  status: 'done' | 'dropped';
  summary: string;
  evidence?: TaskResult['evidence'];
  alsoHandled?: string[];
  followUps?: TaskResult['followUps'];
  quiet?: boolean;
  answer?: unknown;
}

/**
 * What "Only me" (Task.private) means for an agent, in its own words (owner 20.11.2026: the to-do needs the person; nothing
 * of it is hidden): it never goes to an agent and an agent never closes it. `held`: the "Only me" to-do a quest still holds.
 */
export function onlyMeLine(held?: string): string {
  return `${held ? `This quest still holds "${held}", which is` : 'This is'} the person's own ("Only me"): they do it and close it themselves. `
    + 'I help around it – notes, a reminder, its quest, a time – and it stays theirs.';
}

const FIELDS = new Set<string>(['title', 'notes', 'priority', 'doneWhen', 'sort', 'widget', 'private', 'kind']);
/** Fields a patch clears with null. */
const CLEARABLE = ['at', 'minutes'] as const;

export class TaskServiceImpl implements TaskService {
  readonly s: TaskDeps;
  readonly repo: TaskRepo;
  private readonly activity: ActivityTracker;
  private readonly human: HumanTodos;
  readonly life: TaskLifecycle; // read by tasks/create.ts
  private readonly offs: Array<() => void>;

  constructor(deps: TaskDeps) {
    this.s = deps;
    this.repo = new TaskRepo(deps.db);
    this.activity = new ActivityTracker(deps.bus, ({ tasks }) => {
      for (const id of tasks) { const task = this.repo.get(id); if (task) this.emit(task); } // "Working" follows the live run
    });
    this.human = new HumanTodos(this);
    this.life = new TaskLifecycle(this);
    this.offs = [
      deps.bus.on('agent.removed', ({ id }) => handOver(this, id)),
      deps.bus.on('message.created', message => onPersonLine(this, message)),
      deps.bus.on('message.created', message => answerByReply(this, message)), // a typed reply answers the ask it replies to
    ];
  }

  // ------------------------------------------------------------- queries

  list(filter: TaskFilter = {}): TaskView[] { return this.views(this.repo.list(filter)); }
  todos(limit = 50, personId?: string): TaskView[] { return this.views(this.repo.todos(limit, personId)); }
  openFor(agentId: string): TaskView[] { return this.views(this.repo.openFor(agentId)); }

  get(id: string): TaskView | undefined {
    const task = this.repo.get(id);
    return task ? this.views([task])[0] : undefined;
  }

  // ------------------------------------------------------------- writes

  create(input: CreateTaskInput & { createdBy: string }, options: CreateOptions = {}): TaskView {
    return createTask(this, input, options);
  }

  /**
   * New work for `to` ("me", "team", an agent, the person or a colleague by id): "team" picks one owner now (`team`
   * narrows it to that team's agents); `route` is what the work needs from its first turn on.
   */
  async createTo(input: Omit<CreateTaskInput, 'assigneeKind' | 'assigneeId'> & { createdBy: string }, to: string, options: CreateOptions & { team?: string; route?: GiveInput['route'] } = {}): Promise<TaskView> {
    let receiver = receiverOf(to, input.createdBy);
    if (receiver.kind === 'team') receiver = await pickOwner(this, { title: input.title, notes: input.notes ?? '', spaceId: input.spaceId }, input.createdBy, options.team);
    const owner = receiver.kind === 'agent' ? { assigneeKind: 'agent' as const, assigneeId: receiver.id } : { assigneeKind: 'human' as const, ...(receiver.kind === 'human' && receiver.id ? { assigneeId: receiver.id } : {}) };
    const view = this.create({ ...input, ...owner }, options);
    if (receiver.kind === 'agent' && options.route) setTaskRoute(this.s.db, receiver.id, view.id, { ...options.route, reason: `given by ${nameOf(this.s, input.createdBy)}`, at: this.s.clock.now() });
    return view;
  }

  /**
   * Changes fields; status 'waiting' with waitingOn sets (or refreshes) a wait, status 'open' ends it (a pause too) – and
   * a person's 'open' on finished work reopens it (a to-do of a closed quest only with its quest). `plan` replaces the
   * plan, `fact` adds one line; both count as a move. A timer widget's time is the to-do's `at`.
   */
  update(id: string, patch: TaskPatch, by: string, rev?: number): TaskView {
    const current = this.require(id);
    if (patch.widget && current.assigneeKind === 'human') {
      const armed = prepareWidget(patch.widget, this.s.clock.now(), by, dayZone(this.s));
      patch = { ...patch, widget: armed.widget, ...(armed.at !== undefined && patch.at === undefined ? { at: armed.at } : {}) };
    }
    if (patch.status === 'open' && isPaused(current)) return this.resume(id, by);
    if (patch.status !== undefined && isFinished(current.status)) {
      if (patch.status !== 'open' || !isHumanActor(by)) throw new WorkforceError('conflict', 'This task is finished; new work is a new task (tasks.add).', { details: { taskId: id } });
      checkReopen(this, current);
    }
    if (patch.status === 'waiting' && !patch.waitingOn && current.status !== 'waiting') throw new WorkforceError('bad_request', 'A wait says what it waits on (waitingOn).');
    if (patch.parentId !== undefined && patch.parentId !== (current.parentId ?? null)) checkMove(this, current, patch.parentId);
    if (patch.kind !== undefined) checkKind(this, { ...current, ...(patch.parentId !== undefined ? { parentId: patch.parentId ?? undefined } : {}) }, patch.kind);
    const parent = patch.parentId === undefined ? current.parentId : patch.parentId ?? undefined;
    const after = patch.dependsOn ? checkDepends(this.repo, id, parent, patch.dependsOn) : undefined;
    const now = this.s.clock.now();
    const task = this.mutate(id, draft => {
      const fields = draft as unknown as Record<string, unknown>;
      for (const key of Object.keys(patch)) if (FIELDS.has(key)) fields[key] = (patch as Record<string, unknown>)[key];
      for (const key of CLEARABLE) if (patch[key] === null) delete draft[key]; else if (patch[key] !== undefined) draft[key] = patch[key]!;
      if (draft.private === false) delete draft.private;
      if (patch.parentId !== undefined) { if (patch.parentId === null) delete draft.parentId; else draft.parentId = patch.parentId; }
      let moved = draft.notes !== current.notes || draft.title !== current.title || draft.doneWhen !== current.doneWhen;
      if (patch.plan !== undefined) { draft.ledger = { ...draft.ledger, plan: patch.plan.map((line) => line.trim()).filter(Boolean).slice(0, 20) }; moved = true; }
      if (patch.fact?.trim()) {
        const fact = patch.fact.trim();
        draft.ledger = { ...draft.ledger, facts: [...(draft.ledger.facts ?? []).filter((item) => item !== fact), fact].slice(-20) };
        moved = true;
      }
      if (patch.facts !== undefined) draft.ledger = { ...draft.ledger, facts: patch.facts.slice(-20) }; // a runtime caller's whole list
      if (patch.doneCount !== undefined) draft.ledger = { ...draft.ledger, doneCount: patch.doneCount };
      if (patch.status === 'waiting') {
        const wait = patch.waitingOn ?? current.waitingOn!;
        const same = current.status === 'waiting' && current.waitingOn?.on === wait.on && current.waitingOn.who === wait.who;
        draft.status = 'waiting';
        draft.waitingOn = { ...wait, since: same ? current.waitingOn!.since : now }; // a refreshed wait keeps when it began
        moved = true;
      } else if (patch.status === 'open' && current.status !== 'open') {
        draft.status = 'open';
        delete draft.waitingOn;
        delete draft.completedAt;
        if (isFinished(current.status)) draft.ledger = { ...draft.ledger, facts: [...(draft.ledger.facts ?? []), `Reopened by ${nameOf(this.s, by)}.`].slice(-20) };
        moved = true;
      } else if (patch.waitingOn && draft.status === 'waiting') {
        draft.waitingOn = { ...patch.waitingOn, since: draft.waitingOn?.since ?? now };
      }
      // 24.11.2026 (Demo Workshop, task_1rv87q8g): the Developer the Reviewer waited on set the wait to "Reviewer: round 2" –
      // a wait on the owner itself, which wakes nobody; the task stood 6 min. Whoever hands a wait back to its agent owner ends it.
      if (draft.status === 'waiting' && draft.waitingOn?.on === 'who' && draft.assigneeKind === 'agent' && draft.waitingOn.who === draft.assigneeId && by !== draft.assigneeId) {
        draft.status = 'open';
        delete draft.waitingOn;
        moved = true;
      }
      if (after) applyDepends(this.repo, draft, after, now);
      if (moved) draft.ledger = { ...draft.ledger, movedAt: now };
      recordChange(draft, current, by, 'update', now); // the change log (tasks/changes.ts): the person's "Undo"
    }, rev);
    const view = this.emit(task);
    for (const quest of new Set([current.parentId, task.parentId])) { // a to-do that came or went changes its quest's view
      if (quest && current.parentId !== task.parentId) { const fresh = this.repo.get(quest); if (fresh) this.emit(fresh); }
    }
    this.life.changed(current, task, by);
    return view;
  }

  /**
   * Gives task `id` to `to` ("me", "team", an agent, the person or a colleague by id); "team" picks one owner now. An agent
   * never gives an "Only me" task to an agent or the team (onlyMeLine) – the person does that themselves if they want to.
   */
  async give(id: string, to: string, by: string, input: { note?: string; effort?: Effort; fact?: string; givenIn?: string } = {}): Promise<TaskView> {
    const task = this.require(id);
    const route = input.effort ? { effort: input.effort } : undefined;
    let receiver = receiverOf(to, by);
    if (task.private && receiver.kind !== 'human' && !isHumanActor(by)) throw new WorkforceError('conflict', onlyMeLine(), { details: { taskId: id } });
    if (receiver.kind === 'team') receiver = await pickOwner(this, task, by);
    const give: GiveInput = { ...(input.note ? { note: input.note } : {}), ...(route ? { route } : {}), ...(input.fact ? { fact: input.fact } : {}), ...(input.givenIn ? { givenIn: input.givenIn } : {}) };
    return giveTask(this, id, receiver, by, give);
  }

  /**
   * Ends a task: done with what came out, or dropped with why (a quest takes its open to-dos along). A finished task comes
   * back as it is. An agent never ends an "Only me" task, nor a quest that still holds an open one (onlyMeLine).
   */
  finish(id: string, input: FinishInput, by: string): TaskView {
    const before = this.require(id);
    if (isFinished(before.status)) return this.views([before])[0];
    if (!input.summary?.trim()) throw new WorkforceError('bad_request', 'Finishing a task needs a summary.');
    const human = isHumanActor(by);
    const kept = human || by === SYSTEM_ID ? undefined : before.private ? before : this.repo.children(id).find((todo) => todo.private && !isFinished(todo.status));
    if (kept) throw new WorkforceError('conflict', onlyMeLine(kept === before ? undefined : kept.title), { details: { taskId: kept.id } });
    const named = input.status === 'dropped' && by !== before.assigneeId && by !== HUMAN_ID && by !== SYSTEM_ID;
    const summary = named ? `Dropped by ${nameOf(this.s, by)}: ${input.summary.trim()}` : input.summary.trim();
    const now = this.s.clock.now();
    const task = this.mutate(id, draft => {
      draft.status = input.status;
      draft.result = {
        summary, evidence: input.evidence ?? [], verification: human ? 'reported_by_human' : 'claimed_by_agent',
        ...(input.alsoHandled?.length ? { alsoHandled: input.alsoHandled } : {}), ...(input.followUps?.length ? { followUps: input.followUps } : {}),
        ...(input.answer !== undefined ? { answer: input.answer } : {}), ...(input.quiet ? { quiet: true as const } : {}),
      };
      draft.completedAt = now;
      delete draft.waitingOn;
      recordChange(draft, before, by, 'finish', now);
    });
    const view = this.emit(task);
    this.life.finished(task, by);
    return view;
  }

  /**
   * Takes back a logged change (the latest not undone one, or `changeId`) within its 24 hours while the task still holds what it wrote: the fields come back,
   * the owner is told as for any change of status and reads a fact why. `not_found` when there is nothing to undo, `conflict` when a later change came after it.
   */
  undo(id: string, by: string, changeId?: string): TaskView {
    const current = this.require(id);
    const now = this.s.clock.now();
    const entry = undoable(current, now, changeId);
    if (!entry) throw new WorkforceError('not_found', 'There is nothing to undo here (a change can be undone for 24 hours).', { details: { taskId: id } });
    if (isFinished(current.status) && entry.before.status !== undefined && !isFinished(entry.before.status as Task['status'])) checkReopen(this, current);
    const task = this.mutate(id, (draft) => applyUndo(draft, entry, by, this.nameOf(by), now));
    const view = this.emit(task);
    if (isFinished(current.status) && !isFinished(task.status)) this.life.changed(current, task, by); // the owner hears that it is open again
    else if (!isFinished(current.status) && isFinished(task.status)) this.life.finished(task, by);
    else this.life.changed(current, task, by);
    return view;
  }

  /** The person's Stop: the task waits on them ("Paused by you") until they or its owner move it on. */
  pause(id: string, by: string): TaskView {
    const task = pauseTask(this, id, by);
    return task ? this.emit(task) : this.views([this.require(id)])[0];
  }

  /** Ends a pause: the task is open again and its owner hears it. */
  resume(id: string, by: string): TaskView {
    const task = resumeTask(this, id, by);
    return this.emit(task ?? this.require(id));
  }

  remove(id: string, by: string): void {
    const task = this.require(id);
    const parts = this.partsOf(id); // its to-dos go with it (ON DELETE CASCADE)
    this.repo.delete(id);
    this.life.removed(task, by, parts);
    for (const gone of [task, ...parts]) dropThread(this.s, gone.id); // each task's own thread goes with it
    this.s.bus.emit('task.removed', { id, ...(task.conversationId ? { conversationId: task.conversationId } : {}) });
    if (task.parentId) { const parent = this.repo.get(task.parentId); if (parent) this.emit(parent); }
  }

  // ------------------------------------------------------------- human flows (tasks/human.ts)

  ingestBlocks(message: Message, blocks: UiBlock[], indexes?: number[]): TaskView[] { return this.human.ingestBlocks(message, blocks, indexes); }
  answer(input: Parameters<TaskService['answer']>[0]): TaskView | undefined { return this.human.answer(input); }
  changeWidget(id: string, type: string, repeat?: TodoRepeat): TaskView { return this.human.changeWidget(id, type, repeat); }
  snooze(ref: string | { messageId: string; blockIndex: number }, until: number): TaskView { return this.human.snooze(ref, until); }
  stopRepeating(id: string, by: string): TaskView { return this.human.stopRepeating(id, by); }

  // ------------------------------------------------------------- shared internals

  require(id: string): Task {
    const task = this.repo.get(id);
    if (!task) throw new WorkforceError('not_found', 'Task not found.', { details: { taskId: id } });
    return task;
  }

  /** Load → change → save with rev check. Throws `conflict` when someone else wrote first. */
  mutate(id: string, change: (draft: Task) => void, expectedRev?: number): Task {
    const current = this.require(id);
    if (expectedRev !== undefined && expectedRev !== current.rev) {
      throw new WorkforceError('conflict', 'The task changed meanwhile. Reload and try again.', { details: { taskId: id, rev: current.rev } });
    }
    const draft: Task = structuredClone(current);
    change(draft);
    draft.rev = current.rev + 1;
    draft.updatedAt = this.s.clock.now();
    if (!this.repo.save(draft, current.rev)) {
      throw new WorkforceError('conflict', 'The task changed meanwhile. Reload and try again.', { details: { taskId: id } });
    }
    return draft;
  }

  emit(task: Task): TaskView {
    const view = this.views([task])[0];
    this.s.bus.emit('task.upserted', view);
    return view;
  }

  /** True while a turn runs on this task (the live activity) – with `agentId`, a turn of that agent. */
  isRunning(id: string, agentId?: string): boolean { return this.activity.running(id, agentId); }

  /** True while any agent runs a turn in this chat. */
  chatRunning(conversationId: string): boolean { return this.activity.working(conversationId).length > 0; }

  /** To-dos, progress, chat title and whether a turn runs on it (tasks/views.ts). */
  views(tasks: Task[]): TaskView[] {
    return taskViews(this.repo, (conversationId?: string) => conversationId ? chatTitleFor(this.s, conversationId, HUMAN_ID) : '', id => this.activity.running(id), tasks);
  }

  /** Every task under `id` (its to-dos – and, on rows from before the quests, theirs), breadth first, at most 500. */
  private partsOf(id: string): Task[] {
    const out: Task[] = [];
    const seen = new Set([id]);
    for (const queue = [id]; queue.length && out.length < 500;) {
      for (const part of this.repo.children(queue.shift()!)) {
        if (!seen.has(part.id)) { seen.add(part.id); out.push(part); queue.push(part.id); }
      }
    }
    return out;
  }

  /** Quiet event line about a task in its own thread (tasks/thread.ts) – every task, chat-free ones and to-dos too. */
  line(task: Task, line: StatusLine, by: string): void {
    threadEvent({ ...this.s, tasks: this }, task.id, line, by);
  }

  nameOf(id: string): string {
    if (isPersonId(id)) return this.s.people?.nameOf(id) ?? 'Former colleague';
    return id === HUMAN_ID ? 'You' : this.s.org?.get(id)?.name ?? id;
  }

  dispose(): void {
    this.activity.dispose();
    for (const off of this.offs) off();
  }
}
