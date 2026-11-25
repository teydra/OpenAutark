// tasks.list (Quests round 20.11.2026, one reader for the work instead of tasks.list, tasks.get and the calendar's to-dos):
// without an id my quests one line each as "## My quests" shows them (context/quest-text.ts); `who` another owner's,
// the person's or everyone's quests and lone to-dos; `search` the open work a text is about (tasks/related.ts – the word
// index that finds a to-do's quest); `done` what ended in the last two weeks; with an id one quest or to-do whole – its
// notes and plan (context/task-text.ts), every to-do in its quest with who, when and since when, the finished ones, and
// its thread (context/render.ts). No time is printed on agent work.
// Owns: this tool and its line format for a lone to-do. Never: writes anything.

import type { ToolContext } from '../types.ts';
import { failure, text } from '../types.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { UNFINISHED, isFinished, type Task, type TaskFilter, type TaskView } from '../../../shared/model/tasks.ts';
import { excerpt } from '../../../shared/text/chat-names.ts';
import { isPersonId } from '../../../shared/model/people.ts';
import { profileZone, dueText } from '../../context/time.ts';
import { humanLabel, renderMessages } from '../../context/render.ts';
import { checklistSuffix, renderTask, taskAge } from '../../context/task-text.ts';
import { isQuest, myQuestsSection, ownerOf, questLine, questSnapshot, todoState } from '../../context/quest-text.ts';
import { namesFor, type NoteNames } from '../../tasks/names.ts';
import { relatedWork } from '../../tasks/related.ts';
import { defineTool, internal } from './util.ts';
import { receiverOf, requireTask } from './tasks-util.ts';

const DONE_DAYS = 14;
const DAY = 24 * 60 * 60_000;
const THREAD_LINES = 30;
const LONE_MAX = 30;

/** A lone to-do (or one found on its own) as a line: id · owner · state · title · its quest. */
function todoLine(task: Task, me: string, names: NoteNames, now: number, includeAge = true): string {
  const owner = ownerOf(task);
  return `- ${task.id} · ${owner === me ? 'me' : names.nameOf(owner)} · ${todoState(task, names, now)} · ${excerpt(task.title, 120)}${task.parentId ? ` · in ${task.parentId}` : ''}${includeAge ? ` · ${taskAge(task, names.zone, now)}` : ''}${checklistSuffix(task)}`;
}

/** One quest or to-do whole (see the header). */
function whole(ctx: ToolContext, id: string): string {
  const s = ctx.services;
  const task = requireTask(ctx, id);
  const zone = profileZone(s);
  const now = s.clock.now();
  const names = namesFor(s, zone);
  const quest = isQuest(task);
  const lines = [renderTask(s, task, zone, quest ? '## Quest' : '## To-do'), quest ? 'Now:' : task.parentId ? 'Its quest now:' : 'Now:', ...questSnapshot(s, task, ctx.agent.id, zone, true)];
  const ended = quest ? task.steps.filter((todo) => isFinished(todo.status)) : [];
  if (ended.length) lines.push('Ended:', ...ended.map((todo) => `  - "${excerpt(todo.title, 100)}" · ${todo.id} · ${names.nameOf(ownerOf(todo))} · ${todo.status} ${dueText(todo.completedAt ?? todo.updatedAt, zone, now)}`));
  const thread = s.chats.get(task.id) ? s.chats.messages(task.id, { limit: THREAD_LINES }) : [];
  const rendered = thread.length ? renderMessages({ services: s, agentId: ctx.agent.id, humanName: humanLabel(s), zone, now }, thread, { images: false }).lines : [];
  lines.push(rendered.length ? `Thread (<chat to="${task.id}"> writes there):` : `Thread: nothing yet (<chat to="${task.id}"> writes there).`, ...rendered);
  return lines.join('\n');
}

/** The owner filter `who` names ("all": none); a string says why not. */
function ownerFilter(ctx: ToolContext, who: string): Pick<TaskFilter, 'assigneeKind' | 'assigneeId'> | string | undefined {
  if (who === 'all') return undefined;
  const id = receiverOf(ctx, who);
  if (typeof id !== 'string') return id.refused;
  if (id === 'team') return 'Name me, a colleague, a person, "person" or "all".';
  if (id === HUMAN_ID || isPersonId(id)) return { assigneeKind: 'human', ...(id === HUMAN_ID ? {} : { assigneeId: id }) };
  return { assigneeKind: 'agent', assigneeId: id };
}

/** Open work as quest lines, then lone to-dos. */
function openLines(ctx: ToolContext, found: TaskView[], ownerId: string | undefined): string[] {
  const s = ctx.services;
  const zone = profileZone(s);
  const now = s.clock.now();
  const names = namesFor(s, zone);
  const ids = new Set<string>();
  const lone: TaskView[] = [];
  for (const task of found) {
    if (ownerId !== undefined && ownerOf(task) !== ownerId) continue;
    if (isQuest(task)) ids.add(task.id);
    else if (task.parentId) ids.add(task.parentId);
    else lone.push(task);
  }
  const quests = [...ids].map((id) => s.tasks.get(id)).filter((quest): quest is TaskView => !!quest && !isFinished(quest.status));
  const lines = quests.map((quest) => questLine(quest, ctx.agent.id, names, now));
  if (lone.length) lines.push('Other:', ...lone.slice(0, LONE_MAX).map((task) => todoLine(task, ctx.agent.id, names, now)));
  if (lone.length > LONE_MAX) lines.push(`(+${lone.length - LONE_MAX} more)`);
  return lines;
}

export const listTool = defineTool<{ id?: string; who?: string; search?: string; done?: boolean }>({
  name: 'tasks.list',
  description: 'Shows the work as it stands: my quests one line each, or one quest or to-do whole. With an id I see every to-do in it for me, my colleagues and the person, with who, when and since when, and its thread.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'One quest or to-do, whole.' },
      who: { type: 'string', description: '"me" (default), a colleague or a person by name or id, "person", or "all".' },
      search: { type: 'string', maxLength: 2000, description: 'Words – a line, a title – whose open work I want to find.' },
      done: { type: 'boolean', description: `What ended in the last ${DONE_DAYS} days.` },
    },
    additionalProperties: false,
  },
  category: 'read',
  describe: (args) => internal(args.id ? `Read ${args.id}` : 'List the work', args.id),
  async run(args, ctx) {
    if (args.id?.trim()) return text(whole(ctx, args.id.trim()));
    const s = ctx.services;
    const zone = profileZone(s);
    const now = s.clock.now();
    const names = namesFor(s, zone);
    const who = args.who?.trim() || (args.search ? 'all' : 'me');
    const owner = ownerFilter(ctx, who);
    if (typeof owner === 'string') return failure(owner);
    const ownerId = owner ? owner.assigneeId ?? (owner.assigneeKind === 'human' ? HUMAN_ID : undefined) : undefined;
    if (args.done) {
      const ended = s.tasks.list({ ...owner, completedSince: now - DONE_DAYS * DAY, ...(args.search ? { search: args.search } : {}), includeSteps: true, limit: 50 })
        .filter((task) => ownerId === undefined || ownerOf(task) === ownerId);
      return text(ended.length ? ended.map((task) => `${todoLine(task, ctx.agent.id, names, now, false)}${task.result ? ` – ${excerpt(task.result.summary, 160)}` : ''} · ${taskAge(task, zone, now)}`).join('\n') : 'Nothing ended in that time.');
    }
    if (args.search?.trim()) {
      const hits = relatedWork(s, args.search, 10, ownerId === undefined ? undefined : (row) => ownerOf(row) !== ownerId);
      const found = hits.map((hit) => s.tasks.get(hit.id)).filter((task): task is TaskView => !!task);
      return text(found.length ? found.map((task) => (isQuest(task) ? questLine(task, ctx.agent.id, names, now) : todoLine(task, ctx.agent.id, names, now))).join('\n') : 'No open work fits these words.');
    }
    if (who === 'me') return text(myQuestsSection(s, ctx.agent.id, zone, true));
    const found = s.tasks.list({ ...owner, status: [...UNFINISHED], includeSteps: true, limit: 500 });
    const lines = openLines(ctx, found, ownerId);
    return text(lines.length ? lines.join('\n') : 'Nothing open there.');
  },
});

