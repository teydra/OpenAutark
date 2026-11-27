// The Tasks page's calendar (src/ui/tasks/calendar-model.ts): what one day shows from calendar.list's rows – events
// (a switched-off calendar's left out, an all-day one in the strip), the person's to-dos at their time in their quest's
// colour (movable), a done one at the time it was done (the logbook, a short mark), a day-only to-do in the strip, the
// agents' notes and what they finished on the AI lane (never an open agent to-do's time) – where blocks sit (wall minutes in the zone, cut at the day's edges, lanes
// for overlaps), and what a click or a drag means (a quarter hour, 15-minute steps, the length kept).
// Owns: these assertions only. Never: the DOM, rpc or a real clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CalendarEvent } from '../../../src/shared/model/calendar.ts';
import { AI_MARK_PX, HOUR_PX, aiPlaced, atMinute, clickSpan, dayBounds, dayView, dragged, lanes, spanIn, weekOf, type CalItem } from '../../../src/ui/tasks/calendar-model.ts';
import { questHue } from '../../../src/ui/tasks/page-model.ts';

const TZ = 'Europe/Berlin';
const H = 3_600_000;
const MIDNIGHT = Date.UTC(2026, 10, 19, 23); // Fri 20 Nov 2026 00:00 in Berlin
const DATE = '2026-11-20';

function row(id: string, patch: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id, ownerId: 'human', kind: 'todo', taskId: id, startAt: MIDNIGHT + 15 * H, endAt: MIDNIGHT + 16 * H, sourceId: 'local', setBy: 'person',
    state: 'planned', createdBy: 'human', rev: 1, createdAt: 1, updatedAt: 1, ...patch,
  };
}

const tasks: Record<string, { title: string; parentId?: string; at?: number; minutes?: number }> = {
  task_call0001: { title: 'Call Gerlinde', parentId: 'task_avos0001', at: MIDNIGHT + 15 * H, minutes: 60 },
  task_done0001: { title: 'Sign the form', at: MIDNIGHT + 9 * H, minutes: 30 },
  task_day00001: { title: 'Belege sammeln', at: MIDNIGHT },
  task_felix001: { title: 'Signed installer', parentId: 'task_sign0001' },
};
const lookup = (id: string) => tasks[id];

test('one day: the person\'s to-do (movable, its quest\'s colour), the logbook mark, a day-only to-do and an all-day event in the strip', () => {
  const view = dayView([
    row('task_call0001'),
    row('task_done0001', { state: 'done', startAt: MIDNIGHT + 10 * H + 5 * 60_000, endAt: MIDNIGHT + 10.5 * H }),
    row('task_day00001', { startAt: MIDNIGHT, endAt: MIDNIGHT + 0.5 * H }),
    row('cev_holiday1', { kind: 'event', taskId: undefined, title: 'Holiday', allDay: true, startAt: MIDNIGHT, endAt: MIDNIGHT + 24 * H }),
    row('cev_dentist', { kind: 'event', taskId: undefined, title: 'Dentist', startAt: MIDNIGHT + 11 * H, endAt: MIDNIGHT + 12 * H }),
    row('cev_hidden1', { kind: 'event', taskId: undefined, title: 'Hidden', sourceId: 'src_off' }),
  ], [], DATE, TZ, lookup, new Set(['src_off']));
  const blocks = new Map(view.blocks.map((entry) => [entry.item.id, entry.item]));
  assert.deepEqual([...blocks.keys()].sort(), ['cev_dentist', 'task_call0001', 'task_done0001']);
  const call = blocks.get('task_call0001')!;
  assert.deepEqual([call.kind, call.title, call.span, call.hue, Boolean(call.row)], ['todo', 'Call Gerlinde', { start: 900, end: 960 }, questHue('task_avos0001'), true]);
  const done = blocks.get('task_done0001')!;
  assert.deepEqual([done.kind, done.span, Boolean(done.row)], ['done', { start: 605, end: 625 }, false], 'at the time it was done, a short mark, not movable');
  assert.equal(blocks.get('cev_dentist')?.hue, 0);
  assert.deepEqual(view.allDay.map((item) => item.title).sort(), ['Belege sammeln', 'Holiday']);
});

test('the AI lane: an agent\'s note and what an agent finished, at their time – an open agent to-do\'s time is never drawn', () => {
  const view = dayView([
    row('task_felix001', { ownerId: 'ag_felix', state: 'done', startAt: MIDNIGHT + 13 * H, endAt: MIDNIGHT + 13.5 * H }),
    row('task_open0001', { ownerId: 'ag_felix', startAt: MIDNIGHT + 14 * H, endAt: MIDNIGHT + 14.5 * H }),
  ], [{ scheduleId: 'sch_1', agentId: 'ag_lukas', title: 'Certum-Status ansehen', at: MIDNIGHT + 12 * H }], DATE, TZ, lookup);
  assert.equal(view.blocks.length, 0, 'an agent\'s to-do is no block of the person\'s');
  assert.deepEqual(view.ai.map((item: CalItem) => [item.who, item.span.start, item.title, item.done ?? false]),
    [['ag_lukas', 720, 'Certum-Status ansehen', false], ['ag_felix', 780, 'Signed installer', true]], 'the open one (an invented date) is left out');
});

test('geometry: spans cut at the day\'s edges, lanes for overlaps, a click\'s quarter hour, a drag in 15-minute steps', () => {
  const bounds = dayBounds(DATE, TZ);
  assert.deepEqual(bounds, { start: MIDNIGHT, end: MIDNIGHT + 24 * H });
  assert.deepEqual(spanIn({ startAt: MIDNIGHT - H, endAt: MIDNIGHT + H }, bounds, TZ), { start: 0, end: 60 }, 'from the day before');
  assert.equal(spanIn({ startAt: MIDNIGHT + 25 * H, endAt: MIDNIGHT + 26 * H }, bounds, TZ), undefined);
  const item = (id: string, start: number, end: number): CalItem => ({ id, kind: 'todo', title: id, span: { start, end }, hue: 0 });
  const laned = lanes([item('a', 600, 660), item('b', 630, 700), item('c', 720, 750)]);
  assert.deepEqual(laned.map((entry) => [entry.item.id, entry.lane, entry.lanes]), [['a', 0, 2], ['b', 1, 2], ['c', 0, 1]]);
  assert.deepEqual(clickSpan(9 * 60 + 40), { start: 570, end: 600 });
  assert.equal(atMinute(DATE, 570, TZ), MIDNIGHT + 9.5 * H);
  const moved = dragged({ startAt: MIDNIGHT + 15 * H, endAt: MIDNIGHT + 16 * H }, { start: 900, end: 960 }, HOUR_PX * 1.3, DATE, TZ);
  assert.deepEqual(moved, { startAt: MIDNIGHT + 16.25 * H, endAt: MIDNIGHT + 17.25 * H }, '78 minutes down: 75, the hour kept');
  assert.deepEqual(weekOf(DATE), ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']);
});

test('the AI lane stands notes of the same time one below the other, in time order, never over each other', () => {
  const note = (id: string, start: number): CalItem => ({ id, kind: 'ai', title: id, span: { start, end: start }, hue: 0, who: id });
  const alone = aiPlaced([note('mika', 840)]);
  assert.equal(alone[0]!.top, (840 / 60) * HOUR_PX - AI_MARK_PX / 2, 'a lone note is centred on its time');
  const two = aiPlaced([note('mika', 840), note('lena', 840)]);
  assert.deepEqual(two.map((placed) => placed.item.id), ['mika', 'lena']);
  assert.equal(two[1]!.top - two[0]!.top, AI_MARK_PX, 'the second stands right under the first');
  const crowd = aiPlaced([note('c', 845), note('a', 840), note('b', 840), note('far', 960)]);
  assert.deepEqual(crowd.map((placed) => placed.item.id), ['a', 'b', 'c', 'far'], 'time order, ties as given');
  for (let index = 1; index < crowd.length; index += 1) assert.ok(crowd[index]!.top >= crowd[index - 1]!.top + AI_MARK_PX, 'no two overlap');
  assert.equal(crowd[3]!.top, (960 / 60) * HOUR_PX - AI_MARK_PX / 2, 'a later note far enough away keeps its own time');
});