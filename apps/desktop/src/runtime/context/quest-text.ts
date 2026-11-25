// Quests as the agent reads them (Quests round 20.11.2026, CONTRACT "AI" and "Against forgetting and invented dates"):
// "## My quests" – one line per open quest I own, hold an open to-do in or gave, without a cap (title · id · the person's
// open to-dos with the next one · mine · each colleague's count · my next note), then "Other:" my open to-dos without a
// quest and the lone ones I gave (five and a count), and one line for my notes and posts outside them; the quest as it
// stands now (the snapshot: done-when, every owner's open to-dos with their waits and since when, the person's done ones
// counted, the thread lines since my last line there) – for the turn's own work, the morning pass, tasks.list and under a
// reminder's note (reminderSnapshot); the person's lines a turn starts from (personLinesOf) and "## Related open work" –
// the open work of others the newest is about (tasks/related.ts). A time is printed only on the person's to-dos: work
// among agents starts now (VERGESSEN.md finding 1).
// An "Only me" to-do reads "only me" in its state: the person does it themselves; I see it and help around it.
// Owns: those renderings and which work counts as mine here. Never: writes a task, caps the quest list, or prints a time
// on agent work.

import type { RuntimeServices } from '../contracts.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import type { Message } from '../../shared/model/chat.ts';
import { isPersonId } from '../../shared/model/people.ts';
import { isFinished, isPaused, stillRuns, type Schedule, type Task, type TaskView } from '../../shared/model/tasks.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { namesFor, waitWords, type NoteNames } from '../tasks/names.ts';
import { relatedWork } from '../tasks/related.ts';
import { dayName, dueText, todoWhen } from './time.ts';
import { taskAge, renderTask } from './task-text.ts';

export type QuestDeps = Pick<RuntimeServices, 'tasks' | 'clock' | 'org' | 'settings'> & Partial<Pick<RuntimeServices, 'chats' | 'people' | 'scheduler' | 'db'>>;

/** "Other:" shows this many to-dos, then a count. */
const OTHER_MAX = 5;
/** Thread lines a snapshot shows at most (the newest). */
const THREAD_MAX = 8;
/** Lines read from each thread for a snapshot. */
const THREAD_READ = 50;

/** Whose a task is: an agent id, 'human' or a colleague's per_… id. */
export function ownerOf(task: Pick<Task, 'assigneeKind' | 'assigneeId'>): string {
  return task.assigneeKind === 'agent' ? task.assigneeId ?? '' : task.assigneeId ?? HUMAN_ID;
}

/** A quest – also an older top-level row that holds to-dos. */
export const isQuest = (task: Pick<TaskView, 'kind' | 'steps'>): boolean => task.kind === 'quest' || (task.steps?.length ?? 0) > 0;

/** My open work: the quests I own, hold an open to-do in or gave (open ones, oldest first), and my lone to-dos and the lone ones I gave. */
export function myWork(s: QuestDeps, agentId: string): { quests: TaskView[]; other: TaskView[] } {
  const own = s.tasks.openFor(agentId);
  const given = s.tasks.list({ givenBy: agentId, includeSteps: true, limit: 200 });
  const ids = new Set<string>();
  const other: TaskView[] = [];
  for (const task of [...own, ...given]) {
    if (isQuest(task)) ids.add(task.id);
    else if (task.parentId) ids.add(task.parentId);
    else if (!other.some((item) => item.id === task.id)) other.push(task);
  }
  const quests = [...ids].map((id) => s.tasks.get(id)).filter((quest): quest is TaskView => !!quest && !isFinished(quest.status))
    .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
  return { quests, other };
}

/** My active reminders by the task they are about (the next time each fires), and the rest of my active schedules. */
function myNotes(s: QuestDeps, agentId: string): { byTask: Map<string, number>; rest: Schedule[] } {
  const byTask = new Map<string, number>();
  const rest: Schedule[] = [];
  let all: Schedule[] = [];
  try { all = s.scheduler?.list({ ownerId: agentId }).filter(stillRuns) ?? []; } catch { all = []; }
  for (const schedule of all) {
    if (schedule.kind === 'reminder' && schedule.taskId && schedule.nextAt !== undefined) {
      byTask.set(schedule.taskId, Math.min(byTask.get(schedule.taskId) ?? Infinity, schedule.nextAt));
    } else rest.push(schedule);
  }
  return { byTask, rest };
}

/** The open to-do the person does next: the earliest time, else the oldest – "title, Tue 24 Nov 11:00". */
function nextOfPerson(open: Task[], zone: string, now: number): string {
  const next = [...open].sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.createdAt - b.createdAt)[0];
  return `${excerpt(next.title, 60)}${next.at !== undefined ? `, ${todoWhen({ at: next.at, minutes: next.minutes }, zone, now)}` : ''}`;
}

/** One quest as a line of "## My quests" (see the header). */
export function questLine(quest: TaskView, me: string, names: NoteNames, now: number, nextNote?: number): string {
  const open = quest.steps.filter((todo) => !isFinished(todo.status));
  const parts = [excerpt(quest.title, 100), quest.id, taskAge(quest, names.zone, now)];
  const owner = ownerOf(quest);
  if (owner !== me) parts.push(`${names.nameOf(owner)}'s`);
  const person = quest.steps.filter((todo) => ownerOf(todo) === HUMAN_ID);
  const personOpen = open.filter((todo) => ownerOf(todo) === HUMAN_ID);
  if (personOpen.length) parts.push(`person: ${personOpen.length} open (next: ${nextOfPerson(personOpen, names.zone, now)})`);
  else if (person.length) parts.push(`person: all ${person.length} done`);
  const mine = open.filter((todo) => ownerOf(todo) === me);
  if (mine.length) {
    const waits = mine.filter((todo) => todo.status === 'waiting').sort((a, b) => (a.waitingOn?.since ?? 0) - (b.waitingOn?.since ?? 0));
    const oldest = waits[0];
    parts.push(`me: ${mine.length}${oldest ? ` (${waits.length} wait${waits.length === 1 ? 's' : ''}, on ${waitWords(oldest, names)} since ${dayName(oldest.waitingOn?.since ?? oldest.createdAt, names.zone, now)})` : ''}`);
  }
  const others = new Map<string, number>();
  for (const todo of open) { const who = ownerOf(todo); if (who !== me && who !== HUMAN_ID) others.set(who, (others.get(who) ?? 0) + 1); }
  if (others.size) parts.push([...others].map(([who, count]) => `${names.nameOf(who)} ${count}`).join(', '));
  if (!open.length) parts.push('no open to-dos');
  parts.push(nextNote !== undefined ? `next note ${dueText(nextNote, names.zone, now)}` : 'no next note');
  return `- ${parts.join(' · ')}`;
}

/**
 * A to-do's state in a few words: a person's time, a wait with since when, "after …", else since when it stands open –
 * "only me, …" first on an open "Only me" one (the person does it; I help around it).
 */
export function todoState(todo: Task, names: NoteNames, now: number): string {
  if (todo.status === 'done' || todo.status === 'dropped') return todo.status;
  return todo.private ? `only me, ${openState(todo, names, now)}` : openState(todo, names, now);
}

function openState(todo: Task, names: NoteNames, now: number): string {
  if (isPaused(todo)) return `paused by ${names.nameOf(todo.waitingOn?.who ?? HUMAN_ID)}`;
  const wait = todo.status === 'waiting' ? todo.waitingOn : undefined;
  if (wait?.on === 'task') return `after ${(wait.ids ?? []).join(', ') || 'another to-do'}`;
  if (wait) return `waits on ${waitWords(todo, names)} since ${dayName(wait.since, names.zone, now)}: ${excerpt(wait.why, 100)}`;
  const person = todo.assigneeKind !== 'agent';
  if (person && todo.at !== undefined) return `at ${todoWhen({ at: todo.at, minutes: todo.minutes }, names.zone, now)}`;
  return `open since ${dayName(todo.createdAt, names.zone, now)}`;
}

/** "## My quests" (see the header). */
export function myQuestsSection(s: QuestDeps, agentId: string, zone: string): string {
  const now = s.clock.now();
  const names = namesFor(s, zone);
  const { quests, other } = myWork(s, agentId);
  const notes = myNotes(s, agentId);
  const covered = new Set<string>();
  const lines = quests.map((quest) => {
    const ids = [quest.id, ...quest.steps.map((todo) => todo.id)];
    ids.forEach((id) => covered.add(id));
    const next = Math.min(...ids.map((id) => notes.byTask.get(id) ?? Infinity));
    return questLine(quest, agentId, names, now, Number.isFinite(next) ? next : undefined);
  });
  if (other.length) {
    lines.push('Other:');
    for (const task of other.slice(0, OTHER_MAX)) {
      covered.add(task.id);
      const owner = ownerOf(task);
      lines.push(`- ${task.id} · ${owner === agentId ? '' : `${names.nameOf(owner)} · `}${todoState(task, names, now)} · ${excerpt(task.title, 100)} · ${taskAge(task, zone, now)}`);
    }
    if (other.length > OTHER_MAX) lines.push(`(+${other.length - OTHER_MAX} more – tasks.list)`);
  }
  for (const task of other) covered.add(task.id);
  const rest = [...notes.rest.map((schedule) => schedule.nextAt), ...[...notes.byTask].filter(([id]) => !covered.has(id)).map(([, at]) => at)]
    .filter((at): at is number => at !== undefined);
  if (rest.length) lines.push(`My other notes and posts: ${rest.length}, the next ${dueText(Math.min(...rest), zone, now)} (tasks.remind list).`);
  return ['## My quests', ...(lines.length ? lines : ['Nothing open of mine.'])].join('\n');
}

/** The thread lines of `ids` since my last line or my read mark there (not mine, no event line), the newest THREAD_MAX. */
function threadSince(s: QuestDeps, ids: readonly string[], titles: ReadonlyMap<string, string>, readerId: string, names: NoteNames, now: number): string[] {
  if (!s.chats) return [];
  const found: Message[] = [];
  for (const id of ids) {
    try {
      if (!s.chats.get(id)) continue;
      const member = s.chats.members(id).find((item) => item.memberId === readerId && !item.leftAt);
      const recent = s.chats.messages(id, { limit: THREAD_READ });
      const from = Math.max(member?.readSeq ?? 0, ...recent.filter((line) => line.authorId === readerId).map((line) => line.seq));
      found.push(...recent.filter((line) => line.seq > from && line.kind !== 'status' && !line.silent && line.state !== 'streaming' && line.authorId !== readerId));
    } catch { /* a thread that cannot be read adds nothing */ }
  }
  const lines = found.sort((a, b) => a.createdAt - b.createdAt).map((line) =>
    `  - ${dueText(line.createdAt, names.zone, now)} · ${names.nameOf(line.authorId)} on "${excerpt(titles.get(line.conversationId) ?? '', 60)}" (${line.conversationId}): ${excerpt(line.body, 300)}`);
  return lines.length > THREAD_MAX ? [`  (+${lines.length - THREAD_MAX} earlier)`, ...lines.slice(-THREAD_MAX)] : lines;
}

/**
 * The quest as it stands now (a to-do in a quest: its quest; a lone to-do: itself): done-when, every owner's open to-dos
 * with their state, the person's done ones counted, and the thread lines since my last line there.
 */
export function questSnapshot(s: QuestDeps, task: TaskView, readerId: string, zone: string): string[] {
  const now = s.clock.now();
  const names = namesFor(s, zone);
  const quest = isQuest(task) ? task : task.parentId ? s.tasks.get(task.parentId) ?? task : task;
  const owner = ownerOf(quest);
  const head = `${excerpt(quest.title, 120)} · ${quest.id}${owner === readerId ? '' : ` · ${names.nameOf(owner)}'s`}`;
  if (!isQuest(quest)) {
    const news = threadSince(s, [quest.id], new Map([[quest.id, quest.title]]), readerId, names, now);
    return [`${head} · ${todoState(quest, names, now)}`, `Thread since my last line: ${news.length ? '' : 'nothing new.'}`.trimEnd(), ...news];
  }
  const lines = [`${head} – done when ${quest.doneWhen?.trim().replace(/\.+$/, '') || 'not set yet'}.`]; // "…abgegeben." ends once (real run 20.11.)
  const todos = quest.steps;
  const byOwner = new Map<string, Task[]>();
  for (const todo of todos) if (!isFinished(todo.status)) byOwner.set(ownerOf(todo), [...(byOwner.get(ownerOf(todo)) ?? []), todo]);
  const todoLine = (todo: Task) => `  - "${excerpt(todo.title, 100)}" · ${todo.id} · ${todoState(todo, names, now)} · ${taskAge(todo, zone, now)}`;
  const personDone = todos.filter((todo) => ownerOf(todo) === HUMAN_ID && todo.status === 'done').sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
  const last = personDone.at(-1);
  const personOpen = byOwner.get(HUMAN_ID) ?? [];
  lines.push(`Person: ${personOpen.length} open${personDone.length ? `, ${personDone.length} done (last: "${excerpt(last!.title, 60)}", ${dueText(last!.completedAt ?? last!.updatedAt, zone, now)})` : ''}`, ...personOpen.map(todoLine));
  const mine = byOwner.get(readerId) ?? [];
  lines.push(`Me: ${mine.length ? '' : '–'}`.trimEnd(), ...mine.map(todoLine));
  for (const [who, list] of byOwner) {
    if (who === HUMAN_ID || who === readerId) continue;
    lines.push(`${names.nameOf(who)}${isPersonId(who) ? ' (person)' : ''}:`, ...list.map(todoLine));
  }
  const ids = [quest.id, ...todos.filter((todo) => !isFinished(todo.status)).map((todo) => todo.id)];
  const news = threadSince(s, ids, new Map([quest, ...todos].map((item) => [item.id, item.title])), readerId, names, now);
  lines.push(`Thread since my last line: ${news.length ? '' : 'nothing new.'}`.trimEnd(), ...news);
  return lines;
}

/** The snapshot's label: a to-do in a quest shows its quest, anything else itself. */
const nowLabel = (task: TaskView): string => (!isQuest(task) && task.parentId ? 'Its quest now:' : 'Now:');

/** "## Current quest" / "## Current to-do": the turn's work whole (task-text.ts) and its quest as it stands now. */
export function currentWorkSection(s: RuntimeServices, taskId: string, readerId: string, zone: string): string {
  const task = s.tasks.get(taskId);
  if (!task) return '';
  const whole = renderTask(s, task, zone, isQuest(task) ? '## Current quest' : '## Current to-do');
  return [whole, nowLabel(task), ...questSnapshot(s, task, readerId, zone)].join('\n');
}

/**
 * The quest as it stands now under a reminder's note (FIXREAL 5, 20.11.2026: a resumed session's live block left out the
 * unchanged "## Current quest", so the note fired without it): part of the note's own text, so the turn has it whatever
 * its live block keeps. Undefined when the task is gone.
 */
export function reminderSnapshot(s: QuestDeps, taskId: string, readerId: string, zone: string): string | undefined {
  const task = s.tasks.get(taskId);
  return task ? [nowLabel(task), ...questSnapshot(s, task, readerId, zone)].join('\n') : undefined;
}

/** The lines of a person this turn takes in its chat (after my read mark there), oldest first – the turn started from them. */
export function personLinesOf(s: Pick<RuntimeServices, 'chats'>, agentId: string, conversationId: string | undefined): Message[] {
  if (!conversationId) return [];
  try {
    const member = s.chats.members(conversationId).find((item) => item.memberId === agentId && !item.leftAt);
    if (!member) return [];
    return s.chats.messages(conversationId, { afterSeq: member.readSeq, limit: 200 })
      .filter((line) => line.authorKind === 'human' && line.kind === 'text' && line.state !== 'streaming' && line.body.trim());
  } catch { return []; }
}

/** The newest of them – the line the turn started from. */
export function personLineOf(s: Pick<RuntimeServices, 'chats'>, agentId: string, conversationId: string | undefined): Message | undefined {
  return personLinesOf(s, agentId, conversationId).at(-1);
}

/** "## Related open work": the three open quests or lone to-dos of others the person's new line is about (tasks/related.ts). */
export function relatedSection(s: QuestDeps & Pick<RuntimeServices, 'chats' | 'db'>, agentId: string, conversationId: string | undefined, zone: string): string {
  const line = personLineOf(s, agentId, conversationId);
  if (!line) return '';
  const { quests, other } = myWork(s, agentId);
  const mine = new Set([...quests.map((quest) => quest.id), ...other.map((task) => task.id)]);
  const hits = relatedWork(s, line.body, 3, (row) => row.assigneeId === agentId || mine.has(row.id));
  if (!hits.length) return '';
  const names = namesFor(s, zone);
  return ['## Related open work', ...hits.map((hit) => `- ${excerpt(hit.title, 100)} · ${hit.id} · ${hit.kind} of ${names.nameOf(ownerOf(hit))}`)].join('\n');
}
