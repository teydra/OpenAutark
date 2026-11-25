// Turn phase 2 – one engine attempt: wires engine.run to our tools (dynamic tools or the
// MCP hub lease), the streamed text (kept for the finish – no chat row) and every text to the run's chat outbox
// (agents/chat-out.ts: a complete <chat> block posts at once – 13.11.2026), live status, usage, account limits and the run journal for engine-own tools.
// D5: reasoning is journaled live per block (reasoning-log.ts) and its headline is the live status;
// an engine-native call is journaled with its human line (shared/text/step-label.ts: summary + step),
// which is also the live status while it runs (the engine's raw "running <cmd>" line is dropped then).
// Owns: the EngineTurnInput callbacks, admission (heavy slot while a CLI engine runs) and the
// latest input coordinates for interruption context (interruption-context.ts),
// tool-call count failover relies on (engine-own, callTool and MCP hub calls) and whether each
// call succeeded (ours: its output, else tool_end; engine-native ones: tool_end – the progress signal), and each call's start and
// end for the dispatcher's tool boundaries (request.onTool, agents/dispatch-boundary.ts: engine-native
// calls by the engine's id; our calls under the registry's id – callTool here, MCP hub calls through
// the registry's onCall, so the engine's tool_start for them is not counted twice under another id).
// An abort releases the MCP lease at once, so a hub
// call arriving after a cut never starts (B-059: nor a callTool call). The dynamic tool
// list comes with the routed turn (buildTurn computes the offer the prompt key covers).
// The engine's folder is the task's active worktree (git/records.ts turnCwd), else the agent's home project (B-044), else the workspace.
// B-044 stall watchdog (stall-watch.ts): an engine quiet for 10 min (45 min while a tool call runs) is cut
// and the attempt ends 'unavailable' ("The
// engine stopped responding."), so turn.ts's failover applies (B-080: no account cools for it); a run note records the cut
// with how long the engine was silent (quietMs) and how long the attempt ran (afterMs).
// B-048 E1 (LEDGER): the attempt names its run to the context ledger (services.ledger.capture – the chat lines its
// input shows, then the run's journal items, become ledger items); an engine-native call's full output
// (tool_end.output, redacted) is journaled with its result, so the ledger can restore and replay it. B-049 F9: an
// engine-native call made inside a code-mode script is journaled with `nested` (and its script's id as `parent`).
// The attempt names its run to the context ledger (the chat lines its input shows, then the run's journal items, become ledger
// items) and journals the subconscious's calls of this turn as real calls with their outputs (journalTrace), so they stay in the
// ledger and in a rebuilt history; an engine that cannot show them natively gets them as a block in the input (engines/trace-text.ts).
// B-054: our tools see what started the run (ToolContext.origin, the wake group's) and the first line of an app-written
// wake note (ToolContext.wakeNote, at most WAKE_NOTE_MAX characters; only an outside event's ('event') own note, never a
// schedule, retry, review or message note – dispatch-groups.ts originNote).
// B-057 (agents/split-turn.ts): a split's calls carry ToolContext.split (also through the hub lease); its engine runs in its
// worktree or its group's folder. 07.11.2026: no turn waits for a heavy slot any more (split-admit.ts and the
// supervisor's admission are gone) – the attempt goes straight to 'Working'; how many turns run is the dispatcher's rule.
// B-059 #184: a provider's transient failure (an engine timeout, a cloud provider's HTTP 500/502/504 – never a local
// runtime's) ends the attempt 'unavailable' – an outage, not a failure of the model (engines/provider-outage.ts
// providerOutage), so turn.ts's cooling and failover apply (B-080: an engine timeout is our own process, details.local: no cooling).
// B-059 #182: an engine-native tool_result
// is journaled with its call's tool name (by call id), so the readers of the journal see which native call failed.
// B-080: that result's `preview` is its summary and output ("exit 1" and the error text), as our tools' preview; a fresh
// native session the engine announces ('session') is bound at once with the turn's start cursor (finishTurn overwrites it);
// an in-turn model switch ('model', Engine.setModel – Claude Code reports it once a request runs on it, Codex once it applied
// it, before a request did: open under FIXES-3 C1) moves the turn's
// route, the run's books and the activity row to it, ends my now-request (next-route.ts tookInTurn) and names the model my
// first requests ran on in the route's reason (FIXES-3 C1);
// the engine's own background work ('background') counts as a call in flight for the stall watch.
// B-083: the engine gets the turn's temperature – the agent's own request (plan), else the person's suggestion on the route;
// the activity row says whether the engine sends it (liveRoute, engines/http/temperature.ts); an in-turn switch posts the
// quiet switch line with the agent's name (route-line.ts postRunLine) – a running turn keeps its temperature.
// B-085: a turn the person stopped (stopKind 'human') whose engine still returns 'done' ends 'interrupted'.
// B-089 / package C (what a run costs): the attempt counts its model calls – one per 'usage' event of a per-request engine
// (Codex), else the count the event carries (Claude Code: its main-thread message_start), else absent – and costs itself from a
// session's running total; the engine sets, the kept total and the own cost are in agents/attempt-cost.ts.
// An in-turn switch that changes the effort makes it the agent's own.
// Never: decides failover or integrates the result (turn.ts / turn-finish.ts do).

import type { RuntimeServices } from '../contracts.ts';
import type { EngineEvent, EngineTurnResult } from '../engines/types.ts';
import { addCache } from '../engines/shared.ts';
import { WAKE_NOTE_MAX, failure, type ToolContext } from '../tools/types.ts';
import { toErrorData, WorkforceError } from '../../shared/errors.ts';
import { preview } from '../tools/outputs.ts';
import { maskKeyShapes } from '../secrets/redact.ts';
import { turnCwd } from '../git/records.ts';
import { accountFailure } from '../accounts/failure.ts';
import { providerOutage } from '../engines/provider-outage.ts'; // B-059 #184
import { StallWatch } from './stall-watch.ts';
import { ReasoningLog } from './reasoning-log.ts';
import { stepLabel, stepText } from '../../shared/text/step-label.ts';
import { calledTool } from '../tools/builtin/tools-meta.ts'; // B-049 F4 (TOOLS-CORE)
import type { AttemptResult, RoutedTurn, ToolUse, TurnPlan, TurnRequest, TurnRoute } from './turn-types.ts';
import { takesTemperature } from '../engines/http/temperature.ts'; // B-083
import { postRunLine } from './route-line.ts'; // B-083
import { REQUESTED_WHY, switchText } from './switch-line.ts'; // B-083
import { splitCwd } from './split-turn.ts'; // B-057
import { traceCallId } from '../../shared/model/subconscious.ts';
import { traceInput } from '../engines/trace-text.ts';
import { recordTurnInput } from './interruption-context.ts';
import { runWithNativeTimeouts } from './native-timeout.ts';
import { SessionStore } from './sessions.ts'; // B-080: a fresh native session bound at once
import { tookInTurn } from './next-route.ts'; // FIXES-3 C1
import { recordStart } from './session-key.ts'; // S2: with its start record
import { PER_REQUEST_USAGE, keptTotal, ownCost } from './attempt-cost.ts'; // B-089, package C
import type { ChatOutbox } from './chat-out.ts';

/**
 * B-054: the first line of the note of the outside event that started the run (TurnRequest.originNote – only an
 * 'event' wake's, dispatch-groups.ts), cut to WAKE_NOTE_MAX (app text, data only). Never another wake's note of the
 * group: a schedule, retry, review, child, handoff or message note is agent- or system-written.
 */
export function wakeNoteOf(request: Pick<TurnRequest, 'origin' | 'originNote'>): { wakeNote?: string } {
  if (!request.origin || !request.originNote) return {};
  const line = request.originNote.split('\n').map((part) => part.trim()).find(Boolean);
  if (!line) return {};
  return { wakeNote: line.length > WAKE_NOTE_MAX ? `${line.slice(0, WAKE_NOTE_MAX - 1)}…` : line };
}

/** B-083: the route fields a turn reports (TurnRoute), with its temperature and whether its engine sends it. */
export type LiveRoute = TurnRoute;

/** B-083: the temperature a turn runs with – the agent's own request (model.set, its subconscious), else the person's suggestion. */
export function turnTemperature(plan: Pick<TurnPlan, 'temperature'>, turn: Pick<RoutedTurn, 'route'>): number | undefined {
  return plan.temperature ?? turn.route.temperature;
}

/** B-083: the turn's engine puts a temperature on the wire for its model at its effort (else the model samples at its own setting). */
export function sendsTemperature(turn: Pick<RoutedTurn, 'engine' | 'model' | 'route'>): boolean {
  return takesTemperature(turn.engine.id, turn.model, turn.route.effort);
}

/** B-048 E4.5: what the turn runs on, as its activity row reports it (B-080: with its account; B-083: with its temperature). */
export function liveRoute(turn: RoutedTurn, temperature: number | undefined): LiveRoute {
  return {
    model: turn.route.modelId, modelName: turn.modelName, effort: turn.route.effort, engine: turn.engine.id, accountId: turn.account.id,
    ...(temperature !== undefined ? { temperature, temperatureSent: sendsTemperature(turn) } : {}),
  };
}

/** The subconscious's calls in the run's journal, as the calls they are (once per run, also over a failover). Never throws. */
function journalTrace(services: RuntimeServices, plan: TurnPlan, runId: string): void {
  try {
    plan.trace?.calls.forEach((call, index) => {
      const callId = traceCallId(runId, index);
      services.runs.item(runId, { kind: 'tool_call', name: call.tool, idemKey: `${callId}:call`, effectStatus: 'none', data: { callId, args: preview(services.secrets, call.args), summary: `Subconscious: ${call.tool}`, subconscious: true } });
      services.runs.item(runId, { kind: 'tool_result', name: call.tool, idemKey: `${callId}:result`, effectStatus: 'none', data: { callId, ok: true, summary: preview(services.secrets, call.output, 400), output: { content: [{ type: 'text', text: call.output }] } } });
    });
  } catch (error) {
    services.log.warn('journaling the subconscious calls failed', { runId, error: String(error) });
  }
}

export async function runAttempt(services: RuntimeServices, plan: TurnPlan, turn: RoutedTurn, request: TurnRequest, out?: ChatOutbox): Promise<AttemptResult> {
  const started = services.clock.now();
  recordTurnInput(services, plan, request, turn.lastSeq);
  const status = (note: string) => { try { request.onStatus?.(note); } catch { /* cosmetic */ } };
  // 17.11.2026 (BEFUND-RUNTIME-JAN §1): a fresh stream buffer per attempt; a mid-turn block that did not arrive is told to
  // this running turn at once (its next model request reads the line), not only to the next turn.
  const steer = turn.engine.steer?.bind(turn.engine);
  out?.attach(steer ? (line) => { steer(request.runId, line).catch(() => false); } : undefined);
  // B-044: the engine and our calls run on the watch's signal (the turn's own abort, or the stall cut).
  const watch = new StallWatch({ now: () => services.clock.now(), parent: request.signal });
  // Our calls also end with the attempt itself (a failover starts the next one): a call still holding – a waiting
  // agents.split – ends 'stopped' then, so its parts wake the origin instead of counting as read.
  const ended = new AbortController();
  const callSignal = AbortSignal.any([watch.signal, ended.signal]);
  // The routed model of this attempt (a failover brings its own).
  const toolCtx: Omit<ToolContext, 'services'> = {
    agent: plan.agent, runId: request.runId, conversationId: plan.conversationId, taskId: plan.task?.id,
    mode: plan.mode.key, deviceId: plan.agent.deviceId, modelId: turn.route.modelId, signal: callSignal,
    status: (note) => { watch.activity(); status(note); },
    ...(plan.origin ? { origin: plan.origin } : {}), ...wakeNoteOf(request),
    ...(plan.split ? { split: plan.split } : {}), // B-057 S15: the parent's chat/task for reads
  };
  // A failover attaches again with its own engine and model.
  // The subconscious's calls stand in front of the chat lines of this turn, as the engine's own session holds them (injected before the input).
  const journal = () => journalTrace(services, plan, request.runId);
  if (!plan.split && services.ledger?.capture) services.ledger.capture({ runId: request.runId, agentId: plan.agent.id, thread: plan.thread, conversationId: plan.conversationId ?? '', engine: turn.engine.id, model: turn.route.modelId, seenSeq: turn.lastSeq, fromSeq: turn.session ? plan.memberCursor : 0, first: journal });
  else journal();
  let streamed = '';
  // D5: reasoning blocks are journaled live, one run item each, between the steps (reasoning-log.ts).
  const thoughts = new ReasoningLog({
    open: (summary) => services.runs.item(request.runId, { kind: 'reasoning', data: { summary, live: true }, effectStatus: 'none' })?.id,
    update: (itemId, data) => services.runs.updateItem(itemId, { data }),
    redact: (text) => services.secrets.redact(text),
    status, now: () => services.clock.now(),
    warn: (message, error) => services.log.warn(message, { runId: request.runId, error: String(error) }),
  });
  let toolCalls = 0;
  const ownCalls = new Set<string>(); // engine-native tool calls (ours are journaled by the registry)
  const managedCalls = new Set<string>(); // 0.3.19: those of them with the managed-shell row mark
  // Our tools arrive via callTool (dynamic tools / function calls) or through the MCP hub
  // (Claude, ACP agents: only a tool_start with own:false). Both count, once per call id.
  const ourCalls = new Set<string>();
  const used: ToolUse[] = []; // what ran, for the progress signal (turn-types.ts effectful)
  const ourUses = new Map<string, ToolUse>(); // call id → its entry in `used` (ok arrives with the output or tool_end)
  const nativeUses = new Map<string, ToolUse>(); // B-059: engine-native call id → its entry (a failed or declined call is no activity)
  let planSteps: string[] | undefined; // the engine's latest plan
  let planDone: number | undefined; // B-059: how many of its steps are done (an outcome when the same plan finishes more)
  // Tool boundaries for the dispatcher (an urgent interrupt waits until no call is in flight).
  const boundary = (callId: string, running: boolean) => { try { request.onTool?.(callId, running); } catch { /* bookkeeping only */ } };
  const countOurs = (callId: string, name?: string): ToolUse | undefined => {
    if (callId && ourCalls.has(callId)) return ourUses.get(callId);
    if (callId) ourCalls.add(callId);
    toolCalls++;
    const use: ToolUse = { name: name ?? 'tool', category: name ? services.tools.get(name)?.category : undefined, native: false };
    used.push(use);
    if (callId) ourUses.set(callId, use);
    return use;
  };
  const usage: AttemptResult['usage'] = { inputTokens: 0, outputTokens: 0 };
  const perRequest = PER_REQUEST_USAGE.has(turn.engine.id); // B-089: its usage events count the model calls
  let modelCalls: number | undefined = perRequest ? 0 : undefined; // package C: or the engine's own count on the event
  const kept = keptTotal(services, plan, turn); // package C: the session's running total before this attempt
  const temperature = turnTemperature(plan, turn); // B-083 (T3 request 1): the agent's own, else the person's suggestion

  const onEvent = (event: EngineEvent) => {
    watch.activity();
    try {
      switch (event.type) {
        case 'text':
          if (event.delta) thoughts.close();
          streamed += event.delta;
          if (event.delta) out?.text(event.delta);
          break;
        case 'reasoning':
          thoughts.delta(event.delta, event.id);
          break;
        case 'reasoning_end':
          thoughts.end(event.id, event.text);
          break;
        case 'commentary':
          thoughts.close();
          if (event.text.trim()) {
            streamed = ''; // pre-tool text is an update, never the fallback final answer
            const update = services.runs.item(request.runId, { kind: 'note', name: 'Update', data: { text: services.secrets.redact(event.text).slice(0, 4000), commentary: true }, effectStatus: 'none' });
            out?.segment(event.text, false, update?.id); // the note names the messages its blocks became (the ledger keeps them through a fold)
            status(services.secrets.redact(event.text).replace(/\s+/g, ' ').slice(0, 140));
          }
          break;
        case 'plan':
          thoughts.close();
          planSteps = event.steps.map((step) => step.text).filter(Boolean);
          planDone = event.steps.filter((step) => step.text && step.status === 'done').length; // B-059
          services.runs.item(request.runId, { kind: 'plan', data: { steps: event.steps }, effectStatus: 'none' });
          break;
        case 'tool_start': {
          thoughts.close();
          // D5: what the step does in words ("Ran npm test", "Read src/app.ts") – the live status while it runs.
          const shown = event.own ? event : calledTool(event.name, event.args); // B-049 F4: a tools.call shows and counts as the tool it runs
          const step = stepLabel(shown.name, shown.args, { own: event.own, ...(event.title ? { title: event.title } : {}) });
          status(preview(services.secrets, stepText(step, true) || event.name, 140));
          watch.call(event.callId, true);
          if (event.own) {
            boundary(event.callId, true); // ours are reported by the registry (onCall) under its own id
            if (event.callId && ownCalls.has(event.callId)) break; // an engine may repeat 'running' updates of one call
            ownCalls.add(event.callId);
            if (event.managed) managedCalls.add(event.callId); // 0.3.19: the row mark (a script call on a thread without native shell)
            toolCalls++;
            const use: ToolUse = { name: event.name, native: true };
            used.push(use);
            nativeUses.set(event.callId, use); // B-059: its tool_end says whether it ran (ok)
            // Engine-native calls carry their human line too (ours get the registry's action summary).
            const target = preview(services.secrets, step.target, 300);
            const args = preview(services.secrets, event.args);
            services.runs.item(request.runId, {
              kind: 'tool_call', name: event.name, effectStatus: 'none',
              data: {
                callId: event.callId, own: true, args,
                ...(args.endsWith('…') ? { argsChars: argsLength(event.args) } : {}), // B-049 F9: the ledger's estimate of a cut preview (an exec script)
                summary: preview(services.secrets, stepText(step), 300), step: { ...step, target },
                ...(event.title ? { title: preview(services.secrets, event.title, 200) } : {}),
                ...(event.nested ? { nested: true, ...(event.parent ? { parent: event.parent } : {}) } : {}), // B-049 F9: a call inside a code-mode script
                ...(event.managed ? { managed: true } : {}),
              },
            });
          } else countOurs(event.callId, shown.name);
          break;
        }
        case 'tool_end':
          watch.call(event.callId, false);
          if (ownCalls.delete(event.callId)) {
            boundary(event.callId, false);
            const native = nativeUses.get(event.callId);
            if (native) native.ok = event.ok; // B-059: a failed or declined engine-native call is no activity (turn-types.ts effectful)
            // This is only Autark's projection; the engine has already handled the native result.
            // Never persist the original text when either masking step fails.
            const checked = (value: string, limit = Infinity) => {
              let masked: string;
              try { masked = maskKeyShapes(services.secrets.redact(value)); }
              catch { masked = '[tool output withheld: redaction unavailable]'; }
              return masked.length > limit ? masked.slice(0, limit) + '…' : masked;
            };
            services.runs.item(request.runId, { kind: 'tool_result', name: native?.name, data: { // B-059 #182: named by its call
              callId: event.callId, ok: event.ok, summary: checked(event.summary ?? '', 400),
              preview: checked([event.summary, event.output].filter(Boolean).join('\n'), 600), // B-080: "exit 1" and what it printed, as our tools' preview
              ...(event.output ? { output: checked(event.output) } : {}), // B-048 E1 (LEDGER): kept whole by the journal (over 4,000 chars: a blob)
              ...(managedCalls.delete(event.callId) ? { managed: true } : {}), // written here, masked above: never derived from a session's mark
            }, effectStatus: 'none' });
          } else {
            // Our call (MCP hub or dynamic tool); its start may have been missed: a tool still ran.
            const use = countOurs(event.callId);
            if (use && use.ok === undefined) use.ok = event.ok; // callTool's own output decides first
          }
          break;
        case 'usage':
          if (perRequest) modelCalls = (modelCalls ?? 0) + 1; // B-089
          else if (event.modelCalls !== undefined) modelCalls = event.modelCalls; // package C: the engine's own count so far
          // Engines report running totals per turn; keep the latest (and the largest context).
          usage.inputTokens = Math.max(usage.inputTokens, event.inputTokens);
          usage.outputTokens = Math.max(usage.outputTokens, event.outputTokens);
          if (event.costUsd !== undefined) usage.costUsd = event.costUsd;
          if (event.contextTokens !== undefined) usage.contextTokens = event.contextTokens;
          break;
        case 'limits':
          services.accounts.updateLimits(turn.account.id, event.limits);
          break;
        case 'status':
          // D5: while an engine-native call runs its worded step is the status; the engine's own raw line
          // for it ("running C:\…\powershell.exe -Command …", "using Read") never replaces it.
          if (ownCalls.size) break;
          status(event.note);
          break;
        case 'session': { // B-080: the engine's fresh session is bound now (as finishTurn binds it) – a kill or restart mid-turn resumes it
          if (!turn.engine.caps.sessions) break;
          // S2: a new ref started with this turn's prompt and gets its start record with its binding; the session the turn
          // resumed keeps the key it was bound with (a session from before the record takes this turn's only once a turn ran through).
          const fresh = event.ref !== turn.session?.ref;
          new SessionStore(services.db).save({
            agentId: plan.agent.id, conversationId: plan.thread, engine: turn.engine.id, accountId: turn.account.id, ref: event.ref, generation: event.generation,
            cursorSeq: plan.memberCursor, model: turn.route.modelId, updatedAt: services.clock.now(), promptKey: fresh ? turn.promptKey : turn.session?.promptKey ?? turn.promptKey, mode: plan.mode.key,
          });
          if (fresh && turn.sessionStart) recordStart(services.db, { agentId: plan.agent.id, thread: plan.thread, engine: turn.engine.id }, turn.sessionStart, services.clock.now());
          break;
        }
        case 'model': { // B-080: the engine runs this turn on my model.set now – the run's route, cost and the activity row take the new model
          const before = turn.route;
          const beforeName = turn.modelName;
          const info = services.catalog.list().find((model) => model.engine === turn.engine.id && model.model === event.model);
          turn.route = { ...turn.route, ...(info ? { modelId: info.id } : {}), effort: event.effort, ...(event.effort !== before.effort ? { effortBy: 'request' as const } : {}) }; // B-089
          turn.model = event.model;
          if (info) turn.modelName = info.name;
          toolCtx.modelId = turn.route.modelId;
          try { request.onRoute?.(liveRoute(turn, temperature)); } catch { /* cosmetic */ }
          if (before.modelId === turn.route.modelId && before.effort === turn.route.effort) break;
          // FIXES-3 C1: the request is used up once a request of this turn ran on it (until then my next turn takes it); a part's lane holds none
          if (!toolCtx.split) { try { tookInTurn(services.db, plan.agent.id, services.clock.now()); } catch (error) { services.log.warn('next-step model request not ended', { runId: request.runId, error: String(error) }); } }
          // FIXES-3 C1: the run names the model of its last request; the one its first requests ran on stands in its route's reason
          if (before.modelId !== turn.route.modelId) turn.route = { ...turn.route, reason: [before.reason, `first requests on ${beforeName}`].filter(Boolean).join(' · ') };
          // B-083: the switch inside the turn gets its quiet line too (my model.set now)
          const to = { modelName: turn.modelName, effort: turn.route.effort, temperature, sent: temperature !== undefined && sendsTemperature(turn) };
          postRunLine(services, { agentId: plan.agent.id, runId: request.runId, conversationId: plan.conversationId, taskId: plan.task?.id }, 'model_switched',
            switchText(plan.agent.name, to, REQUESTED_WHY), { from: before.modelId, to: turn.route.modelId, effort: turn.route.effort, inTurn: true });
          break;
        }
        case 'background': // B-080: the engine's own background work counts as a call in flight for the stall watch
          watch.call(`bg:${event.id}`, event.running);
          break;
        case 'compacted': // KI-Runde 17.11.2026 (package S1): the engine compacted the session by itself – journaled with its own figures
          services.runs.item(request.runId, { kind: 'note', data: { compacted: 'engine', ...(event.before !== undefined ? { before: event.before } : {}), ...(event.after !== undefined ? { after: event.after } : {}), ...(event.ms !== undefined ? { ms: event.ms } : {}) }, effectStatus: 'none' });
          break;
      }
    } catch (error) {
      services.log.warn('engine event handling failed', { runId: request.runId, type: event.type, error: String(error) });
    }
  };

  const lease = turn.engine.caps.mcp ? services.mcp.lease({
    agent: plan.agent, runId: request.runId, conversationId: plan.conversationId, taskId: plan.task?.id, mode: plan.mode.key, deviceId: plan.agent.deviceId, modelId: turn.route.modelId,
    ...(toolCtx.origin ? { origin: toolCtx.origin } : {}), ...(toolCtx.wakeNote ? { wakeNote: toolCtx.wakeNote } : {}), // B-054: the hub's calls see what started the run too
    ...(toolCtx.split ? { split: toolCtx.split } : {}), // B-057: a split's hub calls carry it too
  }, turn.hubTools) : undefined; // S2: the hub serves the turn's offer (a resumed session's own)
  // A cut (Stop, emergency stop, urgent interrupt at a boundary) ends the hub's calls and refuses late ones at once.
  const releaseLease = () => lease?.release();
  if (lease) watch.signal.addEventListener('abort', releaseLease, { once: true });
  // The tool offer is computed by buildTurn (SES2: the session's prompt key covers exactly these).
  const tools = turn.engine.caps.dynamicTools ? (turn.tools ?? []) : [];
  let result: EngineTurnResult;
  // 25.11.2026 (task_3jyxzgfq): the person switches the account this attempt runs on off (here, or on another PC of the company –
  // the sync announces that row too): the attempt is cut at once and fails over to another account (agents/turn.ts), instead of
  // waiting on the switched-off plan until the stall cut. Also an account that was switched off between the route and now.
  const offSwitch = services.bus.on('account.upserted', (changed) => { if (changed.id === turn.account.id && changed.enabled === false) watch.cutSwitchedOff(); });
  try {
    if (accountSwitchedOff(services, turn.account.id)) watch.cutSwitchedOff();
    status('Working'); // D5: the reasoning headline or the running step replaces it as soon as there is one
    watch.start();
    // An engine that subscribes to abort at startup cannot hear an earlier abort event.
    watch.signal.throwIfAborted();
    result = await runWithNativeTimeouts(turn.engine, {
      runId: request.runId, agentId: plan.agent.id, account: turn.account, model: turn.model, effort: turn.route.effort,
      ...(temperature !== undefined ? { temperature } : {}), // B-078/B-083: the turn's temperature (engines whose model takes one send it)
      session: turn.session ? { ref: turn.session.ref, generation: turn.session.generation, ...(turn.session.contextTokens !== undefined ? { contextTokens: turn.session.contextTokens } : {}) } : undefined,
      system: turn.prompt, tools,
      ...(turn.trace && !turn.engine.caps.trace ? { input: [traceInput(turn.trace.calls), ...turn.input] } : { input: turn.input, ...(turn.trace ? { trace: turn.trace } : {}) }),
      callTool: async (name, args, callId) => {
        if (callSignal.aborted) return failure('The turn was stopped; this call did not run.'); // B-059: never after a cut or the attempt's end
        boundary(callId, true);
        watch.call(callId, true); // B-059: before the count – an overrun it triggers waits for this call to end
        try {
          const use = countOurs(callId, calledTool(name, args).name); // B-049 F4: tools.call counts as its target
          const output = await services.tools.call(name, args, toolCtx, callId);
          // Failed or refused: no progress by itself. An unknown external effect may have happened.
          if (use) use.ok = !output.isError || output.effect?.status === 'unknown';
          return output;
        } finally { boundary(callId, false); watch.call(callId, false); }
      },
      mcp: lease ? { url: lease.url, token: lease.token } : undefined,
      cwd: splitCwd(services, plan.split) ?? turnCwd(services, plan.task, plan.agent.id), // I02: the task's own worktree once it has one, else (B-044) the agent's home project, else the workspace; B-057: a split's worktree or its group's folder
      onEvent, signal: watch.signal,
    }, { ...toolCtx, services }, { thread: plan.thread });
  } catch (error) {
    if (request.signal.aborted) result = { text: streamed, stop: 'interrupted' };
    else if (watch.cutError) result = { text: streamed, stop: 'error', error: watch.cutError }; // the stall cut, or B-059's overrun
    else {
      const data = toErrorData(error);
      result = { text: streamed, stop: data.code === 'rate_limited' ? 'limit' : 'error', error: error instanceof WorkforceError ? data : { ...data, code: data.code } };
    }
  } finally {
    offSwitch();
    thoughts.close(); // a block still open ends with the attempt (live: false)
    ended.abort();
    watch.stop();
    watch.signal.removeEventListener('abort', releaseLease);
    lease?.release();
  }
  // B-085: the person's Stop wins over an engine that did not hear it and still says 'done'.
  if (request.signal.aborted && request.control.stopKind === 'human' && result.stop === 'done') result = { ...result, stop: 'interrupted' };
  if (turn.trace && (!turn.engine.caps.trace || result.traceAsText)) {
    try { services.runs.item(request.runId, { kind: 'note', data: { traceAsText: result.traceAsText ?? turn.engine.id }, effectStatus: 'none' }); } catch { /* journal is best effort */ }
  }
  result = providerOutage(result, turn.account); // B-059 #184: an engine timeout or a cloud HTTP 500/502/504 is an outage of the account
  // The engine answered the cut as an interrupt (or an error of its own): the stall (B-059: or the overrun) is what happened.
  const cut = watch.cutError;
  if (cut && !request.signal.aborted && result.stop !== 'done') {
    result = { text: streamed, stop: 'error', error: cut, ...(result.session ? { session: result.session } : {}), ...(result.usage ? { usage: result.usage } : {}) };
  }
  if (watch.stalled) {
    services.log.warn('engine stopped responding; attempt cut', { runId: request.runId, engine: turn.engine.id, toolCalls });
    // B-080: quietMs – how long the engine was silent at the cut; afterMs – how long the attempt ran
    try { services.runs.item(request.runId, { kind: 'note', data: { stalled: { engine: turn.engine.id, quietMs: watch.quietMs, afterMs: services.clock.now() - started } }, effectStatus: 'none' }); } catch { /* journal is best effort */ }
  }
  if (result.usage) {
    usage.inputTokens = Math.max(usage.inputTokens, result.usage.inputTokens);
    usage.outputTokens = Math.max(usage.outputTokens, result.usage.outputTokens);
    if (result.usage.costUsd !== undefined) usage.costUsd = result.usage.costUsd;
    Object.assign(usage, addCache(result.usage, {})); // the turn's cached input as its result sums it (Codex's events count per request)
  }
  if (result.contextTokens !== undefined) usage.contextTokens = result.contextTokens;
  const own = kept.counts && usage.costUsd !== undefined ? ownCost(services, plan, turn, result, usage.costUsd, kept.usd) : undefined;
  if (own) usage.costUsd = own.usd;
  return { result, streamed, reasoning: thoughts.text, toolCalls, tools: used, plan: planSteps, ...(planDone !== undefined ? { planDone } : {}), usage, ...(modelCalls !== undefined ? { modelCalls } : {}), ...(own?.total ? { costTotal: own.total } : {}), ms: services.clock.now() - started };
}

/** The account was switched off by the person (read live; an account that cannot be read counts as on). */
function accountSwitchedOff(services: RuntimeServices, accountId: string): boolean {
  try { return services.accounts.get(accountId)?.enabled === false; } catch { return false; }
}

/** The full length of a call's arguments as the journal would show them uncut (B-049 F9). */
function argsLength(args: unknown): number {
  try { return typeof args === 'string' ? args.length : (JSON.stringify(args) ?? '').length; } catch { return 0; }
}

/**
 * Errors worth one retry on another account/model – an account failure (accounts/failure.ts): before
 * any tool call, or (PR3) after tool calls when every effect is known (`effectsKnown`) – the
 * continuation then gets them as its recap.
 */
export function canFailover(attempt: AttemptResult, signal: AbortSignal, effectsKnown = false): boolean {
  if (signal.aborted || (attempt.toolCalls > 0 && !effectsKnown)) return false;
  return accountFailure(attempt.result) !== undefined;
}
