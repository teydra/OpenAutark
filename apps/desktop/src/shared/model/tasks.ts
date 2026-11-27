// Task model ("simplified Asana"), human to-dos with adaptive widgets, and schedules.
// A task is its own row of one of two kinds (Quests round 20.11.2026): a quest – a goal with an end (doneWhen), owned by an
// agent or a person, holding to-dos – or a to-do – one thing one owner does, in a quest (parentId) or not. One level only:
// a quest never sits in a quest, a to-do never holds to-dos. `at`/`minutes` is the one "when" of a task: a person does it
// then (calendar, ring); an agent's shows on the calendar's AI lane and never wakes anyone by itself. `conversationId` is
// the chat it was handed over in, if any (its anchor message). Four stored states – open, waiting (on whom or what, why,
// since), done, dropped; "working" is only a live run on it (TaskView.running).
// Owns: shapes for tasks, results/evidence, schedules, and the pause marker (isPaused).
// Never: a second task world – the Tasks page, the PWA and the phone are queries over these rows.

import type { UiBlock } from '../blocks/catalog.ts';
import type { Attachment } from './chat.ts';
import type { Origin } from './origin.ts';

export type TaskStatus = 'open' | 'waiting' | 'done' | 'dropped';

/** A quest holds to-dos (one level); a to-do is one thing one owner does. */
export type TaskKind = 'quest' | 'todo';
export const TASK_KINDS: readonly TaskKind[] = ['quest', 'todo'];

/** 'team' is only on rows an older PC still sends: the watcher gives such a task an owner (runtime/tasks/watch.ts). */
export type AssigneeKind = 'team' | 'agent' | 'human';

export type Verification = 'reported_by_human' | 'claimed_by_agent' | 'verified';

export interface Evidence {
  kind: 'file' | 'link' | 'tool' | 'check' | 'note' | 'screenshot';
  label: string;
  ref?: string; // file id, url, run item id …
}

export interface TaskResult {
  summary: string; // what came out – for a dropped task why ("Dropped by Felix: …")
  alsoHandled?: string[]; // side work everyone should know ("Also handled: …")
  evidence: Evidence[];
  followUps?: Array<{ scheduleId?: string; taskId?: string; label: string }>;
  verification: Verification;
  answer?: unknown; // structured answer from a human widget (record/choice/form …)
  /** Why a claimed result is not 'verified' ("Not independently checked: …"), one muted line under the result. */
  verificationNote?: string;
  /** Finished quietly (a quest closing its to-dos, a removed message) – nobody gets a notice. */
  quiet?: true;
}

/** One logged change of a task (runtime/tasks/changes.ts): who changed which of the logged fields, with the values before and after (null = none). */
export interface TaskChange {
  id: string;
  at: number;
  by: string; // the actor's id: 'human', a per_… id, 'system' or an agent id
  kind: 'update' | 'finish' | 'give';
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** Set when it was undone (tasks.undo), and by whom. */
  undone?: number;
  undoneBy?: string;
}

/**
 * One checklist item (P5): a stable id, its words, its tick, and – once handed over – who does it and the linked task that
 * ticks it when done (shared/model/task-plan.ts; runtime/tasks/checklist.ts).
 */
export interface ChecklistItem { id: string; text: string; done: boolean; owner?: string; taskId?: string }

/** What a task keeps across turns and owners (the ledger column: one JSON container, read as it is by older PCs too). */
export interface TaskLedger {
  plan?: string[]; // the steps, "✓ " before a done one (tasks.update plan) – kept in step with checklist for older PCs
  checklist?: ChecklistItem[]; // the same steps with ids, owners and linked tasks (read through task-plan.ts readChecklist)
  item?: { of: string; id: string }; // this task is checklist item `id` of task `of`, handed over (its end ticks it there)
  again?: string; // the finished task this one runs again ("Run again")
  facts?: string[]; // lines learned or decided, kept for whoever works on it next
  movedAt?: number; // its last real move: a status change, a new plan or fact, a give, a finished to-do
  doneCount?: number; // how often the person ticked off a repeating to-do (its author hears only the first)
  ringedAt?: number; // the ring time the person was last pushed for (tasks/watch.ts): the PC that comes back does not ring it twice
  escalated?: { since: number; level: number }; // the stuck escalation told up to this step (1 manager, 2 head) for the standstill since (tasks/stuck-escalation.ts)
  givenIn?: string; // the chat of the agent turn that gave it, when that is not its own chat: where the giver hears how it ended
  changes?: TaskChange[]; // the last logged changes within 24 hours (the undo's source; runtime/tasks/changes.ts)
}

/** What a waiting task waits on: a person or agent (`who`), tasks (`ids`), or something outside – `why` in one short line. */
export interface TaskWait {
  on: 'who' | 'task' | 'outside';
  who?: string; // an agent id, 'human' (the owner) or a colleague's per_… id
  ids?: string[]; // on 'task'
  why: string;
  since: number;
  until?: number; // local follow-up instant, independent of the calendar's at
  followedUp?: boolean; // delivery recorded for this deadline
  later?: true; // the person said "Later" on its card: the card rests until `until`, then its owner follows up (P7)
}

export interface Task {
  id: string;
  kind: TaskKind;
  conversationId?: string; // the chat it was handed over in; absent = a chat-free task (Tasks page, mail, reminder …)
  messageId?: string; // anchor message (kind 'task') in its chat; to-dos of a quest and chat-free tasks have none
  parentId?: string; // a to-do's quest
  title: string; // the goal, short
  notes: string; // what is to be done now (markdown)
  status: TaskStatus;
  assigneeKind: AssigneeKind;
  assigneeId?: string; // agent id or a colleague's per_… id; absent (or 'human') for the owner
  createdBy: string; // 'human', a per_… id, 'system' or an agent id
  priority: 0 | 1 | 2; // 0 normal, 1 high, 2 urgent
  at?: number; // the one "when" (epoch ms): a person does it then (calendar, ring); an agent's shows on the AI lane
  minutes?: number; // how long it takes (its length on the calendar)
  doneWhen?: string; // the outcome in one line (checked once by the verifier, tasks/verification.ts)
  dependsOn?: string[]; // the tasks this one comes after (tasks/depends.ts)
  widget?: UiBlock; // how a person answers (ask block from the catalog)
  waitingOn?: TaskWait;
  result?: TaskResult;
  ledger: TaskLedger;
  sort: number;
  rev: number; // optimistic concurrency counter
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  /** Who last gave it its owner ("given by"); that giver hears how it ends. */
  assignedBy?: string;
  private?: boolean; // "Only me": the person does it themselves – the AI sees it and helps around it, never takes it over
  spaceId?: string; // set only on a chat-free task; a task with a chat gets its space from that chat
  origin?: Origin; // why it exists (runtime-written)
  files?: Attachment[]; // the files it was posted with (a quick task's)
}

/** A task with its to-dos (a quest's), as rendered in chats and on the Tasks page. */
export interface TaskView extends Task {
  steps: Task[]; // a quest's to-dos (none for a to-do)
  progress: { done: number; total: number };
  conversationTitle: string; // '' when the task has no chat
  running: boolean; // a turn runs on it right now ("Working")
}

export interface TaskFilter {
  conversationId?: string;
  kind?: TaskKind;
  status?: TaskStatus[];
  assigneeKind?: AssigneeKind;
  assigneeId?: string;
  spaceId?: string;
  search?: string;
  includeSteps?: boolean;
  limit?: number;
  /** Only tasks finished (done/dropped) at or after this epoch ms. */
  completedSince?: number;
  /** Unfinished tasks this actor gave (assigned_by, else created_by) that someone else owns – "Given by me". */
  givenBy?: string;
}

export interface CreateTaskInput {
  conversationId?: string; // the chat to hand it over in; absent = a chat-free task
  origin?: Origin; // why it exists (runtime code only – never taken from an agent's or a person's input)
  spaceId?: string; // runtime only – a chat-free task's space (a quick task's chosen space); ignored with a chat
  kind?: TaskKind; // default 'todo'
  title: string;
  notes?: string;
  plan?: string[];
  checklist?: ChecklistItem[]; // runtime only – the checklist with ids, owners and linked tasks (plan follows from it)
  item?: { of: string; id: string }; // runtime only – the checklist item this task is (runtime/tasks/checklist.ts)
  again?: string; // runtime only – the finished task this one runs again
  waitingOn?: Omit<TaskWait, 'since'>; // runtime only: create directly in a wait
  givenIn?: string; // runtime only – the giving agent turn's chat (TaskLedger.givenIn)
  assigneeKind?: AssigneeKind;
  assigneeId?: string;
  at?: number;
  minutes?: number;
  priority?: Task['priority'];
  doneWhen?: string;
  dependsOn?: string[];
  parentId?: string; // the quest a to-do goes into
  widget?: UiBlock;
  clientId?: string;
  files?: Attachment[]; // runtime only – a quick task's stored files (tasks/quick.ts)
  private?: boolean;
}

export const UNFINISHED: readonly TaskStatus[] = ['open', 'waiting'];

export function isFinished(status: TaskStatus): boolean { return status === 'done' || status === 'dropped'; }

/** How a person's to-do repeats (its timer widget's `repeat`; a Done moves its `at` to the next time). */
export const TODO_REPEATS = ['daily', 'weekdays', 'weekly'] as const;
export type TodoRepeat = (typeof TODO_REPEATS)[number];

/** Every task of the lists once by id, a quest's to-dos (its steps) included; of two copies the newer (rev) wins. */
export function everyTask(...lists: ReadonlyArray<readonly TaskView[]>): Map<string, Task> {
  const byId = new Map<string, Task>();
  const put = (task: Task) => { const known = byId.get(task.id); if (!known || task.rev > known.rev) byId.set(task.id, task); };
  for (const list of lists) for (const task of list) { put(task); for (const step of task.steps ?? []) put(step); }
  return byId;
}

/** The wait a person's Stop leaves: "Paused by you" – nothing runs on it until they or its owner move it on. */
export const PAUSED_REASON = 'Paused by you';

export function isPaused(task: Pick<Task, 'status' | 'waitingOn'>): boolean {
  return task.status === 'waiting' && task.waitingOn?.on === 'who' && task.waitingOn.why === PAUSED_REASON;
}

// ---------------------------------------------------------------- schedules

export type ScheduleKind =
  | 'message' // a visible chat message sent at the given time (as if typed then) – "Send later"
  | 'reminder'; // an agent's own note at a time, once or repeating (taskId: the quest or to-do it is about)

export interface ScheduleSpec {
  at?: number; // one-off epoch ms; with cron / times "not before", with everyMs the interval's anchor
  cron?: string; // 5-field cron (croner syntax)
  everyMs?: number; // fixed interval (>= 60_000)
  times?: string[]; // B-044: clock times each local day ("09:00", "13:30"; 1–24, in `tz`) – several times a day without cron
  tz?: string; // IANA zone; default OS zone
  until?: number;
  maxRuns?: number;
  except?: string[]; // YYYY-MM-DD dates to skip
  days?: number[]; // only fire on these local weekdays (0 Sunday … 6 Saturday, in `tz`)
  window?: { from: string; to: string }; // only fire between HH:MM and HH:MM
  catchUp?: 'once' | 'all' | 'skip'; // what to do with fires missed while the PC was off
}

export interface Schedule {
  id: string;
  ownerId: string; // 'human' or agent id
  conversationId?: string;
  taskId?: string;
  kind: ScheduleKind;
  title: string; // shown as a small chip ("Look at the signing quest · daily 09:00")
  spec: ScheduleSpec;
  payload: { body?: string; note?: string; mentions?: string[]; priority?: 'normal' | 'important'; silent?: boolean; ultra?: true }; // silent (B-050 K4): a quiet scheduled message; ultra (B-057): Ultra suggested for it
  nextAt?: number;
  lastAt?: number;
  runs: number;
  active: boolean;
  pausedBy?: string; // B-044: who paused it ('human' or an agent id); only the person resumes what the person paused
  createdAt: number;
}

/**
 * A schedule that still runs: neither paused nor ended (a one-off that fired, its runs used up). Owner 21.11.2026: what
 * no longer runs reaches an agent only when it asks for it – its context and its default lists hold the running ones.
 */
export function stillRuns(schedule: Pick<Schedule, 'active'>): boolean {
  return schedule.active;
}

// ---------------------------------------------------------------- mini-app to-dos (addition F01)

/**
 * The widget of a to-do an agent programmed itself (an ```app todo=true fence): it points back at
 * the fence – the message stays the only copy of the app's HTML – and is no catalog block (never
 * validated as an ask block, no "Show as…", no timer). Stored in the to-do's widget column.
 * `Task.widget` is still typed `UiBlock`; read it as a TodoWidget through
 * shared/blocks/app-todo.ts `appWidgetOf`.
 */
export interface AppTodoWidget {
  type: 'app';
  messageId: string; // the agent message that holds the fence
  index: number; // the fence's parse index (the chat's blockIndex)
  title?: string;
  permissions: string[]; // what the app may ask the person for (granted by them, once)
  expand?: boolean;
}

/** What a human to-do's widget column holds: a catalog ask block or a mini-app. */
export type TodoWidget = UiBlock | AppTodoWidget;

// ---------------------------------------------------------------- declined to-dos (addition F06)

/**
 * The answer that declines a to-do ("Can't do this…", todos.decline): exactly these keys. The dropped to-do keeps it as `result.answer`.
 */
export interface DeclineAnswer {
  declined: true;
  reason?: string; // one line, why the person cannot or will not do it
}
