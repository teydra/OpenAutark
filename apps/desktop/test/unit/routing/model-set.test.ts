// model.set through the tool, planTurn (agents/next-route.ts, agents/boundary.ts), the real router and the run journal.
// 17.11.2026 – the model settles, only the effort moves per turn: an effort I ask for is one turn's and my settled effort
// returns after it (also after an effort my subconscious or a task set for one message); a model I ask for waits while my
// session is live, runs from where my context next starts anew (here: an hour of rest) and then stays – the model I am on
// is where every turn starts, never a model several runs old; a task's request is its effort, on every turn of the task
// until it is done, and a model named with it is mine; a change of the kind of work does not carry the old effort and
// leaves the model I am on.
// B-080: `task` names the task (key agent + task: its turns in any chat run at its effort), the answer names what the
// preview route runs on (effort-only too), a temperature rides on the plan without a run to return to, planTurn leaves the
// step for turn.ts to take (the turn helper here takes it like turn.ts before the engine: the ones the plan read,
// plan.nextStepAt and plan.nextModelAt). B-080 review: with pinned Sol unavailable two turns of one task keep the task's
// category. B-083: the person's suggestion (chip) is information (13.11.2026: never a route) – my model or effort is
// stored, the answer names whose suggestion I leave (this chat or the task's chat); a temperature that does not reach the
// model is my stance for the step. D1: a named model carries `from` (the model I am on); one that cannot run now is
// answered with `instead` and never switches my running turn; D4: an effort the model lacks is stored as asked and
// clamped by the router.
// Owns: these assertions only. Never: real engines, accounts, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from '../chat/harness.ts';
import { FakeAccounts, FakeEngine, account, mode } from '../models/harness.ts';
import { Priors } from '../../../src/runtime/models/priors.ts';
import { Catalog } from '../../../src/runtime/models/catalog.ts';
import { RouterImpl } from '../../../src/runtime/routing/router.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { defaultSettings } from '../../../src/runtime/settings/defaults.ts';
import { planTurn, routeRequest } from '../../../src/runtime/agents/turn-prepare.ts';
import { SessionStore } from '../../../src/runtime/agents/sessions.ts';
import { pendingRoute, returnChoice, setNextRoute, setTaskRoute, takeNextModel, takeNextRoute } from '../../../src/runtime/agents/next-route.ts';
import { NO_TASK_TEXT, modelTools } from '../../../src/runtime/tools/builtin/models.ts'; // B-048: model.set moved here from skills.ts
import { taskTools } from '../../../src/runtime/tools/builtin/tasks.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import type { Effort, EngineId, RouteDecision } from '../../../src/shared/model/providers.ts';
import type { Run } from '../../../src/shared/model/runs.ts';
import path from 'node:path';
import { Org } from '../../../src/runtime/org/service.ts';
import { AgentRepo } from '../../../src/runtime/store/agents.ts';
import { setPolicy } from '../../../src/runtime/routing/policies.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';

const SOL = 'codex:gpt-6.1-sol';
const LUNA = 'codex:gpt-6-luna';
const OPUS = 'claude:claude-opus-5-5';
const AGENT = 'ag_ada';
const caps = { vision: true, tools: true, structuredOutput: true };
const ALL: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const HOUR = 60 * 60_000;
const PRIORS = Priors.parse({
  version: 'test-rt2',
  categories: {},
  models: [
    { match: 'gpt-6.1-sol*', name: 'GPT-6.1 Sol', tier: 'frontier', relCost: 0.3, caps, efforts: ALL, strengths: { coding: 0.8, research: 0.7, chat: 0.4, 'cheap-chat': -0.2 } },
    { match: 'gpt-6-luna*', name: 'GPT-6 Luna', tier: 'small', relCost: 0.03, caps, efforts: ['none', 'low', 'medium', 'high'], strengths: { coding: 0, research: 0.2, chat: 0.4, 'cheap-chat': 0.8 } },
    { match: 'claude-opus-5-5*', name: 'Claude Opus 5.5', tier: 'frontier', relCost: 0.6, caps, efforts: ALL, strengths: { coding: 0.7, research: 0.8, chat: 0.4, 'cheap-chat': -0.6 } },
  ],
});
const MODES = Object.fromEntries(['coding', 'cheap-chat', 'research', 'chat'].map((key) => [key, mode(key)]));

async function rt2Setup() {
  const h = harness({ subconscious: {} });
  h.org.add(agent(AGENT, 'Ada', { mode: 'coding' }));
  // model.set writes my start model through org.update (tools/builtin/models.ts settleModel)
  Object.assign(h.org, { update: (id: string, patch: Partial<ReturnType<typeof agent>>) => h.org.add({ ...h.org.require(id), ...patch }) });
  const chat = h.chats.create({ agentIds: [AGENT], createdBy: 'human' });
  const defaults = defaultSettings({ locale: 'en-US', timezone: 'UTC' });
  const settings = { ...defaults, routing: { ...defaults.routing, work: 'gemini-cli' } }; // without B-044's Claude Code work plan default (a plan never connected here)
  const engines = new Map<EngineId, FakeEngine>([['codex', new FakeEngine('codex')], ['claude', new FakeEngine('claude')]]);
  engines.get('codex')!.lists.set('codex', [
    { model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ALL },
    { model: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: ['none', 'low', 'medium', 'high'] },
  ]);
  engines.get('claude')!.lists.set('claude', [{ model: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ALL }]);
  const accounts = new FakeAccounts(h.clock, h.bus);
  accounts.upsert(account('acc_codex', 'codex'), false);
  accounts.upsert(account('acc_claude', 'claude'), false);
  const runs = new Journal({ db: h.db, bus: h.bus, clock: h.clock });
  Object.assign(h.services, {
    settings: { get: () => settings }, accounts, runs, secrets: { use: async () => { throw new Error('no secret'); } },
    engines: { get: (id: EngineId) => engines.get(id)!, all: () => [...engines.values()] },
    modes: { get: (key: string) => { if (!MODES[key]) throw new Error(`unknown mode ${key}`); return MODES[key]; }, list: () => Object.values(MODES) },
  });
  const catalog = new Catalog({ services: () => h.services, priors: PRIORS, debounceMs: 0 });
  h.services.catalog = catalog;
  const router = new RouterImpl({ services: () => h.services });
  h.services.router = router;
  await catalog.refresh({ force: true });

  let seq = 0;
  const sessions = new SessionStore(h.db);
  /** A finished run and – as turn-finish does – the session it leaves: the next turn within the hour stands off a boundary. */
  const finish = (run: Omit<Run, 'id' | 'agentId' | 'conversationId' | 'trigger' | 'status'> & { status?: Run['status'] }, conversationId = chat.id) => {
    const id = `run_${++seq}`;
    runs.start({ id, agentId: AGENT, conversationId, taskId: run.taskId, trigger: run.taskId ? 'task' : 'message' });
    runs.finish(id, { status: 'done', endedAt: h.clock.now(), ...run });
    sessions.save({ agentId: AGENT, conversationId: 'main', engine: run.engine as EngineId, accountId: run.accountId, ref: `ses_${run.engine}`, generation: 1, cursorSeq: 0, model: run.model, updatedAt: h.clock.now() });
    h.clock.advance(60_000);
    return id;
  };
  /** An earlier turn the rules chose, at an effort nobody asked for. */
  const seed = (model: string, effort: Effort, category: string, patch: Partial<Run> = {}) =>
    finish({ engine: model.startsWith('claude') ? 'claude' : 'codex', model, effort, route: { reason: 'seed', by: 'rules', category, effortBy: 'default' }, ...patch });
  /** More than an hour passes: my session's cache is cold, the next turn stands at a boundary. */
  const rest = () => h.clock.advance(HOUR + 60_000);
  /** One turn: plan, route, take what the plan read as turn.ts does before the engine (B-080) and record it the way turn-finish does. */
  const turn = async (taskId?: string, note?: string, conversationId = chat.id, reason?: 'task' | 'message' | 'review'): Promise<RouteDecision> => {
    const plan = await planTurn(h.services, {
      runId: `plan_${seq + 1}`, agentId: AGENT, conversationId, taskId, reason: reason ?? (taskId ? 'task' : 'message'), notes: note ? [{ text: note, at: Date.now() }] : [],
      signal: new AbortController().signal, control: { lastSeq: 0, steeredSeq: 0 },
    });
    assert.ok(plan, 'a turn is planned');
    const route = await router.route(routeRequest(plan));
    if (plan.nextStepAt !== undefined) takeNextRoute(h.db, AGENT, plan.nextStepAt);
    if (plan.nextModelAt !== undefined) takeNextModel(h.db, AGENT, plan.nextModelAt);
    finish({ taskId, engine: route.engine, model: route.modelId, effort: route.effort, accountId: route.accountId, route: { reason: route.reason, by: route.by, category: route.category, ...(route.effortBy ? { effortBy: route.effortBy } : {}) } }, conversationId);
    return route;
  };
  const modelSet = modelTools.find((tool) => tool.name === 'model.set')!;
  const ask = async (args: Record<string, unknown>, taskId?: string, conversationId = chat.id): Promise<ToolOutput> => modelSet.run(args, {
    agent: h.org.get(AGENT)!, runId: 'run_tool', conversationId, taskId, mode: 'coding', services: h.services,
    signal: new AbortController().signal, status() {},
  } as ToolContext);
  const setMode = (key: string) => h.org.add({ ...h.org.get(AGENT)!, mode: key });
  const stored = (ns: string, key = AGENT) => { const row = h.db.get<{ value: string }>('SELECT value FROM kv WHERE ns = ? AND key = ?', [ns, key]); return row ? JSON.parse(row.value) as Record<string, unknown> : undefined; };
  return { ...h, chat, router, catalog, runs, seed, rest, turn, ask, setMode, stored };
}

const pair = (route: RouteDecision) => `${route.modelId}/${route.effort}`;
const ok = (output: ToolOutput) => { assert.ok(!output.isError, JSON.stringify(output.content)); return output.structured as { appliesTo: string }; };

test('Sol/low → max for one step → back to low; a model I ask for waits for my next fresh context, runs from there and stays', async () => {
  const h = await rt2Setup();
  h.seed(SOL, 'low', 'coding');
  const usual = await h.turn();
  assert.equal(pair(usual), `${SOL}/low`);
  assert.equal(usual.by, 'previous');

  assert.equal(ok(await h.ask({ effort: 'max', reason: 'the tricky migration' })).appliesTo, 'next turn');
  const hard = await h.turn();
  assert.equal(pair(hard), `${SOL}/max`, 'the requested effort for this step');
  assert.equal(hard.by, 'request');
  assert.match(hard.reason, /effort requested by the agent/);

  const after = await h.turn();
  assert.equal(pair(after), `${SOL}/low`, 'back to my settled effort');
  assert.equal(after.by, 'previous');
  assert.equal(pair(await h.turn()), `${SOL}/low`);

  // A named model: the answer says when it starts; its effort is my next turn's.
  const answer = ok(await h.ask({ model: OPUS, effort: 'max' })) as unknown as { appliesTo: string; modelId: string };
  assert.equal(answer.modelId, OPUS);
  assert.equal(answer.appliesTo, 'Claude Opus 5.5 runs from my next context (after a fold or an hour of rest) and stays my model until I, my lead or the person names another; until then I stay on GPT-6.1 Sol; now: true moves me at once; its effort: next turn');
  // On the code before 17.11.2026 the very next turn ran on Opus – on a live cache – and the one after went back to Sol.
  const live = await h.turn();
  assert.deepEqual([pair(live), live.by], [`${SOL}/max`, 'request'], 'my session is live: the model waits, the effort runs');
  assert.match(live.reason, /^continues on my model · Claude Opus 5\.5 from my next context · coding · effort requested by the agent$/);
  assert.equal(pair(await h.turn()), `${SOL}/low`);
  assert.equal(h.stored('next_model')?.modelId, OPUS, 'it still waits');

  h.rest();
  const opus = await h.turn();
  assert.deepEqual([pair(opus), opus.by], [`${OPUS}/low`, 'request'], 'where my context starts anew it runs – same kind of work: at my settled effort');
  assert.match(opus.reason, /^requested by the agent/);
  assert.equal(h.stored('next_model'), undefined, 'used up by the turn that applied it');
  const stays = await h.turn();
  assert.deepEqual([pair(stays), stays.by, stays.reason], [`${OPUS}/low`, 'previous', 'continues on my model · coding'], 'the model I am on – no way back to Sol');
  h.rest();
  assert.equal(pair(await h.turn()), `${OPUS}/low`, 'and at the next boundary too: it fits my kind');
});

test('my own model.set stands past the context it starts: it is my start model, set by me, until another is named; auto gives it back to my kind', async () => {
  const h = await rt2Setup();
  h.seed(SOL, 'low', 'coding');
  // Luna is below my kind's tier: Auto alone would take me back to the frontier tier at every boundary
  ok(await h.ask({ model: LUNA }));
  const policy = h.org.get(AGENT)!.modelPolicy;
  assert.equal(policy.pin, LUNA, 'my start model from here on');
  assert.equal(policy.pinBy?.self, true, 'set by me');
  h.rest();
  const luna = await h.turn();
  assert.equal(luna.modelId, LUNA, luna.reason);
  assert.equal(h.stored('next_model'), undefined, 'the waiting request is used up');
  // review 17.11.2026: on the code before, the boundary after this one put me back on the frontier tier
  h.rest();
  const still = await h.turn();
  assert.equal(still.modelId, LUNA, still.reason);
  // auto: my kind of work settles my model again from my next context
  const back = ok(await h.ask({ model: 'auto' })) as unknown as { appliesTo: string };
  assert.match(back.appliesTo, /^my kind of work settles my model again/);
  assert.equal(h.org.get(AGENT)!.modelPolicy.pin, undefined);
  assert.equal(h.org.get(AGENT)!.modelPolicy.pinBy, undefined);
  h.rest();
  assert.equal(h.catalog.get((await h.turn()).modelId)!.tier, 'frontier', 'my kind settles it');
});

test('model.set names a model inside the band the person or my lead set; auto clears my own choice, never theirs', async () => {
  const h = await rt2Setup();
  h.seed(LUNA, 'low', 'coding');
  const ada = h.org.get(AGENT)!;
  // review 2, 17.11.2026: a model above my ceiling was written as my start model and ran from my next boundary
  h.org.add({ ...ada, modelPolicy: { ceilingTier: 'small' } });
  const refused = await h.ask({ model: OPUS });
  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused.content), /Claude Opus 5\.5 \(frontier tier\) is outside my model policy, which runs the small tier and below/);
  assert.equal(h.org.get(AGENT)!.modelPolicy.pin, undefined, 'nothing written');
  assert.equal(h.stored('next_model'), undefined);
  // a start model the person set stays through my auto; only my own waiting request goes
  h.org.add({ ...ada, modelPolicy: { pin: OPUS, pinBy: { name: 'Heike', at: 1 } } });
  ok(await h.ask({ model: SOL }));
  h.org.add({ ...h.org.get(AGENT)!, modelPolicy: { pin: OPUS, pinBy: { name: 'Heike', at: 1 } } }); // as if Heike set it again after
  const back = ok(await h.ask({ model: 'auto' }));
  assert.match(back.appliesTo, /^my own choice is gone; my start model stays Claude Opus 5\.5, set by Heike, from my next context/);
  assert.deepEqual(h.org.get(AGENT)!.modelPolicy.pin, OPUS);
  assert.equal(h.org.get(AGENT)!.modelPolicy.pinBy?.name, 'Heike');
  assert.equal(h.stored('next_model'), undefined);
});

test('task scope: its effort on every turn of the task until it is done, other turns and a step on top; a model named with it is mine', async () => {
  const h = await rt2Setup();
  h.seed(SOL, 'low', 'coding');
  const task = h.tasks.create({ conversationId: h.chat.id, title: 'Port the parser', assigneeId: AGENT, createdBy: 'human' });
  const noTask = await h.ask({ effort: 'high', for: 'task' });
  assert.equal(noTask.isError, true);
  assert.match(String((noTask.content[0] as { text: string }).text), /no task/);

  // On the code before 17.11.2026 a model on a task ran every turn of it there and every other turn elsewhere: 38 switches measured.
  const both = ok(await h.ask({ model: OPUS, effort: 'high', for: 'task' }, task.id));
  assert.equal(both.appliesTo, `Claude Opus 5.5 runs from my next context (after a fold or an hour of rest) and stays my model until I, my lead or the person names another; until then I stay on GPT-6.1 Sol; now: true moves me at once; its effort: every turn on task ${task.id} until it is done, in whichever chat it runs`);
  assert.deepEqual(h.stored('next_route_task', `${AGENT}:${task.id}`), { effort: 'high', reason: 'given by me', at: h.stored('next_model')!.at }, 'the task keeps the effort, given by me (its switch line reads "effort from my task (given by me)")');
  assert.equal(h.stored('next_model')?.modelId, OPUS, 'the model is mine');
  assert.equal(h.stored('next_route'), undefined);
  takeNextRoute(h.db, AGENT); // without the waiting model from here on

  for (let i = 0; i < 2; i++) {
    const onTask = await h.turn(task.id);
    assert.equal(pair(onTask), `${SOL}/high`, `task turn ${i + 1}`);
    assert.equal(onTask.by, 'request');
    assert.equal(onTask.reason, 'continues on my model · Claude Opus 5.5 from my next context · coding · effort from my task (given by me)');
  }
  assert.equal(pair(await h.turn()), `${SOL}/low`, 'a chat turn without the task runs at my settled effort');

  // A step on top: its effort wins for one turn, then the task's again.
  ok(await h.ask({ effort: 'max' }));
  assert.equal(pair(await h.turn(task.id)), `${SOL}/max`);
  assert.equal(pair(await h.turn(task.id)), `${SOL}/high`);

  // Done: the request ends with the task (its row is dropped).
  h.tasks.finish(task.id, { status: 'done' as const, summary: 'Done' }, 'human');
  // A bare task wake for finished work plans no turn (B-047, turn-prepare.ts SET_ASIDE); a wake with news does.
  const back = await h.turn(task.id, 'The human commented: thanks');
  assert.equal(pair(back), `${SOL}/low`);
  assert.equal(back.by, 'previous');
  assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM kv WHERE ns = 'next_route_task'")!.n, 0);
  const late = await h.ask({ effort: 'high', for: 'task' }, task.id);
  assert.equal(late.isError, true);
  assert.match(String((late.content[0] as { text: string }).text), /finished/);
});

test('another kind of work: the effort is not carried, the model I am on stays – in a live session and where my context starts anew', async () => {
  // Coding → cheap chat. On the code before 17.11.2026 the turn left Sol for Luna ("new work … not close to the best fit"), on a live cache.
  const h = await rt2Setup();
  h.seed(SOL, 'high', 'coding');
  h.setMode('cheap-chat');
  const live = await h.turn();
  // Runde „Halb“ 21.11.2026: at medium, not at the category's default (cheap chat: low)
  assert.deepEqual([pair(live), live.by, live.reason], [`${SOL}/medium`, 'previous', 'continues on my model · cheap chat · not weighed · effort medium'], 'at medium, the unweighed effort, and the reason says so');
  h.rest();
  assert.equal(pair(await h.turn()), `${SOL}/medium`, 'not weak at it and of my kind\'s tier: it stays at a boundary too');

  // Coding → research: at research's default effort, not xhigh; then its own effort is carried.
  const r = await rt2Setup();
  r.seed(SOL, 'xhigh', 'coding');
  r.setMode('research');
  const kept = await r.turn();
  assert.equal(pair(kept), `${SOL}/medium`);
  assert.equal(kept.by, 'previous');
  assert.equal(pair(await r.turn()), `${SOL}/medium`, 'same category now: its effort is carried');

  // A previous choice without a category (older runs): model and effort continue.
  const legacy = await r.router.route({ agent: r.org.get(AGENT)!, mode: mode('cheap-chat'), previous: { modelId: SOL, effort: 'high' } });
  assert.equal(pair(legacy), `${SOL}/high`);
});

test('B-078: a temperature rides with the next step (like an effort) and leaves the model to the rules; the answer says where it reaches', async () => {
  const h = await rt2Setup();
  h.seed(SOL, 'low', 'coding');
  const plan = (n: number, conversationId = h.chat.id) => planTurn(h.services, {
    runId: `plan_t${n}`, agentId: AGENT, conversationId, reason: 'message', notes: [],
    signal: new AbortController().signal, control: { lastSeq: 0, steeredSeq: 0 },
  });
  const answer = ok(await h.ask({ temperature: 1.2 })) as unknown as { temperature: number; temperatureNote?: string; effort?: string };
  assert.equal(answer.temperature, 1.2);
  assert.equal(answer.effort, 'low', 'B-080: the answer names what the work runs on');
  const first = await plan(1);
  assert.equal(first!.temperature, 1.2, 'the next turn carries it to the engine (TurnPlan.temperature)');
  assert.equal(first!.previous && 'temperature' in first!.previous, false, 'no routing input');
  assert.equal(pair(await h.router.route(routeRequest(first!))), `${SOL}/low`, 'the model and effort stay the rules\'');
  takeNextRoute(h.db, AGENT, first!.nextStepAt); // turn.ts, as the engine starts
  assert.equal((await plan(2))!.temperature, undefined, 'one step only');
  assert.equal((await h.ask({ temperature: 3 })).isError, true);
  assert.equal((await h.ask({})).isError, true);
  // Codex samples at its own setting: the answer says so, and where a temperature reaches (B-083, live 09.11.)
  const named = ok(await h.ask({ model: SOL, temperature: 0.2 })) as unknown as { temperatureNote?: string };
  assert.match(named.temperatureNote ?? '', /^GPT-6\.1 Sol samples at its own setting – my thinking comes first, so a temperature goes only where it costs none: .* Claude and Codex keep their own setting \(older Claude models take one only without thinking, the newer ones none, Codex not at all\) – there my drafts carry the variety\.$/);
  // B-080: a fresh chat keeps the temperature too (it was lost on previous); one context – it returns to my last run.
  const fresh = h.chats.create({ agentIds: [AGENT], createdBy: 'human' });
  ok(await h.ask({ temperature: 0.3 }, undefined, fresh.id));
  const there = await plan(3, fresh.id);
  assert.equal(there!.previous?.modelId, SOL, 'my last run, from another chat');
  assert.equal(there!.temperature, 0.3);
});


test('the three rows: my step, the model I asked for and a task\'s request – read without taking; a task keeps an effort and a temperature, never a model', async () => {
  const h = await rt2Setup();
  const at = h.clock.now();
  setTaskRoute(h.db, AGENT, 'task_1', { effort: 'high', temperature: 0.4, at });
  const pending = () => pendingRoute(h.db, AGENT, 'task_1', () => false);
  assert.deepEqual(pending(), { effort: 'high', temperature: 0.4, by: 'task', at });
  setNextRoute(h.db, AGENT, { temperature: 0.9, at });
  assert.deepEqual(pending(), { effort: 'high', temperature: 0.9, by: 'task', at, stepAt: at }, 'stepAt: the step\'s at, the one turn.ts takes; the effort is still the task\'s');
  assert.equal(pending()?.temperature, 0.9, 'read, not taken');
  assert.equal(takeNextRoute(h.db, AGENT, at - 1), undefined, 'a step other than the one read stays');
  assert.equal(takeNextRoute(h.db, AGENT, pending()?.stepAt)?.temperature, 0.9);
  assert.equal(pending()?.temperature, 0.4, 'the task\'s again');

  // A request with a model and an effort: the effort is my next turn's step, the model waits in its own row.
  setNextRoute(h.db, AGENT, { modelId: OPUS, effort: 'max', at: at + 1 });
  assert.deepEqual(pending(), { modelId: OPUS, effort: 'max', temperature: 0.4, at: at + 1, stepAt: at + 1, modelAt: at + 1 }, 'my step\'s effort over the task\'s');
  takeNextRoute(h.db, AGENT, at + 1);
  assert.deepEqual(pending(), { modelId: OPUS, effort: 'high', temperature: 0.4, by: 'task', at: at + 1, modelAt: at + 1 }, 'the step is used up, the model still waits');
  takeNextModel(h.db, AGENT, at);
  assert.equal(pending()?.modelId, OPUS, 'a model other than the one read stays');
  takeNextModel(h.db, AGENT, at + 1);
  assert.equal(pending()?.modelId, undefined);
  setNextRoute(h.db, AGENT, { modelId: OPUS, temperature: 0.2, at: at + 2 });
  assert.deepEqual(takeNextRoute(h.db, AGENT), { modelId: OPUS, temperature: 0.2, at: at + 2 }, 'without an at – my running turn took the request – everything stored');
  assert.equal(pendingRoute(h.db, AGENT, undefined, () => false), undefined);

  // A task's request is an effort. On the code before 17.11.2026 a model on it ran every turn of the task there.
  setTaskRoute(h.db, AGENT, 'task_2', { modelId: OPUS, effort: 'xhigh', reason: 'given by Clara', at });
  assert.deepEqual(pendingRoute(h.db, AGENT, 'task_2', () => false), { effort: 'xhigh', by: 'task', reason: 'given by Clara', at });
  setTaskRoute(h.db, AGENT, 'task_3', { modelId: OPUS, at });
  assert.equal(pendingRoute(h.db, AGENT, 'task_3', () => false), undefined, 'a model alone stores nothing');
  h.db.run('INSERT INTO kv (ns, key, value, updated_at) VALUES (?, ?, ?, ?)', ['next_route_task', `${AGENT}:task_4`, JSON.stringify({ modelId: OPUS, need: 'stronger', from: SOL, at }), at]);
  assert.equal(pendingRoute(h.db, AGENT, 'task_4', () => false), undefined, 'a row a version before this one wrote: its model is not read');

  const runs = [{ id: 'run_1', agentId: AGENT, conversationId: 'ch', trigger: 'message', status: 'done', model: SOL, effort: 'low', route: { reason: 'r', by: 'rules', category: 'coding' } }] as unknown as Run[];
  assert.deepEqual(returnChoice(runs, { temperature: 0.4, at }), { modelId: SOL, effort: 'low', category: 'coding' });
  assert.deepEqual(returnChoice(runs, { modelId: OPUS, temperature: 0, at }), { modelId: OPUS, explicit: true, from: SOL, asked: 'model', effort: 'low', category: 'coding' });
  assert.deepEqual(returnChoice(runs, { modelId: OPUS, now: true, at }), { modelId: OPUS, explicit: true, from: SOL, now: true, asked: 'model', effort: 'low', category: 'coding' });
});

test('an effort that is not my own names whose it is; every request rides on the model I am on, not on the task\'s last run', async () => {
  const h = await rt2Setup();
  const at = h.clock.now();
  const runs = [
    { id: 'run_2', agentId: AGENT, trigger: 'message', status: 'done', model: OPUS, effort: 'high', route: { reason: 'other work', by: 'rules', category: 'research' } },
    { id: 'run_1', agentId: AGENT, taskId: 'task_1', trigger: 'task', status: 'done', model: SOL, effort: 'low', route: { reason: 'r', by: 'rules', category: 'coding' } },
  ] as unknown as Run[];
  setTaskRoute(h.db, AGENT, 'task_1', { effort: 'high', reason: 'given by Clara', at });
  setNextRoute(h.db, AGENT, { temperature: 0.3, at });
  const pending = () => pendingRoute(h.db, AGENT, 'task_1', () => false);
  // On the code before 17.11.2026 a task's request returned to that task's own last run (Sol) – an agent with two pieces of work alternated models.
  assert.deepEqual(returnChoice(runs, pending()), { modelId: OPUS, effort: 'high', explicit: true, asked: 'effort', category: 'research', by: 'task', why: 'given by Clara' });
  setNextRoute(h.db, AGENT, { effort: 'medium', temperature: 0.3, at });
  assert.deepEqual(returnChoice(runs, pending()), { modelId: OPUS, effort: 'medium', explicit: true, asked: 'effort', category: 'research' }, 'my own step\'s effort');
  setNextRoute(h.db, AGENT, { effort: 'low', reason: 'a receipt', by: 'subconscious', at });
  assert.deepEqual(returnChoice(runs, pending()), { modelId: OPUS, effort: 'low', explicit: true, asked: 'effort', category: 'research', by: 'subconscious', why: 'a receipt' });
  assert.deepEqual(returnChoice(runs, undefined, { on: SOL }), { modelId: SOL, effort: 'low', category: 'coding' }, 'the model my session is on over my newest run\'s');
});

test('B-083 D1: a named model carries `from` – the model I am on: my newest done run, also one a request shaped; a split\'s run is aside', () => {
  const at = 1;
  const run = (id: string, model: string, patch: Partial<Run> = {}) => ({ id, agentId: AGENT, conversationId: 'ch', trigger: 'message', status: 'done', model, effort: 'low', route: { reason: 'r', by: 'rules', category: 'coding' }, ...patch }) as unknown as Run;
  const shaped = [run('run_3', LUNA, { route: { reason: 'requested by the agent', by: 'request', category: 'coding' } }), run('run_1', SOL)];
  const choice = returnChoice(shaped, { modelId: OPUS, effort: 'high', at });
  assert.deepEqual([choice?.modelId, choice?.from], [OPUS, LUNA], 'the request-shaped run is the model I am on');
  assert.equal(returnChoice([run('run_4', LUNA, { splitId: 'sp_1' })], { modelId: OPUS, at })?.from, undefined, 'a split\'s run is not where I am');
  assert.equal(returnChoice([run('run_5', LUNA, { status: 'failed' }), run('run_1', SOL)], { modelId: OPUS, at })?.from, SOL, 'done runs only');
  assert.equal(returnChoice([run('run_1', SOL)], { modelId: SOL, at })?.from, SOL, 'also when I am on the model I named');
  assert.equal(returnChoice([run('run_1', SOL, { conversationId: 'other' })], { modelId: OPUS, at })?.from, SOL, 'any chat: one context');
  assert.equal(returnChoice([run('run_1', SOL)], { effort: 'max', at })?.from, undefined, 'an effort-only request names no model');
});

test('B-080: task names the task – keyed agent + task, every turn of mine on it runs at its effort, in its chat and in another', async () => {
  const h = await rt2Setup();
  h.org.add({ ...h.org.get(AGENT)!, modelPolicy: { pin: SOL, effort: 'medium' } }); // pinned to Sol, fixed medium
  h.seed(SOL, 'medium', 'coding');
  const work = h.chats.create({ agentIds: [AGENT], createdBy: 'human' });
  const task = h.tasks.create({ conversationId: work.id, title: 'Port the parser', assigneeId: AGENT, createdBy: 'human' });
  const answer = ok(await h.ask({ effort: 'high', task: task.id })) as unknown as { appliesTo: string; modelId: string; effort: string };
  assert.equal(answer.appliesTo, `every turn on task ${task.id} until it is done, in whichever chat it runs`);
  assert.deepEqual([answer.modelId, answer.effort], [SOL, 'high'], 'the preview: the model I am on at the asked effort');
  assert.deepEqual(h.db.all<{ key: string }>("SELECT key FROM kv WHERE ns = 'next_route_task'").map((row) => row.key), [`${AGENT}:${task.id}`]);
  const own = await h.turn(task.id, 'go on', work.id, 'task');
  assert.deepEqual([pair(own), own.by], [`${SOL}/high`, 'request'], 'a task wake in the task\'s own chat – over my fixed medium');
  const review = await h.turn(task.id, 'Review your work', h.chat.id, 'review');
  assert.deepEqual([pair(review), review.by], [`${SOL}/high`, 'request'], 'a review wake in another chat');
  assert.equal(pair(await h.turn()), `${SOL}/medium`, 'a chat turn without the task: my fixed effort');

  // Without a task in the turn and without a task id: the first-person fact, nothing stored.
  const before = h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM kv WHERE ns IN ('next_route', 'next_model', 'next_route_task')")!.n;
  const none = await h.ask({ effort: 'high', for: 'task' });
  assert.equal(String((none.content[0] as { text: string }).text), NO_TASK_TEXT);
  assert.match(NO_TASK_TEXT, /^This turn has no task of mine – I name it with task: "<id>" \(tasks\.list\)/);
  assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM kv WHERE ns IN ('next_route', 'next_model', 'next_route_task')")!.n, before);
  h.tasks.finish(task.id, { status: 'done' as const, summary: 'Done' }, 'human');
  assert.equal(String(((await h.ask({ effort: 'high', task: task.id })).content[0] as { text: string }).text), `Task ${task.id} is finished – my next step here takes it with for: "next_step".`);
});

test('an effort for a task in another chat – the preview shows what its next turn runs: the model I am on, whatever the task ran on before', async () => {
  const h = await rt2Setup();
  const work = h.chats.create({ agentIds: [AGENT], createdBy: 'human' });
  const task = h.tasks.create({ conversationId: work.id, title: 'Port the parser', assigneeId: AGENT, createdBy: 'human' });
  h.seed(SOL, 'low', 'coding', { taskId: task.id });
  h.seed(OPUS, 'high', 'coding'); // other work since: the model I am on
  const answer = ok(await h.ask({ effort: 'high', task: task.id })) as unknown as { modelId: string; effort: string };
  const next = await h.turn(task.id, 'go on', work.id, 'task');
  assert.deepEqual([answer.modelId, answer.effort], [OPUS, 'high'], 'the preview: one context, one model');
  assert.equal(pair(next), `${OPUS}/high`, 'and its turn runs just that');
});

test('B-083: the person\'s suggestion is information – my effort is stored and runs my next turn, the answer names their suggestion; else the answer is what the next turn runs', async () => {
  const h = await rt2Setup();
  h.seed(SOL, 'low', 'coding');
  Object.assign(h.services.settings.get(), { profile: { ...h.services.settings.get().profile, name: 'Stanislaus' } });
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Think this through.', effort: 'medium' }); // 26.11.2026: a pick is on one line only
  const chip = ok(await h.ask({ effort: 'xhigh' })) as unknown as { effort: string; suggestion?: string };
  assert.equal(chip.effort, 'xhigh', 'the preview runs on my request');
  assert.equal(chip.suggestion, 'Stanislaus picked effort medium for their newest message – I take effort xhigh for this step.');
  const says = (body: string) => h.chats.send({ conversationId: h.chat.id, authorId: 'human', body });
  says('Go on with the parser, please.');
  const mine = await h.turn();
  assert.deepEqual([mine.effort, mine.by], ['xhigh', 'request'], 'my request runs for one step');
  says('And the tests too.');
  assert.equal((await h.turn()).effort, 'low', 'then my settled effort again – never the suggested medium (Runde „Halb“: the person\'s line lifts nothing)');
  assert.equal((ok(await h.ask({ effort: 'medium' })) as unknown as { suggestion?: string }).suggestion, undefined, 'the suggestion\'s own effort: no line');
  takeNextRoute(h.db, AGENT);

  // A task whose chat has the suggestion, asked from another chat: that chat is named; my turns on the task run on my request.
  const elsewhere = h.tasks.create({ conversationId: h.chat.id, title: 'Port the parser', assigneeKind: 'agent', assigneeId: AGENT, createdBy: 'human' });
  const other = h.chats.create({ agentIds: [AGENT], createdBy: 'human' });
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Port it carefully.', effort: 'medium' });
  const named = ok(await h.ask({ effort: 'xhigh', task: elsewhere.id }, undefined, other.id)) as unknown as { suggestion?: string };
  assert.equal(named.suggestion, `Stanislaus picked effort medium for their newest message in the chat of task ${elsewhere.id} – I take effort xhigh for task ${elsewhere.id}.`);
  const onTask = await h.turn(elsewhere.id, 'go on', h.chat.id, 'task');
  assert.deepEqual([onTask.effort, onTask.by], ['xhigh', 'request'], 'in the task\'s own chat');

  // A suggested model: another one is stored and named; one that cannot run now is stored as asked (like with my start model).
  const tipped = h.chats.create({ agentIds: [AGENT], createdBy: 'human' });
  h.chats.send({ conversationId: tipped.id, authorId: 'human', body: 'Use Sol for this.', model: SOL });
  const opus = ok(await h.ask({ model: OPUS }, undefined, tipped.id)) as unknown as { modelId: string; suggestion?: string };
  assert.deepEqual([opus.modelId, opus.suggestion], [OPUS, 'Stanislaus picked GPT-6.1 Sol for their newest message – I take Claude Opus 5.5 for this step.']);
  (h.services.accounts as unknown as FakeAccounts).markLimited('acc_claude', h.clock.now() + 3600_000);
  const limited = ok(await h.ask({ model: OPUS }, undefined, tipped.id)) as unknown as { modelId: string; suggestion?: string; instead?: string };
  assert.deepEqual([limited.modelId, limited.suggestion], [SOL, undefined], 'the preview stays on the model I am on');
  assert.match(limited.instead ?? '', /^Asked for Claude Opus 5\.5 – no account of it can run now \(limited until .+\)\. I go on with GPT-6\.1 Sol · \w+; Claude Opus 5\.5 stays my model and runs from my next context once it can run\.$/, 'D1: the answer says why');
  assert.equal(h.stored('next_model')?.modelId, OPUS, 'stored as asked');
  takeNextRoute(h.db, AGENT);

  const free = h.chats.create({ agentIds: [AGENT], createdBy: 'human' });
  const answer = ok(await h.ask({ effort: 'xhigh' }, undefined, free.id)) as unknown as { effort: string };
  const next = await h.turn(undefined, undefined, free.id);
  assert.equal(answer.effort, next.effort);
  assert.equal(next.effort, 'xhigh');
});

test('B-080: planTurn reads the next step and leaves it – a turn that fails before its engine keeps it; turn.ts takes it', async () => {
  const h = await rt2Setup();
  h.seed(SOL, 'low', 'coding');
  setNextRoute(h.db, AGENT, { effort: 'max', at: h.clock.now() });
  const plan = () => planTurn(h.services, {
    runId: 'plan_s', agentId: AGENT, conversationId: h.chat.id, reason: 'message', notes: [],
    signal: new AbortController().signal, control: { lastSeq: 0, steeredSeq: 0 },
  });
  assert.equal((await plan())!.previous?.effort, 'max', 'a first plan (its route then failed)');
  const next = (await plan())!;
  assert.equal(next.previous?.effort, 'max', 'the next turn still has it');
  takeNextRoute(h.db, AGENT, next.nextStepAt);
  assert.equal((await plan())!.previous?.explicit, undefined, 'taken once the engine started');
});



test('B-080 (route-category): pinned Sol unavailable – two turns of one task both get the task\'s category, no "new work ("', async () => {
  const h = await rt2Setup();
  h.org.add({ ...h.org.get(AGENT)!, mode: 'chat', modelPolicy: { pin: SOL } });
  h.org.add(agent('ag_lena', 'Lena'));
  h.chats.setMembers(h.chat.id, { add: ['ag_lena'] }, 'human');
  const task = h.tasks.create({ conversationId: h.chat.id, title: 'Postfach-Abgleich der Antworten', notes: 'Wer hat schon auf die Mail geantwortet?', assigneeKind: 'agent', assigneeId: AGENT, createdBy: 'human' });
  (h.services.accounts as unknown as FakeAccounts).markLimited('acc_codex', h.clock.now() + 4 * 3600_000); // Sol (and Luna) cannot run
  h.chats.send({ conversationId: h.chat.id, authorId: 'ag_lena', body: 'Originalvideo ist fertig, die Animation und der Schnitt stehen.' });
  const first = await h.turn(task.id, 'go on', h.chat.id, 'task');
  h.chats.send({ conversationId: h.chat.id, authorId: 'ag_lena', body: 'Der LinkedIn-Post steht, das Thumbnail auch.' });
  const second = await h.turn(task.id, 'go on', h.chat.id, 'task');
  assert.notEqual(first.modelId, SOL, 'a stand-in runs');
  assert.deepEqual([first.category, second.category], ['personal-assistant', 'personal-assistant'], 'the task\'s kind, not the colleague\'s reports');
  for (const route of [first, second]) assert.doesNotMatch(route.reason, /new work \(/);
});


test('B-083 D1: a model I name with now that cannot run – the answer says why, my running turn stays; my next turn stays on the model I am on, and the model I named runs from my first context after it can run', async () => {
  const h = await rt2Setup();
  h.seed(SOL, 'high', 'coding');
  const switches: unknown[] = [];
  Object.assign(h.services, { dispatcher: {
    activity: () => [{ agentId: AGENT, runId: 'run_tool', note: '', startedAt: 0, model: SOL, effort: 'high' as Effort }],
    continueNow: (...args: unknown[]) => { switches.push(args); return true; },
  } });
  const reset = h.clock.now() + 3 * 24 * 3600_000; // the Claude plan's weekly window
  (h.services.accounts as unknown as FakeAccounts).markLimited('acc_claude', reset);
  const answer = ok(await h.ask({ model: OPUS, effort: 'high', now: true })) as unknown as { modelId: string; appliesTo: string; instead?: string; now?: string };
  assert.equal(answer.now, 'my running turn stays on GPT-6.1 Sol');
  assert.deepEqual(switches, [], 'no cut and no switch onto a model I did not name');
  assert.deepEqual([h.stored('next_model')?.modelId, h.stored('next_model')?.now], [OPUS, true], 'the request stays as asked');
  // The texts and the turn's model below come from the router's D1 rule (routing/router.ts, routing/unfit.ts askedMiss).
  assert.equal(answer.modelId, SOL);
  assert.match(answer.instead ?? '', /^Asked for Claude Opus 5\.5 – no account of it can run now \(limited until .+\)\. I go on with GPT-6\.1 Sol · high; Claude Opus 5\.5 stays my model and runs from my next context once it can run\.$/);
  const next = await h.turn();
  assert.deepEqual([next.modelId, next.effort, next.by], [SOL, 'high', 'request']);
  assert.match(next.reason, /^asked for Claude Opus 5\.5 – no account of it can run now \(limited until .+\) · continues on my model/);
  assert.equal(h.stored('next_model'), undefined, 'it had its turn');
  h.clock.advance(3 * 24 * 3600_000);
  const later = await h.turn();
  assert.deepEqual([later.modelId, later.by], [OPUS, 'pin'], 'after the reset the model I named runs: it stayed my start model (review 17.11.2026)');
});

test('B-083 D4: an effort the named model lacks is asked as is – the answer names the effort the router clamps it to', async () => {
  const h = await rt2Setup();
  h.seed(SOL, 'low', 'coding');
  const answer = ok(await h.ask({ model: LUNA, effort: 'max' })) as unknown as { modelId: string; effort: string; instead?: string };
  assert.deepEqual([answer.modelId, answer.effort, answer.instead], [LUNA, 'high', undefined]);
  assert.equal(h.stored('next_route')?.effort, 'max', 'stored as asked');
  h.rest();
  assert.equal(pair(await h.turn()), `${LUNA}/high`);
});

test('tasks.add for a colleague with an effort: the task request exists before its wake is claimed', async () => {
  const h = await rt2Setup();
  h.org.add(agent('ag_bo', 'Bo', { mode: 'research' }));
  const ctx = { agent: h.org.get(AGENT)!, runId: 'run_d', conversationId: h.chat.id, mode: 'coding', services: h.services, signal: new AbortController().signal, status() {} } as unknown as ToolContext;
  const create = taskTools.find((tool) => tool.name === 'tasks.add')!;
  const textOf = (result: { content: unknown[] }) => String((result.content[0] as { text?: string }).text);
  const out = JSON.parse(textOf(await create.run({ title: 'Compare the parsers', for: 'ag_bo', effort: 'xhigh' } as never, ctx)));
  const row = h.db.get<{ value: string }>("SELECT value FROM kv WHERE ns = 'next_route_task' AND key = ?", [`ag_bo:${out.taskId}`]);
  assert.equal(JSON.parse(row!.value).effort, 'xhigh', 'stored before anything claims the wake');
  assert.match(JSON.parse(row!.value).reason, /^given by Ada$/, 'with who gave it – the route\'s reason names it');
  assert.ok(h.wakes.list('ag_bo').some((wake) => wake.taskId === out.taskId && wake.claimedAt === undefined), 'its wake is still unclaimed');
});

test('FIXES-3b F3: the newest choice holds – a start model set for me after my request ends it, my model.set after that holds again, another field leaves it', async () => {
  const h = await rt2Setup();
  // the real org on the same database: the person's change goes the way agents.update and models.setPolicy save it
  const org = new Org({ db: h.db, bus: h.bus, clock: h.clock, templatesDir: path.resolve(import.meta.dirname, '../../../resources/agents') });
  new AgentRepo(h.db).save(h.org.get(AGENT)!);
  Object.assign(h.org, { get: (id: string) => org.get(id), require: (id: string) => org.require(id), list: () => org.list(), update: org.update.bind(org) });
  h.seed(SOL, 'low', 'coding');
  ok(await h.ask({ model: LUNA })); // my request waits while my session is live
  assert.equal(h.stored('next_model')?.modelId, LUNA);

  // the person changes my effort and my role: nothing about the model – my request stays
  setPolicy(h.services, { agentId: AGENT }, { ...h.org.get(AGENT)!.modelPolicy, effort: 'medium' });
  org.update(AGENT, { role: 'Writes the release notes' }, { by: HUMAN_ID });
  assert.equal(h.stored('next_model')?.modelId, LUNA, 'a change of another field leaves my request');

  // w3-chat: Tessa's pin set back to Terra ran on Luna, "requested by the agent"
  org.update(AGENT, { modelPolicy: { pin: OPUS } }, { by: HUMAN_ID });
  assert.equal(h.stored('next_model'), undefined, 'the person decided anew – my older request ends');
  h.rest();
  const theirs = await h.turn();
  assert.deepEqual([theirs.modelId, theirs.by], [OPUS, 'pin'], theirs.reason);
  assert.match(theirs.reason, /^my start model/);

  // my own model.set after that is the newer choice again
  ok(await h.ask({ model: LUNA }));
  assert.equal(h.org.get(AGENT)!.modelPolicy.pin, LUNA);
  h.rest();
  const mine = await h.turn();
  assert.deepEqual([mine.modelId, mine.by], [LUNA, 'request'], mine.reason);
  assert.match(mine.reason, /^requested by the agent/);
});
