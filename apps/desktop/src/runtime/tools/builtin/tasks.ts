// The task tools (Quests round 20.11.2026: four commands instead of twenty – CONTRACT "AI"): tasks.add and tasks.update
// here, tasks.list (tasks-list.ts) and tasks.remind (tasks-remind.ts). tasks.add puts a to-do into a quest – for me, a
// colleague, the person or "team" – or starts a quest (quest "new"); tasks.update keeps one true: words, the person's
// time, its quest, its owner (= give), a wait in one line, open again, done (with its result – the one verification against
// done-when runs as before) or dropped. Every capability of the old commands stays: give is `for`, finish is status done
// with result, a preparation is notes, an order is `after`, a person's to-do with a time is `at`, an appointment for the
// person is their to-do with a time. A time on agent work is refused in code (tasks-util.ts AGENT_TIME); one on a person's
// to-do stands when their words this turn name it (on one to-do per quest) or I am their assistant (personTimeRefused); a quest holds no time
// (QUEST_TIME – its to-dos carry the times); a day without a clock takes no length (DAY_LENGTH – it would ring at
// midnight). Without an id or quest, the task my turn is about is the default only when the turn began on it – its
// thread, a note or wake on it (tasks-util.ts turnTask); a turn from a chat line names one. A to-do made in a
// turn a person's line started carries that line in its thread (tasks-util.ts keepPersonLine). The same open ask to the
// same person is made once. R2.13 (measured 20.11.: of 304 old finishes 69 were quiet, 47 had follow-ups, 19 alsoHandled):
// a close can be quiet and carry its side work (alsoHandled); its follow-ups are what I set up in the same turn – my new
// to-dos and reminders –, listed with the result by themselves; `priority` (normal · high · urgent) on add and update.
// An "Only me" task is the person's to do: I add notes, a time, its quest around it, but never give it to an agent or
// close it, nor its quest while it is open (tasks/service.ts onlyMeLine, refused here before anything changes).
// Owns: these two tool definitions, the wait line's reading and the dedupe of an ask. Never: an alias of an old argument
// name, or a model or a mode on a task (both are the agent's own).

import type { ToolContext, ToolDef } from '../types.ts';
import { EFFORT_PROPERTY, WHEN_PROPERTY, failure, json } from '../types.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import type { UiBlock } from '../../../shared/blocks/catalog.ts';
import { isFinished, type Evidence, type Task, type TaskResult, type TaskWait } from '../../../shared/model/tasks.ts';
import { readChecklist, settleItems, type PlanItem } from '../../../shared/model/task-plan.ts';
import { askBackLine, droppedAsk } from '../../tasks/cards.ts';
import type { Effort } from '../../../shared/model/providers.ts';
import { onlyMeLine, type TaskPatch } from '../../tasks/service.ts';
import { approveNotes, normalizeAskWidget } from '../../tasks/widgets.ts';
import { askTarget } from '../../people/ask-target.ts';
import { chatIfAny, clip, defineTool, internal } from './util.ts';
import { isQuest, ownerOf } from '../../context/quest-text.ts';
import { AGENT_TIME, DAY_LENGTH, QUEST_TIME, answer, isPerson, keepPersonLine, personTimeRefused, questOf, receiverOf, requireTask, timeOf, turnTask } from './tasks-util.ts';
import { isDayOnly } from '../../../shared/model/day-settings.ts';
import { namesFor } from '../../tasks/names.ts';
import { similarOpen } from '../../tasks/related.ts';
import { nextFollowUp } from '../../tasks/follow-up.ts';
import { profileZone } from '../../context/time.ts';
import { listTool } from './tasks-list.ts';
import { remindTool } from './tasks-remind.ts';

const TASK_ID = /\btask_[a-z0-9]+\b/gi;
const ASK_TYPES_TEXT = 'record, upload, choice, form, confirm, checklist, review or app';

/** My still open ask to the same person with the same title, ask type and quest (one is enough). */
function openAsk(ctx: ToolContext, title: string, at: { owner: string; parentId?: string; type?: string }) {
  const row = ctx.services.db.get<{ id: string }>(
    `SELECT id FROM tasks WHERE created_by = ? AND assignee_kind = 'human' AND status IN ('open', 'waiting') AND parent_id IS ?
       AND COALESCE(assignee_id, 'human') = ? AND lower(trim(title)) = ? AND COALESCE(json_extract(widget, '$.type'), '') = ? LIMIT 1`,
    [ctx.agent.id, at.parentId ?? null, at.owner, title.trim().toLowerCase(), at.type ?? '']);
  return row ? ctx.services.tasks.get(row.id) : undefined;
}

/** The ask block as stored, with the title as its question where it has none; a string says why not. */
function askOf(raw: Record<string, unknown>, title: string): UiBlock | string {
  const normal = normalizeAskWidget(raw);
  if (typeof normal === 'string') return normal;
  if (normal.type === 'choice' && !normal.question) normal.question = title;
  if (normal.type === 'confirm' && !normal.instructions) normal.instructions = title;
  return normal;
}

/** The wait a line names: task ids → after them; "<name>: …" of a member → on them; else something outside. */
export function waitOf(ctx: ToolContext, line: string): Omit<TaskWait, 'since'> | string {
  const why = line.trim();
  if (!why) return 'A wait names what it waits on, in one line.';
  const ids = [...new Set(why.match(TASK_ID) ?? [])];
  if (ids.length) {
    for (const id of ids) requireTask(ctx, id);
    return { on: 'task', ids, why };
  }
  const head = /^([^:–\n]{1,60})\s*[:–]/.exec(why)?.[1]?.trim();
  const who = head ? receiverOf(ctx, head) : undefined;
  if (typeof who === 'string' && who !== ctx.agent.id && who !== 'team') return { on: 'who', who, why };
  return { on: 'outside', why };
}

const PLAN_PROPERTY = {
  type: 'array', maxItems: 20, description: 'Checklist: ordered points with their checked state. Update replaces the entire list; [] clears it. A point handed over with for becomes its own linked task and is checked by itself when that task is done.',
  items: { type: 'object', additionalProperties: false, required: ['text', 'done'], properties: {
    id: { type: 'string', maxLength: 20, description: 'The point\'s id as tasks.list shows it (p1 …), to keep it; new points get one.' },
    text: { type: 'string', minLength: 1, maxLength: 298 }, done: { type: 'boolean' },
    for: { type: 'string', description: 'Hand this point over: a colleague, "person" or a person by name or id – it becomes their own task, linked to this one.' },
  } },
};

/** A checklist point as the tool takes it. */
type ToolItem = PlanItem & { for?: string };

/** The points as stored items (their handing over follows once the list stands: handOver). */
const itemsOf = (plan: readonly ToolItem[]): PlanItem[] => plan.map(({ id, text, done }) => ({ ...(id ? { id } : {}), text, done }));

/**
 * The points of `plan` with a `for` go to that owner – their own task, linked – once the checklist of `taskId` stands;
 * one to the task's own owner stays a plain point. A string says why a point was not handed over.
 */
async function handOver(ctx: ToolContext, taskId: string, plan: readonly ToolItem[]): Promise<string[]> {
  const handed = plan.filter((item) => item.text.trim()).map((item, index) => ({ item, index })).filter(({ item }) => item.for?.trim());
  if (!handed.length) return [];
  const task = ctx.services.tasks.get(taskId)!;
  const stored = readChecklist(task.ledger);
  const problems: string[] = [];
  for (const { item, index } of handed) {
    const point = stored[index];
    const to = receiverOf(ctx, item.for);
    if (!point) continue;
    if (typeof to !== 'string') { problems.push(`${point.id}: ${to.refused}`); continue; }
    if (to === ownerOf(task) && !point.taskId) continue;
    try {
      await ctx.services.tasks.handOverItem(taskId, point.id, to, ctx.agent.id, ctx.conversationId ? { givenIn: ctx.conversationId } : {});
    } catch (error) { problems.push(`${point.id}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return problems;
}
const WAIT_PROPERTY = { type: 'string', description: 'What it waits on, in one line: a name or task id first when it waits on them.' };
const UNTIL_PROPERTY = { ...WHEN_PROPERTY, description: `When to follow up on the wait, not a calendar time. An outside wait defaults to tomorrow at 09:00 local. ${String(WHEN_PROPERTY.description)}` };

function readWait(ctx: ToolContext, line: string, until?: string, old?: TaskWait) {
  const wait = waitOf(ctx, line);
  if (typeof wait === 'string') return wait;
  const time = timeOf(ctx, until, 'until');
  if ('refused' in time) return time.refused;
  const same = old?.on === wait.on && old.why === wait.why;
  const at = time.at ?? (same ? old?.until : undefined);
  if (at !== undefined) return { wait: { ...wait, until: at, ...(same && old?.until === at && old.followedUp ? { followedUp: true } : {}) } };
  if (wait.on !== 'outside') return { wait };
  const zone = profileZone(ctx.services);
  const date = nextFollowUp(ctx.services.clock.now(), zone);
  return { wait: { ...wait, until: date }, followUp: 'Default follow-up: tomorrow at 09:00 local.' };
}

/** How urgent a to-do is, in words (Task.priority 0 · 1 · 2). */
const PRIORITIES = ['normal', 'high', 'urgent'] as const;
type Priority = (typeof PRIORITIES)[number];
const PRIORITY_PROPERTY = { type: 'string', enum: [...PRIORITIES], description: 'How urgent it is for whoever does it.' } as const;
const priorityOf = (word: Priority | undefined): Task['priority'] | undefined => (word === undefined ? undefined : PRIORITIES.indexOf(word) as Task['priority']);

/**
 * What I set up in this turn besides `task` – my new open to-dos (not inside it) and my reminders – listed with its
 * result as its follow-ups (R2.13); none when the turn's start is unknown.
 */
function followUpsOf(ctx: ToolContext, task: Task): TaskResult['followUps'] {
  let since: number | undefined;
  try { since = ctx.services.runs.get(ctx.runId)?.startedAt; } catch { since = undefined; }
  if (since === undefined) return undefined;
  const todos = ctx.services.db.all<{ id: string; title: string }>(
    `SELECT id, title FROM tasks WHERE created_by = ? AND created_at >= ? AND id <> ? AND parent_id IS NOT ? AND status IN ('open', 'waiting')
     ORDER BY created_at LIMIT 10`, [ctx.agent.id, since, task.id, task.id]);
  const notes = ctx.services.db.all<{ id: string; title: string }>(
    `SELECT id, title FROM schedules WHERE owner_id = ? AND kind = 'reminder' AND active = 1 AND created_at >= ? ORDER BY created_at LIMIT 10`, [ctx.agent.id, since]);
  const items = [...todos.map((row) => ({ taskId: row.id, label: clip(row.title, 120) })), ...notes.map((row) => ({ scheduleId: row.id, label: clip(row.title, 120) }))];
  return items.length ? items : undefined;
}

type AddArgs = { title: string; for?: string; quest?: string; at?: string; minutes?: number; notes?: string; ask?: Record<string, unknown>; after?: string[]; waiting?: string; until?: string; plan?: ToolItem[]; doneWhen?: string; effort?: Effort; priority?: Priority; again?: string };

const addTool = defineTool<AddArgs>({
  name: 'tasks.add',
  description: 'Puts a to-do into a quest for me, a colleague or the person, with a time when it has one. A goal with several steps gets its own quest (quest: "new"); what the person does stays theirs, and I hand them only what I could not do myself. An ask I answer with questions is unfinished: its to-do waits on the person.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 300, description: 'What is to be done, in the words of whoever asked for it.' },
      for: { type: 'string', description: '"me" (default; with ask: the person of this chat), "person", a colleague or a person by name or id, or "team" – Autark picks one owner now.' },
      quest: { type: 'string', description: 'The quest it goes into (a to-do\'s id means its quest), or "none". "new" makes this item itself the quest: its title is the goal, not a step, it holds no time, and its to-dos follow with further tasks.add {quest: <its id>}. Default: the quest my turn is about when it began in that quest\'s thread or from a note or wake on it; a line in a chat names none.' },
      at: { ...WHEN_PROPERTY, description: `When the person does it, as their own words or their assistant set it; work among agents starts now. ${String(WHEN_PROPERTY.description)}` },
      minutes: { type: 'integer', minimum: 1, maximum: 1440, description: 'How long the person needs; their calendar shows it.' },
      notes: { type: 'string', maxLength: 20_000, description: "What is to be done now and what whoever takes it on cannot find without me: the person's words, the facts, what good looks like." },
      ask: { type: 'object', properties: { type: { type: 'string' } }, required: ['type'], description: `How the person answers: an ask block – ${ASK_TYPES_TEXT} – with its fields (ui.help shows them).` },
      after: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'The to-dos it comes after; it waits until the last of them ends.' },
      waiting: WAIT_PROPERTY,
      until: UNTIL_PROPERTY,
      plan: PLAN_PROPERTY,
      doneWhen: { type: 'string', maxLength: 2000, description: 'The outcome in one line – what exists or changed when it is done.' },
      effort: { ...EFFORT_PROPERTY, description: "The effort a colleague's work runs at from its first turn." },
      priority: PRIORITY_PROPERTY,
      again: { type: 'string', description: 'Run again: a finished task\'s id – it comes back as a new one under title, with its notes, done-when, owner and checklist, every point unchecked and handed-over points with the same owners. Other fields are not read then.' },
    },
    required: ['title'], additionalProperties: false,
  },
  category: 'think',
  describe: (args, ctx) => internal(`${args.again ? 'Run again' : args.quest === 'new' ? 'Start quest' : 'Add to-do'} "${clip(args.title, 80)}"${args.for ? ` for ${args.for}` : ''}`, ctx.conversationId),
  async run(args, ctx) {
    if (args.again !== undefined) {
      const source = requireTask(ctx, args.again);
      const copy = await ctx.services.tasks.runAgain(source.id, ctx.agent.id, { title: args.title });
      return json(answer(ctx, copy, { again: source.id }));
    }
    const quest = args.quest?.trim() === 'new';
    if (quest && (args.at?.trim() || args.minutes !== undefined)) return failure(QUEST_TIME);
    const time = timeOf(ctx, args.at, 'at');
    if ('refused' in time) return failure(time.refused);
    if (args.until !== undefined && args.waiting === undefined) return failure('until needs a waiting line.');
    const wait = args.waiting === undefined ? undefined : readWait(ctx, args.waiting, args.until);
    if (typeof wait === 'string') return failure(wait);
    const conversationId = chatIfAny(ctx, undefined);
    let widget: UiBlock | undefined;
    let notes = args.notes?.trim() ?? '';
    if (args.ask) {
      notes = [notes, approveNotes(args.ask)].filter(Boolean).join('\n\n');
      const block = askOf(args.ask, args.title);
      if (typeof block === 'string') return failure(block);
      widget = block;
    }
    // An ask without `for` goes to the person of this chat (who wrote last), else the person who owns the organisation.
    const asked = args.for === undefined && widget ? (conversationId ? askTarget(ctx.services.db, conversationId, (ctx.services.chats.get(conversationId)?.lastSeq ?? 0) + 1, widget) : undefined) ?? HUMAN_ID : undefined;
    const to = asked ?? receiverOf(ctx, args.for);
    if (typeof to !== 'string') return failure(to.refused);
    if (widget && !isPerson(to)) return failure('An ask is how a person answers: for names a person.');
    const parentId = quest ? undefined : questOf(ctx, args.quest);
    if (isPerson(to) && !quest) { // the same ask again: the one that stands (its time included)
      const same = openAsk(ctx, args.title, { owner: to, parentId, type: widget?.type });
      if (same) return json(answer(ctx, same, { already: true }));
    }
    if (typeof time.at === 'number') {
      const refused = isPerson(to) ? personTimeRefused(ctx, to, time.at, { quest: parentId }) : AGENT_TIME;
      if (refused) return failure(refused);
    }
    if (time.day && args.minutes !== undefined) return failure(DAY_LENGTH);
    for (const after of args.after ?? []) requireTask(ctx, after);
    const task = await ctx.services.tasks.createTo({
      ...(conversationId ? { conversationId } : {}), ...(ctx.origin ? { origin: ctx.origin } : {}), ...(quest ? { kind: 'quest' as const } : {}),
      title: args.title, ...(notes ? { notes } : {}), doneWhen: args.doneWhen, parentId, dependsOn: args.after, widget, waitingOn: wait?.wait, ...(args.plan?.length ? { checklist: settleItems(itemsOf(args.plan)) } : {}),
      ...(typeof time.at === 'number' ? { at: time.at } : {}), ...(args.minutes ? { minutes: args.minutes } : {}), createdBy: ctx.agent.id,
      ...(args.priority ? { priority: priorityOf(args.priority) } : {}),
      ...(to !== ctx.agent.id && ctx.conversationId ? { givenIn: ctx.conversationId } : {}),
    }, to, to !== ctx.agent.id && !isPerson(to) && args.effort ? { route: { effort: args.effort } } : {});
    keepPersonLine(ctx, task.id);
    const notHanded = args.plan ? await handOver(ctx, task.id, args.plan) : [];
    const hit = similarOpen(ctx.services, task);
    const owner = hit?.assigneeId ? namesFor(ctx.services, profileZone(ctx.services)).nameOf(hit.assigneeId) : 'unassigned';
    return json(answer(ctx, ctx.services.tasks.get(task.id) ?? task, {
      ...(wait?.followUp ? { followUp: wait.followUp } : {}), ...(notHanded.length ? { notHandedOver: notHanded } : {}),
      ...(hit ? { similar: `Similar open: ${hit.id} ‘${clip(hit.title, 120)}’ (${owner}). Consider adding a checklist point there if it is the same work.` } : {}),
    }));
  },
});

type UpdateArgs = {
  id?: string; title?: string; notes?: string; doneWhen?: string; for?: string; at?: string; minutes?: number; quest?: string; after?: string[];
  status?: 'open' | 'waiting' | 'done' | 'dropped'; waiting?: string; until?: string; plan?: ToolItem[]; result?: string; evidence?: Evidence[]; effort?: Effort;
  priority?: Priority; quiet?: boolean; alsoHandled?: string[];
};

const updateTool = defineTool<UpdateArgs>({
  name: 'tasks.update',
  description: 'Keeps a to-do or quest true: new words, a time, another owner, a wait, done or dropped. The person acts on what it says, so the moment it stops being true I change it, and when it is done or no longer needed I close it – a quest with everything in it.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The quest or to-do; default the one my turn is about when it began in its thread or from a note or wake on it – a line in a chat names none.' },
      title: { type: 'string', minLength: 1, maxLength: 300 },
      notes: { type: 'string', maxLength: 20_000, description: 'What is to be done now; it replaces the notes.' },
      doneWhen: { type: 'string', maxLength: 2000 },
      for: { type: 'string', description: 'A new owner: "me", "person", a colleague or a person by name or id, or "team". They hear of it at once, and I hear how it ends.' },
      at: { ...WHEN_PROPERTY, description: `When the person does it, as their own words or their assistant set it; work among agents starts now. ${String(WHEN_PROPERTY.description)}` },
      minutes: { type: 'integer', minimum: 1, maximum: 1440 },
      effort: { ...EFFORT_PROPERTY, description: "With for: the effort the new owner's work runs at from its first turn." },
      quest: { type: 'string', description: 'The quest it moves into, or "none".' },
      after: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'The to-dos it comes after; it replaces the list.' },
      status: { type: 'string', enum: ['open', 'waiting', 'done', 'dropped'] },
      waiting: WAIT_PROPERTY,
      until: UNTIL_PROPERTY,
      plan: PLAN_PROPERTY,
      result: { type: 'string', maxLength: 4000, description: 'Done: what came out, in a few lines the person reads; dropped: why.' },
      evidence: {
        type: 'array', maxItems: 30, description: 'What shows the result: files, links, checks.',
        items: { type: 'object', properties: { kind: { type: 'string', enum: ['file', 'link', 'tool', 'check', 'note', 'screenshot'] }, label: { type: 'string', minLength: 1 }, ref: { type: 'string' } }, required: ['kind', 'label'] },
      },
      alsoHandled: { type: 'array', items: { type: 'string', maxLength: 300 }, maxItems: 20, description: "Done or dropped: side work and fixes I did on the way that everyone should know, one line each – our team's report." },
      quiet: { type: 'boolean', description: 'Done or dropped: I close it without a notice to anyone – nobody waits to hear about it.' },
      priority: PRIORITY_PROPERTY,
    },
    additionalProperties: false,
  },
  category: 'think',
  describe: (args, ctx) => {
    const id = args.id ?? turnTask(ctx)?.id;
    return internal(`${args.status === 'done' ? 'Finish' : args.status === 'dropped' ? 'Drop' : 'Update'} ${id ?? ''}`.trim(), id);
  },
  async run(args, ctx) {
    let current = requireTask(ctx, args.id ?? turnTask(ctx)?.id);
    const to = args.for === undefined ? undefined : receiverOf(ctx, args.for);
    if (to !== undefined && typeof to !== 'string') return failure(to.refused);
    const time = timeOf(ctx, args.at, 'at');
    if ('refused' in time) return failure(time.refused);
    const ownerAfter = to ?? ownerOf(current);
    if (isQuest(current) && (typeof time.at === 'number' || args.minutes !== undefined)) return failure(QUEST_TIME);
    const into = args.quest === undefined ? current.parentId : args.quest.trim() === 'none' ? undefined : questOf(ctx, args.quest); // its quest after this call
    if (typeof time.at === 'number') { // on the person's to-do the time it already has stands as it is
      const refused = !isPerson(ownerAfter) ? AGENT_TIME : time.at === current.at ? undefined : personTimeRefused(ctx, ownerAfter, time.at, { quest: into, id: current.id });
      if (refused) return failure(refused);
    }
    // A day without a clock takes no length – neither with it nor later on a to-do that stands as a day (isDayOnly).
    const dayOnly = time.day === true || (time.at === undefined && isDayOnly(current, profileZone(ctx.services)));
    if (dayOnly && args.minutes !== undefined) return failure(DAY_LENGTH);
    const ending = args.status === 'done' || args.status === 'dropped';
    if (ending && !args.result?.trim()) return failure('A to-do or quest I close says in result what came out, or why it is no longer needed.');
    // "Only me" (tasks/service.ts onlyMeLine): never to an agent or the team, never closed by me – nor its quest while it is open
    if (current.private && ((typeof to === 'string' && !isPerson(to)) || ending)) return failure(onlyMeLine());
    const held = ending ? current.steps?.find((todo) => todo.private && !isFinished(todo.status)) : undefined;
    if (held) return failure(onlyMeLine(held.title));
    const patch: TaskPatch = {};
    if (args.plan !== undefined) patch.checklist = itemsOf(args.plan);
    if (args.title !== undefined) patch.title = args.title;
    if (args.notes !== undefined) patch.notes = args.notes;
    if (args.doneWhen !== undefined) patch.doneWhen = args.doneWhen;
    if (time.at !== undefined) patch.at = time.at;
    if (args.minutes !== undefined) patch.minutes = args.minutes;
    else if (time.day && current.minutes !== undefined) patch.minutes = null; // the length went with the clock time the day replaces
    if (args.priority !== undefined) patch.priority = priorityOf(args.priority);
    if (args.quest !== undefined) {
      const target = into ? ctx.services.tasks.get(into) : undefined;
      if (target && target.kind !== 'quest') ctx.services.tasks.update(target.id, { kind: 'quest' }, ctx.agent.id); // a lone to-do named as the place becomes a quest, as on add
      patch.parentId = into ?? null;
    }
    if (args.after !== undefined) { for (const after of args.after) requireTask(ctx, after); patch.dependsOn = args.after; }
    let followUp: string | undefined;
    if (args.until !== undefined && (ending || args.status === 'open')) return failure('until needs a waiting task.');
    if (args.waiting !== undefined || args.status === 'waiting' || args.until !== undefined) {
      const line = args.waiting ?? current.waitingOn?.why;
      if (!line) return failure('A wait names what it waits on, in one line (waiting).');
      const wait = readWait(ctx, line, args.until, current.waitingOn);
      if (typeof wait === 'string') return failure(wait);
      patch.status = 'waiting';
      patch.waitingOn = wait.wait;
      followUp = wait.followUp;
    } else if (args.status === 'open') patch.status = 'open';
    if (Object.keys(patch).length) current = ctx.services.tasks.update(current.id, patch, ctx.agent.id);
    if (typeof to === 'string' && to !== ownerOf(current)) {
      current = await ctx.services.tasks.give(current.id, to, ctx.agent.id, { ...(args.effort ? { effort: args.effort } : {}), ...(ctx.conversationId ? { givenIn: ctx.conversationId } : {}) });
    }
    const notHanded = args.plan && !ending ? await handOver(ctx, current.id, args.plan) : [];
    if (args.plan?.some((item) => item.for) && !ending) current = requireTask(ctx, current.id); // the items now name their tasks
    let askBack: string | undefined;
    if (ending) {
      const alsoHandled = (args.alsoHandled ?? []).map((line) => line.trim()).filter(Boolean);
      const followUps = followUpsOf(ctx, current);
      current = ctx.services.tasks.finish(current.id, {
        status: args.status as 'done' | 'dropped', summary: args.result!.trim(), evidence: args.evidence ?? [],
        ...(alsoHandled.length ? { alsoHandled } : {}), ...(followUps ? { followUps } : {}), ...(args.quiet ? { quiet: true } : {}),
      }, ctx.agent.id);
      // P7: my own ask to the person dropped without their word asks me back here (cards.ts askDropped asks the others)
      if (droppedAsk(current, ctx.agent.id) && current.createdBy === ctx.agent.id) askBack = askBackLine(ctx.services, current, ctx.agent.id);
    }
    return json(answer(ctx, current, { ...(followUp ? { followUp } : {}), ...(notHanded.length ? { notHandedOver: notHanded } : {}), ...(askBack ? { askBack } : {}) }));
  },
});

export const taskTools: ToolDef[] = [addTool, updateTool, listTool, remindTool];
