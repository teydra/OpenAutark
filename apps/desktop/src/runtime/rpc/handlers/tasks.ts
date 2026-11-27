// RPC handlers: tasks (quests and to-dos), the person's "For you" list (todos) and schedules.
// tasks.create (to: an agent, 'human', a colleague, 'team' – Autark picks – or 'me'; kind 'quest' or a to-do in a quest),
// tasks.update (fields, its time, its quest, the plan, status 'open' to resume or reopen), tasks.give, tasks.finish (done or dropped – a to-do with a widget done is an
// *answer*: stored, the person's line posted, its author woken). A task without a chat is chat-free (the origin is
// runtime-written). tasks.share ("Share to chat…") lives in handlers/task-links.ts.
// Owns: param checks and scope rules. Never: business logic – it delegates to the task service and the scheduler. A
// device without the 'tasks' capability may only finish the person's to-dos, not agents' work. Changing, deleting or
// running schedules needs 'manage'.

import { WorkforceError } from '../../../shared/errors.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { validateBlock } from '../../../shared/blocks/validate.ts';
import type { UiBlock } from '../../../shared/blocks/catalog.ts';
import { TASK_KINDS, TODO_REPEATS, type CreateTaskInput, stillRuns, type Schedule, type ScheduleSpec, type Task, type TaskFilter, type TaskStatus, type TaskView } from '../../../shared/model/tasks.ts';
import type { TaskPatch } from '../../tasks/service.ts';
import type { RuntimeServices } from '../../contracts.ts';
import { answerWithSecrets } from '../../secrets/capture.ts';
import { MAX_DECLINE_REASON, declineAnswer, removeTodo } from '../../tasks/decline.ts';
import { POST_PRIORITIES, rewordPost } from '../../schedules/post.ts';
import { registerTaskLinks } from './task-links.ts';
import { MAX_CARD_TASKS } from '../../tasks/cards.ts';
import { nextFollowUp } from '../../tasks/follow-up.ts';
import { dayZone } from '../../day/clock.ts';
import { PREVIEW_MAX, previewTimes } from '../../schedules/preview.ts';
import {
  bad, capJson, id, ids, input, notFound, num, onlyKeys, optBool, optId, optIds, optNum, optObj, optOneOf, optStrings, optText, text,
} from '../params.ts';
import type { Obj } from '../params.ts';
import { scopeHas, secureScope, type HandlerContext, type HandlerTable } from '../table.ts';

const TODO = { capability: 'todo' } as const;
const TASKS = { capability: 'tasks' } as const;
const MANAGE = { capability: 'manage' } as const;
const STATUSES: readonly TaskStatus[] = ['open', 'waiting', 'done', 'dropped'];
const ASSIGNEES = ['team', 'agent', 'human'] as const;
const PRIORITIES = [0, 1, 2] as const;
const MAX_NOTES = 50_000;
const PATCH_KEYS = ['title', 'notes', 'at', 'minutes', 'priority', 'doneWhen', 'dependsOn', 'sort', 'plan', 'status', 'private', 'parentId', 'kind'] as const;
const MAX_MINUTES = 24 * 60;

function taskOrThrow(services: RuntimeServices, taskId: string): TaskView {
  return services.tasks.get(taskId) ?? notFound('Task', { taskId });
}

function priorityOf(o: Obj): Task['priority'] | undefined {
  const value = optNum(o, 'priority', { min: 0, max: 2 });
  return value === undefined ? undefined : PRIORITIES[value];
}

function widgetOf(o: Obj): UiBlock | undefined {
  if (o.widget === undefined || o.widget === null) return undefined;
  const result = validateBlock(o.widget);
  if (!result.ok) bad('widget', `a valid block (${result.error})`);
  return result.block;
}

function filterOf(params: unknown): TaskFilter {
  const o = input(params);
  onlyKeys(o, ['conversationId', 'kind', 'status', 'assigneeKind', 'assigneeId', 'spaceId', 'search', 'includeSteps', 'limit', 'completedSince', 'givenBy']);
  const status = optStrings(o, 'status', { maxItems: STATUSES.length, max: 20 });
  if (status?.some((value) => !(STATUSES as readonly string[]).includes(value))) bad('status', `statuses from ${STATUSES.join(', ')}`);
  return {
    conversationId: optId(o, 'conversationId'), kind: optOneOf(o, 'kind', TASK_KINDS), status: status as TaskStatus[] | undefined, assigneeKind: optOneOf(o, 'assigneeKind', ASSIGNEES),
    assigneeId: optId(o, 'assigneeId'), spaceId: optId(o, 'spaceId'), search: optText(o, 'search', { max: 200, allowEmpty: true }),
    includeSteps: optBool(o, 'includeSteps'), limit: optNum(o, 'limit', { min: 1, max: 1000 }),
    completedSince: optNum(o, 'completedSince', { min: 0 }), givenBy: optText(o, 'givenBy', { max: 120 }),
  };
}

function createInput(params: unknown): { input: Omit<CreateTaskInput, 'assigneeKind' | 'assigneeId'>; to: string } {
  const o = input(params);
  onlyKeys(o, ['conversationId', 'kind', 'title', 'notes', 'plan', 'to', 'at', 'minutes', 'priority', 'doneWhen', 'dependsOn', 'parentId', 'widget', 'clientId', 'private']);
  return {
    to: optText(o, 'to', { max: 120 }) ?? 'me',
    input: {
      conversationId: optId(o, 'conversationId'), title: text(o, 'title', { max: 300 }), notes: optText(o, 'notes', { max: MAX_NOTES, allowEmpty: true, multiline: true }),
      kind: optOneOf(o, 'kind', TASK_KINDS), plan: optStrings(o, 'plan', { maxItems: 20, max: 300 }), at: optNum(o, 'at', { min: 0 }),
      minutes: optNum(o, 'minutes', { min: 1, max: MAX_MINUTES }), priority: priorityOf(o), private: optBool(o, 'private'),
      doneWhen: optText(o, 'doneWhen', { max: 2000, multiline: true }), parentId: optId(o, 'parentId'), widget: widgetOf(o),
      clientId: optText(o, 'clientId', { max: 100 }), dependsOn: optIds(o, 'dependsOn', 50),
    },
  };
}

/** Patch for tasks.update: null clears optional fields (JSON has no undefined) – `at`/`minutes` the time, `parentId` the quest. */
function patchOf(value: unknown): TaskPatch {
  const o = input(value);
  onlyKeys(o, PATCH_KEYS, 'patch');
  const patch: TaskPatch = {};
  if ('title' in o) patch.title = text(o, 'title', { max: 300 });
  if ('notes' in o) patch.notes = optText(o, 'notes', { max: MAX_NOTES, allowEmpty: true, multiline: true }) ?? '';
  if ('at' in o) patch.at = optNum(o, 'at', { min: 0 }) ?? null;
  if ('minutes' in o) patch.minutes = optNum(o, 'minutes', { min: 1, max: MAX_MINUTES }) ?? null;
  if ('parentId' in o) patch.parentId = optId(o, 'parentId') ?? null;
  if ('kind' in o) patch.kind = optOneOf(o, 'kind', TASK_KINDS);
  if ('private' in o) patch.private = optBool(o, 'private') === true;
  if ('priority' in o) patch.priority = priorityOf(o) ?? 0;
  if ('doneWhen' in o) patch.doneWhen = optText(o, 'doneWhen', { max: 2000, multiline: true });
  if ('dependsOn' in o) patch.dependsOn = optIds(o, 'dependsOn', 50) ?? [];
  if ('sort' in o) patch.sort = optNum(o, 'sort', { integer: false, min: -1e15, max: 1e15 });
  if ('plan' in o) patch.plan = optStrings(o, 'plan', { maxItems: 20, max: 300 }) ?? [];
  if ('status' in o) patch.status = optOneOf(o, 'status', ['open'] as const);
  for (const key of Object.keys(patch) as Array<keyof TaskPatch>) {
    // Keys the service must not clear stay out when null was sent for them.
    if (patch[key] === undefined && (key === 'sort' || key === 'title' || key === 'status' || key === 'kind')) delete patch[key];
  }
  return patch;
}

/** The person ends a task: a to-do with a widget done is answered (secret form fields stored first); everything else ends as reported. */
async function finish(params: unknown, ctx: HandlerContext): Promise<TaskView> {
  const o = input(params);
  onlyKeys(o, ['id', 'status', 'answer', 'note', 'clientId']);
  const status = optOneOf(o, 'status', ['done', 'dropped'] as const) ?? 'done';
  const taskId = id(o);
  const note = optText(o, 'note', { max: 2000, multiline: true });
  const clientId = optText(o, 'clientId', { max: 100 });
  const { tasks } = ctx.services;
  const task = taskOrThrow(ctx.services, taskId);
  if (ctx.scope.kind === 'device' && !ctx.scope.capabilities.includes('tasks') && task.assigneeKind !== 'human') {
    throw new WorkforceError('forbidden', 'This device can only finish your own to-dos.');
  }
  capJson('answer', o.answer, 256 * 1024);
  if (task.widget && status === 'done') {
    const typed = o.answer !== undefined ? o.answer : { done: true, ...(note ? { note } : {}) };
    const view = await answerWithSecrets(ctx.services, { taskId }, typed, { secure: secureScope(ctx.scope) },
      (answer) => tasks.answer({ taskId, answer, by: HUMAN_ID, clientId }));
    return view ?? taskOrThrow(ctx.services, taskId);
  }
  return tasks.finish(taskId, {
    status, summary: note?.trim() || (status === 'done' ? 'Done' : 'Dropped'), ...(o.answer !== undefined ? { answer: o.answer } : {}),
  }, HUMAN_ID);
}

/** Reorders within the slots the tasks already occupy, so other tasks keep their places. */
function reorder(params: unknown, ctx: HandlerContext): { ok: true } {
  const order = ids(input(params), 'ids', 500);
  const tasks = order.map((taskId) => taskOrThrow(ctx.services, taskId));
  const slots = tasks.map((task) => task.sort).sort((a, b) => a - b);
  for (let i = 1; i < slots.length; i++) if (slots[i] <= slots[i - 1]) slots[i] = slots[i - 1] + 0.001;
  tasks.forEach((task, index) => {
    if (task.sort !== slots[index]) ctx.services.tasks.update(task.id, { sort: slots[index] }, HUMAN_ID);
  });
  return { ok: true };
}

/** Settings › Scheduled (owner 21.11.2026): a scheduled message moves to another chat – one its author is in. */
function movedTo(services: RuntimeServices, schedule: Schedule, conversationId: string): string {
  if (schedule.kind !== 'message') throw new WorkforceError('bad_request', 'Only a scheduled message moves to another chat.', { details: { scheduleId: schedule.id } });
  services.chats.get(conversationId) ?? notFound('Chat', { conversationId });
  const member = services.chats.members(conversationId).some((entry) => entry.memberId === schedule.ownerId && !entry.leftAt);
  if (schedule.ownerId !== HUMAN_ID && !member) throw new WorkforceError('bad_request', 'Its agent is not in that chat.', { details: { scheduleId: schedule.id, conversationId } });
  return conversationId;
}

export function register(table: HandlerTable): void {
  // ---------------------------------------------------------------- tasks
  table.add('tasks.list', (params, ctx) => ctx.services.tasks.list(filterOf(params)), TASKS);
  table.add('tasks.get', (params, ctx) => taskOrThrow(ctx.services, id(input(params))), TASKS);
  table.add('tasks.create', (params, ctx) => {
    const { input: fields, to } = createInput(params);
    return ctx.services.tasks.createTo({ ...fields, createdBy: HUMAN_ID }, to);
  }, TASKS);
  table.add('tasks.update', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'rev', 'patch']);
    return ctx.services.tasks.update(taskOrThrow(ctx.services, id(o)).id, patchOf(o.patch), HUMAN_ID, optNum(o, 'rev', { min: 0 }));
  }, TASKS);
  table.add('tasks.give', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'to', 'note']);
    const task = taskOrThrow(ctx.services, id(o));
    return ctx.services.tasks.give(task.id, text(o, 'to', { max: 120 }), HUMAN_ID, { note: optText(o, 'note', { max: 4000, multiline: true }) });
  }, TASKS);
  table.add('tasks.undo', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'changeId']);
    return ctx.services.tasks.undo(taskOrThrow(ctx.services, id(o)).id, HUMAN_ID, optText(o, 'changeId', { max: 40 }));
  }, TODO);
  table.add('tasks.finish', (params, ctx) => finish(params, ctx), TODO);
  table.add('tasks.reorder', (params, ctx) => reorder(params, ctx), TASKS);
  // P7 (tasks/cards.ts): the person answers a "Waiting on you" card, or puts it off ("Later", default tomorrow 09:00 local)
  table.add('tasks.answerCard', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['ids', 'reply', 'choice', 'decline']);
    return ctx.services.tasks.answerCard({
      ids: ids(o, 'ids', MAX_CARD_TASKS), reply: optText(o, 'reply', { max: 4000, allowEmpty: true, multiline: true }),
      choice: optText(o, 'choice', { max: 300 }), decline: optBool(o, 'decline'),
    }, HUMAN_ID);
  }, TASKS);
  table.add('tasks.laterCard', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['ids', 'until']);
    const until = optNum(o, 'until', { min: 0 }) ?? nextFollowUp(ctx.services.clock.now(), dayZone(ctx.services));
    return ctx.services.tasks.laterCard(ids(o, 'ids', MAX_CARD_TASKS), until, HUMAN_ID);
  }, TASKS);
  table.add('tasks.handOverItem', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'itemId', 'to']);
    const task = taskOrThrow(ctx.services, id(o));
    await ctx.services.tasks.handOverItem(task.id, text(o, 'itemId', { max: 80 }), text(o, 'to', { max: 120 }), HUMAN_ID);
    return ctx.services.tasks.get(task.id)!;
  }, TASKS);
  table.add('tasks.runAgain', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'title']);
    return ctx.services.tasks.runAgain(taskOrThrow(ctx.services, id(o)).id, HUMAN_ID, { title: optText(o, 'title', { max: 300 }) });
  }, TASKS);
  table.add('tasks.delete', (params, ctx) => {
    ctx.services.tasks.remove(taskOrThrow(ctx.services, id(input(params))).id, HUMAN_ID);
    return { ok: true };
  }, TASKS);

  registerTaskLinks(table, taskOrThrow); // B-054: tasks.share

  // ---------------------------------------------------------------- human to-dos
  table.add('todos.list', (params, ctx) => ctx.services.tasks.todos(optNum(input(params), 'limit', { min: 1, max: 200 }) ?? 50), TODO);
  table.add('todos.changeWidget', (params, ctx) => {
    const o = input(params);
    return ctx.services.tasks.changeWidget(taskOrThrow(ctx.services, id(o)).id, text(o, 'type', { max: 40 }), optOneOf(o, 'repeat', TODO_REPEATS));
  }, TODO);
  // Snooze (F03): by to-do id or by the chat block it came from; minutes from now or an exact time.
  table.add('todos.snooze', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'messageId', 'blockIndex', 'minutes', 'until']);
    const minutes = optNum(o, 'minutes', { min: 1, max: 30 * 24 * 60 });
    const until = optNum(o, 'until', { min: 0 });
    if ((minutes === undefined) === (until === undefined)) bad('minutes', 'either minutes or until');
    const when = until ?? ctx.services.clock.now() + minutes! * 60_000;
    const ref = o.id !== undefined ? id(o) : { messageId: id(o, 'messageId'), blockIndex: num(o, 'blockIndex', { min: 0, max: 1000 }) };
    if (typeof ref === 'string') taskOrThrow(ctx.services, ref);
    return ctx.services.tasks.snooze(ref, when);
  }, TODO);
  table.add('todos.stopRepeating', (params, ctx) => {
    return ctx.services.tasks.stopRepeating(taskOrThrow(ctx.services, id(input(params))).id, HUMAN_ID);
  }, TODO);
  // "Can't do this…": the person declines a to-do (dropped, their line, its author woken with the reason). Remove: only
  // to-dos the person added.
  table.add('todos.decline', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'reason', 'clientId']);
    const taskId = taskOrThrow(ctx.services, id(o)).id;
    const reason = optText(o, 'reason', { max: MAX_DECLINE_REASON, allowEmpty: true });
    const view = ctx.services.tasks.answer({ taskId, answer: declineAnswer(reason), by: HUMAN_ID, clientId: optText(o, 'clientId', { max: 100 }), decline: true });
    return view ?? taskOrThrow(ctx.services, taskId);
  }, TODO);
  table.add('todos.remove', (params, ctx) => {
    removeTodo(ctx.services.tasks, taskOrThrow(ctx.services, id(input(params))).id);
    return { ok: true };
  }, TODO);

  // ---------------------------------------------------------------- schedules
  table.add('schedules.list', (params, ctx) => {
    const o = input(params);
    const list = ctx.services.scheduler.list({ conversationId: optId(o, 'conversationId'), ownerId: optId(o, 'ownerId') });
    const agent = ctx.scope.kind === 'agent' || (ctx.scope.kind === 'owner' && ctx.scope.agentId !== undefined);
    return (optBool(o, 'all') ?? !agent) ? list : list.filter(stillRuns); // what no longer runs reaches an agent when it asks
  }, TASKS);
  table.add('schedules.update', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'conversationId', 'active', 'spec', 'title', 'body', 'priority', 'mentions']);
    const scheduleId = id(o);
    const current = ctx.services.scheduler.get(scheduleId) ?? notFound('Schedule', { scheduleId });
    const patch: Parameters<RuntimeServices['scheduler']['update']>[1] = {};
    const active = optBool(o, 'active');
    if (active !== undefined) patch.active = active;
    const spec = optObj(o, 'spec');
    if (spec) patch.spec = spec as ScheduleSpec; // validated by the scheduler
    const conversationId = optId(o, 'conversationId');
    if (conversationId !== undefined && conversationId !== current.conversationId) patch.conversationId = movedTo(ctx.services, current, conversationId);
    // T11, owner 21.11.2026: rewording any scheduled message or an agent's reminder note (schedules/post.ts).
    const reword = { body: optText(o, 'body', { max: 100_000, multiline: true }), priority: optOneOf(o, 'priority', POST_PRIORITIES), mentions: optIds(o, 'mentions', 50) };
    if (reword.body !== undefined || reword.priority !== undefined || reword.mentions !== undefined) Object.assign(patch, rewordPost(current, reword));
    const title = optText(o, 'title', { max: 120 });
    if (title !== undefined) patch.title = title;
    return ctx.services.scheduler.update(scheduleId, patch, HUMAN_ID); // B-044: the person's pause only the person lifts
  }, MANAGE);
  /** T11: read-only next-run preview for the schedule dialog (the chat tier schedules messages). */
  table.add('schedules.preview', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['spec', 'count', 'runs']);
    const spec = optObj(o, 'spec') ?? bad('spec', 'a schedule spec ({at} | {cron} | {everyMs} | {times})');
    const options = { count: optNum(o, 'count', { min: 1, max: PREVIEW_MAX }), runs: optNum(o, 'runs', { min: 0 }) };
    return { times: previewTimes(spec as ScheduleSpec, ctx.services.clock.now(), options) };
  }, { capability: 'chat' });
  table.add('schedules.delete', (params, ctx) => {
    const scheduleId = id(input(params));
    ctx.services.scheduler.get(scheduleId) ?? notFound('Schedule', { scheduleId });
    ctx.services.scheduler.remove(scheduleId);
    return { ok: true };
  }, MANAGE);
  table.add('schedules.runNow', (params, ctx) => {
    ctx.services.scheduler.runNow(id(input(params)));
    return { ok: true };
  }, MANAGE);
}
