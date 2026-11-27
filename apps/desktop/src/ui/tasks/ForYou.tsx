// "For you" and "Done today" on the Tasks page (owner 19.11.2026: "für einen, was man selber machen muss"): the
// person's own open to-dos – what is overdue and today first (timed ones by their time, then the rest), then "Later" –
// with a count; "Other" from the quest column narrows it to to-dos without a quest (its × shows all again). Under it
// "Done today (n)", closed by default: what the person finished today, in the order it was done (the calendar keeps
// it at that time, the logbook).
// Owns: these two sections. Never: the rows' markup (TodoRow.tsx) or the lists' rules (page-model.ts).

import type { Task } from '../../shared/model/tasks.ts';
import { Icon } from '../lib/ui.tsx';
import { notLoaded } from '../shell/connection-line.ts';
import { doneToday, forYou } from './page-model.ts';
import { doneOpen, otherOnly, toggle, type PageScope } from './page-state.ts';
import { TodoRow } from './TodoRow.tsx';

export interface ForYouProps {
  scope: PageScope;
  todos: readonly Task[];
  hidden?: ReadonlySet<string>; // the asks a "Waiting on you" card stands for (WaitingOnYou.tsx)
  finished: readonly Task[];
  index: ReadonlyMap<string, Task>;
  selected: string | null;
  now: number;
  dayStart: number;
  dayEnd: number;
}

export function ForYou(props: ForYouProps) {
  const { index, now } = props;
  const hidden = props.hidden;
  const lists = forYou(hidden?.size ? props.todos.filter((task) => !hidden.has(task.id)) : props.todos, now, props.dayEnd, otherOnly.value);
  const done = doneToday(props.finished, props.dayStart);
  const row = (task: Task) => {
    const quest = task.parentId ? index.get(task.parentId) : undefined;
    return <TodoRow key={task.id} task={task} scope={props.scope} quest={quest?.kind === 'quest' ? quest : undefined} now={now} selected={props.selected === task.id} />;
  };
  const count = lists.now.length + lists.later.length;
  const waiting = notLoaded.value; // nothing was ever loaded: no count, no "Nothing for you here" (shell/connection-line.ts)
  return (
    <>
      <h3 class="tasks-sec">
        For you {waiting === null && <span class="tabular">{count}</span>}
        {otherOnly.value && (
          <span class="tasks-sec-filter">· Other<button type="button" class="task-chip-x" aria-label="Show all" title="Show all" onClick={() => { otherOnly.value = false; }}>×</button></span>
        )}
      </h3>
      <ul class="todo-rows" aria-label="For you">
        {lists.now.map(row)}
        {lists.later.length > 0 && <li class="tasks-sec later" aria-hidden="true">Later</li>}
        {lists.later.map(row)}
        {!count && <li class="tasks-empty">{waiting ?? 'Nothing for you here.'}</li>}
      </ul>
      <button type="button" class={`tasks-fold${doneOpen.value ? ' open' : ''}`} aria-expanded={doneOpen.value} onClick={() => toggle(doneOpen)}>
        <Icon name="caret-right" size={14} />Done today{waiting === null && ` (${done.length})`}
      </button>
      {doneOpen.value && <ul class="todo-rows" aria-label="Done today">{done.map(row)}</ul>}
    </>
  );
}
