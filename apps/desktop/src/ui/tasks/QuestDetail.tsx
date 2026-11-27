// A quest's detail on the Tasks page, where the calendar was (owner 19.11.2026: "eine Quest für Windows-Signierung …
// verschiedene To-dos drin, die ich hätte machen sollen"): who leads it, ⋯ with the quest's menu (task-menu.ts: Rename…,
// Give to…, Done, Drop, Reopen, Delete – a right-click on the body opens it too), its title (15 px, edited in place),
// "Done when …", how many of its to-dos are done (a bar in the quest's colour) and how long the AI worked on it this
// week, its to-dos of every owner – the person's first, then the agents', colleagues' and the team's with what each waits
// on (agent work shows no time: it starts now) – each opening its own detail, the next note its agent left itself, its
// notes, and the quest's own thread with the line to write into it. While it is open the input line puts new to-dos into it.
// Owns: the quest detail's markup. Never: the lists' rules (page-model.ts), the menu's items or the thread's lines
// (chat/TaskThread.tsx).

import type { Schedule, Task } from '../../shared/model/tasks.ts';
import { TaskPlan, PlanSummary } from './TaskPlan.tsx';
import { wallOf, wallTime } from '../../shared/text/when.ts';
import { Markdown } from '../blocks/markdown.tsx';
import { TaskThread } from '../chat/TaskThread.tsx';
import { useContextMenu } from '../lib/context-menu.tsx';
import { dayZone } from '../lib/day-store.ts';
import { agentName } from '../lib/store.ts';
import { Icon } from '../lib/ui.tsx';
import { doerName } from './AtWork.tsx';
import { weekOf } from './calendar-model.ts';
import { doerOf, isMine, nextNote, questHue, questProgress } from './page-model.ts';
import { openDetail, type PageScope } from './page-state.ts';
import { useWeekTime } from './quest-runs.ts';
import { taskMenu } from './task-menu.ts';
import { TitleEdit } from './TaskEdit.tsx';
import { asView, DetailTop, HistoryHead, RunAgain } from './TodoDetail.tsx';
import { waitingLine } from './waiting.ts';
import { doneText, minutesText, whenOf } from './when-text.ts';

function sub(task: Task, now: number): string {
  if (task.status === 'done') return task.completedAt ? doneText(task.completedAt, now, dayZone.value) : 'done';
  if (task.status === 'dropped') return 'dropped';
  return waitingLine(task, agentName, now) ?? whenOf(task, now, dayZone.value)?.text ?? '';
}

function MiniRow(props: { task: Task; who: string; scope: PageScope; now: number }) {
  const { task } = props;
  const finished = task.status === 'done' || task.status === 'dropped';
  return (
    <li>
      <button type="button" class={`quest-row${finished ? ' done' : ''}${isMine(task) ? ' you' : ''}`} onClick={() => openDetail(props.scope, task.id)}>
        <span class="quest-ck" aria-hidden="true" />
        <span class="quest-who">{props.who}</span>
        <span class="quest-what"><span class="quest-title">{task.title}</span>{sub(task, props.now) && <span class="quest-sub">{sub(task, props.now)}</span>}<PlanSummary task={task} /></span>
      </button>
    </li>
  );
}

/** "AI this week 1 h 50 min" – nothing while it is read or when no agent turn ran on it this week. */
function AiWeek(props: { quest: Task; todos: readonly Task[]; now: number }) {
  const zone = dayZone.value;
  const since = wallTime(weekOf(wallOf(props.now, zone).date)[0], 0, zone);
  const week = useWeekTime(props.quest, props.todos, since);
  if (!week?.runs) return null;
  return <span class="quest-week">AI this week <b class="tabular">{week.partial ? 'at least ' : ''}{minutesText(week.ms / 60_000)}</b></span>;
}

export function QuestDetail(props: { scope: PageScope; quest: Task; todos: readonly Task[]; schedules: readonly Schedule[]; now: number; onClose: () => void }) {
  const { quest, now } = props;
  const build = () => taskMenu(asView(quest), props.scope);
  const menu = useContextMenu(build);
  const order = (a: Task, b: Task) => Number(a.status === 'done' || a.status === 'dropped') - Number(b.status === 'done' || b.status === 'dropped') || a.sort - b.sort || a.createdAt - b.createdAt;
  const yours = props.todos.filter(isMine).sort(order);
  const others = props.todos.filter((task) => !isMine(task)).sort(order);
  const progress = questProgress(props.todos);
  const lead = quest.assigneeKind === 'agent' && quest.assigneeId ? agentName(quest.assigneeId) : 'You';
  const note = nextNote(props.schedules, new Set([quest.id, ...props.todos.map((task) => task.id)]));
  const noteWhen = note?.nextAt !== undefined ? whenOf({ at: note.nextAt, minutes: 1 }, now, dayZone.value)?.text : undefined;
  const closed = quest.status === 'done' || quest.status === 'dropped';
  return (
    <div class="task-detail quest" style={{ '--qc': `var(--wf-c${questHue(quest.id)})` }}>
      <DetailTop scope={props.scope} quest={quest} label={`Quest · ${lead} ${lead === 'You' ? 'lead' : 'leads'}${closed ? ` · ${quest.status}` : ''}`} menu={build} onClose={props.onClose} />
      <div class="detail-body" {...menu}>
        <TitleEdit task={quest} label={quest.title} />
        {quest.doneWhen && <p class="quest-done-when"><b>Done when:</b> {quest.doneWhen}</p>}
        <div class="quest-progress">
          <span class="quest-stats">
            <span class="quest-done-count"><b class="tabular">{progress.done}</b> of {progress.total} done</span>
            <AiWeek quest={quest} todos={props.todos} now={now} />
          </span>
          <span class="quest-bar" aria-hidden="true"><i style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} /></span>
        </div>
        <TaskPlan task={quest} scope={props.scope} />
        {closed && <RunAgain scope={props.scope} task={quest} />}
        <h4 class="detail-label">For you</h4>
        <ul class="quest-rows">
          {yours.map((task) => <MiniRow key={task.id} task={task} who="You" scope={props.scope} now={now} />)}
          {!yours.length && <li class="tasks-empty">Nothing for you in this quest.</li>}
        </ul>
        {others.length > 0 && (
          <>
            <h4 class="detail-label">AI and team</h4>
            <ul class="quest-rows">
              {others.map((task) => <MiniRow key={task.id} task={task} who={doerName(doerOf(task))} scope={props.scope} now={now} />)}
            </ul>
          </>
        )}
        {note && <p class="ai-note"><Icon name="bell" size={13} /><b>{agentName(note.ownerId)} · next note{noteWhen ? ` ${noteWhen}` : ''}:</b> {note.payload.note ?? note.title}</p>}
        {quest.notes.trim() && <Markdown text={quest.notes} class="task-notes" />}
      </div>
      <HistoryHead task={quest} now={now} />
      <TaskThread taskId={quest.id} />
    </div>
  );
}
