// Internal service contracts of the runtime. Modules depend on these interfaces, not on each
// other's classes, so they can be built, tested (with fakes) and replaced independently.
// The composition root (main.ts) creates the implementations and fills `RuntimeServices`.
// Split by topic: contracts/models.ts, contracts/safety.ts and contracts/voice.ts (re-exported here).
// Owns: interface shapes only. Keep methods few and meaningful; add, never silently change.

import type { Bus } from './bus.ts';
import type { Db } from './db/database.ts';
import type { Host } from './host.ts';
import type { Engine, EngineFile } from './engines/types.ts';
import type { ToolContext, ToolDef, ToolOutput, ToolSpec } from './tools/types.ts';
import type { Agent, AgentTemplate, OrgNode, Space } from '../shared/model/org.ts';
import type {
  Conversation, ConversationSettings, ConversationSummary, Member, Message, MessageMeta, SendMessageInput, StatusLine,
} from '../shared/model/chat.ts';
import type {
  CreateTaskInput, Schedule, Task, TaskFilter, TaskResult, TaskView, TodoRepeat,
} from '../shared/model/tasks.ts';
import type { FinishInput, TaskPatch } from './tasks/service.ts';
import type { CardAnswer } from './tasks/cards.ts';
import type { NextRoute } from './agents/next-route.ts';
import type { Handoff, KnowledgeHit, KnowledgeItem, KnowledgeQuery, ModeInfo, SkillInfo } from '../shared/model/knowledge.ts';
import type {
  Account, AccountLimits, DetectionReport, Effort, EngineId, ModelInfo, ProviderId, RouteDecision, UsageSummary,
} from '../shared/model/providers.ts';
import type { SecretInfo } from '../shared/model/security.ts';
import type { Device } from '../shared/model/devices.ts';
import type { AgentActivity, Run, RunItem, WakeReason } from '../shared/model/runs.ts';
import type { Origin } from '../shared/model/origin.ts';
import type { SubconsciousTrace } from '../shared/model/subconscious.ts';
import type { FileRef, Settings, SettingsPatch } from '../shared/model/system.ts';
import type { UiBlock } from '../shared/blocks/catalog.ts';
import type { ActionDescription } from './tools/types.ts';
import type { AccountService, DecisionService, EngineRegistry, KnowledgeService, ModeService, ModelCatalog, Router, SkillService } from './contracts/models.ts';
import type { DeviceService, FileStore, McpHub, NotificationService, RunJournal, SpendLedger, SecretService, ToolRegistry } from './contracts/safety.ts';
export type * from './contracts/models.ts';
export type * from './contracts/safety.ts';
import type { SpeechToText } from './contracts/voice.ts';
import type { SecurityService } from './security/service.ts';
export type * from './contracts/voice.ts';
/** Addition (CTX4): skill modes on save and skills from agent files (augments contracts/models.ts). */
export type * from './contracts/skills.ts';
export type * from './contracts/calendar.ts'; // B-041 My day: calendar, sources, day, estimates (optional RuntimeServices members)
export type * from './contracts/splits.ts'; // B-057: services.splits (SplitService), the dispatcher's split lanes
export type * from './contracts/ledger.ts'; // services.ledger (the context ledger)

export interface Clock {
  now(): number;
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface Paths {
  data: string; // userData: db, blobs, accounts, settings.json, theme.css
  workspace: string; // human/AI-readable working area (agents' cwd, skills, artifacts)
  resources: string; // shipped resources (skills, modes, agent templates, prompts)
  blobs: string;
  accounts: string; // isolated CLI homes per account
  logs: string;
  temp: string;
}

// ------------------------------------------------------------------ settings & org

export interface SettingsService {
  get(): Settings;
  update(patch: SettingsPatch): Settings;
}

export interface OrgService {
  spaces(): Space[];
  saveSpace(input: Partial<Space> & { name: string }): Space;
  list(options?: { includeArchived?: boolean }): Agent[];
  get(id: string): Agent | undefined;
  require(id: string): Agent;
  create(input: { name?: string; template?: string; role?: string; managerId?: string; spaceId?: string; instructions?: string; mode?: string; createdBy: string }): Agent;
  update(id: string, patch: Partial<Agent>): Agent;
  archive(id: string): void;
  /** O6: an archived agent back – under its old manager while that one is active, else the person. */
  restore(id: string): Agent;
  /** O6: file ids agents (archived too) use as avatar images – references for blob clean-up. */
  avatarFileIds(): string[];
  templates(): AgentTemplate[];
  tree(): OrgNode[];
  /** Live status line + ring ("working", "rendering intro"). Emits agent.activity. */
  setStatus(id: string, status: Agent['status'], note?: string): void;
  /** Agents in the chain of command above `id` (direct manager first). */
  managers(id: string): Agent[];
  /** May `viewerId` ('human' or an agent) see/manage `targetId`? */
  canManage(viewerId: string, targetId: string): boolean;
  /** Archives a space (agents/chats keep their space id; lists hide archived spaces). */
  archiveSpace(id: string): void;
  /** First run only: creates the single seed agent "Manager" (template `manager`); no spaces. */
  ensureSeed(): Agent | undefined;
}

// ------------------------------------------------------------------ chats

export interface ChatService {
  /** `includeHidden`: also team rooms, system chats and (C2) archived chats – one list the views sort. `threads`: also tasks' threads (tasks/thread.ts – in no list otherwise). */
  list(options?: { includeHidden?: boolean; search?: string; forMember?: string; threads?: boolean }): ConversationSummary[];
  get(id: string): Conversation | undefined;
  summary(id: string): ConversationSummary;
  members(id: string): Member[];
  /** `settings` (C2): applied at creation, so a hidden or system chat never shows in the main list first. `id` (runtime only): a task's thread is made with its task's id (tasks/thread.ts). */
  create(input: { id?: string; title?: string; agentIds: string[]; humans?: boolean; people?: string[]; createdBy: string; spaceId?: string; lead?: string; settings?: Partial<ConversationSettings> }): Conversation; // people (F-52): person ids, members as 'human'
  update(id: string, patch: { title?: string; pinned?: boolean; settings?: Partial<ConversationSettings> }, by: string): Conversation;
  /** `quiet`: no "Added …" or lead lines (a task's thread: its event line says it). */
  setMembers(id: string, change: { add?: string[]; remove?: string[]; lead?: string }, by: string, options?: { quiet?: boolean }): Member[];
  archive(id: string): void;
  /** C2: back into the person's list (archive only hides a chat; its agents keep working there). */
  unarchive(id: string): void;
  remove(id: string): void;
  /** Persists a message (human or agent), updates seq/preview/unread, emits events, triggers delivery. */
  /** `runId` (B-047 D4): the agent run that posts it (a <chat> block, agents/chat-out.ts). `silent`: no unread or notification – mentioned agents are still reached. */
  /** `deliver: false` (runtime only, F07's start line): stored and shown, delivered to nobody – no wake, no notification. */
  send(input: SendMessageInput & { authorId: string; authorKind?: Message['authorKind']; meta?: MessageMeta; kind?: Message['kind']; taskId?: string; silent?: boolean; runId?: string; deliver?: false }): Message;
  /** Quiet status line ("Mara → Opus 5.5 · high – …"). `runId`: the run it belongs to; `fromRun`: meta.fromRun of a line the runtime writes during a run. */
  status(conversationId: string, line: StatusLine, options?: { authorId?: string; taskId?: string; runId?: string; fromRun?: string }): Message;
  /** `files`: outputs the engine produced (e.g. Codex images) – stored and attached before the message is announced (MM2). */
  /** `silent`: in the chat without unread or notification – unless it mentions the person (a colleague's mention still reaches the colleague quietly). `priority` (B-050 K4): 'important' for an answer the agent marked [[important]]. */
  /** B-047 D4: a run's answer – posted at the end of the chat; `state` 'failed'/'stopped' for a run that ended so. */
  postAgentMessage(conversationId: string, agentId: string, runId: string, final: { body: string; meta?: MessageMeta; files?: EngineFile[]; silent?: boolean; priority?: Message['priority']; state?: 'final' | 'failed' | 'stopped' }): Message;
  /** Who `body` would @mention when `authorId` posts it in this chat (agent ids, 'human', person ids) – nothing is posted. */
  mentionsOf(conversationId: string, authorId: string, body: string): string[];
  edit(messageId: string, body: string, by: string): Message;
  removeMessage(messageId: string, by: string): void;
  /** B-050 K4: an important message past the important brake becomes normal (stored; no seq move) – chat/delivery.ts. */
  demote?(messageId: string): void;
  message(id: string): Message | undefined;
  messages(conversationId: string, options?: { afterSeq?: number; beforeSeq?: number; limit?: number }): Message[];
  /** Advance a member's cursor (agents: in the same transaction that integrates a turn result). */
  markRead(conversationId: string, memberId: string, seq: number): void;
  search(text: string, options?: { conversationId?: string; memberId?: string; limit?: number; excludeConversations?: readonly string[] }): Array<{ message: Message; snippet: string }>;
  draft(conversationId: string): { text: string; attachments: unknown[] } | undefined;
  saveDraft(conversationId: string, text: string, attachments?: unknown[], secrets?: string[]): void;
  // --- additions (A2)
  /** The agent that answers un-addressed messages and picks owners for team tasks. */
  lead(conversationId: string): string | undefined;
  /** Startup: rows an older version left 'streaming' go (chat/lifecycle.ts). */
  reconcileStreaming(): number;
}

/** Decides which agents a new message wakes (1:1, mentions, lead, decision model in groups). */
export interface DeliveryService {
  onMessage(message: Message): void;
  /** Addition (C3), optional so simple fakes stay valid: startup sweep after wakes.reconcile() – the newest
   *  unanswered human/external message of a chat no agent has seen and nothing will wake for is delivered
   *  again (without notifying the person again). Returns how many messages were delivered. */
  recover?(): number;
}

// ------------------------------------------------------------------ tasks

export interface TaskService {
  list(filter?: TaskFilter): TaskView[];
  get(id: string): TaskView | undefined;
  /** `fromRun`: the run that caused it – its anchor message carries meta.fromRun. The owner is set (an agent, the person or a colleague). */
  create(input: CreateTaskInput & { createdBy: string }, options?: { fromRun?: string }): TaskView;
  /** New work for `to` ("me", "team", an agent, the person or a colleague by id) – "team" picks one owner now (tasks/give.ts). */
  createTo(input: Omit<CreateTaskInput, 'assigneeKind' | 'assigneeId'> & { createdBy: string }, to: string, options?: { fromRun?: string; team?: string; route?: Omit<NextRoute, 'at' | 'reason'> }): Promise<TaskView>;
  /** Fields; status 'waiting' with waitingOn sets a wait, 'open' ends it (a person's 'open' reopens finished work); plan, fact. */
  update(id: string, patch: TaskPatch, by: string, rev?: number): TaskView;
  /** Gives the task to `to` (as createTo); the receiver hears at once, the giver hears how it ends. */
  give(id: string, to: string, by: string, input?: { note?: string; effort?: Effort; fact?: string; givenIn?: string }): Promise<TaskView>;
  /** Ends it: done with what came out, or dropped with why; the one verification step runs on a done one with doneWhen. */
  finish(id: string, input: FinishInput, by: string): TaskView;
  /** Takes back the latest logged change of a task (or `changeId`) within 24 hours: the fields it changed come back (tasks/changes.ts). */
  undo(id: string, by: string, changeId?: string): TaskView;
  remove(id: string, by: string): void;
  /** A person's open to-dos and those waiting for a ring (the calm "For you" list); `personId`: a colleague's instead of the owner's. */
  todos(limit?: number, personId?: string): TaskView[];
  /** Ask blocks of a final agent message → human to-dos. `indexes[i]` is the parse index of `blocks[i]` (the chat's
   *  blockIndex; default i) – it keys the to-do, so answers by blockIndex find it; ```app todo=true fences become mini-app to-dos too. */
  ingestBlocks(message: Message, blocks: UiBlock[], indexes?: number[]): TaskView[];
  /** The person answered a widget/to-do: store, post their line, wake the author; {declined: true, reason?} with
   *  `decline` (todos.decline) drops it instead (tasks/decline.ts). A mini-app's data never declines. */
  answer(input: { taskId?: string; messageId?: string; blockIndex?: number; answer: unknown; by: string; clientId?: string; decline?: boolean }): TaskView | undefined;
  /** "Show as" another widget; `repeat` (with 'timer') makes the to-do repeat at its time. */
  changeWidget(id: string, type: string, repeat?: TodoRepeat): TaskView;
  /** A to-do waits until `until` and rings again (no receipt, nobody woken). */
  snooze(ref: string | { messageId: string; blockIndex: number }, until: number): TaskView;
  /** A repeating to-do stops repeating and is done. */
  stopRepeating(id: string, by: string): TaskView;
  /** Tasks an agent owns that are not finished. */
  openFor(agentId: string): TaskView[];
  /** The person's Stop: it waits on them ("Paused by you"); nothing runs on it until they or its owner move it on. */
  pause(id: string, by: string): TaskView;
  /** Ends a pause: open again, its owner goes on. */
  resume(id: string, by: string): TaskView;
  /** P5: hands checklist item `itemId` of task `id` to `to` – a linked task of its own, ticked there when done (tasks/checklist.ts). */
  handOverItem(id: string, itemId: string, to: string, by: string, options?: { givenIn?: string }): Promise<TaskView>;
  /** P5 "Run again": a finished task as a new one with its checklist, every tick reset, the same owners. */
  runAgain(id: string, by: string, input?: { title?: string }): Promise<TaskView>;
  /** P7: the person's one answer to a "Waiting on you" card – every task on it hears it and stops waiting (tasks/cards.ts). */
  answerCard(input: CardAnswer, by: string): TaskView[];
  /** P7 "Later": the card's waits rest with a follow-up at `until`; its ask moves there. */
  laterCard(ids: readonly string[], until: number, by: string): TaskView[];
}

/** The follow-up of each turn of an owner on its task, and the start (tasks/watch.ts – the watcher). */
export interface OwnershipService {
  /**
   * `progressed`: the task moved in the turn, or a call did something (agents/turn-types.ts effectful) – it decides
   * between going on now and the doubling pause. Outcome 'stopped': the person stopped the turn – the task pauses.
   * 'limit' / 'unavailable': no model or account could run it – retried within 30 min (`retryAfterMs` at the earliest).
   */
  afterTurn(input: {
    agentId: string; taskId: string; runId: string; progressed: boolean;
    outcome: 'done' | 'failed' | 'interrupted' | 'limit' | 'unavailable' | 'waiting' | 'stopped'; note?: string;
    approach?: string; plan?: string[];
    retryAfterMs?: number;
  }): void;
  /** On startup: older rows converted, one pass of the watcher, cut-off chat turns woken; returns how many tasks go on. */
  recover(input?: { interruptedRuns?: readonly string[] }): number;
}

// ------------------------------------------------------------------ schedules & wakes

export interface WakeRequest {
  agentId: string;
  reason: WakeReason;
  conversationId?: string;
  taskId?: string;
  note?: string;
  dueAt?: number; // default now
  coalesceKey?: string; // wakes with the same key for the same agent merge
  /** B-054: what caused it (runtime-written; chat and task wakes may omit it). On a merge the older origin wins. */
  origin?: Origin;
}

/** A stored wake (row of `wakes`). Added for the dispatcher's claim/done cycle. */
export interface Wake {
  id: string;
  agentId: string;
  reason: WakeReason;
  conversationId?: string;
  taskId?: string;
  note?: string;
  dueAt: number;
  createdAt: number;
  claimedAt?: number;
  attempts: number;
  origin?: Origin; // B-054 (wakes.source/source_label)
}

export interface WakeQueue {
  wake(request: WakeRequest): void;
  cancel(agentId: string, filter?: { taskId?: string; conversationId?: string }): void;
  pending(agentId?: string): number;
  // --- additions (A2): the dispatcher's side of the queue
  /** Cancels unclaimed wakes of any agent for a task (optionally only some reasons). */
  cancelTask(taskId: string, reasons?: WakeReason[]): void;
  /** Atomically claims all due, unclaimed wakes of one agent (oldest first). */
  claim(agentId: string, now?: number): Wake[];
  /** Removes finished wakes. */
  done(ids: string[]): void;
  /** Un-claims wakes (e.g. admission refused); optionally postpones them. `notRun`: they were never run (B-054 P9: the claim is not an attempt). */
  release(ids: string[], dueAt?: number, notRun?: boolean): void;
  /** Agents with due, unclaimed wakes (dispatcher start / resume). */
  dueAgents(now?: number): string[];
  /** Agents whose unclaimed wakes became due in (from, to] (scheduler timer). */
  dueBetween(from: number, to: number): string[];
  /** Earliest due time of unclaimed wakes strictly after `after` (scheduler timer). */
  nextDueAfter(after: number): number | undefined;
  /** Claimed wakes left by a crash become due again (startup). */
  reconcile(): number;
  /** Fires on every insert/merge/cancel (the scheduler re-arms its single timer). */
  onChange(listener: (change: { agentId: string; dueAt?: number }) => void): () => void;
  /** Addition (T01): all wakes of one agent, claimed or not (ownership.recover checks coverage). */
  list(agentId: string): Wake[];
  /** Addition (C3), optional so simple fakes stay valid: withdraws the unclaimed wake under a coalesce key
   *  (a provisional wake); false when none waits there (already claimed or gone). */
  cancelKey?(agentId: string, coalesceKey: string): boolean;
}

export interface Scheduler {
  create(input: Omit<Schedule, 'id' | 'nextAt' | 'lastAt' | 'runs' | 'active' | 'pausedBy' | 'createdAt'> & { active?: boolean }): Schedule;
  /** `by` ('human' or an agent id): a pause records it; an agent cannot resume what the person paused (B-044). */
  update(id: string, patch: Partial<Pick<Schedule, 'conversationId' | 'title' | 'spec' | 'payload' | 'active'>>, by?: string): Schedule;
  remove(id: string): void;
  list(filter?: { conversationId?: string; ownerId?: string; taskId?: string }): Schedule[];
  runNow(id: string): void;
  /** Re-arm the single timer (called after changes, resume, clock jumps). */
  arm(): void;
  /** Next fire time for a spec (pure; used by UI previews and validation). */
  next(spec: Schedule['spec'], after: number): number | undefined;
  // --- additions (A2)
  /** Arms the timer, subscribes to power events and the wake queue; fires missed schedules. */
  start(): void;
  stop(): void | Promise<void>; // B-044: SchedulerImpl resolves once next-due.json is settled
  /** The dispatcher subscribes here: agent ids that have due wakes now. */
  onDueWakes(listener: (agentIds: string[]) => void): () => void;
  get(id: string): Schedule | undefined;
}

// ------------------------------------------------------------------ agents at work

export interface Dispatcher {
  start(): void;
  stop(): Promise<void>;
  /** Interrupt the running turn of an agent (optionally only for one chat). A human stop (T02:
   *  TurnControl.stopKind 'human'): a task turn ends 'stopped' and the task pauses. */
  interrupt(agentId: string, conversationId?: string): Promise<void>;
  /** Important message: steer if supported, otherwise interrupt and re-run with priority. */
  urgent(agentId: string, conversationId: string): Promise<void>;
  activity(): AgentActivity[];
  // --- additions (R3-D); optional so simple fakes stay valid
  /** Stops one running turn by run id (RPC runs.cancel); false when it is not running here. */
  cancelRun?(runId: string): Promise<boolean>;
  /** Holds new turns (update restart); running turns continue. `false` resumes. */
  setPaused?(paused: boolean): void;
  /** Hook for ToolRegistryOptions.onCall: a tool call of that run started (true) or ended – the turn's tool boundaries. */
  setCall?(ctx: { agentId: string; runId: string; callId: string }, running: boolean): void;
  /** 17:09: a normal message of the person folded into the agent's running turn in that chat (engine steer); false = it waits for the next turn. */
  steer?(agentId: string, conversationId: string): Promise<boolean>;
  /** B-080: a person's line in a group chat folded into the agent's running turn wherever it runs, without a pick or a waiting line (chat/delivery-route.ts). */
  hear?(agentId: string, conversationId: string): Promise<boolean>;
  /** D15: a call's live voice relays `text` into the agent's running turn in that chat ('next': only where it lands at the next model request); false = not steered (calls/talker.ts). */
  relay?(agentId: string, conversationId: string, text: string, mode: 'now' | 'next'): Promise<boolean>;
  /** The person's emergency stop (agents/work-stop.ts): no new turn while halted. */
  setHalted?(halted: boolean): void;
  /** Aborts every running turn at once as the person's Stop; their runs and when they ended. */
  haltAll?(reason: string): { runIds: string[]; settled: Promise<void> };
  /**
   * B-048 E4.2 (ROUTING hunk): model.set now – the running turn `runId` of the agent ends at its next tool
   * boundary (the urgent interrupt path: its wakes are kept) and its chat (task) runs again at once with
   * `note`, on the route the request set. Never awaits the cut (the caller is a tool of that turn);
   * false = that run is not running here.
   * `target` (addition, B-080): the model (and effort) the turn goes on with – when it runs on the turn's own engine,
   * the running turn takes it at its next step without a cut (Engine.setModel); else the cut above.
   */
  continueNow?(agentId: string, runId: string, note: string, target?: { modelId: string; effort?: Effort }): boolean;
  /** B-050 K4 round 3: a person's quiet line reached chats of these agents (chat/delivery.ts) – each one with no turn running picks it up a little later (chat/quiet-pickup.ts). */
  quietArrived?(agentIds: readonly string[]): void;
}

export interface PromptParts {
  stable: string; // identity, org, rules, tool + ui guidance, mode, skills index
  volatile: string; // pinned memory, open tasks/promises, time
  /** B-049 F6: `volatile` by section name ('now' …; joined it is `volatile`) – agents/volatile-delta.ts. */
  sections?: Array<{ name: string; text: string; failed?: true }>;
  /** S2: `stable` by section name ('identity' …; joined by a blank line it is `stable`) – agents/volatile-delta.ts stableDelta. */
  stableSections?: Array<{ name: string; text: string }>;
}

export interface ContextService {
  /** Builds the system prompt sections for a turn; `direct` (S2): the tools a resumed session holds, so "More tools" lists the rest. */
  prompt(input: { agent: Agent; conversationId?: string; taskId?: string; thread?: string; mode: ModeInfo; route: RouteDecision; direct?: readonly string[] }): PromptParts;
  /** New chat lines the agent has not seen yet, rendered for the engine (context/delta.ts: within their reach). */
  delta(input: { agent: Agent; conversationId: string; sinceSeq: number }): { text: string; images: Array<{ path: string; mime: string }>; lastSeq: number };
  /** Portable checkpoint for handoffs/model switches. */
  checkpoint(input: { agentId: string; taskId?: string; conversationId?: string }): Handoff;
  /** Compaction: summarize old segments into observations (session renewal then starts fresh). */
  /** Addition (R3-C): extracts text of unseen text/PDF attachments so the next delta() can
   * include it (delta() is synchronous; a PDF never extracted before is otherwise only named). */
  prepare?(input: { agentId: string; conversationId: string; sinceSeq: number }): Promise<void>;
}

/** One service for the subconscious: the routing call before a turn, the main AI's own call, and the small side-work around turns. */
export interface Subconscious {
  /** A running call reached its estimate: choose another interval in seconds or abort it. */
  toolTimeout?(input: import('./tools/timeout.ts').ToolTimeoutInput & { agent: Agent; signal: AbortSignal }): Promise<import('./tools/timeout.ts').ToolTimeoutDecision>;
  /** Verifies a task result against its done-condition (clean context). */
  /** `checked` (addition, R3-C): false when no real check ran (no done-condition, no decision
   * model, unsure or failed verifier) – then `ok` only means "do not reopen", not "verified".
   * `fact` (addition, B-080): the failure is a runtime fact (a named file is missing, a link does not answer), not a
   * model's doubt – only such a failure wakes the assignee (tasks/verification.ts). */
  verify(task: Task, result: TaskResult): Promise<{ ok: boolean; reason: string; checked?: boolean; fact?: boolean }>;
  /** Addition (01.11.2026), optional: what the main AI's history gets before this turn's model call – the trace kept for the thread; undefined = nothing. `said`: what people wrote for this turn; `woke` (v1, 14.11.2026): what other agents wrote for it; `taskText`: the turn's task as it reads it, its title and newest note (else its notes) – with content (`said` when a person wrote, else `woke` with content, else `taskText`), one call sets the turn's model and effort – not while a request of the agent's own or of its task (`taskId`) holds the turn –, opens the hits of the word search it chooses (first in the trace) and condenses context items whose job is done, and the turn waits for it, bounded (subconscious/service.ts, route-turn.ts, look.ts); `vision`: the turn shows an image (the call offers only models that see); `callId` (FIXES-3 D2): this turn answers a line of that running call (a task's turn too) – it does not wait for the call. `signal`: the turn's stop, which ends that call too. Never throws. */
  beforeTurn?(input: { agent: Agent; thread: string; conversationId?: string; taskId?: string; mode?: string; said?: string; woke?: string; taskText?: string; vision?: boolean; callId?: string; signal?: AbortSignal }): Promise<SubconsciousTrace | undefined>;
  /** Addition (01.11.2026), optional: a turn that never reached its engine gives back what beforeTurn gave it, a native turn the timeout decisions it could not take in (agents/native-timeout.ts); the next turn on the thread shows it. Never throws. */
  putBack?(agentId: string, thread: string, trace: SubconsciousTrace): void;
  /** Addition (F26, 16.11.2026), optional: a forked part's first start – the call that condenses context items whose job is done, as beside the agent's own turns, on the part's own record (`thread`) with its brief as what wakes it; the part waits for it, bounded, and `signal` (its turn's stop) ends it. Returns how many items it condensed. Never throws. */
  condensePart?(input: { agent: Agent; thread: string; conversationId?: string; brief: string; signal?: AbortSignal }): Promise<number>;
  /** Addition (01.11.2026), optional: the main AI's own call (tools/builtin/subconscious.ts): `ask` is any text; the answer is its tool output. Never throws. */
  ask?(input: { agent: Agent; conversationId?: string; thread?: string; taskId?: string; mode?: string; ask: string; context?: 'none' | 'recent' | 'chat'; signal?: AbortSignal }): Promise<string>;
  /** Addition (01.11.2026), optional: the person's Forget – a kept trace that mentions it goes. Never throws. */
  forget?(match: (text: string) => boolean): void;
}

/** Everything a tool or module may reach. Filled by the composition root. */
export interface RuntimeServices {
  clock: Clock;
  log: Logger;
  paths: Paths;
  host: Host;
  db: Db;
  bus: Bus;
  settings: SettingsService;
  org: OrgService;
  chats: ChatService;
  delivery: DeliveryService;
  tasks: TaskService;
  ownership: OwnershipService;
  wakes: WakeQueue;
  scheduler: Scheduler;
  dispatcher: Dispatcher;
  context: ContextService;
  subconscious: Subconscious;
  decisions: DecisionService;
  catalog: ModelCatalog;
  router: Router;
  accounts: AccountService;
  engines: EngineRegistry;
  knowledge: KnowledgeService;
  skills: SkillService;
  modes: ModeService;
  spend: SpendLedger;
  secrets: SecretService;
  tools: ToolRegistry;
  mcp: McpHub;
  files: FileStore;
  devices: DeviceService;
  notifications: NotificationService;
  runs: RunJournal;
  /** Addition (MM1): speech to text for dictation and agents hearing recordings (voice/transcribe.ts). */
  stt: SpeechToText;
  /** Sicher-Runde 19.11.2026: the security gate – Trust AI or Secure mode, approval requests (security/service.ts). */
  security: SecurityService;
}
