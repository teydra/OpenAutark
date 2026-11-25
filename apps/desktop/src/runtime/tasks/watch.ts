// The watcher (Quests round 20.11.2026): what keeps tasks moving that is not a "look again later" – an agent's own look
// later is a reminder (schedules), and nothing here wakes an agent on a timer of its own:
//  - a row without an owner (an older PC's "team" row) gets one now (tasks/give.ts pickOwner);
//  - an archived agent's unfinished work goes to its successor (tasks/owners.ts handOver), also for rows that arrive later;
//  - the follow-up of an owner's turn on its task (afterTurn): the person's Stop pauses it; a cut-off turn goes on now; an
//    outage (a usage limit, no model or account) gets one retry wake – at its retry-after, else OUTAGE_RETRY_MS later –
//    that comes forward when an account or a model comes back or the host is online again;
//  - at start (recover): the tasks and chats whose turn was cut off woken, the install receipt;
//  - the person's ring: a person's to-do whose `at` is reached pushes them once (kv mark: rings sent up to when, from the first start on; a day
//    without a time at the start of that working day) – on the
//    CEO PC with the smallest id that is not gone (no main PC: the next one rings while it is out; `ledger.ringedAt` on the
//    synced row says what rang, so the PC that comes back does not ring it again), never on a PC that joined as an employee;
//  - the morning pass (tasks/morning.ts): once a day an agent hears of its quests and eligible standalone to-dos without a next note.
// Where: an agent's tasks on the PC it runs on (devices/sync/home.ts).
// Owns: those passes and their timers. Never: calls a model (except the owner pick), writes "working", plans a look, or
// wakes a paused task.

import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { isFinished, isPaused, type Task } from '../../shared/model/tasks.ts';
import type { OwnershipService, RuntimeServices } from '../contracts.ts';
import type { TaskServiceImpl } from './service.ts';
import { OutageTracker, isOutage, onlineDeliveryAt } from '../agents/outages.ts';
import { firesHere, homeElsewhere, links } from '../devices/sync/home.ts';
import { DueTimer, REAL_DUE_TIMERS } from '../people/due-timer.ts';
import type { Timers } from '../people/join.ts';
import { INTERRUPTED_NOTE, installReceipt, wakeInstaller } from './recover-notes.ts';
import { giveTask, pickOwner, tell } from './give.ts';
import { handOver } from './owners.ts';
import { KvRepo } from '../store/kv.ts';
import { MorningPass } from './morning.ts';
import { nextWorkStart, ringAt } from '../../shared/model/day-settings.ts';
import { dayZone, daySettings } from '../day/clock.ts';

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
/** An outage's retry when the route names no retry-after: this much later (an account or model coming back brings it forward). */
export const OUTAGE_RETRY_MS = 30 * 60_000;
/** kv: the person's rings are sent up to this time. */
export const RINGS_KV = { ns: 'tasks', key: 'ringsTo' } as const;

export type TurnInput = Parameters<OwnershipService['afterTurn']>[0];

export type WatchDeps = Pick<RuntimeServices, 'tasks' | 'wakes' | 'chats' | 'clock' | 'db' | 'bus' | 'org' | 'settings'>
  & Partial<Pick<RuntimeServices, 'log' | 'accounts' | 'catalog' | 'host' | 'runs' | 'paths' | 'notifications' | 'people' | 'devices'>>;

export class TaskWatcher implements OwnershipService {
  private readonly s: WatchDeps;
  private readonly rings: DueTimer;
  readonly morning: MorningPass;
  private offs: Array<() => void> = [];
  private routing = new Set<string>();

  constructor(deps: WatchDeps, timers: Timers = REAL_DUE_TIMERS) {
    this.s = deps;
    this.rings = new DueTimer(timers, () => deps.clock.now(), () => this.ring());
    this.morning = new MorningPass(deps, timers);
  }

  private get t(): TaskServiceImpl { return this.s.tasks as unknown as TaskServiceImpl; }

  // ------------------------------------------------------------- the follow-up of a turn

  afterTurn(input: TurnInput): void {
    const task = this.t.repo.get(input.taskId);
    if (!task || isFinished(task.status) || task.assigneeKind !== 'agent' || task.assigneeId !== input.agentId) return; // another agent's turn changes nothing
    if (input.outcome === 'stopped') { this.t.pause(task.id, HUMAN_ID); return; }
    if (isPaused(task)) return;
    const now = this.s.clock.now();
    if (input.progressed) this.t.emit(this.t.mutate(task.id, (draft) => { draft.ledger = { ...draft.ledger, movedAt: now }; }));
    if (input.outcome === 'interrupted') tell(this.s, task.assigneeId!, { reason: 'retry', taskId: task.id, conversationId: task.conversationId, note: INTERRUPTED_NOTE });
    else if (isOutage(input.outcome)) this.retryLater(task, input.outcome, now + (input.retryAfterMs ?? OUTAGE_RETRY_MS));
  }

  /** The one retry wake of a task whose turn hit an outage. */
  private retryLater(task: Task, outcome: string, at: number): void {
    const why = outcome === 'limit' ? 'a usage limit' : 'no model or account was reachable';
    this.s.wakes.wake({
      agentId: task.assigneeId!, reason: 'retry', taskId: task.id, ...(task.conversationId ? { conversationId: task.conversationId } : {}), dueAt: at,
      coalesceKey: `task:${task.id}`, note: `My last turn on "${excerpt(task.title, 120)}" did not run (${why}); this is the next try.`,
    });
  }

  // ------------------------------------------------------------- start

  /** At start: the cut-off turns woken, one pass; returns how many tasks go on now. */
  recover(input: { interruptedRuns?: readonly string[] } = {}): number {
    const now = this.s.clock.now();
    const cut = new Set<string>();
    for (const runId of input.interruptedRuns ?? []) {
      const run = this.s.runs?.get(runId);
      if (!run) continue;
      if (run.taskId) { cut.add(run.taskId); continue; }
      if (run.conversationId && this.active(run.agentId)) {
        this.s.wakes.wake({ agentId: run.agentId, reason: 'retry', conversationId: run.conversationId, dueAt: now, note: INTERRUPTED_NOTE, coalesceKey: `recover:${run.conversationId}` });
      }
    }
    let continued = 0;
    for (const id of cut) {
      const task = this.t.repo.get(id);
      if (task && !isFinished(task.status) && !isPaused(task) && task.assigneeKind === 'agent' && task.assigneeId && this.watchesHere(task)) {
        tell(this.s, task.assigneeId, { reason: 'retry', taskId: id, conversationId: task.conversationId, note: INTERRUPTED_NOTE });
        continued++;
      }
    }
    this.pass();
    let receipt: ReturnType<typeof installReceipt>;
    try { receipt = installReceipt(this.s); } catch (error) { this.s.log?.warn('install receipt not read', { error: String(error) }); }
    if (receipt) wakeInstaller(this.s, receipt);
    return continued;
  }

  /** The hourly pass, rows that arrive or change, the end of outages, the rings and the morning pass. Idempotent; returns the stop. */
  start(): () => void {
    if (this.offs.length) return () => this.stop();
    const { bus } = this.s;
    const hourly = setInterval(() => this.pass(), HOUR_MS);
    (hourly as { unref?: () => void }).unref?.();
    const tracker = new OutageTracker(this.accounts(), this.s.catalog?.list() ?? [], this.s.clock.now());
    this.offs = [
      () => clearInterval(hourly),
      bus.on('task.upserted', (task) => { // a row from here or another PC: an owner it lacks, a ring it brings
        if (isFinished(task.status)) return;
        if (task.assigneeKind === 'team' || (task.assigneeKind === 'agent' && task.assigneeId && !this.active(task.assigneeId))) this.owner(task);
        if (task.assigneeKind === 'human' && task.at !== undefined && task.at > this.s.clock.now()) this.armRings();
      }),
      bus.on('account.upserted', (account) => { if (tracker.account(account, this.s.clock.now())) this.outagesEnded(); }),
      bus.on('account.removed', ({ id }) => tracker.removed(id)),
      bus.on('models.updated', (list) => { if (tracker.models(list)) this.outagesEnded(); }),
    ];
    try { if (this.s.host) this.offs.push(this.s.host.onPower((event) => { if (event === 'online') this.outagesEnded(onlineDeliveryAt(this.accounts(), this.s.clock.now())); })); } catch { /* a host without power events */ }
    this.ringsFromNow();
    this.armRings();
    this.morning.start();
    return () => this.stop();
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    this.rings.stop();
    this.morning.stop();
  }

  // ------------------------------------------------------------- the pass

  /** Rows without an owner get one; work of archived agents goes to their successors. Returns how many rows it touched. */
  pass(): number {
    let touched = 0;
    try {
      for (const task of this.t.repo.list({ status: ['open', 'waiting'], assigneeKind: 'team', includeSteps: true, limit: 500 })) { this.owner(task); touched++; }
      const owners = this.s.db.all<{ id: string }>(`SELECT DISTINCT assignee_id AS id FROM tasks WHERE assignee_kind = 'agent' AND status IN ('open', 'waiting') AND assignee_id IS NOT NULL`);
      for (const { id } of owners) if (!this.active(id) && this.s.org.get(id)?.archivedAt !== undefined) { handOver(this.t, id); touched++; }
    } catch (error) {
      this.s.log?.warn('task watcher pass failed', { error: String(error) });
    }
    return touched;
  }

  /** A row that needs an owner: an older PC's "team" row gets one; an archived agent's goes to its successor. */
  private owner(task: Pick<Task, 'id' | 'assigneeKind' | 'assigneeId'>): void {
    if (task.assigneeKind === 'agent' && task.assigneeId) { if (this.s.org.get(task.assigneeId)?.archivedAt !== undefined) handOver(this.t, task.assigneeId); return; }
    const row = this.t.repo.get(task.id);
    if (!row || !this.watchesHere(row) || this.routing.has(row.id)) return;
    this.routing.add(row.id);
    void pickOwner(this.t, row, SYSTEM_ID)
      .then((to) => { const fresh = this.t.repo.get(row.id); if (fresh?.assigneeKind === 'team' && !isFinished(fresh.status)) giveTask(this.t, row.id, to, SYSTEM_ID); })
      .catch((error: unknown) => this.s.log?.warn('giving an ownerless task an owner failed', { taskId: row.id, error: String(error) }))
      .finally(() => this.routing.delete(row.id));
  }

  // ------------------------------------------------------------- the person's rings

  /** Pushes the person for every to-do of theirs whose time came since the last ring (once each); returns how many. A
   *  day without a time rings at the start of that working day, not at its midnight (day-settings.ts ringAt). */
  ring(): number {
    const kv = new KvRepo(this.s.db);
    const now = this.s.clock.now();
    let pushed = 0;
    try {
      const from = kv.get<number>(RINGS_KV.ns, RINGS_KV.key);
      kv.set(RINGS_KV.ns, RINGS_KV.key, now, now);
      if (typeof from === 'number' && this.peopleHere()) {
        const zone = dayZone(this.s);
        const { workStart } = daySettings(this.s);
        for (const task of this.t.repo.ringsBetween(from - DAY_MS, now)) { // a day-only to-do's midnight lies up to a day before its ring
          const at = ringAt(task, zone, workStart);
          if (at === undefined || at <= from || at > now || isPaused(task)) continue;
          if ((task.ledger.ringedAt ?? 0) >= at) continue; // another PC rang it already (24.11.2026: the stamp travels with the row)
          const timer = task.widget?.type === 'timer'; // a timer rings with its own words
          tell(this.s, task.assigneeId ?? HUMAN_ID, { kind: 'todo', title: timer ? excerpt(task.title, 80) : `Due: ${excerpt(task.title, 80)}`, body: excerpt(task.notes, 160), taskId: task.id, conversationId: task.conversationId });
          pushed++;
          try { this.t.emit(this.t.mutate(task.id, (draft) => { draft.ledger = { ...draft.ledger, ringedAt: at }; })); } catch { /* the ring went; a changed row keeps no stamp */ }
        }
      }
    } catch (error) {
      this.s.log?.warn('to-do rings failed', { error: String(error) });
    }
    this.armRings();
    return pushed;
  }

  /** A PC without the mark (the first start of this version, a new PC) rings from its start on – the first ring is not lost. */
  private ringsFromNow(): void {
    try {
      const kv = new KvRepo(this.s.db);
      if (kv.get<number>(RINGS_KV.ns, RINGS_KV.key) === undefined) kv.set(RINGS_KV.ns, RINGS_KV.key, this.s.clock.now(), this.s.clock.now());
    } catch (error) {
      this.s.log?.warn('to-do rings: the start mark was not set', { error: String(error) });
    }
  }

  /** The ring timer: the next to-do's time, and the next start of the working day (a day-only to-do rings then). */
  private armRings(): void {
    const now = this.s.clock.now();
    let next: number | undefined;
    try { next = this.t.repo.nextRingAfter(now); } catch { next = undefined; }
    const morning = nextWorkStart(now, dayZone(this.s), daySettings(this.s).workStart);
    this.rings.arm(next === undefined ? morning : Math.min(next, morning));
  }

  // ------------------------------------------------------------- helpers

  /** An account or a model came back (or the host is online): the outage retries of agent work go at `at`. */
  private outagesEnded(at = this.s.clock.now()): void {
    for (const agent of this.s.org.list()) {
      if (agent.archivedAt !== undefined) continue;
      for (const wake of this.s.wakes.list(agent.id)) {
        if (wake.claimedAt !== undefined || wake.reason !== 'retry' || !wake.taskId || wake.dueAt <= at || wake.dueAt > at + OUTAGE_RETRY_MS) continue;
        this.s.wakes.wake({ agentId: agent.id, reason: 'retry', taskId: wake.taskId, ...(wake.conversationId ? { conversationId: wake.conversationId } : {}), dueAt: at, coalesceKey: `task:${wake.taskId}`, note: wake.note });
      }
    }
  }

  /** Where the task's owner lives: an agent where it runs, a person's work on the CEO PC with the smallest id. */
  private watchesHere(task: Task): boolean {
    if (task.assigneeKind === 'agent' && task.assigneeId) return !homeElsewhere(this.s, task.assigneeId);
    return this.peopleHere();
  }

  /** The people's rings and ownerless rows are this PC's: the CEO PC with the smallest id among those not gone (home.ts firesHere), never an employee's PC. */
  private peopleHere(): boolean {
    try {
      if (links(this.s.db).some(({ link }) => link.kind === 'employer')) return false;
      return firesHere(this.s, HUMAN_ID);
    } catch { return true; }
  }

  private active(agentId: string): boolean {
    const agent = this.s.org.get(agentId);
    return agent !== undefined && agent.archivedAt === undefined;
  }

  private accounts() {
    try { return this.s.accounts?.list() ?? []; } catch { return []; }
  }
}
