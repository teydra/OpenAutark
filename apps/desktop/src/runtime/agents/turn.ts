// The turn executor: one agent turn from wake to integrated result.
//   plan (agent, mode, task, the subconscious's trace, previous model) → route (without images when no model can
//   read them) → session/prompt/input (S2: a changed prompt key keeps the session on its start record; it starts anew
//   only at a switch, no session, a fold, past the fit or a cold cache – rebuild.ts) →
//   run journal + streaming message → engine attempt → session renewal once when the native
//   session cannot continue (context full, thread gone; another folder, details.folder: quietly; the ended attempt's
//   tokens and cost stay the run's – mergeAttempts)
//   → the account learns what the attempt says about it (always, also after tool calls) →
//   failover on limit/unavailable (renewal only when no tool ran; failover also after tool calls whose effects are all known – PR3: the
//   continuation gets them as "What I already did then" (in the cut-off note); finish then judges and books every attempt:
//   tools, plan, tokens and cost – mergeAttempts; B-083: again after each account that fails, every failed account of the
//   turn left out, until routing has no other or tools with unknown effects ran; a context fold's turn has neither renewal nor
//   failover – it folds the session it resumes or nothing, agents/context-fold.ts) → finish (message, blocks, cursor, ownership …)
//   → the engine-reported context window is kept with the session. A turn that cannot start
//   (routing or preparation failed) ends as a failed run; for a task, no model or account to run
//   on is the ownership outcome 'unavailable' and a limit 'limit' (no stall), anything else
//   'failed' – an outage of a task leaves one quiet line per outage, no failed bubble (T06); an
//   outage of a chat turn without a task is noted for one automatic re-delivery (B-044, redelivery.ts) – B-080 wave 3: one
//   the platform re-delivers by itself leaves one quiet Paused line too (on its first attempt there), no red bubble.
// Owns: the phase order, run start, switch/renewal status lines (a turn on another model than my last one says why, as does an
// effort someone asked for – route-line.ts decides, switch-line.ts words it, RT5), the renewal retry, failover and recording
// the account consequence of every failed attempt (the rules – limit → cooling, a signed-out plan →
// needs_login plus one notification, CLI missing → error, else a short cooling – live in
// accounts/failure.ts, shared with helper calls).
// B-047 D4: the run's status lines carry meta.fromRun. 13.11.2026: a run has no row in the history – it shows in the
// chat's live bar from the dispatcher's activity (chat/live.ts); a turn that fails before its engine posts its failed
// bubble (a task's outage only its quiet line, T06).
// B-048 E4.5: bindTurn reports what the turn runs on after every (re)build (the activity's model fields). My next turn's step
// (an effort, a temperature – mine or my subconscious's) is used up only once the turn is built and bound – just before its
// engine runs (a turn that fails before its engine leaves it for the next one) – and only the one planning read
// (plan.nextStepAt): one written while the turn was routed or prepared holds for the next turn. 17.11.2026: the model I asked
// for is used up the same way by the turn that could apply it (plan.nextModelAt: at a boundary, or at once with now); off a
// boundary it stays stored and waits.
// B-054: the run row carries the plan's origin (what started it); session and repair-note bookkeeping use plan.thread.
// Owner 16.11.2026 ("Wenn eine Mail reinkommt, dann sollt ihr richtig arbeiten können"): a run a mail started is a turn
// like every other, with every tool; the mail stays data through its wake note and the app tools' untrusted marks.
// B-057: a split's turn (request.split, on its own dispatcher lane) runs the same phases on its thread `split:<id>`
// (agents/split-turn.ts); its run row names the split, and a split run that fails before its engine tells the split service;
// its session renewal starts fresh with the brief (no second seed from the parent).
// B-083: the route a turn runs on carries its temperature (turnRoute: the agent's own request over the person's suggestion),
// so its prompt's "## Now", its activity row (with whether the engine sends it), its switch lines – "<Agent> → <model> ·
// <effort> · temperature T – <why>", a change of my own temperature alone too – and its finished row all say the same.
// Never: runs two turns on one lane (the dispatcher guarantees that), retries a turn whose tool
// effects are unknown, keeps a session that cannot continue, or swallows a failure silently
// (run error; a failed message where the turn streams one or fails before the engine).

import type { RuntimeServices } from '../contracts.ts';
import type { Effort, RouteDecision } from '../../shared/model/providers.ts';
import type { Run } from '../../shared/model/runs.ts';
import { toErrorData, type WorkforceErrorData } from '../../shared/errors.ts';
import type { StatusLine } from '../../shared/model/chat.ts';
import { buildTurn, planTurn, routeRequest, visionUnavailable, withoutImages } from './turn-prepare.ts';
import { renewSession } from './session-choice.ts';
import { canFailover, liveRoute, runAttempt, sendsTemperature } from './turn-attempt.ts';
import { effectsKnown } from '../context/recent-actions.ts';
import { errorOutcome, finishTurn, saveRepairNotes, takeRepairNotes } from './turn-finish.ts';
import { ChatOutbox } from './chat-out.ts';
import { SessionStore } from './sessions.ts';
import { accountFailure, recordAccountFailure } from '../accounts/failure.ts';
import { isOutage } from './outages.ts';
import { outageLine, pausedLine } from './outage-line.ts';
import { noteChatOutage } from './redelivery.ts';
import { failoverText } from './switch-line.ts';
import { postRunLine, routeLine, type SwitchFrom } from './route-line.ts';
import { takeNextModel, takeNextRoute } from './next-route.ts';
import { splitTurnFailed } from './split-turn.ts'; // B-057
import { addCache } from '../engines/shared.ts';
import type { AttemptResult, RoutedTurn, TurnOutcome, TurnPlan, TurnRequest } from './turn-types.ts';

/** True when the agent is a current member of the chat. */
function isMember(services: RuntimeServices, conversationId: string, agentId: string): boolean {
  return services.chats.members(conversationId).some((item) => item.memberId === agentId && !item.leftAt);
}

/** Runs looked at for my last done turn. */
const SWITCH_WINDOW = 50;

/** The engine says its native session cannot continue (context window full, thread gone). */
export function sessionEnded(attempt: AttemptResult): boolean {
  return attempt.result.stop === 'error' && attempt.result.error?.details?.rebase === true;
}

/**
 * The switch line's base: what my last done turn ran on, in whichever chat (one context – the line stands once, in the chat
 * of the turn that switched); none: a first turn, no line. B-083: with the temperature that turn ran with; `at`: when it
 * began (a start model set since is new).
 */
export function switchedFrom(services: Pick<RuntimeServices, 'runs' | 'log'>, plan: Pick<TurnPlan, 'agent'>): SwitchFrom | undefined {
  let last: Run | undefined;
  try { last = services.runs.list(plan.agent.id, SWITCH_WINDOW).find((run) => !run.splitId && run.model && run.status === 'done'); } catch (error) { // B-057: never a split's run
    services.log.warn('reading the last turn failed', { agentId: plan.agent.id, error: String(error) });
  }
  if (!last?.model) return undefined;
  return {
    modelId: last.model, effort: last.effort ?? 'medium',
    ...(last.route?.temperature !== undefined ? { temperature: last.route.temperature } : {}), ...(last.startedAt !== undefined ? { at: last.startedAt } : {}),
  };
}

/** B-083: the route a turn runs on, with its temperature – the agent's own request (plan) over the person's suggestion (router). */
export function turnRoute(plan: Pick<TurnPlan, 'temperature'>, route: RouteDecision): RouteDecision {
  return plan.temperature === undefined || plan.temperature === route.temperature ? route : { ...route, temperature: plan.temperature };
}

/**
 * The turn after a session renewal or a failover: the second attempt's result, text, session, context size and time,
 * plus what both did – their tools (progress, approach line), the latest plan, tokens and cost
 * (the run and the agent's budget book both; each attempt's cost is already its own share, attempt-cost.ts). `lastUsage`
 * keeps the second attempt's own usage for its model's outcome (the first attempt's end says nothing about a model).
 */
export function mergeAttempts(first: AttemptResult, second: AttemptResult): AttemptResult {
  const paid = first.usage.costUsd !== undefined || second.usage.costUsd !== undefined;
  return {
    ...second,
    // B-049 F6: a compaction in the first attempt (the guard continues the same session) still counts.
    result: first.result.compacted && !second.result.compacted ? { ...second.result, compacted: true } : second.result,
    lastUsage: second.lastUsage ?? second.usage,
    toolCalls: first.toolCalls + second.toolCalls,
    tools: [...(first.tools ?? []), ...(second.tools ?? [])],
    plan: second.plan?.length ? second.plan : first.plan,
    usage: {
      inputTokens: first.usage.inputTokens + second.usage.inputTokens, outputTokens: first.usage.outputTokens + second.usage.outputTokens,
      ...addCache(first.usage, second.usage),
      ...(paid ? { costUsd: (first.usage.costUsd ?? 0) + (second.usage.costUsd ?? 0) } : {}),
      ...(second.usage.contextTokens !== undefined ? { contextTokens: second.usage.contextTokens } : {}),
    },
  };
}

/**
 * B-048 E4.5: hands a (re)built turn to the dispatcher's live handles – engine for steering, the
 * input's cursor – and reports what it runs on (AgentActivity's model, modelName, effort, engine;
 * dispatch-runs.ts re-emits the activity). Every path that builds the turn – route time, session
 * renewal or rebuild, failover, a later re-route – goes through here, so the shown model never lags.
 */
export function bindTurn(request: TurnRequest, turn: RoutedTurn): void {
  request.control.engine = turn.engine;
  request.control.lastSeq = turn.lastSeq;
  try { request.onRoute?.(liveRoute(turn, turn.route.temperature)); } catch { /* cosmetic */ } // B-080: the account too; B-083: the temperature (turnRoute)
}

export class TurnExecutor {
  private readonly services: () => RuntimeServices;

  constructor(services: () => RuntimeServices) {
    this.services = services;
  }

  async execute(request: TurnRequest): Promise<TurnOutcome> {
    const services = this.services();
    let plan = await planTurn(services, request);
    if (!plan) return { runId: request.runId, status: 'skipped' };

    services.runs.start({
      // 13.11.2026: the chat of the turn's main wake – a part's: the chat its work is for (agents.split part `chat`)
      id: request.runId, agentId: plan.agent.id, conversationId: plan.conversationId ?? plan.split?.chat, taskId: plan.task?.id,
      trigger: request.reason, deviceId: plan.agent.deviceId, ...(plan.origin ? { origin: plan.origin } : {}),
      ...(plan.split ? { splitId: plan.split.splitId } : {}), // B-057: the run of a split (runs.split_id)
    });
    const repairNotes = plan.fold ? [] : takeRepairNotes(services, plan.agent.id, plan.thread); // a fold's turn reads one note; the others wait for my next turn

    let turn: RoutedTurn;
    try {
      let route: RouteDecision;
      try {
        route = plan.fold?.route ?? await services.router.route(routeRequest(plan)); // a fold resumes its session where it is (agents/context-fold.ts)
      } catch (error) {
        // Images are a preference, not a requirement: without a model that can read them the
        // turn runs on the text and the agent is told. Failing instead would block the chat –
        // a failed turn keeps the image message unread, so every later turn would need vision.
        if (!plan.needsVision || !visionUnavailable(error)) throw error;
        plan = withoutImages(plan);
        route = await services.router.route(routeRequest(plan));
        services.runs.item(request.runId, { kind: 'note', data: { imagesHidden: true }, effectStatus: 'none' });
      }
      turn = await buildTurn(services, plan, request, turnRoute(plan, route), repairNotes);
    } catch (error) {
      // No engine ran, so nothing read these notes (the standard's among them): they wait for my next turn.
      saveRepairNotes(services, plan.agent.id, plan.thread, repairNotes);
      return this.failBeforeEngine(services, plan, request, toErrorData(error));
    }
    bindTurn(request, turn);
    this.announceSwitch(services, plan, request.runId, turn);
    if (!plan.split && plan.nextStepAt !== undefined) takeNextRoute(services.db, plan.agent.id, plan.nextStepAt); // B-080: the step this turn read is used up now
    if (!plan.split && plan.nextModelAt !== undefined) takeNextModel(services.db, plan.agent.id, plan.nextModelAt); // the model I asked for had its boundary (or ran at once)

    // 13.11.2026: what the run writes into chats – its <chat> blocks, posted as they arrive (agents/chat-out.ts)
    const out = new ChatOutbox(services, { agentId: plan.agent.id, runId: request.runId, ...(plan.callId && plan.conversationId ? { skip: plan.conversationId } : {}) });
    let attempt = await runAttempt(services, plan, turn, request, out);

    // Renew once (compaction + fresh session with the full projection) in the same run – only when
    // nothing external happened yet (else it is forgotten below); another folder: no chat line.
    // A fold turn is never renewed or routed elsewhere: it exists to fold the session it resumes (agents/context-fold.ts).
    if (sessionEnded(attempt) && attempt.toolCalls === 0 && !request.signal.aborted && !plan.fold) {
      const folder = attempt.result.error?.details?.folder === true;
      const retry = { ...request, interruption: { at: services.clock.now(), reason: attempt.result.error?.message ?? 'The previous session ended.' } };
      try { request.onStatus?.('starting a fresh session'); } catch { /* cosmetic */ }
      try {
        await renewSession(services, plan, turn.engine.id, request.runId, folder ? 'folder' : 'overflow');
        if (plan.split?.firstTurn) plan = { ...plan, split: { ...plan.split, firstTurn: false } }; // B-057: a renewed split starts fresh with its brief – never seeded (forked) again
        turn = await buildTurn(services, plan, retry, turn.route, repairNotes);
        bindTurn(request, turn);
        if (!folder) this.statusLine(services, plan, request.runId, 'note', 'Continued in a fresh session', { renewed: true, cause: attempt.result.error?.message });
        attempt = mergeAttempts(attempt, await runAttempt(services, plan, turn, request, out)); // the ended attempt's tokens and cost stay the run's
      } catch (error) {
        services.log.warn('session renewal retry could not start', { agentId: plan.agent.id, error: toErrorData(error).message });
      }
    }

    this.accountFailed(services, turn, attempt);
    // B-083: every account that failed in this turn stays out of the next route; it ends when routing has no other account
    // (the route throws or names a failed one) or when tools with unknown effects ran (canFailover).
    const failedAccounts: string[] = [];
    while (!plan.fold && canFailover(attempt, request.signal, attempt.toolCalls > 0 && effectsKnown(services, request.runId, attempt.toolCalls))) {
      const afterTools = attempt.toolCalls;
      const failed = turn;
      const first = attempt;
      failedAccounts.push(failed.account.id);
      if (attempt.result.error?.details?.declined === true) failedAccounts.push(failed.route.modelId); // 19.11.2026: a model that declined the conversation stays out of this turn on every account
      const limited = accountFailure(attempt.result) === 'limit';
      const switchedOff = attempt.result.error?.details?.switchedOff === true; // 25.11.2026: the person switched the plan off while the turn ran on it
      const retry = { ...request, interruption: { at: services.clock.now(), reason: attempt.result.error?.message ?? (limited ? 'Usage limit reached.' : 'The model was unavailable.') } };
      try {
        const alternative = turnRoute(plan, await services.router.route(routeRequest(plan, [...failedAccounts])));
        if (failedAccounts.includes(alternative.accountId)) break; // routing has no other account
        turn = await buildTurn(services, plan, retry, alternative, repairNotes);
        bindTurn(request, turn);
        // Once in the log, also for a start model the person had set on that plan (pin): the turn goes on the stand-in, nothing is replaced unseen.
        if (switchedOff) services.log.info('plan switched off – the turn goes on another account', { agentId: plan.agent.id, runId: request.runId, from: failed.route.modelId, fromAccount: failed.account.id, to: alternative.modelId, toAccount: alternative.accountId, pinned: plan.agent.modelPolicy?.pin === failed.route.modelId });
        services.runs.item(request.runId, { kind: 'note', data: { failover: { from: failed.route.modelId, fromAccount: failed.account.id, to: alternative.modelId, toAccount: alternative.accountId, reason: limited ? 'limit' : 'unavailable', ...(switchedOff ? { switchedOff: true } : {}), ...(afterTools ? { afterTools } : {}) } }, effectStatus: 'none' });
        const text = failoverText(plan.agent.name, this.runsOn(turn), { failedName: failed.modelName, sameModel: failed.route.modelId === alternative.modelId, limited, switchedOff });
        this.statusLine(services, plan, request.runId, 'model_switched', text, { from: failed.route.modelId, to: alternative.modelId, effort: alternative.effort, reason: limited ? 'limit' : 'unavailable' });
        attempt = mergeAttempts(first, await runAttempt(services, plan, turn, request, out));
        this.accountFailed(services, turn, attempt);
      } catch (error) {
        services.log.info('no failover route', { agentId: plan.agent.id, error: toErrorData(error).message });
        break;
      }
    }
    // Still unusable (tools ran, stopped, or the retry ended the same way): the next turn starts fresh.
    if (sessionEnded(attempt)) attempt = this.forgetSession(services, plan, turn, request, attempt);
    if (attempt.result.stop === 'done') out.segment(attempt.result.text || attempt.streamed, true); // the final text's blocks, its last open one closed
    await out.done();
    const outcome = finishTurn(services, plan, turn, request, attempt, out);
    // A turn that ended with nothing of mine in it did not read these notes either: they wait for my next turn.
    if (attempt.result.stop !== 'done' && !attempt.toolCalls && !attempt.streamed.trim()) saveRepairNotes(services, plan.agent.id, plan.thread, repairNotes);
    this.rememberWindow(services, plan, turn, attempt);
    return outcome;
  }

  /**
   * Records what a failed attempt says about its account (accounts/failure.ts) – also after tool
   * calls, so ownership retries and later turns do not land on the same used-up or signed-out plan again.
   */
  private accountFailed(services: RuntimeServices, turn: RoutedTurn, attempt: AttemptResult): void {
    try { recordAccountFailure(services, turn.account, turn.model, attempt.result); } catch (error) {
      services.log.warn('recording the account failure failed', { accountId: turn.account.id, failure: accountFailure(attempt.result), error: String(error) });
    }
  }

  /** Drops the binding and keeps finishTurn from saving the ended session again. */
  private forgetSession(services: RuntimeServices, plan: TurnPlan, turn: RoutedTurn, request: TurnRequest, attempt: AttemptResult): AttemptResult {
    try {
      new SessionStore(services.db).remove(plan.agent.id, plan.thread, turn.engine.id);
      services.runs.item(request.runId, { kind: 'note', data: { sessionDropped: 'ended' }, effectStatus: 'none' });
    } catch (error) {
      services.log.warn('dropping the ended session failed', { agentId: plan.agent.id, error: String(error) });
    }
    return { ...attempt, result: { ...attempt.result, session: undefined } };
  }

  /** The window the engine reported is kept with the session (renewal uses it when the catalog has none). */
  private rememberWindow(services: RuntimeServices, plan: TurnPlan, turn: RoutedTurn, attempt: AttemptResult): void {
    const window = attempt.result.contextWindow;
    if (!window || window <= 0 || !attempt.result.session || !turn.engine.caps.sessions) return;
    try { new SessionStore(services.db).setContextWindow(plan.agent.id, plan.thread, turn.engine.id, window); } catch (error) {
      services.log.warn('storing the context window failed', { agentId: plan.agent.id, error: String(error) });
    }
  }

  /**
   * A switch someone asked for (route-line.ts: my own request or temperature, a start model set since) becomes one quiet status line
   * (identity stays the agent) that says why: "Mara → X · high – my start model" (RT5, switch-line.ts; the agent reads it too).
   */
  private announceSwitch(services: RuntimeServices, plan: TurnPlan, runId: string, turn: RoutedTurn): void {
    const of = { agent: plan.agent.name, sent: this.runsOn(turn).sent, ownTemperature: plan.temperature !== undefined, pinAt: plan.agent.modelPolicy?.pinBy?.at };
    const line = routeLine(turn.route, turn.modelName, switchedFrom(services, plan), of);
    if (line) this.statusLine(services, plan, runId, 'model_switched', line.text, line.details);
  }

  /** B-083: what the turn runs on, as a switch line names it (the temperature: sent, or the agent's stance). */
  private runsOn(turn: RoutedTurn): { modelName: string; effort: Effort; temperature?: number; sent: boolean } {
    const { temperature } = turn.route;
    return { modelName: turn.modelName, effort: turn.route.effort, temperature, sent: temperature !== undefined && sendsTemperature(turn) };
  }

  /** A quiet line of this run (meta.fromRun: the UI may fold it into the run's steps). */
  private statusLine(services: RuntimeServices, plan: TurnPlan, runId: string, type: StatusLine['type'], text: string, details: Record<string, unknown>): void {
    postRunLine(services, { agentId: plan.agent.id, runId, conversationId: plan.conversationId, taskId: plan.task?.id }, type, text, details);
  }

  /**
   * Routing/preparation failed: close the run, tell the chat briefly, let ownership retry later –
   * no model or account to run on ('unavailable') and limits are no stall of the task. A task's
   * outage gets one quiet "Paused: … – continues by itself" line per outage instead of a failed
   * bubble on every retry (T06); B-080 wave 3: so does a chat turn's outage the platform re-delivers by itself (the line
   * on its first attempt there, by the agent); a setup error or any other failure keeps its bubble.
   * The subconscious's trace was shown to nobody: it waits for the next turn on the thread.
   */
  private failBeforeEngine(services: RuntimeServices, plan: TurnPlan, request: TurnRequest, error: WorkforceErrorData): TurnOutcome {
    const message = error.message;
    if (plan.trace) services.subconscious.putBack?.(plan.agent.id, plan.thread, plan.trace);
    services.runs.finish(request.runId, { status: 'failed', endedAt: services.clock.now(), error: message });
    let messageId: string | undefined;
    // B-044: no model or account for a chat turn – delivered again once one becomes usable (redelivery.ts); B-080 wave 3: its attempt number there.
    const retry = !plan.task && plan.conversationId ? noteChatOutage(services, { agentId: plan.agent.id, conversationId: plan.conversationId, runId: request.runId, cursor: plan.memberCursor, error, toolCalls: 0 }) : 0;
    const outage = isOutage(errorOutcome(error)) && (Boolean(plan.task) || retry > 0);
    const member = plan.conversationId !== undefined && isMember(services, plan.conversationId, plan.agent.id);
    if (outage && plan.task) outageLine(services, plan.task, message, request.runId); // meta.fromRun
    else if (outage) { if (retry === 1 && member) pausedLine(services, plan.conversationId!, message, { runId: request.runId, authorId: plan.agent.id }); } // B-080 wave 3: once per outage
    else if (plan.conversationId && member) {
      messageId = services.chats.postAgentMessage(plan.conversationId, plan.agent.id, request.runId, { body: '', state: 'failed', meta: { error: message } }).id;
    }
    if (plan.task) {
      try { services.ownership.afterTurn({ agentId: plan.agent.id, taskId: plan.task.id, runId: request.runId, progressed: false, outcome: errorOutcome(error), note: message, ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}) }); } catch (failure) { // B-059 C6: when the route can run again
        services.log.warn('ownership.afterTurn failed', { taskId: plan.task.id, error: String(failure) });
      }
    }
    splitTurnFailed(services, plan, request.runId, error); // B-057: a split's run that never reached its engine
    return { runId: request.runId, status: 'failed', messageId, error: message };
  }
}
