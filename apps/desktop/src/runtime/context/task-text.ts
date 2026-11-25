// A quest or to-do whole, as the agent reads it (Quests round 20.11.2026: "## Current quest" / "## Current to-do" and
// tasks.list with an id, context/quest-text.ts adds the quest as it stands): its id and state (open, waiting on whom
// since when, paused, done, dropped), the person's time – work among agents has none (VERGESSEN.md finding 1) –, the chat
// it was handed over in, who gave it, done-when, its wait, notes (whole – bounded where they are written), files with
// their place, the plan with ✓, facts and the result. The goal chain for the checkpoint. Times in the live part's one
// absolute form (time.ts dueText; a day without a time by its day – todoWhen).
// Owns: that rendering and its caps; the walk up the parents (bounded, cycle-safe).
// Never: claims verification the task row does not record, counts turns, or prints a time on agent work.

import type { RuntimeServices } from '../contracts.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { isFinished, isPaused, type Task, type TaskView } from '../../shared/model/tasks.ts';
import { planProgress } from '../../shared/model/task-plan.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { dueText, todoWhen } from './time.ts';
import { attachmentLines } from './render.ts';
import { namesFor, waitWords, type NoteNames } from '../tasks/names.ts';

const MAX_FACTS = 8;

/** Titles of the parent chain, nearest first (max 4). */
export function goalChain(services: RuntimeServices, task: Task): string[] {
  const out: string[] = [];
  const seen = new Set([task.id]);
  let parentId = task.parentId;
  while (parentId && !seen.has(parentId) && out.length < 4) {
    seen.add(parentId);
    const parent = services.tasks.get(parentId);
    if (!parent) break;
    out.push(parent.title);
    parentId = parent.parentId;
  }
  return out;
}

/** The files the task was posted with, each with its place (no file reads here; media.view/media.transcribe open them). */
function fileLines(services: RuntimeServices, task: TaskView, zone: string, now: number): string[] {
  if (!task.files?.length) return [];
  try {
    return attachmentLines({ services, agentId: task.assigneeId ?? '', humanName: '', zone, now }, task.files, undefined, false).lines;
  } catch {
    return task.files.map((file) => `[Attached file: ${file.name}] (${file.mime}, ${file.fileId})`);
  }
}

/** Its state in words: "open", "waiting on Felix since Thu 12 Nov 19:41: why", "paused by Felix", "done", "dropped". */
export function stateWords(task: Pick<Task, 'status' | 'waitingOn'>, names: NoteNames, now: number, why = true): string {
  const wait = task.waitingOn;
  if (task.status !== 'waiting' || !wait) return task.status;
  if (isPaused(task)) return `paused by ${names.nameOf(wait.who ?? HUMAN_ID)}`;
  return `waiting on ${waitWords(task, names)} since ${dueText(wait.since, names.zone, now)}${why ? `: ${excerpt(wait.why, 120)}` : ''}`;
}

/** Creation is immutable; task movement is not the same as a technical row update. */
export function taskAge(task: Task, zone: string, now: number): string {
  const created = `Created on ${dueText(task.createdAt, zone, now)}`;
  return isFinished(task.status) ? created : `${created} · Stuck since ${dueText(task.ledger.movedAt ?? task.createdAt, zone, now)}`;
}

export function checklistSummary(task: Task, nextLimit = 100): string | undefined {
  const { done, total, next } = planProgress(task.ledger.plan);
  if (total) return `☑ ${done}/${total}${next ? ` · Next: ${excerpt(next, nextLimit)}` : ''}`;
}

export const checklistSuffix = (task: Task): string => {
  const summary = checklistSummary(task);
  return summary ? ` · ${summary}` : '';
};

/** The whole quest or to-do under `heading`. */
export function renderTask(services: RuntimeServices, task: TaskView, zone: string, heading: string): string {
  const now = services.clock.now();
  const names = namesFor(services, zone);
  const head = [task.id, stateWords(task, names, now, false)];
  if (task.priority > 0) head.push(task.priority === 2 ? 'urgent' : 'high priority');
  if (task.at !== undefined && task.assigneeKind !== 'agent') head.push(`at ${todoWhen({ at: task.at, minutes: task.minutes }, zone, now)}${task.minutes ? ` for ${task.minutes} min` : ''}`);
  if (task.conversationId) head.push(`handed over in ${task.conversationId}`);
  const lines = [heading, head.join(' · '), `Title: ${task.title}`, `Owner: ${names.nameOf(task.assigneeKind === 'agent' ? task.assigneeId ?? '' : task.assigneeId ?? HUMAN_ID)}`];
  lines.push(taskAge(task, zone, now));
  const giver = task.assignedBy ?? task.createdBy;
  if (giver !== task.assigneeId && giver !== (task.assigneeId ?? HUMAN_ID)) lines.push(`Given by: ${names.nameOf(giver)}`);
  if (task.doneWhen || !isFinished(task.status)) lines.push(`Done when: ${task.doneWhen || 'not set yet.'}`);
  if (task.status === 'waiting' && task.waitingOn) {
    const state = stateWords(task, names, now);
    lines.push(`${state[0].toUpperCase()}${state.slice(1)}`);
    const { until, followedUp } = task.waitingOn;
    if (until !== undefined) lines.push(`Follow-up: ${dueText(until, zone, now)}${followedUp ? ' (sent)' : ''}`);
  }
  if (task.dependsOn?.length) lines.push(`After: ${task.dependsOn.join(', ')}`);
  if (task.notes.trim()) lines.push(`Notes:\n${task.notes.trim()}`);
  const files = fileLines(services, task, zone, now);
  if (files.length) lines.push(`Files:\n${files.join('\n')}`);
  const plan = task.ledger.plan ?? [];
  if (plan.length) lines.push(`Checklist: ${checklistSummary(task, 300)}\n${plan.slice(0, 20).map((line) => excerpt(line, 300)).join('\n')}`);
  const facts = (task.ledger.facts ?? []).slice(-MAX_FACTS);
  if (facts.length) lines.push(`Facts:\n${facts.map((fact) => `- ${excerpt(fact, 300)}`).join('\n')}`);
  if (task.result) {
    const evidence = task.result.evidence.map((item) => item.label).slice(0, 6).join('; ');
    const note = task.result.verificationNote?.trim();
    lines.push(`Result: ${excerpt(task.result.summary, 300)} (${task.result.verification.replace(/_/g, ' ')})${evidence ? ` · evidence: ${evidence}` : ''}${note ? ` – ${note}` : ''}`);
  }
  return lines.join('\n');
}
