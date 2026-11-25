// A security approval request as the person's to-do (Sicher-Runde 19.11.2026): a choice with "Allow once", "Always:
// <switch>", "Always: <place>" (when the request names one) and "Decline", chat-free, so it stands in My day and is pushed
// like every new to-do (tasks/give.ts tellGiven). Made by the app itself (SYSTEM_ID, FX1 19.11.2026: the asking agent is
// named in the title, but the to-do is not its own to finish or drop) with the runtime's own widget; its client id
// `apr:<request id>` is how an answer finds the request – an agent's own to-do can never carry it. Who may answer how:
// security/rpc-guard.ts answerAs (tasks/human.ts).
// Answering it goes to the security service (security.answer) and posts no chat line; the service then ends the to-do
// quietly with the answer as its result, also when the person answered in Settings › Security.
// Owns: the to-do's shape, finding the request of a to-do, ending it. Never: decides or applies an answer (security/service.ts).

import type { RuntimeServices } from '../contracts.ts';
import type { ApprovalAnswer } from '../../shared/model/security-settings.ts';
import { SECURITY_LABELS } from '../../shared/model/security-settings.ts';
import type { ApprovalRequest } from '../../shared/api/methods-security-mode.ts';
import type { UiBlock } from '../../shared/blocks/catalog.ts';
import type { Db } from '../db/database.ts';
import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';

const PREFIX = 'apr:';
const ANSWERS: readonly ApprovalAnswer[] = ['once', 'setting', 'place', 'decline'];

type TodoServices = Partial<Pick<RuntimeServices, 'tasks' | 'log' | 'devices'>>;

/** The PC whose rules closed it (Umzug 21.11.2026: each PC keeps its own mode; the to-do reaches every PC). */
function pcName(s: TodoServices): string {
  try { return s.devices?.self().name || 'this PC'; } catch { return 'this PC'; }
}

/** The choice the person answers. */
export function approvalWidget(request: Pick<ApprovalRequest, 'agentName' | 'summary' | 'capability' | 'place'>): UiBlock {
  const options = [
    { value: 'once', label: 'Allow once' },
    { value: 'setting', label: `Always: ${SECURITY_LABELS[request.capability]}` },
    ...(request.place ? [{ value: 'place', label: `Always: ${request.place.value}` }] : []),
    { value: 'decline', label: 'Decline' },
  ];
  return { type: 'choice', question: questionOf(request), options } as unknown as UiBlock;
}

/** The question: a new site (web 'chosen', 25.11.2026) in its own words, everything else as "<agent>: <step>". */
export function questionOf(request: Pick<ApprovalRequest, 'agentName' | 'summary' | 'capability' | 'place'>): string {
  if (request.capability === 'web' && request.place?.kind === 'site') return `${request.agentName} wants to open ${request.place.value} for the first time. Allow this site?`;
  return `${request.agentName}: ${request.summary}`;
}

/** Makes the to-do; its id, or undefined where there is no task service (tests, a headless start before it). */
export function openApprovalTodo(s: TodoServices, request: ApprovalRequest): string | undefined {
  if (!s.tasks) return undefined;
  // TaskServiceImpl's own options (tasks/create.ts CreateOptions): the client id, and the widget is the runtime's
  const options: { fromRun?: string } & Record<string, unknown> = { clientId: `${PREFIX}${request.id}`, runtimeWidget: true };
  const view = s.tasks.create({
    title: (request.place?.kind === 'site' && request.capability === 'web' ? questionOf(request) : `${request.agentName} asks: ${request.summary}`).slice(0, 200), assigneeKind: 'human', widget: approvalWidget(request),
    notes: `${SECURITY_LABELS[request.capability]} is closed on ${pcName(s)} until you answer.`, createdBy: SYSTEM_ID, priority: 1,
    origin: { source: 'security', label: 'Security request' },
  }, options);
  return view.id;
}

/** Ends the to-do quietly with the answer (nothing when it is already finished or gone). */
export function closeApprovalTodo(s: TodoServices, todoId: string, answer: ApprovalAnswer, label: string): void {
  try {
    const todo = s.tasks?.get(todoId);
    if (!todo || todo.status === 'done' || todo.status === 'dropped') return;
    s.tasks!.finish(todoId, { status: answer === 'decline' ? 'dropped' : 'done', summary: label, answer: { choice: answer }, quiet: true }, HUMAN_ID);
  } catch (error) {
    s.log?.warn('security request to-do not closed', { todoId, error: String(error) });
  }
}

/** The request id of an approval to-do: its client id apr:<id> (undefined for every other to-do). */
export function approvalIdOf(db: Pick<Db, 'get'>, taskId: string): string | undefined {
  let clientId: string | null | undefined;
  try { clientId = db.get<{ client_id: string | null }>('SELECT client_id FROM tasks WHERE id = ?', [taskId])?.client_id; } catch { return undefined; }
  return clientId?.startsWith(PREFIX) ? clientId.slice(PREFIX.length) : undefined;
}

/** The answer a to-do answer carries ({choice}, {value}, {choices:[…]}, a declined to-do → 'decline'). */
export function approvalAnswer(answer: unknown, declined: boolean): ApprovalAnswer | undefined {
  if (declined) return 'decline';
  const a = (answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : { value: answer }) as Record<string, unknown>;
  const raw = Array.isArray(a.choices) ? a.choices[0] : a.choice ?? a.value;
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return ANSWERS.find((item) => item === value);
}
