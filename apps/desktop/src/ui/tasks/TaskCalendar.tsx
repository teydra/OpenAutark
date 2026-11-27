// The calendar beside the list (owner 19.11.2026: "dass es auch gut mit dem Kalender funktioniert"): one day of hours
// or the week, in the person's zone. The person's to-dos stand at their time in their quest's colour and move by drag
// (calendar.move: the to-do's `at`, 15-minute steps); connected calendars' events stand grey; what the person finished
// stays at the time it was done (the logbook, faded); to-dos of a day without a time sit in the strip above the hours.
// With "At work" open a slim lane on the right shows the notes the agents left themselves and what they finished, at
// that time (never a time for open agent work). A click into a free time with text in the input line adds that line
// there; without text it puts the caret into the line. A click on a block opens its detail – where this calendar was.
// A week's block shows its title whole words at a time (a long word is cut at the column's edge, never split letter by
// letter; its tooltip has it all). The day's head names it ("Monday, November 23"; the page's head is the day line
// now); a past day is only read (no slot clicks, no drags). On one column another day's head carries "Today" beside its note; at 360 px the head wraps (the note takes a second line) – nothing leaves the screen.
// Owns: the grid's markup, the drag and the slot click. Never: what a day shows (calendar-model.ts) or the calls.

import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Task } from '../../shared/model/tasks.ts';
import { calendarWindow, dayZone } from '../lib/day-store.ts';
import { agentName } from '../lib/store.ts';
import { DAY_MINUTES, HOUR_PX, aiPlaced, atMinute, clickSpan, dayView, dragged, spanClock, weekOf, type AiPlaced, type CalItem, type Laned, type Lookup } from './calendar-model.ts';
import { moveRow } from './page-actions.ts';
import { backToToday, lineOf, openDetail, workOpen, type PageScope } from './page-state.ts';
import { submitLine } from './TaskInput.tsx';
import { KindMark } from './DayPreview.tsx';
import { dayWord, headTitle, weekdayOf } from './when-text.ts';
import { wallOf } from '../../shared/text/when.ts';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const px = (minutes: number) => (minutes / 60) * HOUR_PX;

export interface CalendarProps {
  scope: PageScope;
  date: string;
  today: string;
  span: 'day' | 'week';
  lookup: Lookup;
  hidden: ReadonlySet<string>;
  now: number;
  /** The quest a slot's to-do goes into (its detail is open). */
  quest?: Task;
  /** A past day: only to read – a click into the hours adds nothing, a block does not move. */
  readOnly?: boolean;
  /** One column (the list is not beside it): on another day its head carries "Today" (Mika's review 23.11.2026). */
  todayButton?: boolean;
}

function Block(props: { entry: Laned; scope: PageScope; date: string; readOnly: boolean; drag: { id: string; dy: number } | null; onDrag: (id: string | null, dy: number) => void }) {
  const { item, lane, lanes } = props.entry;
  const start = useRef<{ y: number; moved: boolean } | null>(null);
  const dy = props.drag?.id === item.id ? props.drag.dy : 0;
  const height = Math.max(px(item.span.end - item.span.start) - 2, 18);
  const style = {
    '--qc': item.hue ? `var(--wf-c${item.hue})` : 'var(--muted)', top: `${px(item.span.start) + dy}px`, height: `${height}px`,
    left: `calc(${(lane / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)`,
  };
  const open = () => { if (item.taskId) openDetail(props.scope, item.taskId); };
  const movable = Boolean(item.row) && !props.readOnly;
  return (
    <div class={`cal-block ${item.kind}${dy ? ' dragging' : ''}`} style={style} role={item.taskId ? 'button' : undefined} tabIndex={item.taskId ? 0 : undefined}
      title={`${spanClock(item.span)} ${item.title}`}
      onKeyDown={(event) => { if (event.key === 'Enter') open(); }}
      onPointerDown={(event) => {
        if (!movable || event.button !== 0) return;
        start.current = { y: event.clientY, moved: false };
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        const delta = event.clientY - start.current.y;
        if (Math.abs(delta) > 4) start.current.moved = true;
        if (start.current.moved) props.onDrag(item.id, delta);
      }}
      onPointerUp={(event) => {
        const began = start.current;
        start.current = null;
        if (!began?.moved) { props.onDrag(null, 0); open(); return; }
        props.onDrag(null, 0);
        if (!item.row) return;
        const to = dragged(item.row, item.span, event.clientY - began.y, props.date, dayZone.peek());
        void moveRow(item.row, to.startAt, to.endAt);
      }}
      onClick={(event) => { event.stopPropagation(); if (!movable) open(); }}>
      <span class="cal-block-head">
        <KindMark kind={item.kind} size={12} />
        {height < 34 && <span class="cal-block-time">{spanClock(item.span)}</span>}
        <span class="cal-block-title">{item.title}</span>
      </span>
      {height >= 34 && <span class="cal-block-time">{spanClock(item.span)}</span>}
    </div>
  );
}

function AiMark(props: { placed: AiPlaced; scope: PageScope }) {
  const { item, top } = props.placed;
  return (
    <button type="button" class={`cal-ai${item.done ? ' done' : ''}`} style={{ top: `${top}px`, '--qc': item.hue ? `var(--wf-c${item.hue})` : 'var(--muted)' }}
      title={`${spanClock(item.span)} ${item.who ? agentName(item.who) : ''} · ${item.title}`} onClick={() => { if (item.taskId) openDetail(props.scope, item.taskId); }}>
      <i aria-hidden="true" /><span class="cal-ai-name">{item.who ? agentName(item.who) : item.title}</span>
    </button>
  );
}

function DayGrid(props: CalendarProps) {
  const window = calendarWindow.value;
  const zone = dayZone.value;
  const view = dayView(window?.list.events ?? [], window?.list.agentRuns ?? [], props.date, zone, props.lookup, props.hidden);
  const scroller = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; dy: number } | null>(null);
  const today = props.date === props.today;
  const nowMinute = today ? wallOf(props.now, zone).minutes : -1;
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = px(Math.max(0, (today ? nowMinute : 8 * 60) - 90));
  }, [props.date]);
  const slot = (event: MouseEvent) => {
    if (props.readOnly) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-minute]');
    if (!target) return;
    const at = atMinute(props.date, clickSpan(Number(target.dataset.minute)).start, zone);
    const line = lineOf(props.scope);
    if (line.text.peek().trim()) void submitLine(props.scope, props.quest?.id, at);
    else line.field.current?.focus();
  };
  return (
    <>
      <div class="cal-allday" aria-label="Without a time">
        {view.allDay.map((item) => (
          <button key={item.id} type="button" class={`cal-chip ${item.kind}`} style={{ '--qc': item.hue ? `var(--wf-c${item.hue})` : 'var(--muted)' }}
            onClick={() => { if (item.taskId) openDetail(props.scope, item.taskId); }}><KindMark kind={item.kind} size={12} />{item.title}</button>
        ))}
      </div>
      <div class="cal-scroll" ref={scroller}>
        <div class={`cal-grid${workOpen.value ? ' ai' : ''}${props.readOnly ? ' read-only' : ''}`} style={{ height: `${px(DAY_MINUTES)}px` }} onClick={slot}>
          {Array.from({ length: 24 }, (_, hour) => (
            <div key={hour} class="cal-hour" style={{ top: `${hour * HOUR_PX}px` }}><span>{hour ? `${String(hour).padStart(2, '0')}:00` : ''}</span></div>
          ))}
          {Array.from({ length: 48 }, (_, half) => (
            <div key={`s${half}`} class="cal-slot" data-minute={half * 30} style={{ top: `${half * HOUR_PX / 2}px`, height: `${HOUR_PX / 2}px` }} />
          ))}
          <div class="cal-blocks">
            {view.blocks.map((entry) => <Block key={entry.item.id} entry={entry} scope={props.scope} date={props.date} readOnly={!!props.readOnly} drag={drag} onDrag={(id, dy) => setDrag(id ? { id, dy } : null)} />)}
          </div>
          {workOpen.value && aiPlaced(view.ai).map((placed) => <AiMark key={placed.item.id} placed={placed} scope={props.scope} />)}
          {today && <div class="cal-now" style={{ top: `${px(nowMinute)}px` }} aria-hidden="true" />}
        </div>
      </div>
    </>
  );
}

function WeekItem(props: { item: CalItem; scope: PageScope; timed: boolean }) {
  const { item } = props;
  return (
    <button type="button" class={`cal-wb ${item.kind}`} style={{ '--qc': item.hue ? `var(--wf-c${item.hue})` : 'var(--muted)' }}
      title={`${props.timed ? `${spanClock(item.span)} ` : ''}${item.title}`} onClick={() => { if (item.taskId) openDetail(props.scope, item.taskId); }}>
      {props.timed && <span class="cal-wb-time">{spanClock(item.span)}</span>}
      <span class="cal-wb-title">{item.kind === 'done' ? '✓ ' : ''}{item.title}</span>
    </button>
  );
}

function WeekGrid(props: CalendarProps) {
  const window = calendarWindow.value;
  const zone = dayZone.value;
  return (
    <div class="cal-scroll">
      <div class="cal-week">
        {weekOf(props.date).map((date) => {
          const view = dayView(window?.list.events ?? [], [], date, zone, props.lookup, props.hidden);
          const timed = view.blocks.map((entry) => entry.item).sort((a, b) => a.span.start - b.span.start);
          return (
            <div key={date} class={`cal-wd${date === props.today ? ' today' : ''}`}>
              <div class="cal-wd-head">{WEEKDAYS[weekdayOf(date)]} {Number(date.slice(8))}</div>
              {view.allDay.map((item) => <WeekItem key={item.id} item={item} scope={props.scope} timed={false} />)}
              {timed.map((item) => <WeekItem key={item.id} item={item} scope={props.scope} timed />)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TaskCalendar(props: CalendarProps) {
  const week = props.span === 'week';
  return (
    <section class="task-cal" aria-label="Calendar">
      <div class="cal-head">
        <span class="cal-head-day">{week ? `Week of ${dayWord(weekOf(props.date)[0], props.today)}` : `${headTitle(props.date)}${workOpen.value ? ' · AI lane on' : ''}`}</span>
        {props.todayButton && props.date !== props.today && <button type="button" class="day-list-today" onClick={() => backToToday(props.scope)}>Today</button>}
        <span class="cal-head-note">{week ? '✓ = done' : 'Logbook before now'}</span>
      </div>
      {week ? <WeekGrid {...props} /> : <DayGrid {...props} />}
    </section>
  );
}
