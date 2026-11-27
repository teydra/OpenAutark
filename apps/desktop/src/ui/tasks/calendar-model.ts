// The Tasks page's calendar, pure (Quests round 20.11.2026): what one day or week shows from the calendar window
// (calendar.list rows) – connected calendars' events, the person's to-dos at their time (movable), to-dos the person
// finished at the time they were done (the logbook), on the slim AI lane the agents' notes (reminders) and what they
// finished at that time – never a time for open agent work (it starts now; CONTRACT "agent work has no time") –, and a day's
// to-dos without a time in the strip above the hours – where each sits in the grid (local wall minutes in the person's
// zone, DST-correct; overlapping blocks share the width in lanes), and the time a click or a drag means.
// Owns: these rules. Never: the store, rpc, the DOM or a clock – callers pass rows, dates, the zone and a task lookup.

import type { AgentRun, CalendarEvent } from '../../shared/model/calendar.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { isDayOnly } from '../../shared/model/day-settings.ts';
import type { Task } from '../../shared/model/tasks.ts';
import { wallOf, wallTime } from '../../shared/text/when.ts';
import { shiftDate, weekdayOf } from './when-text.ts';
import { questHue } from './page-model.ts';

export const DAY_MINUTES = 24 * 60;
/** Height of one hour in the day grid (px); the stylesheet reads it as --cal-hour. */
export const HOUR_PX = 40;
/** A drag moves a to-do by this many minutes at a time; a click takes CLICK_MIN from the quarter hour. */
export const SNAP_MIN = 15;
export const CLICK_MIN = 30;
/** A done to-do's mark in the logbook is this long on screen (it records a moment, not a span). */
const DONE_MIN = 20;

export interface Span { start: number; end: number } // minutes after local midnight

export interface CalItem {
  id: string; // the row's id (an event's, or the task's)
  kind: 'todo' | 'done' | 'event' | 'ai';
  title: string;
  span: Span;
  hue: number; // 0: no quest colour (an event, a to-do without quest)
  taskId?: string;
  who?: string; // the agent on the AI lane
  done?: true; // an agent's to-do it finished (the lane's logbook)
  row?: CalendarEvent; // the row a drag moves (the person's open to-do)
}

export interface Laned { item: CalItem; lane: number; lanes: number }

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** The instants a local day starts and ends in `tz`. */
export function dayBounds(date: string, tz: string): { start: number; end: number } {
  return { start: wallTime(date, 0, tz), end: wallTime(shiftDate(date, 1), 0, tz) };
}

/** The instant of `minute` (0–1440) on local `date` in `tz`. */
export function atMinute(date: string, minute: number, tz: string): number {
  return minute >= DAY_MINUTES ? wallTime(shiftDate(date, 1), 0, tz) : wallTime(date, clamp(Math.round(minute), 0, DAY_MINUTES - 1), tz);
}

/** Where [startAt, endAt) sits on the day `bounds`: minutes, cut at the day's edges; undefined when it is not on it. */
export function spanIn(row: { startAt: number; endAt: number }, bounds: { start: number; end: number }, tz: string): Span | undefined {
  if (row.endAt <= bounds.start || row.startAt >= bounds.end) return undefined;
  const start = row.startAt <= bounds.start ? 0 : wallOf(row.startAt, tz).minutes;
  const end = row.endAt >= bounds.end ? DAY_MINUTES : wallOf(row.endAt, tz).minutes;
  return { start, end: Math.max(end, start) };
}

/** A click at `minute`: CLICK_MIN minutes from the quarter hour it falls in (inside the day). */
export function clickSpan(minute: number): Span {
  const start = clamp(Math.floor(minute / 15) * 15, 0, DAY_MINUTES - CLICK_MIN);
  return { start, end: start + CLICK_MIN };
}

/** A block dragged by `deltaPx`: its new start (snapped, inside the day) and end (its length kept). */
export function dragged(row: { startAt: number; endAt: number }, span: Span, deltaPx: number, date: string, tz: string): { startAt: number; endAt: number } {
  const minutes = Math.round((deltaPx / HOUR_PX) * 60 / SNAP_MIN) * SNAP_MIN;
  const start = clamp(Math.round((span.start + minutes) / SNAP_MIN) * SNAP_MIN, 0, DAY_MINUTES - SNAP_MIN);
  const startAt = atMinute(date, start, tz);
  return { startAt, endAt: startAt + (row.endAt - row.startAt) };
}

/** Side-by-side lanes: each block takes the first lane free at its start; a cluster of overlapping blocks shares its lane count. */
export function lanes(items: readonly CalItem[]): Laned[] {
  const sorted = [...items].sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end);
  const out: Laned[] = [];
  let cluster: Laned[] = [];
  let ends: number[] = [];
  let clusterEnd = -1;
  const close = () => { for (const entry of cluster) entry.lanes = ends.length; cluster = []; ends = []; };
  for (const item of sorted) {
    const end = Math.max(item.span.end, item.span.start + DONE_MIN); // a short block still takes a row's height
    if (item.span.start >= clusterEnd && cluster.length) close();
    let lane = ends.findIndex((laneEnd) => laneEnd <= item.span.start);
    if (lane === -1) { lane = ends.length; ends.push(end); } else ends[lane] = end;
    const laned = { item, lane, lanes: 1 };
    cluster.push(laned);
    out.push(laned);
    clusterEnd = Math.max(clusterEnd, end);
  }
  if (cluster.length) close();
  return out;
}

/** A mark on the AI lane is this high (px; the stylesheet's .cal-ai height), centred on its time. */
export const AI_MARK_PX = 14;

export interface AiPlaced { item: CalItem; top: number }

/**
 * Where the AI lane's marks stand (px from the hours' top): each centred on its time, but never over the one before it –
 * notes of the same minute (Mika and Lena at 14:00) stand one below the other, each readable, in time order (S9 review,
 * 27.11.2026). The lane is one narrow column, so a collision pushes down rather than sideways; a mark's tooltip has its time.
 */
export function aiPlaced(items: readonly CalItem[]): AiPlaced[] {
  const out: AiPlaced[] = [];
  let free = -Infinity; // the first top a mark may take
  for (const item of [...items].sort((a, b) => a.span.start - b.span.start)) {
    const top = Math.max((item.span.start / 60) * HOUR_PX - AI_MARK_PX / 2, free);
    out.push({ item, top });
    free = top + AI_MARK_PX;
  }
  return out;
}

/** The seven dates (Monday first) of the week `date` is in. */
export function weekOf(date: string): string[] {
  const monday = shiftDate(date, -((weekdayOf(date) + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => shiftDate(monday, index));
}

/** How the calendar names a task: its title and its quest's colour (looked up by the caller). */
export type Lookup = (taskId: string) => Pick<Task, 'title' | 'parentId' | 'minutes' | 'at'> | undefined;

export interface DayView { blocks: Laned[]; ai: CalItem[]; allDay: CalItem[] }

/**
 * One day: events (hidden sources left out) and the person's to-dos as blocks, a done one at the time it was done,
 * a to-do without a time and an all-day event in the strip, on the AI lane the agents' notes (`runs`) and the to-dos they
 * finished, at the time they were done (an open agent to-do's time is not drawn).
 */
export function dayView(rows: readonly CalendarEvent[], runs: readonly AgentRun[], date: string, tz: string, lookup: Lookup, hidden: ReadonlySet<string> = new Set()): DayView {
  const bounds = dayBounds(date, tz);
  const blocks: CalItem[] = [];
  const ai: CalItem[] = [];
  const allDay: CalItem[] = [];
  for (const row of rows) {
    if (row.kind === 'event') {
      if (hidden.has(row.sourceId)) continue;
      const span = spanIn(row, bounds, tz);
      if (!span) continue;
      const item: CalItem = { id: row.id, kind: 'event', title: row.title || 'Busy', span, hue: 0 };
      (row.allDay ? allDay : blocks).push(item);
      continue;
    }
    const task = row.taskId ? lookup(row.taskId) : undefined;
    const hue = task?.parentId ? questHue(task.parentId) : 0;
    const title = task?.title ?? '';
    const done = row.state === 'done';
    if (row.ownerId !== HUMAN_ID) {
      if (!done || row.startAt < bounds.start || row.startAt >= bounds.end) continue;
      const minute = wallOf(row.startAt, tz).minutes;
      ai.push({ id: row.id, kind: 'ai', title, span: { start: minute, end: minute }, hue, taskId: row.taskId, who: row.ownerId, done: true });
      continue;
    }
    if (!done && task && isDayOnly(task, tz)) {
      if (row.startAt >= bounds.start && row.startAt < bounds.end) allDay.push({ id: row.id, kind: 'todo', title, span: { start: 0, end: 0 }, hue, taskId: row.taskId });
      continue;
    }
    const span = spanIn(done ? { startAt: row.startAt, endAt: row.startAt + DONE_MIN * 60_000 } : row, bounds, tz);
    if (!span) continue;
    blocks.push({ id: row.id, kind: done ? 'done' : 'todo', title, span, hue, taskId: row.taskId, ...(done ? {} : { row }) });
  }
  for (const run of runs) {
    if (run.at < bounds.start || run.at >= bounds.end) continue;
    const minute = wallOf(run.at, tz).minutes;
    ai.push({ id: `run:${run.scheduleId}:${run.at}`, kind: 'ai', title: run.title, span: { start: minute, end: minute }, hue: 0, who: run.agentId });
  }
  ai.sort((a, b) => a.span.start - b.span.start);
  return { blocks: lanes(blocks), ai, allDay };
}

/** 'HH:MM' of a span's start. */
export function spanClock(span: Span): string {
  return `${String(Math.floor(span.start / 60)).padStart(2, '0')}:${String(span.start % 60).padStart(2, '0')}`;
}
