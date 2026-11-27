// The Tasks page's calls, each with its calm failure toast (Quests round 20.11.2026): the input line's to-dos
// (tasks.quickCreate – the one intake: each line stands at once as the person's, in the quest they picked and at the time
// the line or a calendar slot gave, with the files the line's + added; their assistant is woken and sorts it – or it
// goes straight to whom "Send to…" named; "Only me" stays the person's), a new quest, a tick, "Later", "Repeat", "Can't do",
// "Send to team", "Only me", "Important", "Undo last change", removing one's own to-do, a new title, a new time, moving
// a to-do into a quest, and moving a to-do on the calendar (calendar.move: its `at`). A fresh view goes into the store
// and the task cache at once; the events follow anyway.
// Owns: these calls. Never: decides what the page shows, renders, or retries a refused call.

import { signal } from '@preact/signals';
import type { ParamsOf } from '../../shared/api/methods.ts';
import type { CalendarEvent } from '../../shared/model/calendar.ts';
import type { Attachment } from '../../shared/model/chat.ts';
import type { QuickTaskTarget } from '../../shared/model/task-center.ts';
import type { Task, TaskView, TodoRepeat } from '../../shared/model/tasks.ts';
import { newId } from '../../shared/ids.ts';
import { onForYouList } from '../../shared/model/todo-later.ts';
import { calendarWindow, withEvent } from '../lib/day-store.ts';
import { rpc } from '../lib/rpc.ts';
import { removeById, tasks, todos, upsertById } from '../lib/store.ts';
import { pushToast, toastError } from '../lib/toasts.ts';
import type { LineTodo } from './input-model.ts';
import { putTask } from './task-cache.ts';
import { checkAnswer } from './todo-actions.ts';
import type { Told } from './page-model.ts';

/** A fresh view from a call: into the cache, and onto (or off) the person's list and the open work. */
export function applyTask(view: TaskView): void {
  putTask(view);
  if (onForYouList(view)) upsertById(todos, view); else removeById(todos, view.id); // a quest never (todo-later.ts)
  if (view.status === 'open' || view.status === 'waiting') upsertById(tasks, view); else removeById(tasks, view.id);
}

async function attempt<T>(call: () => Promise<T>, failed: string): Promise<T | undefined> {
  try { return await call(); } catch (error) { toastError(error, failed); return undefined; }
}

/** The assistant the line woke for the person's new to-do – its row says "<name> is sorting…" while its run is live. */
export const told = signal<Told | null>(null);

/** What the line's + set for all of its to-dos: the quest, whom they go to, "Only me", the files (on the first one). */
export interface LineExtras { quest?: string; target?: QuickTaskTarget; private?: boolean; files?: readonly Attachment[] }

/** The input line: one to-do per line at once (see the header). Answers the lines that could not be added (none: all stood). */
export async function addLines(list: readonly LineTodo[], extras: LineExtras = {}): Promise<LineTodo[]> {
  const failed: LineTodo[] = [];
  const ids: string[] = [];
  let assistant: string | undefined;
  for (const [index, todo] of list.entries()) {
    const files = index === 0 && extras.files?.length ? { attachments: extras.files.map((file) => ({ fileId: file.fileId, ...(file.name ? { name: file.name } : {}) })) } : {};
    const result = await attempt(() => rpc.call('tasks.quickCreate', {
      text: todo.title, ...(todo.at !== undefined ? { at: todo.at } : {}), ...(todo.minutes !== undefined ? { minutes: todo.minutes } : {}),
      ...(extras.quest ? { quest: extras.quest } : {}), ...(extras.target ? { target: extras.target } : {}),
      ...(extras.private !== undefined ? { private: extras.private } : {}), ...files, clientId: newId('up'),
    }), 'Could not add it');
    if (!result) { failed.push(todo); continue; }
    applyTask(result.task);
    ids.push(result.task.id);
    assistant = result.assistantId ?? assistant;
  }
  if (assistant) told.value = { agentId: assistant, at: Date.now(), ids };
  return failed;
}

/** "+" in the quest column: a quest of the person's own, named by the line. */
export async function addQuest(title: string): Promise<TaskView | undefined> {
  const quest = await attempt(() => rpc.call('tasks.create', { kind: 'quest', title }), 'Could not start the quest');
  if (quest) applyTask(quest);
  return quest;
}

/** The row's check: finishes the to-do with the answer its widget takes. False when it failed or has no check. */
export async function tick(task: Task): Promise<boolean> {
  const check = checkAnswer(task);
  if (!check) return false;
  const view = await attempt(() => rpc.call('tasks.finish', { id: task.id, clientId: newId('up'), ...(check.answer === undefined ? {} : { answer: check.answer }) }), 'Could not complete');
  if (view) applyTask(view);
  return Boolean(view);
}

/** "Later": the to-do's time moves to `until` (Undo takes it back). */
export async function later(task: Task, until: number, label: string): Promise<void> {
  const view = await attempt(() => rpc.call('todos.snooze', { id: task.id, until }), "Couldn't move it");
  if (view) { applyTask(view); pushToast({ title: `Later: ${label}` }, 3000); }
}

/** "Stop repeating" on a repeating to-do (it ends as done). */
export async function stopRepeating(task: Task): Promise<void> {
  const view = await attempt(() => rpc.call('todos.stopRepeating', { id: task.id }), 'Could not stop it');
  if (view) applyTask(view);
}

/** Repeat › Daily · Weekdays · Weekly: the to-do repeats at its time (a timer widget with the repeat; its Done moves it on). */
export async function repeatTodo(task: Task, repeat: TodoRepeat): Promise<void> {
  const view = await attempt(() => rpc.call('todos.changeWidget', { id: task.id, type: 'timer', repeat }), 'Could not make it repeat');
  if (view) applyTask(view);
}

/** "Show as …": another widget for the person's to-do (a Reminder is the timer widget). */
export async function showAs(task: Task, type: string): Promise<void> {
  const view = await attempt(() => rpc.call('todos.changeWidget', { id: task.id, type }), 'Could not switch it');
  if (view) applyTask(view);
}

/** "Can't do": declined with a reason; the one who asked hears why. */
export async function decline(task: Task, reason: string): Promise<boolean> {
  const view = await attempt(() => rpc.call('todos.decline', { id: task.id, reason, clientId: newId('up') }), 'Could not decline');
  if (view) applyTask(view);
  return Boolean(view);
}

/** "Send to team": Autark picks the owner now (tasks.give "team"). */
export async function sendToTeam(task: Task): Promise<void> {
  const view = await attempt(() => rpc.call('tasks.give', { id: task.id, to: 'team' }), 'Could not give it on');
  if (view) { applyTask(view); pushToast({ title: 'Given on – Autark picked its owner' }, 3000); }
}

type Patch = ParamsOf<'tasks.update'>['patch'];

/** One tasks.update (`guard`: with the task's rev – a concurrent change of the words is never silently overwritten). True when it stood. */
async function change(task: Task, patch: Patch, failed: string, guard = false): Promise<boolean> {
  const view = await attempt(() => rpc.call('tasks.update', { id: task.id, ...(guard ? { rev: task.rev } : {}), patch }), failed);
  if (view) applyTask(view);
  return Boolean(view);
}

/** "Only me": the person does it; the AI keeps it in view and never takes it over – or back. */
export const setOnlyMe = (task: Task, only: boolean) => change(task, { private: only }, 'Could not change it');
/** "Important": the person's to-do marked (priority 1) – or back. */
export const setImportant = (task: Task, important: boolean) => change(task, { priority: important ? 1 : 0 }, 'Could not change it');
/** The title, edited in place in the detail. */
export const rename = (task: Task, title: string) => change(task, { title }, 'Could not rename it', true);
export const setPlan = (task: Task, plan: string[]) => change(task, { plan }, 'Could not update the checklist', true);
/** The time field in the detail: a new `at` (and length), or none. */
export const setTime = (task: Task, time: { at: number | null; minutes: number | null }) => change(task, time, 'Could not set the time');
/** "Move to quest": into that quest, or out of its quest (null). */
export const moveToQuest = (task: Task, quest: string | null) => change(task, { parentId: quest }, 'Could not move it');

/** "Undo last change": the latest logged change of the task (within 24 hours) taken back. */
export async function undoLast(task: Task): Promise<void> {
  const view = await attempt(() => rpc.call('tasks.undo', { id: task.id }), 'Nothing to undo');
  if (view) { applyTask(view); pushToast({ title: 'Undone' }, 3000); }
}

/** P7: one answer for a "Waiting on you" card – every task on it hears it and stops waiting. True when it stood. */
export async function answerCard(ids: readonly string[], answer: { reply?: string; choice?: string; decline?: boolean } = {}): Promise<boolean> {
  const views = await attempt(() => rpc.call('tasks.answerCard', { ids: [...ids], ...answer }), 'Could not send the answer');
  for (const view of views ?? []) applyTask(view);
  return Boolean(views);
}

/** P7 "Later": the card rests until its follow-up (tomorrow 09:00 local unless `until`). */
export async function laterCard(ids: readonly string[], until?: number): Promise<boolean> {
  const views = await attempt(() => rpc.call('tasks.laterCard', { ids: [...ids], ...(until !== undefined ? { until } : {}) }), 'Could not put it off');
  for (const view of views ?? []) applyTask(view);
  if (views) pushToast({ title: 'Later: tomorrow 09:00' }, 3000);
  return Boolean(views);
}

/** Give a checklist item to an owner; update the holder with its new link. */
export async function handOverItem(task: Task, itemId: string, to: string): Promise<boolean> {
  const view = await attempt(() => rpc.call('tasks.handOverItem', { id: task.id, itemId, to }), 'Could not hand over the checklist item');
  if (view) applyTask(view);
  return Boolean(view);
}

/** P5 "Run again": the finished task as a new one, its checklist unticked; answers the new task. */
export async function runAgain(task: Task): Promise<TaskView | undefined> {
  const view = await attempt(() => rpc.call('tasks.runAgain', { id: task.id }), 'Could not run it again');
  if (view) applyTask(view);
  return view;
}

/** "Remove" on a to-do the person added: gone at once. */
export async function removeOwn(task: Task): Promise<void> {
  const done = await attempt(() => rpc.call('todos.remove', { id: task.id }), 'Could not remove it');
  if (done) { removeById(todos, task.id); removeById(tasks, task.id); }
}

/** Puts a calendar row into the window at once (its event follows). */
function showRow(row: CalendarEvent): void {
  const window = calendarWindow.peek();
  if (window) calendarWindow.value = withEvent(window, row);
}

/** A to-do dragged on the calendar: its `at` moves there (shown at once, back where it was when the call fails). */
export async function moveRow(row: CalendarEvent, startAt: number, endAt: number): Promise<void> {
  showRow({ ...row, startAt, endAt });
  const moved = await attempt(() => rpc.call('calendar.move', { id: row.id, startAt, endAt, rev: row.rev }), 'Could not move it');
  showRow(moved ?? row);
}
