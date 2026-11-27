// The Tasks page (Quests round 20.11.2026; owner 19.11.2026: "das alles in einen bringen"): one page instead of My
// day and Work. Its head is the day line (owner 23.11.2026, DayLine.tsx): ‹ the days as circles ›, a small month, and
// Day | Week (one column: Tasks | Calendar as two symbols). The list on today: "Next" (the next appointments,
// DayPreview.tsx), the input line, on a phone or in the side pane the quests as chips, "For you", "Done today" and "At
// work"; on another day that day's lines instead (a past day only to read: no input line, the calendar takes no clicks
// or drags). Beside it the calendar, or the open to-do's or quest's detail in its place – the list never moves. The
// view and the chosen day stay across a switch to the chats (page-state.ts settleKept / keepView). One column (a
// phone, the side pane, a narrow window) shows the list or the calendar, and a detail as a view of its own with ×. The
// main zone's selection lives in the route, its day in the route's ?date= and kept in page-state.ts, the
// pane's in the pane. The quest column is the sidebar on a computer (QuestNav.tsx).
// Owns: the page's layout and what it hands its parts. Never: data of its own (page-data.ts, lib/store.ts,
// lib/day-store.ts) or the parts' markup.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Task } from '../../shared/model/tasks.ts';
import { wallOf, wallTime } from '../../shared/text/when.ts';
import { calendarWindow, dayClock, dayRange, dayZone, loadDay } from '../lib/day-store.ts';
import { useContextMenu } from '../lib/context-menu.tsx';
import { Header } from '../lib/header.tsx';
import { isMobile, todoClock, todos } from '../lib/store.ts';
import { AtWork } from './AtWork.tsx';
import { hiddenSources, watchSources } from './calendar-sources.ts';
import { DayLine } from './DayLine.tsx';
import { busyDays, dayAgenda, nextUp } from './day-preview.ts';
import { DayList, NextUp } from './DayPreview.tsx';
import { lineDays, windowSpan } from './day-strip.ts';
import { cardAsks, waitingCards } from '../../shared/model/waiting-cards.ts';
import { ForYou } from './ForYou.tsx';
import { WaitingOnYou } from './WaitingOnYou.tsx';
import { finished, runningTasks, taskIndex, watchFinished } from './page-data.ts';
import { atWork, childrenOf, questLines, type QuestLine } from './page-model.ts';
import { calendarSpan, closeDetail, followRouteDay, keepView, linePaged, oneColumn, openDetail, otherOnly, routePart, selected, settleKept, shownDay, type PageScope } from './page-state.ts';
import { QuestDetail } from './QuestDetail.tsx';
import { startQuest } from './QuestNav.tsx';
import { ensureSchedules, schedules } from './schedules.ts';
import { TaskCalendar } from './TaskCalendar.tsx';
import { TaskInput } from './TaskInput.tsx';
import { useTask } from './task-cache.ts';
import { searchHits, searchState, taskSearch, useFound } from './task-search.ts';
import { taskMenu } from './task-menu.ts';
import { asView, TodoDetail } from './TodoDetail.tsx';
import { TodoRow } from './TodoRow.tsx';
import { shiftDate } from './when-text.ts';

/** Wide enough for the list and the calendar side by side. */
const WIDE_PX = 720;

function useWide(root: { current: HTMLElement | null }, allowed: boolean): boolean {
  const [wide, setWide] = useState(allowed);
  useEffect(() => {
    const el = root.current;
    if (!el || !allowed) { setWide(false); return; }
    const measure = () => setWide(el.clientWidth >= WIDE_PX);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [allowed]);
  return wide;
}

/** A quest as a chip: a click opens it, a long press or right-click its menu (task-menu.ts). */
function QuestChip(props: { scope: PageScope; line: QuestLine }) {
  const { line } = props;
  const menu = useContextMenu(() => taskMenu(asView(line.quest), props.scope));
  return (
    <button type="button" class="quest-chip" title={line.quest.title} style={{ '--qc': `var(--wf-c${line.hue})` }} onClick={() => openDetail(props.scope, line.quest.id)} {...menu}>
      <span class="task-dot" aria-hidden="true" />
      <span class="quest-chip-label">{line.quest.title}</span>
    </button>
  );
}

/** On a phone and in the pane (no quest column): the quests with the person's to-dos as chips, Other, and + Quest. */
function QuestChips(props: { scope: PageScope; index: ReadonlyMap<string, Task> }) {
  const lists = questLines(props.index);
  return (
    <div class="quest-chips">
      {lists.withYou.map((line) => <QuestChip key={line.quest.id} scope={props.scope} line={line} />)}
      {lists.other > 0 && <button type="button" class="quest-chip" aria-pressed={otherOnly.value} onClick={() => { otherOnly.value = !otherOnly.value; }}>Other</button>}
      <button type="button" class="quest-chip add" onClick={() => startQuest(props.scope)}>+ Quest</button>
    </div>
  );
}

/** While the search holds words: what it finds, in place of For you and At work. */
function Found(props: { scope: PageScope; index: ReadonlyMap<string, Task>; selected: string | null; now: number }) {
  const query = taskSearch.value.query;
  const hits = searchHits(props.index.values(), useFound(query), query);
  return (
    <>
      <h3 class="tasks-sec">Found <span class="tabular">{hits.length}</span></h3>
      <ul class="todo-rows" aria-label="Found">
        {hits.map((task) => {
          const quest = task.parentId ? props.index.get(task.parentId) : undefined;
          return <TodoRow key={task.id} task={task} scope={props.scope} quest={quest?.kind === 'quest' ? quest : undefined} now={props.now} selected={props.selected === task.id} />;
        })}
        {!hits.length && <li class="tasks-empty">Nothing found.</li>}
      </ul>
    </>
  );
}

export function TasksPage(props: { scope?: PageScope }) {
  const scope = props.scope ?? 'main';
  const root = useRef<HTMLDivElement>(null);
  const phone = isMobile.value;
  const wide = useWide(root, !phone && scope === 'main');
  void todoClock.value; void dayClock.value; // re-read when either clock moves
  const now = Date.now();
  const zone = dayZone.value;
  const today = wallOf(now, zone).date;
  settleKept(today);
  const routeDay = scope === 'main' ? routePart().date : undefined;
  useEffect(() => { if (routeDay) followRouteDay(); }, [routeDay]);
  const date = shownDay(scope) ?? today;
  const [count, setCount] = useState(5);
  const days = lineDays(date, count, linePaged[scope].value);
  useEffect(() => { if (scope === 'main') keepView(today); }, [scope, today, date, oneColumn.value]);
  const dayStart = wallTime(today, 0, zone);
  const dayEnd = wallTime(shiftDate(today, 1), 0, zone);
  useEffect(() => watchFinished(dayStart), [dayStart]);
  useEffect(() => { ensureSchedules(); return watchSources(); }, []);
  const span = windowSpan(date, today, days);
  useEffect(() => { // the shown day's week (the day and week views), the line's days (dots) and on today the next two (Next)
    const range = dayRange(span.first, zone, span.days);
    const window = calendarWindow.peek();
    if (!window || window.from > range.from || window.to < range.to) void loadDay(range);
  }, [span.first, span.days, zone]);

  const index = taskIndex.value;
  const children = useMemo(() => childrenOf(index), [index]);
  const cards = useMemo(() => waitingCards(new Map([...todos.value, ...index.values()].map((task) => [task.id, task])).values(), now), [index, todos.value, Math.floor(now / 60_000)]);
  const open = selected(scope);
  const fetched = useTask(open ?? undefined);
  const openTask = open ? index.get(open) ?? fetched : undefined;
  const owner = scope === 'main' ? routePart().owner : undefined;
  const groups = useMemo(() => atWork(index, runningTasks.value, schedules.value, dayStart, owner, children), [index, runningTasks.value, schedules.value, dayStart, owner, children]);
  const windowList = calendarWindow.value?.list;
  const windowTasks = windowList?.tasks;
  const lookup = (id: string) => index.get(id) ?? windowTasks?.find((task) => task.id === id);
  const rows = windowList?.events ?? [];
  const past = date < today;
  const onToday = date === today;
  const questOpen = openTask?.kind === 'quest' ? openTask : undefined;
  const parent = openTask?.parentId ? index.get(openTask.parentId) : undefined;

  const close = () => closeDetail(scope);
  const searching = scope === 'main' && taskSearch.value.query.trim() !== '';
  const detail = open && (questOpen
    ? <QuestDetail scope={scope} quest={questOpen} todos={children.get(questOpen.id) ?? []} schedules={schedules.value} now={now} onClose={close} />
    : <TodoDetail key={open} scope={scope} task={openTask} quest={parent?.kind === 'quest' ? parent : undefined} now={now} onClose={close} />);
  const calendar = (
    <TaskCalendar scope={scope} date={date} today={today} span={wide ? calendarSpan.value : 'day'} lookup={lookup} hidden={hiddenSources.value} now={now} readOnly={past} todayButton={!wide} {...(questOpen ? { quest: questOpen } : {})} />
  );
  const list = (
    <section class="tasks-list" aria-label="Tasks">
      {onToday && !searching && <NextUp scope={scope} lines={nextUp(rows, now, zone, lookup, hiddenSources.value)} wide={wide} />}
      {!past && <TaskInput scope={scope} {...(questOpen ? { quest: questOpen } : {})} onLeaveQuest={close} />}
      {(phone || scope === 'pane') && <QuestChips scope={scope} index={index} />}
      {searching ? <Found scope={scope} index={index} selected={open} now={now} /> : !onToday ? (
        <DayList scope={scope} date={date} today={today} lines={dayAgenda(rows, windowList?.agentRuns ?? [], date, zone, lookup, hiddenSources.value)} />
      ) : (
        <>
          <WaitingOnYou scope={scope} cards={cards} now={now} />
          <ForYou scope={scope} todos={todos.value} hidden={cardAsks(cards)} finished={finished.value} index={index} selected={open} now={now} dayStart={dayStart} dayEnd={dayEnd} />
          <AtWork scope={scope} groups={groups} schedules={schedules.value} index={index} {...(owner ? { owner } : {})} now={now} />
        </>
      )}
    </section>
  );
  const head = <DayLine scope={scope} date={date} today={today} days={days} busy={busyDays(rows, days, zone, hiddenSources.value)} wide={wide} onCount={setCount} />;
  const single = !wide;
  return (
    <div ref={root} class={`tasks-page${wide ? ' wide' : ' narrow'}${scope === 'pane' ? ' in-pane' : ''}`}>
      {scope === 'main' && !phone ? <Header zone="main" class="tasks-header" title={head} search={searchState()} />
        : !(phone && single && detail) && <div class="tasks-toolbar">{head}</div>}
      <div class="tasks-cols">
        {single
          ? (detail ? <div class="tasks-side single">{detail}</div> : oneColumn.value === 'calendar' ? <div class="tasks-side single">{calendar}</div> : list)
          : <>{list}<aside class="tasks-side" aria-label={open ? 'Detail' : 'Calendar'}>{detail || calendar}</aside></>}
      </div>
    </div>
  );
}
