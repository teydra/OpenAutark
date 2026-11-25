// The dispatcher's running turns: at most one per agent, each with its bookkeeping record (RunEntry)
// from the start to its settled wakes. start() builds the TurnRequest and runs the executor a
// microtask later (never inside the caller's pump); at the end the claimed wakes are done (or go back
// to the queue after a shutdown/urgent abort), the agent shows idle, the dispatcher hands the freed slot on
// (onEnded) and only then the keep-awake lease follows.
// Every abort names its kind in TurnControl.stopKind and the abort reason's details.stopKind (the
// first one decides; the fake engine reads it, engines/fake.ts): interrupt/cancelRun = the human
// pressed Stop ('human', the task pauses), urgent = 'urgent', stop() = 'shutdown'. The person's Stop
// and a shutdown drop a deferred urgent interrupt, and a Stop after an urgent cut makes it a stop
// (wakes done) – stopped work never comes back through the urgent hand-over.
// B-054: the turn carries its group's origin (TurnRequest.origin; the activity rows show it). A failed or crashed run
// with neither chat nor task (a mail, a connector event) has nowhere else to keep its note: its wakes go back to the
// queue with backoff (retryAt: 2^attempts minutes, attempts counted by WakeQueue.claim; a claim the dispatcher hands
// back unrun does not count), capped at 30 minutes so a long outage never drops the event.
// B-057 lanes: the running map is keyed by lane – the agent's main lane is its id (one main turn per agent, as before:
// has/get name it), a split's lane `<agentId>#<splitId>` (dispatch-lanes.ts starts it through launch()). A split lane counts
// toward its agent's SPLIT_LIMITS.runningPerAgent (B-080: no global limit), every lane stops with haltAll/stop() and shows in the activity rows (AgentActivity.split and its parent's chat,
// listed after the main lanes – consumers that want the agent's own turn in a chat skip split rows); a split lane has no
// wakes, sets no agent status of its own while the main lane runs, and the agent shows idle only when its last lane ends.
// A split turn that planned no run or crashed tells the split service (split-turn.ts turnEndedEarly), a crashed main run too –
// a run a mail started as well (16.11.2026: it works with every tool and can split).
// KI-Runde 17.11.2026 (the context fold, agents/context-fold.ts): a turn whose outcome calls for a fold keeps the cause on its
// entry (RunEntry.fold) and hands the entry to the dispatcher with the freed lane; fold() starts the fold's turn on the agent's
// main lane – a run of its own (reason 'fold') with no wakes, shown in the chat the ended turn came from (its activity row
// says `fold`, so the live bar names it) and stopped by that chat's Stop; a failed one is not retried (the next turn's end
// asks again) and a crashed one leaves no bubble.
// B-059 (dispatch-settle.ts): #17 a crashed turn's streaming bubble fails and its task gets its after-turn handling;
// #18 a main-lane turn still running RELEASE_MS after its abort is released – run closed, cut calls unknown, its wakes
// settled as its abort said, the slot handed on; the late end of the hung work changes no bookkeeping here. B-057: a split
// lane too – its run closed; after the person's Stop the split service is told (turnEndedEarly: stopped), after a
// shutdown's cut it hears the hung turn's own late end.
// Runde „Halb“ 21.11.2026: the wakes of groups riding along in a turn (TurnRequest.riders) are done only when it ended done –
// every other end (failed, cut, skipped, crashed, released) leaves them due again, unspent, for a turn of their own.
// Owns: the running map, RunEntry, abort kinds, settling a turn's wakes (done, released, or released for a retry),
// closing a crashed run, live notes and the activity rows (with the route the turn reports,
// B-048 E4.5 – B-080: also after a model switch inside the turn, setModelInTurn – and the origin, B-054; B-083: with the
// turn's temperature and whether its engine sends it, turn-attempt.ts liveRoute).
// Never: decides which agent or group runs next, holds the slot FIFO or urgent picks (dispatcher.ts).

import { mailMarker } from '../tools/mail-scope.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { AgentActivity, WakeReason } from '../../shared/model/runs.ts';
import type { Effort } from '../../shared/model/providers.ts';
import type { Origin } from '../../shared/model/origin.ts';
import type { SplitTurn } from '../../shared/model/splits.ts'; // B-057
import { newId } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { StopKind, TurnControl, TurnOutcome, TurnRequest } from './turn-types.ts';
import type { LiveRoute } from './turn-attempt.ts'; // B-083: TurnRoute with the temperature
import { notesOf, wakeIds, type WakeGroup } from './dispatch-groups.ts';
import { ToolBoundary } from './dispatch-boundary.ts';
import type { LiveStatus } from './dispatch-live.ts';
import { turnEndedEarly } from './split-turn.ts'; // B-057
import { abandonRun, armRelease, CRASH_NOTE, RELEASE_MS, settleCrash } from './dispatch-settle.ts'; // B-059 #17/#18
import type { FoldWhy } from './compaction-policy.ts';
import type { TurnMemoryGate } from './dispatch-memory.ts';
import './context-fold.ts'; // TurnRequest.fold, TurnOutcome.fold

const MINUTE_MS = 60_000;

/**
 * When the wakes of a failed run with neither chat nor task are due again: 2^attempts minutes,
 * at most 30 minutes. A chat or task has its own continuation instead.
 */
export function retryAt(entry: Pick<RunEntry, 'conversationId' | 'taskId' | 'attempts'>, now: number): number | undefined {
  if (entry.conversationId || entry.taskId) return undefined;
  return now + Math.min(30, 2 ** Math.max(1, Math.min(entry.attempts, 5))) * MINUTE_MS;
}

/** What a running turn needs from the composition root. */
export interface TurnDeps {
  services: () => RuntimeServices;
  executor: { execute(request: TurnRequest): Promise<TurnOutcome> };
  /** Main and split lanes share admission; their engine is not yet known when the dispatcher picks a wake. */
  memoryGate?: Pick<TurnMemoryGate, 'wait'>;
  /** B-059 #18: how long an aborted main-lane turn may take to end before it is released (default RELEASE_MS; tests). */
  releaseMs?: number;
}

export interface RunEntry {
  runId: string;
  agentId: string;
  /** B-057: its lane – the agent id (main lane) or `<agentId>#<splitId>` (a split's). */
  lane: string;
  /** B-057: the split this lane's turn works for (absent on the main lane). */
  split?: SplitTurn;
  /** Chat of the run (the task's chat when the wakes named only the task). */
  conversationId?: string;
  taskId?: string;
  reason: WakeReason;
  /** B-054: what started the run (the group's origin). */
  origin?: Origin;
  wakeIds: string[];
  /** Runde „Halb“ 21.11.2026: the wakes of the groups riding along (TurnRequest.riders) – done once the turn ended done, else due again. */
  riderWakeIds?: string[];
  /** The turn ended done: its riders were seen. */
  ridden?: boolean;
  /** B-054: the most claims any of its wakes had (WakeQueue.claim counts them) – the retry's backoff. */
  attempts: number;
  controller: AbortController;
  control: TurnControl;
  note: string;
  boundary: ToolBoundary; // calls in flight; an urgent interrupt waits for the next boundary
  startedAt: number;
  /** What happens to the claimed wakes afterwards: done, or back to the queue (shutdown/urgent). */
  settle: 'done' | 'release';
  /** B-054: set when the run failed without chat and task – its wakes are released, due then (retryAt). */
  retryAt?: number;
  /** B-059 #18: released after it ignored its abort – its bookkeeping is done; the late end of the executor changes nothing. */
  released?: boolean;
  finished: Promise<void>;
  /** B-048 E4.5: what the turn runs on now (turn.ts bindTurn → request.onRoute; B-080: with its account; B-083: its temperature); absent while it routes. */
  route?: LiveRoute;
  /** KI-Runde 17.11.2026: the turn ended done and its session calls for a context fold (TurnOutcome.fold) – why. */
  fold?: FoldWhy;
}

export class RunningTurns {
  private readonly deps: TurnDeps;
  private readonly live: LiveStatus;
  private readonly onEnded: (agentId: string, split: boolean, ended: RunEntry) => void;
  private readonly running = new Map<string, RunEntry>(); // by lane (B-057): the agent id = its main lane

  constructor(deps: TurnDeps, live: LiveStatus, onEnded: (agentId: string, split: boolean, ended: RunEntry) => void) {
    this.deps = deps;
    this.live = live;
    this.onEnded = onEnded;
  }

  /** Every running lane (main and split). */
  get size(): number { return this.running.size; }
  /** The agent's main lane runs. */
  has(agentId: string): boolean { return this.running.has(agentId); }
  /** The agent's main-lane turn. */
  get(agentId: string): RunEntry | undefined { return this.running.get(agentId); }
  entries(): RunEntry[] { return [...this.running.values()]; }
  byRunId(runId: string): RunEntry | undefined { return [...this.running.values()].find((item) => item.runId === runId); }
  /** B-057: the turn on that lane. */
  lane(key: string): RunEntry | undefined { return this.running.get(key); }
  /** B-057: running split lanes (of one agent). */
  lanes(agentId?: string): RunEntry[] { return this.entries().filter((entry) => entry.split && (!agentId || entry.agentId === agentId)); }

  /** B-057: main lanes first (a lookup by agent and chat finds the agent's own turn), split lanes after them. */
  activity(): AgentActivity[] {
    return [...this.running.values()]
      .sort((a, b) => Number(Boolean(a.split)) - Number(Boolean(b.split)) || a.startedAt - b.startedAt)
      .map((entry) => {
        const item: AgentActivity = { agentId: entry.agentId, runId: entry.runId, note: entry.note, startedAt: entry.startedAt };
        if (entry.conversationId) item.conversationId = entry.conversationId;
        if (entry.taskId) item.taskId = entry.taskId;
        if (entry.origin) item.origin = entry.origin;
        if (entry.route) Object.assign(item, { model: entry.route.model, modelName: entry.route.modelName, effort: entry.route.effort, engine: entry.route.engine }); // never the account
        if (entry.route?.temperature !== undefined) Object.assign(item, { temperature: entry.route.temperature, temperatureSent: entry.route.temperatureSent === true }); // B-083
        if (entry.boundary.inFlight) item.toolCalls = entry.boundary.inFlight;
        if (entry.reason === 'fold') item.fold = true; // the live bar says what it is (22.11.2026)
        const split = entry.split; // B-057: a split's lane – its row reports its parent's chat (the chat's live block, F-52 views)
        if (split) item.split = { id: split.splitId, groupId: split.groupId, idx: split.idx, of: split.of, parentRunId: split.parentRunId, title: split.title };
        if (split?.parentConversationId) item.conversationId = split.parentConversationId;
        return item;
      });
  }

  /** Hook for ToolRegistryOptions: a call of that run started or ended (by call id, dispatch-boundary.ts). */
  setCall(ctx: { agentId: string; runId: string; callId: string }, running: boolean): void {
    this.ofRun(ctx.agentId, ctx.runId)?.boundary.tool(ctx.callId, running);
  }

  /** The running turn of that run on any lane of the agent (the main lane first). */
  private ofRun(agentId: string, runId: string): RunEntry | undefined {
    const main = this.running.get(agentId);
    if (main?.runId === runId) return main;
    return this.lanes(agentId).find((entry) => entry.runId === runId);
  }

  /** Starts the turn of `group` for an agent that has none running (the dispatcher checked); `riders` ride along in it (dispatch-groups.ts ridersOf). */
  start(services: RuntimeServices, agent: Agent, group: WakeGroup, riders: WakeGroup[] = []): void {
    let conversationId = group.conversationId;
    if (!mailMarker(group.origin) && !conversationId && group.taskId) {
      try { conversationId = services.tasks.get(group.taskId)?.conversationId; } catch { conversationId = undefined; }
    }
    const now = services.clock.now();
    const entry = runEntry({
      runId: newId('run', now), agentId: agent.id, lane: agent.id, conversationId, taskId: group.taskId, reason: group.reason,
      ...(group.origin ? { origin: group.origin } : {}), wakeIds: wakeIds([group]),
      attempts: Math.max(0, ...group.wakes.map((wake) => wake.attempts ?? 0)), startedAt: now,
      ...(riders.length ? { riderWakeIds: wakeIds(riders) } : {}),
    });
    this.launch(services, entry, {
      runId: entry.runId, agentId: agent.id, conversationId: group.conversationId, taskId: group.taskId,
      reason: group.reason, ...(group.origin ? { origin: group.origin } : {}), ...(group.originNote ? { originNote: group.originNote } : {}),
      notes: notesOf(group),
      ...(riders.length ? { riders: riders.map((rider) => ({ conversationId: rider.conversationId!, notes: notesOf(rider) })) } : {}),
    });
  }

  /**
   * KI-Runde 17.11.2026: the context fold's turn after `ended` (agents/context-fold.ts) – on the agent's main lane, a run of its
   * own with no wakes, in the chat `ended` came from (its live bar, its Stop). The dispatcher checked that nothing else is due.
   */
  fold(services: RuntimeServices, ended: RunEntry, why: FoldWhy): void {
    const now = services.clock.now();
    const entry = runEntry({
      runId: newId('run', now), agentId: ended.agentId, lane: ended.agentId, reason: 'fold', wakeIds: [], attempts: 0, startedAt: now,
      ...(ended.conversationId ? { conversationId: ended.conversationId } : {}),
    });
    this.launch(services, entry, { runId: entry.runId, agentId: entry.agentId, reason: 'fold', fold: why, notes: [] });
  }

  /** Runs `entry`'s turn on its lane (B-057: dispatch-lanes.ts starts split lanes here); the request gets the live hooks. */
  launch(services: RuntimeServices, entry: RunEntry, base: Omit<TurnRequest, 'signal' | 'control' | 'onStatus' | 'onTool' | 'onRoute'>): void {
    this.running.set(entry.lane, entry);
    armRelease(entry, this.deps.releaseMs ?? RELEASE_MS, () => this.release(entry)); // B-059 #18 (B-057: split lanes too)
    this.live.awake(true);
    if (!entry.split || !this.has(entry.agentId)) this.live.status(entry.agentId, 'working');
    else this.live.emit(); // B-057: the main lane keeps the agent's status line
    const request: TurnRequest = {
      ...base, signal: entry.controller.signal, control: entry.control,
      onStatus: (note) => this.onStatus(entry, note),
      onTool: (callId, running) => entry.boundary.tool(callId, running),
      onRoute: (route) => this.onRoute(entry, route),
    };
    // Nobody awaits a normal run: a failure in the bookkeeping must not become an unhandled rejection.
    entry.finished = this.execute(request, entry).catch((error: unknown) => {
      services.log.error('dispatcher run bookkeeping failed', { agentId: entry.agentId, runId: entry.runId, error: String(error) });
    });
  }

  private async execute(request: TurnRequest, entry: RunEntry): Promise<void> {
    await Promise.resolve(); // never run the executor (or finish) inside pump()
    const services = this.deps.services();
    try {
      if (!request.signal.aborted && this.deps.memoryGate) {
        await this.deps.memoryGate.wait(request.signal, (phase, note) => {
          const data = { agentId: entry.agentId, runId: entry.runId, splitId: entry.split?.splitId, ...note };
          if (phase === 'waiting') {
            services.log.info('turn waiting for memory headroom', data);
            this.onStatus(entry, 'Waiting for available memory');
          } else {
            services.log.warn('starting turn after bounded memory wait', data);
          }
        });
      }
      if (request.signal.aborted) { // interrupted before it started
        if (entry.split) turnEndedEarly(services, entry.runId, entry.split, entry.control.stopKind === 'human' ? 'stopped' : 'cut');
        return;
      }
      const outcome = await this.deps.executor.execute(request);
      // Finished work is never re-run, even when a shutdown/urgent abort arrived too late.
      if (outcome.status === 'done' || outcome.status === 'skipped') entry.settle = 'done';
      entry.ridden = outcome.status === 'done'; // a skipped turn showed its riders nothing
      if (outcome.fold) entry.fold = outcome.fold; // its session calls for a context fold: the dispatcher starts it when nothing else is due
      if (outcome.status === 'skipped' && entry.split) turnEndedEarly(services, entry.runId, entry.split, 'skipped'); // B-057: no run, no finish
      if (outcome.status === 'failed') {
        services.log.info('turn failed', { agentId: entry.agentId, runId: entry.runId, error: outcome.error });
        if (!this.mailReplyAttempted(services, entry)) this.markRetry(services, entry);
      }
    } catch (error) {
      services.log.error('turn crashed', { agentId: entry.agentId, runId: entry.runId, error: String(error) });
      const open = closeRun(services, entry.runId);
      turnEndedEarly(services, entry.runId, entry.split, 'crashed'); // B-057 – a mail-started run's splits too (it splits like any turn)
      if (!mailMarker(entry.origin)) settleCrash(services, entry, open); // B-059 #17: its bubble fails, its task gets its after-turn handling (a mail's run: its retry below)
      if (!this.mailReplyAttempted(services, entry)) this.markRetry(services, entry);
    } finally {
      if (!entry.released) this.finish(services, entry); // B-059 #18: a released turn was settled already
    }
  }

  /** B-059 #18: the aborted turn has not ended in time – its run is closed and its lane freed as if it had ended. */
  private release(entry: RunEntry): void {
    if (this.running.get(entry.lane) !== entry) return; // it ended
    const services = this.deps.services();
    entry.released = true;
    if (this.mailReplyAttempted(services, entry)) entry.settle = 'done';
    abandonRun(services, entry); // a mail-started run too: its splits hear it (afterParentTurn)
    // B-057: the split service hears the person's Stop now. A shutdown's cut stays 'running' there until its hung turn's
    // late end (or the boot reconcile) puts it back – never a second turn on its session meanwhile (prepareRestart cancel).
    if (entry.split && entry.control.stopKind === 'human') turnEndedEarly(services, entry.runId, entry.split, 'stopped');
    this.finish(services, entry);
  }

  private finish(services: RuntimeServices, entry: RunEntry): void {
    if (this.mailReplyAttempted(services, entry)) { entry.settle = 'done'; entry.retryAt = undefined; }
    entry.boundary.cancel(); // a deferred interrupt of an ended turn has nothing left to cut
    if (this.running.get(entry.lane) === entry) this.running.delete(entry.lane);
    if (!entry.split) { // B-057: a split lane has no wakes
      try {
        if (entry.settle === 'release') services.wakes.release(entry.wakeIds);
        else if (entry.retryAt !== undefined) services.wakes.release(entry.wakeIds, entry.retryAt);
        else services.wakes.done(entry.wakeIds);
        if (entry.riderWakeIds) { // riders: seen in a done turn, else due again as if never claimed (their own turn follows)
          if (entry.ridden) services.wakes.done(entry.riderWakeIds);
          else services.wakes.release(entry.riderWakeIds, undefined, true);
        }
      } catch (error) {
        services.log.warn('wake bookkeeping failed', { agentId: entry.agentId, error: String(error) });
      }
    }
    // B-057: idle only after the agent's last lane; its splits keep it working after the main turn.
    const left = this.entries().filter((item) => item.agentId === entry.agentId);
    if (!left.length) this.live.status(entry.agentId, 'idle');
    else if (!this.has(entry.agentId) && !entry.split) this.live.status(entry.agentId, 'working');
    else this.live.emit();
    this.onEnded(entry.agentId, entry.split !== undefined, entry);
    // After the hand-over, so a freed slot that is taken again does not flap the host lease.
    this.live.awake(this.running.size > 0);
  }

  /** B-054: a failed run with neither chat nor task keeps its wakes for a retry with backoff (a stop or shutdown decides itself). */
  private mailReplyAttempted(services: RuntimeServices, entry: RunEntry): boolean {
    return mailMarker(entry.origin) && services.runs.items(entry.runId).some(item => item.kind === 'note' && item.data.mailReplyAttempted === true);
  }

  private markRetry(services: RuntimeServices, entry: RunEntry): void {
    if (entry.split || entry.reason === 'fold' || entry.settle === 'release' || entry.control.stopKind) return; // B-057: the split service retries a split; a fold is asked for again at the next turn's end
    const at = retryAt(mailMarker(entry.origin) ? { attempts: entry.attempts } : entry, services.clock.now());
    if (at === undefined) return;
    entry.retryAt = at;
    services.log.info('chat-free run failed; its wake is retried', { agentId: entry.agentId, runId: entry.runId, attempts: entry.attempts, dueAt: at });
  }

  // ------------------------------------------------------------------ live status

  /** B-048 E4.5: the turn (re)built its route – the activity rows say so at once (only on a change). */
  private onRoute(entry: RunEntry, route: LiveRoute): void {
    if (this.running.get(entry.lane) !== entry) return;
    const before = entry.route;
    entry.route = {
      model: route.model, modelName: route.modelName, effort: route.effort, engine: route.engine, ...(route.accountId ? { accountId: route.accountId } : {}),
      ...(route.temperature !== undefined ? { temperature: route.temperature, temperatureSent: route.temperatureSent === true } : {}), // B-083
    };
    if (before && before.model === route.model && before.modelName === route.modelName && before.effort === route.effort && before.engine === route.engine
      && before.temperature === route.temperature && before.temperatureSent === entry.route.temperatureSent) return; // shown the same
    this.live.emit();
  }

  private onStatus(entry: RunEntry, note: string): void {
    const clean = note.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!clean || clean === entry.note || this.running.get(entry.lane) !== entry) return;
    entry.note = clean;
    if (entry.split) this.live.emit(); // B-057: a split's note shows in its activity row only
    else this.live.status(entry.agentId, 'working', clean);
  }

}

/** A fresh record of a turn on `lane` (the main lane is the agent id; B-057: a split's `<agentId>#<splitId>`). */
export function runEntry(fields: Pick<RunEntry, 'runId' | 'agentId' | 'lane' | 'reason' | 'wakeIds' | 'attempts' | 'startedAt'>
  & Partial<Pick<RunEntry, 'conversationId' | 'taskId' | 'origin' | 'split' | 'riderWakeIds'>>): RunEntry {
  const control: TurnControl = { lastSeq: 0, steeredSeq: 0 };
  return { ...fields, controller: new AbortController(), control, note: '', boundary: new ToolBoundary(), settle: 'done', finished: Promise.resolve() };
}

/** Aborts a turn as `kind` (the first kind decides, see the header); `settle` 'release' keeps its wakes for later. */
export function abortTurn(entry: RunEntry, reason: string, kind: StopKind, settle?: 'release'): void {
  if (kind !== 'urgent') entry.boundary.cancel(); // a deferred urgent interrupt never undoes a Stop or a shutdown
  if (entry.controller.signal.aborted) {
    // Already cut: a shutdown keeps the wakes; the person's Stop turns an urgent hand-over into a stop.
    if (kind === 'shutdown') entry.settle = 'release';
    else if (kind === 'human' && entry.control.stopKind === 'urgent') { entry.control.stopKind = 'human'; entry.settle = 'done'; }
    return;
  }
  if (settle) entry.settle = settle;
  entry.control.stopKind = kind;
  entry.controller.abort(new WorkforceError('cancelled', reason, { details: { stopKind: kind } })); // the engine sees only the signal
}

/**
 * B-080 (model.set now): the running turn takes `target` inside itself when that model runs on the turn's engine and on
 * the turn's own account (TurnRoute.accountId) and the engine switches it (Engine.setModel) – a run note
 * {modelSet: 'in-turn'}; the engine's 'model' event, once a request runs on it, moves the turn's books and the activity row
 * and ends the request model.set wrote (turn-attempt.ts, FIXES-3 C1 – until then it stays for my next turn). False: another engine or account,
 * an engine without setModel, a refusal (B-083: a refusal or a switch the engine does not apply is logged once) – the
 * caller continues in a new turn (which uses that request).
 */
export async function setModelInTurn(services: RuntimeServices, entry: RunEntry, target: { modelId: string; effort?: Effort }): Promise<boolean> {
  const engine = entry.control.engine;
  const route = entry.route;
  const to = services.catalog.get(target.modelId);
  if (!engine?.setModel || !route?.accountId || !to || to.engine !== engine.id || route.engine !== engine.id || !to.accounts.includes(route.accountId)) return false;
  const effort = target.effort ?? route.effort;
  try {
    const applied = await engine.setModel(entry.runId, to.model, effort);
    // B-083 (verdict silently-substituted fix 4): an in-turn switch the engine does not apply is measurable – the caller cuts and continues
    if (!applied) { services.log.info('model switch inside the turn not applied', { runId: entry.runId, engine: engine.id, model: to.id, effort }); return false; }
  } catch (error) {
    services.log.info('model switch inside the turn refused', { runId: entry.runId, model: to.id, error: String(error) });
    return false;
  }
  // `from` (B-080 splits fix #4): the model the turn ran on before – a part's head names its start model from it (splits/results.ts)
  try { services.runs.item(entry.runId, { kind: 'note', data: { modelSet: 'in-turn', model: to.id, effort, from: route.model }, effectStatus: 'none' }); } catch { /* journal is best effort */ }
  return true;
}

/** The executor threw: make sure the run is not left 'running' in the journal. B-059 #17: true when it was still open (its own finish never ran). */
function closeRun(services: RuntimeServices, runId: string): boolean {
  let open = false;
  try {
    const run = services.runs.get(runId);
    open = run !== undefined && (run.status === 'running' || run.status === 'queued');
    if (open) services.runs.finish(runId, { status: 'failed', endedAt: services.clock.now(), error: CRASH_NOTE });
  } catch (error) {
    services.log.warn('could not close crashed run', { runId, error: String(error) });
  }
  return open;
}
