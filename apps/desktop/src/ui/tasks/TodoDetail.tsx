// A to-do's detail on the Tasks page, where the calendar was (a full view with Back on a phone): its quest (a click
// opens the quest), ⋯ (its menu) and ×, the title (15 px, edited in place – TaskEdit.tsx), its time (a person's: a
// click sets it), who asked or who has it, "Only me", "Important", what is to be done now (notes as Markdown; headings
// never larger than the title – tasks-detail.css), its tool (TodoWidget.tsx) and its own thread (owner 20.11.2026: "pro
// einzelnen Task einen Chat … also einen Verlauf") – the person's and the AI's lines about it and its events, with the
// line to write into it (chat/TaskThread.tsx). The list beside it never moves.
// Owns: the detail's frame and head. Never: the tool's body, the thread's lines, editing (TaskEdit.tsx) or loading the list.

import { useState } from 'preact/hooks';
import type { Task, TaskView } from '../../shared/model/tasks.ts';
import { runAgain } from './page-actions.ts';
import { TaskPlan } from './TaskPlan.tsx';
import { HUMAN_ID } from '../../shared/ids.ts';
import { Markdown } from '../blocks/markdown.tsx';
import { TaskThread } from '../chat/TaskThread.tsx';
import { openContextMenu, useContextMenu } from '../lib/context-menu.tsx';
import { dayZone } from '../lib/day-store.ts';
import type { MenuSection } from '../lib/popover.tsx';
import { can } from '../lib/session.ts';
import { agentName } from '../lib/store.ts';
import { EmptyState, Icon, IconButton, Spinner } from '../lib/ui.tsx';
import { taskIndex } from './page-data.ts';
import { questChoices, questHue } from './page-model.ts';
import { openDetail, type PageScope } from './page-state.ts';
import { TimeChip, TitleEdit } from './TaskEdit.tsx';
import { letGoOfTake, todoHandlers, TodoWidget } from './TodoWidget.tsx';
import { todoMenu } from './todo-menu.ts';
import { todoLabel } from './todo-model.ts';
import { stateLine } from './waiting.ts';
import { momentText } from './when-text.ts';

/** A row of the index as the widgets take it (a quest's step copy has no view fields). */
export function asView(task: Task | TaskView): TaskView {
  return 'steps' in task ? task : { ...task, steps: [], progress: { done: 0, total: 0 }, conversationTitle: '', running: false };
}

/** "History" over the task's thread, with who started the task and when (the one line the thread does not hold). */
export function HistoryHead(props: { task: Task; now: number }) {
  const { task } = props;
  const who = task.createdBy === HUMAN_ID ? 'you' : agentName(task.createdBy);
  return <h4 class="detail-label">History<span class="detail-created">Started by {who} · {momentText(task.createdAt, props.now, dayZone.value)}</span></h4>;
}

/** The detail's top row: the quest it is in (or Other), ⋯ with its menu, and ×. */
export function DetailTop(props: { scope: PageScope; quest?: Task; label?: string; menu?: () => MenuSection[]; onClose: () => void }) {
  const { quest, menu } = props;
  return (
    <div class="detail-top">
      {quest
        ? <button type="button" class="detail-quest" style={{ '--qc': `var(--wf-c${questHue(quest.id)})` }} onClick={() => openDetail(props.scope, quest.id)}>
            <span class="task-dot" aria-hidden="true" />{props.label ?? quest.title}
          </button>
        : <span class="detail-quest plain">{props.label ?? 'Other'}</span>}
      <span class="detail-gap" />
      {menu && <IconButton icon="dots-three" size="small" label="More" aria-haspopup="menu" onClick={(event) => {
        const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
        openContextMenu(box.right, box.bottom, menu());
      }} />}
      <IconButton icon="x" size="small" label="Close" onClick={props.onClose} />
    </div>
  );
}

/** P5 "Run again" on a finished task: a fresh copy with its checklist unticked and the same owners, opened at once. */
export function RunAgain(props: { scope: PageScope; task: Task }) {
  const [busy, setBusy] = useState(false);
  if (!can('tasks.runAgain')) return null;
  return (
    <button type="button" class="task-again" disabled={busy} onClick={async () => {
      setBusy(true);
      try { const copy = await runAgain(props.task); if (copy) openDetail(props.scope, copy.id); } finally { setBusy(false); }
    }}><Icon name="arrow-clockwise" size={14} />Run again</button>
  );
}

export function TodoDetail(props: { scope: PageScope; task: Task | TaskView | null | undefined; quest?: Task; now: number; onClose: () => void }) {
  const { task, now } = props;
  const close = () => { if (task) void letGoOfTake(task).then((ok) => { if (ok) props.onClose(); }); else props.onClose(); };
  const build = () => (task ? todoMenu(task, todoHandlers(task, props.scope), questChoices(taskIndex.peek())) : []);
  const menu = useContextMenu(build);
  if (!task) {
    return (
      <div class="task-detail">
        <DetailTop scope={props.scope} onClose={props.onClose} />
        <div class="detail-missing">{task === null ? <EmptyState>This to-do is gone.</EmptyState> : <Spinner />}</div>
      </div>
    );
  }
  const view = asView(task);
  const mine = task.assigneeKind === 'human' && (!task.assigneeId || task.assigneeId === HUMAN_ID);
  const finished = task.status === 'done' || task.status === 'dropped';
  const who = mine ? `for you${task.createdBy !== HUMAN_ID ? ` · from ${agentName(task.createdBy)}` : ''}` : stateLine(view, agentName, now);
  return (
    <div class="task-detail">
      <DetailTop scope={props.scope} quest={props.quest} menu={build} onClose={close} />
      <div class="detail-body" {...menu}>
        <TitleEdit task={task} label={todoLabel(task)} />
        <div class="detail-meta">
          <TimeChip task={task} now={now} editable={task.assigneeKind === 'human' && !finished} />
          <span class="task-chip">{who}</span>
          {task.priority > 0 && <span class="task-chip important"><Icon name="exclamation-mark" size={12} />Important</span>}
          {task.private && <span class="task-chip" title="You do this one; the AI keeps it in view"><Icon name="user" size={12} />Only me</span>}
          {task.widget?.type === 'timer' && typeof task.widget.repeat === 'string' && <span class="task-chip">repeats {task.widget.repeat}</span>}
        </div>
        {task.notes.trim() && <Markdown text={task.notes} class="task-notes" />}
        <TaskPlan task={task} scope={props.scope} />
        {finished && <RunAgain scope={props.scope} task={task} />}
        <TodoWidget task={view} now={now} />
      </div>
      <HistoryHead task={task} now={now} />
      <TaskThread taskId={task.id} />
    </div>
  );
}
