// Task checklist UI using the same string-backed plan as agent tools and the existing guarded update.
import { useState } from 'preact/hooks';
import type { Task } from '../../shared/model/tasks.ts';
import { planProgress, readPlan, writePlan } from '../../shared/model/task-plan.ts';
import { setPlan } from './page-actions.ts';

export function PlanSummary(props: { task: Task }) {
  const { done, total, next } = planProgress(props.task.ledger.plan);
  if (!total) return null;
  return <span class="task-plan-summary" title={next ? `Next: ${next}` : undefined}>☑ {done}/{total}{next ? ` · ${next}` : ''}</span>;
}

export function TaskPlan(props: { task: Task }) {
  const { task } = props;
  const [busy, setBusy] = useState(false);
  const plan = readPlan(task.ledger.plan);
  if (!plan.length) return null;
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
          <li key={index}><label>
            <input type="checkbox" checked={item.done} disabled={closed || busy} onClick={(event) => {
              event.preventDefault();
              void toggle(index);
            }} />
            <span>{item.text}</span>
          </label></li>
        ))}
      </ul>
    </section>
  );
}
