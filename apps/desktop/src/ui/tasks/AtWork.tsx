// "At work" on the Tasks page (owner 19.11.2026: "das kann man aufklappen, das sieht man standardmäßig nicht"; review
// R2.9: work the person gave on shows here too): one line, closed by default – how many open to-dos the agents, the
// colleagues and the team have in how many quests, how many run now, whose note comes next. Open: per quest (a click on
// its name opens the quest) who is on what – running now, what it waits on and since when, "after …" for a to-do in
// order, what it finished today – and the next note an agent left itself about the quest. An agent's "All tasks"
// (?owner=) opens it narrowed to that agent, with a × to show everyone again.
// Owns: the bar, the open list and how a doer is named. Never: the selection rules (page-model.ts) or any call.

import type { Schedule, Task } from '../../shared/model/tasks.ts';
import { dayZone } from '../lib/day-store.ts';
import { agentName } from '../lib/store.ts';
import { Icon } from '../lib/ui.tsx';
import { soonestNote, workSummary, type WorkGroup } from './page-model.ts';
import { clearOwner, openDetail, toggle, workOpen, type PageScope } from './page-state.ts';
import { planProgress } from '../../shared/model/task-plan.ts';
import { ageOf, waitingLine } from './waiting.ts';
import { doneText, noteWhenText, whenOf } from './when-text.ts';

/** A doer's name (page-model.ts doerOf): the agent's or colleague's, "Team" while Autark has not picked one. */
export function doerName(who: string): string {
  return who === 'team' ? 'Team' : agentName(who);
}

/** A line's state: running now, its wait, "after <to-do>", what it finished, else open. */
function stateOf(line: WorkGroup['lines'][number], index: ReadonlyMap<string, Task>, now: number): string {
  const { task } = line;
  if (line.running) return 'running now';
  if (task.status === 'done') return doneText(task.completedAt ?? task.updatedAt, now, dayZone.value);
  const waiting = waitingLine(task, agentName, now, dayZone.value);
  if (waiting) return waiting.replace(/^Waiting on/, 'waits on');
  const before = (task.dependsOn ?? []).map((id) => index.get(id)).find((other) => other && other.status !== 'done' && other.status !== 'dropped');
  if (before) return `after ${before.title}`;
  return 'open';
}

/** A line's checklist ("☑ 1/3"), when it was created and – while it is stuck – since when (Mika's S9 review 27.11.2026). */
function LineAge(props: { task: Task; now: number }) {
  const { task } = props;
  const { done, total } = planProgress(task.ledger?.plan);
  const age = task.status === 'done' || task.status === 'dropped' ? undefined : ageOf(task, props.now, dayZone.value);
  if (!total && !age) return null;
  return (
    <span class="ai-age">
      {total > 0 && <span>☑ {done}/{total}</span>}
      {age && <span>{age.created}</span>}
      {age?.stuck && <span class="late">{age.stuck}</span>}
    </span>
  );
}

function noteLine(note: Schedule, now: number): string {
  const when = note.nextAt !== undefined ? whenOf({ at: note.nextAt, minutes: 1 }, now, dayZone.value)?.text : undefined;
  return `${agentName(note.ownerId)} · next note${when ? ` ${when}` : ''}: ${note.payload.note ?? note.title}`;
}

export function AtWork(props: { scope: PageScope; groups: WorkGroup[]; schedules: readonly Schedule[]; index: ReadonlyMap<string, Task>; owner?: string; now: number }) {
  const { groups, now } = props;
  const open = workOpen.value || Boolean(props.owner);
  const next = soonestNote(props.schedules, now);
  const summary = workSummary(groups, next?.nextAt !== undefined ? { name: agentName(next.ownerId), clock: noteWhenText(next.nextAt, now, dayZone.value) } : undefined);
  const live = groups.some((group) => group.lines.some((line) => line.running));
  return (
    <section class="ai-work" aria-label="At work">
      <button type="button" class={`ai-bar${open ? ' open' : ''}`} aria-expanded={open} onClick={() => { if (props.owner) clearOwner(); else toggle(workOpen); }}>
        <span class={`ai-live${live ? ' on' : ''}`} aria-hidden="true" />
        <span class="ai-bar-text">
          <b>At work{props.owner ? ` · ${doerName(props.owner)}` : ''}</b>
          <span class="ai-bar-sub">{summary}</span>
        </span>
        <Icon name={props.owner ? 'x' : 'caret-right'} size={14} />
      </button>
      {open && (
        <div class="ai-list">
          {groups.map((group) => (
            <div key={group.key || 'other'} class="ai-group" style={{ '--qc': group.quest ? `var(--wf-c${group.hue})` : 'var(--muted)' }}>
              <button type="button" class="ai-group-head" disabled={!group.quest} onClick={() => { if (group.quest) openDetail(props.scope, group.quest.id); }}>
                <span class="task-dot" aria-hidden="true" />{group.quest?.title ?? 'Other'}
              </button>
              {group.lines.map((line) => (
                <button key={line.task.id} type="button" class={`ai-line${line.task.status === 'done' ? ' done' : ''}`} onClick={() => openDetail(props.scope, line.task.id)}>
                  <span class="ai-who">{doerName(line.who)}</span>
                  <span class="ai-what">
                    <span class="ai-title">{line.task.title}</span>
                    <span class="ai-state">{line.running && <span class="ai-live on" aria-hidden="true" />}{stateOf(line, props.index, now)}</span>
                    <LineAge task={line.task} now={now} />
                  </span>
                </button>
              ))}
              {group.note && <p class="ai-note"><Icon name="bell" size={13} />{noteLine(group.note, now)}</p>}
            </div>
          ))}
          {!groups.length && <p class="tasks-empty">Nobody else has open work{props.owner ? ' here' : ''}.</p>}
        </div>
      )}
    </section>
  );
}
