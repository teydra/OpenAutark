// One to-do row on the Tasks page (For you, Done today, a quest's list): the round check (one tick finishes a plain
// to-do, a confirmation, a reminder or a checklist – tasks/todo-actions.ts; a to-do that needs its tool opens its
// detail instead), the title (14 px, two lines at most; "!" before it when the person marked it Important), one meta
// line – its quest's dot and name, who asked ("from Mira") or "<assistant> is sorting…" while the person's assistant
// sorts a new line, its time ("since Wed" in the warning tone, "Today 15:00–18:00"), "Only me", "done 09:05" – the
// tool's icon at the end and a dot while its thread holds lines the person has not read. A click opens its detail where
// the calendar was; nothing in the list moves. The right-click (a long press, the phone's ⋯) opens the one to-do menu
// (todo-menu.ts).
// Owns: the row's markup. Never: the menu's items or the calls.

import type { Task } from '../../shared/model/tasks.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { hasThreadNews } from '../chat/threads.ts';
import { useContextMenu } from '../lib/context-menu.tsx';
import { dayZone } from '../lib/day-store.ts';
import { activity, agentName } from '../lib/store.ts';
import { Icon } from '../lib/ui.tsx';
import { PlanSummary } from './TaskPlan.tsx';
import { MoreButton } from './parts.tsx';
import { tick, told } from './page-actions.ts';
import { taskIndex } from './page-data.ts';
import { questChoices, questHue, sortingAgent } from './page-model.ts';
import { openDetail, type PageScope } from './page-state.ts';
import { todoHandlers } from './TodoWidget.tsx';
import { checkAnswer } from './todo-actions.ts';
import { todoMenu } from './todo-menu.ts';
import { todoLabel, widgetIcon } from './todo-model.ts';
import { doneText, whenOf } from './when-text.ts';

export interface TodoRowProps {
  task: Task;
  scope: PageScope;
  /** Its quest (for the dot and name), when it is in one. */
  quest?: Task;
  now: number;
  selected: boolean;
}

export function TodoRow(props: TodoRowProps) {
  const { task, quest, now } = props;
  const zone = dayZone.value;
  const handlers = todoHandlers(task, props.scope);
  const build = () => todoMenu(task, handlers, questChoices(taskIndex.peek()));
  const menu = useContextMenu(build);
  const finished = task.status === 'done' || task.status === 'dropped';
  const checkable = !finished && Boolean(checkAnswer(task));
  const sorting = sortingAgent(told.value, task.id, activity.value);
  const asker = task.createdBy !== HUMAN_ID ? task.createdBy : undefined;
  const when = finished ? undefined : whenOf(task, now, zone);
  const open = () => openDetail(props.scope, task.id);
  const news = hasThreadNews(task.id);
  return (
    <li class={`todo-row${finished ? ' done' : ''}${props.selected ? ' on' : ''}`} data-task-id={task.id} {...menu}>
      <button type="button" class="todo-check" aria-label={checkable ? `Done: ${todoLabel(task)}` : finished ? 'Done' : `Open: ${todoLabel(task)}`}
        title={checkable ? 'Done' : finished ? undefined : 'Open it to answer'} disabled={finished}
        onClick={() => { if (checkable) void tick(task); else open(); }}>
        <Icon name="check" size={12} />
      </button>
      <button type="button" class="todo-open" aria-current={props.selected ? 'true' : undefined} onClick={open}>
        <span class="todo-title">
          {news && <span class="todo-news" title="New lines in its history" />}
          {task.priority > 0 && !finished && <span class="todo-important" title="Important">!</span>}
          {todoLabel(task)}
        </span>
        <span class="todo-meta">
          {quest && <span class="todo-quest" style={{ '--qc': `var(--wf-c${questHue(quest.id)})` }}><span class="task-dot" aria-hidden="true" />{quest.title}</span>}
          {sorting ? <span class="todo-sorting">{agentName(sorting)} is sorting…</span> : asker && <span>from {agentName(asker)}</span>}
          {when && <span class={when.late ? 'late' : ''}>{when.text}</span>}
          {task.private && <span class="todo-only" title="You do this one; the AI keeps it in view"><Icon name="user" size={12} />Only me</span>}
          {finished && task.completedAt && <span>{task.status === 'dropped' ? 'dropped' : doneText(task.completedAt, now, zone)}</span>}
        </span>
        <PlanSummary task={task} />
      </button>
      <span class="todo-kind" aria-hidden="true">{task.widget && task.widget.type !== 'confirm' && <Icon name={widgetIcon(task.widget)} size={16} />}</span>
      <MoreButton build={build} />
    </li>
  );
}
