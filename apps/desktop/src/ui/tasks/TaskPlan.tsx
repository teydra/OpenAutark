// A task's checklist in its detail (P4/P5): each item a 44-px row to tick, an item handed over shows its owner's avatar
// and ticks by itself when its own task is done (its tick here stays the person's to set too). The list is written as
// lines through the guarded update; the runtime keeps each item's id, owner and task by its words (task-plan.ts).
// Owns: the checklist's rendering and the toggle. Never: marks the task itself done.
import { useState } from 'preact/hooks';
import type { Task } from '../../shared/model/tasks.ts';
import { planProgress, readChecklist, writePlan } from '../../shared/model/task-plan.ts';
import { AgentAvatar } from '../lib/avatar.tsx';
import { agentName, agents } from '../lib/store.ts';
import { handOverItem, setPlan } from './page-actions.ts';
import { can } from '../lib/session.ts';
import { recipientGroups } from './center-model.ts';
import { recipientPeople } from './RecipientMenu.tsx';
import { openDetail, type PageScope } from './page-state.ts';

export function PlanSummary(props: { task: Task }) {
  const { done, total, next } = planProgress(props.task.ledger.plan);
  if (!total) return null;
  return <span class="task-plan-summary" title={next ? `Next: ${next}` : undefined}>☑ {done}/{total}{next ? ` · ${next}` : ''}</span>;
}

export function TaskPlan(props: { task: Task; scope?: PageScope }) {
  const { task } = props;
  const [busy, setBusy] = useState(false);
  const plan = readChecklist(task.ledger);
  if (!plan.length) return null;
  const groups = recipientGroups(agents.value, recipientPeople(true));
  const recipients = [...groups.agents, ...groups.people];
  const closed = task.status === 'done' || task.status === 'dropped';
  const toggle = async (index: number) => {
    if (busy || closed) return;
    setBusy(true);
    try {
      const next = plan.map((item, i) => i === index ? { ...item, done: !item.done } : item);
      await setPlan(task, writePlan(next));
    } finally { setBusy(false); }
  };
  return (
    <section aria-label="Checklist">
      <h4 class="detail-label">Checklist</h4>
      <PlanSummary task={task} />
      <ul class="task-plan">
        {plan.map((item, index) => (
          <li key={item.id} class={item.done ? 'done' : undefined} data-item-id={item.id}>
            <label>
              <input type="checkbox" checked={item.done} disabled={closed || busy} onClick={(event) => {
                event.preventDefault();
                void toggle(index);
              }} />
              <span class="task-plan-text">{item.text}</span>
            </label>
            {!closed && !item.done && can('tasks.handOverItem') && (
              <select class="task-plan-hand-over" aria-label={`Hand over: ${item.text}`} value="" disabled={busy} onChange={async (event) => {
                const target = event.currentTarget;
                const to = target.value;
                target.value = '';
                if (!to) return;
                setBusy(true);
                try { await handOverItem(task, item.id, to); } finally { setBusy(false); }
              }}>
                <option value="">Hand over</option>
                <option value="human">Me</option>
                {recipients.map((recipient) => <option key={recipient.target.id} value={recipient.target.id}>{recipient.label}</option>)}
              </select>
            )}
            {item.owner && (
              <button type="button" class="task-plan-owner" title={item.taskId ? `${agentName(item.owner)} · open their task` : agentName(item.owner)}
                aria-label={item.taskId ? `Handed to ${agentName(item.owner)} – open their task` : `Handed to ${agentName(item.owner)}`}
                disabled={!item.taskId} onClick={() => { if (item.taskId) openDetail(props.scope ?? 'main', item.taskId); }}>
                <AgentAvatar agentId={item.owner} size={24} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
