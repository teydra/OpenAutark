// Giving work – the one act behind tasks.add {for}, tasks.update {for}, the composer, the person's and a colleague's device,
// a routine, the successor of an archived agent and the watcher's owner pick for a row without one:
//  - receiverOf: who a word names – "me", "team", an agent (id or name), the person (human, their name) or a colleague;
//  - pickOwner ("team"): Autark picks one owner now – one cheap decision among the active agents and the colleagues the
//    giver may give to (a colleague: only agents they work with), each with role, open work and whether it is free right
//    now (Stanislaus 17.11.2026 "welche Mitarbeiter sind gerade aktiv und welcher passt"); a paused agent is no choice –
//    its work would stand until the person resumes it; unsure, no model or
//    fewer than two → the responsible manager; no agent at all → the giver keeps it (an agent or a colleague) or it
//    lands on the person's own list;
//  - giveTask: the colleague rules (people/task-rules.ts) and the chat it lives in, the owner, "given by", its last move,
//    the giver's note as "From <name>: …", the effort the work needs, a quiet line in its chat, the receiver
//    told at once (tell);
//  - tell: an agent hears by a wake on the task, the person by a notification, a colleague by a push.
// Owns: those. Never: gives finished work, gives to an archived or unknown agent, or leaves a task without an owner.

import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { isHumanActor, isPersonId } from '../../shared/model/people.ts';
import { isFinished, isPaused, type Task, type TaskView } from '../../shared/model/tasks.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { Effort } from '../../shared/model/providers.ts';
import type { WakeReason } from '../../shared/model/runs.ts';
import type { NotificationInput, RuntimeServices } from '../contracts.ts';
import type { TaskServiceImpl } from './service.ts';
import { moveTaskChat, responsibleManager, routeOwner, stopRuns } from './owners.ts';
import { checkMayGive } from '../people/task-rules.ts';
import { SURE_CONFIDENCE } from '../decision/service.ts';
import { setTaskRoute, type NextRoute } from '../agents/next-route.ts';
import { recordChange } from './changes.ts';
import '../contracts/people.ts';

/** Who receives work: an agent, the owner (no id) or a colleague (per_…), or "team" before the pick. */
export type Receiver = { kind: 'agent'; id: string } | { kind: 'human'; id?: string } | { kind: 'team'; team?: string };

const SELF = new Set(['me', 'self', 'myself']);
const PICK_TIMEOUT_MS = 20_000;
const NOTES_CHARS = 400;

/** The receiver an id names ("me" is the giver; HUMAN_ID the person; per_… a colleague; else an agent). */
export function receiverOf(id: string, by: string): Receiver {
  const value = SELF.has(id.trim().toLowerCase()) ? by : id.trim();
  if (value === 'team') return { kind: 'team' };
  if (value === HUMAN_ID) return { kind: 'human' };
  if (isPersonId(value)) return { kind: 'human', id: value };
  return { kind: 'agent', id: value };
}

/** The receiver's id as stored (the owner's to-do has none). */
export const receiverId = (to: Receiver): string => to.kind === 'agent' ? to.id : to.kind === 'human' ? to.id ?? HUMAN_ID : 'team';

/** A name for notes and lines. */
export function nameOf(s: Partial<Pick<RuntimeServices, 'org' | 'settings' | 'people'>>, id: string): string {
  if (id === HUMAN_ID) { try { return s.settings?.get().profile.name?.trim() || 'the person'; } catch { return 'the person'; } }
  if (id === SYSTEM_ID) return 'Autark';
  if (isPersonId(id)) return s.people?.nameOf(id) ?? 'a colleague';
  return s.org?.get(id)?.name ?? id;
}

/** Open (and waiting) work per owner, for the pick ("Ida (QA) · 3 open"). */
function loads(s: Pick<RuntimeServices, 'db'>): Map<string, number> {
  const rows = s.db.all<{ who: string | null; n: number }>(
    `SELECT COALESCE(assignee_id, 'human') AS who, COUNT(*) AS n FROM tasks WHERE status IN ('open', 'waiting') GROUP BY who`);
  return new Map(rows.map((row) => [String(row.who), Number(row.n)]));
}

/** Who "team" may land on: active agents (a team's only, with `team`) and the colleagues the giver may give to – never the giver. */
/** A colleague gives only to agents they work with (people/task-rules.ts); everyone else to any agent. */
function mayGiveTo(t: TaskServiceImpl, by: string, agentId: string): boolean {
  if (!isPersonId(by)) return true;
  try { checkMayGive(t.s, by, { kind: 'agent', id: agentId }, undefined); return true; } catch { return false; }
}

/** How an agent is right now, for the pick (idle and waiting agents are free to start). */
const NOW: Partial<Record<Agent['status'], string>> = { working: 'busy right now', error: 'not running right now' };

function candidates(t: TaskServiceImpl, by: string, team?: string): Array<{ id: string; label: string }> {
  const s = t.s;
  const fold = (text: string) => text.trim().toLowerCase();
  const agents = (s.org?.list() ?? []).filter((agent) => agent.archivedAt === undefined && agent.status !== 'paused' && agent.id !== by && (!team || fold(agent.team ?? '') === fold(team)) && mayGiveTo(t, by, agent.id));
  const people = team ? [] : (s.people?.list?.() ?? []).filter((person) => person.id !== by && !person.owner && person.status !== 'revoked' && (() => {
    try { checkMayGive(s, by, { kind: 'human', id: person.id }, undefined); return true; } catch { return false; }
  })());
  const load = loads(s);
  return [
    ...agents.map((agent: Agent) => ({ id: agent.id, label: `${agent.name}${agent.role ? ` (${agent.role})` : ''} · ${load.get(agent.id) ?? 0} open · ${NOW[agent.status] ?? 'free'}` })),
    ...people.map((person) => ({ id: person.id, label: `${person.name}${person.title ? ` (${person.title}, person)` : ' (person)'} · ${load.get(person.id) ?? 0} open` })),
  ];
}

/**
 * "team": the one owner Autark picks now (see the header). `team` (the composer's team label) narrows it to that
 * team's agents. Never undefined: the responsible manager, else the giver (an agent), else the person.
 */
export async function pickOwner(t: TaskServiceImpl, task: Pick<Task, 'title' | 'notes' | 'spaceId'>, by: string, team?: string): Promise<Receiver> {
  const s = t.s;
  const fallback = (): Receiver => {
    const found = s.org ? responsibleManager(s.org, task.spaceId) : undefined;
    const manager = found && mayGiveTo(t, by, found.id) ? found : undefined;
    if (isPersonId(by) && !manager) { // a colleague: an agent they work with, else they keep it
      const agent = options.find((option) => !isPersonId(option.id));
      return agent ? { kind: 'agent', id: agent.id } : { kind: 'human', id: by };
    }
    if (manager && manager.id !== by) return { kind: 'agent', id: manager.id };
    if (!isHumanActor(by) && by !== SYSTEM_ID && s.org?.get(by)) return { kind: 'agent', id: by };
    return manager ? { kind: 'agent', id: manager.id } : { kind: 'human' };
  };
  const options = candidates(t, by, team);
  if (team && options.length === 1) return receiverOf(options[0].id, by);
  let ready = false;
  try { ready = Boolean(s.decisions?.available()); } catch { ready = false; }
  if (!ready || options.length < 2) return fallback();
  try {
    const result = await s.decisions!.decide({
      purpose: 'route', type: 'choice', timeoutMs: PICK_TIMEOUT_MS,
      question: 'Who owns this task? I pick the one whose role fits it best; of those that fit, a free one before a busy one, then the one with less open work.',
      options: options.map((option) => option.label),
      context: `Task: ${excerpt(task.title, 200)}${task.notes.trim() ? `\n${excerpt(task.notes, NOTES_CHARS)}` : ''}`,
    });
    const picked = result.choice && result.confidence >= SURE_CONFIDENCE ? options.find((option) => option.label === result.choice!.trim()) : undefined;
    return picked ? receiverOf(picked.id, by) : fallback();
  } catch (error) {
    s.log?.warn('picking a task owner failed', { error: String(error) });
    return fallback();
  }
}

export interface GiveInput {
  note?: string;
  /** The effort the work needs from here on, for an agent receiver. */
  route?: Omit<NextRoute, 'at' | 'reason'>;
  /** A fact for its ledger ("Taken over from Ida (archived)."). */
  fact?: string;
  /** The giving agent turn's chat (TaskLedger.givenIn). */
  givenIn?: string;
}

/** Gives task `id` to `to` (resolved – "team" goes through pickOwner first); see the header. */
export function giveTask(t: TaskServiceImpl, id: string, to: Receiver, by: string, input: GiveInput = {}): TaskView {
  if (to.kind === 'team') throw new WorkforceError('bad_request', 'Pick the owner first (pickOwner).');
  const s = t.s;
  const before = t.require(id);
  if (isFinished(before.status)) throw new WorkforceError('conflict', 'This task is already finished.', { details: { taskId: id } });
  if (to.kind === 'agent') {
    const agent = s.org?.get(to.id);
    if (s.org && (!agent || agent.archivedAt !== undefined)) throw new WorkforceError('not_found', 'Agent not found.', { details: { agentId: to.id } });
  }
  const toAgentFromPerson = to.kind === 'agent' && before.assigneeKind === 'human';
  if (toAgentFromPerson && before.widget?.type === 'timer') throw new WorkforceError('bad_request', 'A timer stays with the person.', { details: { taskId: id } });
  const chat = checkMayGive(s, by, to, before);
  if (chat && chat !== before.conversationId) moveTaskChat(s, id, chat);
  else if (to.kind === 'agent') routeOwner(t, before, to.id, by);
  const now = s.clock.now();
  const receiver = receiverId(to);
  const note = input.note?.trim();
  const task = t.mutate(id, (draft) => {
    draft.assigneeKind = to.kind;
    if (to.kind === 'human' && !to.id) delete draft.assigneeId; else draft.assigneeId = receiver;
    draft.assignedBy = by;
    if (isPaused(draft)) { draft.status = 'open'; delete draft.waitingOn; } // giving paused work moves it on
    if (toAgentFromPerson) { delete draft.widget; delete draft.private; } // an agent's work has no "Done" button of the person's
    if (to.kind === 'human' && before.assigneeKind === 'agent' && !draft.widget) draft.widget = { type: 'confirm', instructions: draft.title }; // the person's "Done"
    if (note) draft.notes = `${draft.notes.trim() ? `${draft.notes.trimEnd()}\n\n` : ''}From ${nameOf(s, by)}: ${note}`;
    const { givenIn: _before, ...ledger } = draft.ledger; // a new giver hears it where it gave it
    const givenIn = input.givenIn && input.givenIn !== draft.conversationId ? input.givenIn : undefined;
    draft.ledger = { ...ledger, movedAt: now, ...(givenIn ? { givenIn } : {}), ...(input.fact ? { facts: [...(draft.ledger.facts ?? []), input.fact].slice(-20) } : {}) };
    recordChange(draft, before, by, 'give', now);
  });
  const previous = before.assigneeKind === 'agent' ? before.assigneeId : undefined;
  if (previous && previous !== task.assigneeId) {
    s.wakes.cancel(previous, { taskId: id });
    stopRuns(t, before, by); // the person taking work from an agent stops its running turn on it
  }
  if (to.kind === 'agent' && input.route) setTaskRoute(s.db, to.id, id, { ...input.route, reason: `given by ${nameOf(s, by)}`, at: now });
  if (!task.parentId && receiver !== previous) {
    t.line(task, { type: 'handoff', text: `${nameOf(s, by)} → ${nameOf(s, receiver)}`, details: { taskId: id, from: by, to: receiver } }, by);
  }
  const view = t.emit(task);
  if (receiver !== by || to.kind === 'agent') tellGiven(t, task, by);
  return view;
}

/**
 * The receiver of new or given work hears of it at once ("<giver> gave me …"). Work I give myself is no news to me: a bare
 * wake starts a to-do, so a wait I set in the turn that made it stands (FIXES-3b F2.3; agents/turn-prepare.ts B-047), and
 * in its own turn it needs no wake at all; a quest I make myself wakes me never – its to-dos carry the work (FIXREAL 6a,
 * real run 20.11.: two wakes, one with 4 output tokens).
 */
export function tellGiven(t: TaskServiceImpl, task: Task, by: string): void {
  const owner = task.assigneeKind === 'agent' ? task.assigneeId : task.assigneeId ?? HUMAN_ID;
  if (!owner || task.assigneeKind === 'team') return;
  const title = excerpt(task.title, 120);
  if (task.assigneeKind === 'agent') {
    if (owner === by && (task.kind === 'quest' || t.isRunning(task.id, owner))) return; // my own quest, or its own turn on it, knows
    tell(t.s, owner, { reason: 'task', taskId: task.id, conversationId: task.conversationId, ...(owner === by ? {} : { note: `${nameOf(t.s, by)} gave me "${title}".` }) });
    return;
  }
  if (owner === by) return; // the person's own to-do
  tell(t.s, owner, { kind: 'todo', title: `${nameOf(t.s, by)}: ${excerpt(task.title, 80)}`, body: excerpt(task.notes, 160), taskId: task.id, conversationId: task.conversationId });
}

type Tell = { reason: WakeReason; note?: string; taskId?: string; conversationId?: string; key?: string } | NotificationInput;

/**
 * Tells `who`: an agent by a wake (under the task's one key, task:<id>, unless another is given), the person by a
 * notification (desktop and phone), a colleague by a push to their devices (pwa/person-push.ts).
 */
export function tell(s: Pick<RuntimeServices, 'wakes' | 'bus'> & Partial<Pick<RuntimeServices, 'org' | 'notifications'>>, who: string, message: Tell): void {
  if ('reason' in message) {
    const agent = s.org?.get(who);
    if (s.org && (!agent || agent.archivedAt !== undefined)) return;
    s.wakes.wake({
      agentId: who, reason: message.reason, note: message.note, coalesceKey: message.key ?? (message.taskId ? `task:${message.taskId}` : undefined),
      ...(message.conversationId ? { conversationId: message.conversationId } : {}), ...(message.taskId ? { taskId: message.taskId } : {}),
    });
    return;
  }
  if (who === HUMAN_ID) s.notifications?.notify(message);
  else if (isPersonId(who)) s.bus.emit('person.notice', { personId: who, ...message });
}

