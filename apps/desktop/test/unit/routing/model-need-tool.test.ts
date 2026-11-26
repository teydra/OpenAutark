// B-048 E4.2 – model.set by need through the tool (tools/builtin/models.ts), planTurn, the real router
// and the run journal: the answer names the model it will be and when it starts; where my context starts anew (this harness
// keeps no session, so every turn does) the turn runs there and I stay on it (17.11.2026: the model settles – no way back
// by itself); with now my next turn runs it inside a live session too; need and model together or a need nothing meets are refused without storing
// anything, while my own agent pin (B-080) is only where I start – model.set
// leaves it for a step (the person's suggestion in a chat routes nothing, 13.11.2026); stronger on the top model stays there one effort step up;
// now: true asks the dispatcher to continue at once (Dispatcher.continueNow, B-080: with the target model and effort) and
// says so – without it the request applies from the next turn; B-080 review: a request for another task than this turn's
// leaves the running turn alone and holds from that task's next turn. B-083 review: with a temperature the model takes now
// cuts the turn (no target; the new turn takes the stored request with it), a stance keeps the in-turn switch; stronger on the best model names the person's effort tip it
// leaves. B-083 integration review: a part (ctx.split, no chat) stores no request, tries its switch without now and its
// answer says what its running turn does. B-083 routing wave: "cheap" / "strong"
// are needs (D5), a part's model that cannot run now switches nothing and says so (D1). Owns: these assertions only. Never: real engines, timers or network.

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
import { takeNextModel, takeNextRoute } from '../../../src/runtime/agents/next-route.ts';
import { SessionStore } from '../../../src/runtime/agents/sessions.ts';
import { modelTools } from '../../../src/runtime/tools/builtin/models.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import type { Effort, EngineId, RouteDecision } from '../../../src/shared/model/providers.ts';
import type { Run } from '../../../src/shared/model/runs.ts';

const SOL = 'codex:gpt-6.1-sol';
const LUNA = 'codex:gpt-6-luna';
const OPUS = 'claude:claude-opus-5-5';
const AGENT = 'ag_ada';
const caps = { vision: true, tools: true, structuredOutput: true };
const ALL: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const PRIORS = Priors.parse({
  version: 'test-need', categories: {},
  models: [
    { match: 'gpt-6.1-sol*', name: 'GPT-6.1 Sol', tier: 'frontier', relCost: 0.3, caps, efforts: ALL, strengths: { coding: 0.8, chat: 0.4, 'video-animation': -0.7 } },
    { match: 'gpt-6-luna*', name: 'GPT-6 Luna', tier: 'small', relCost: 0.03, caps: { tools: true, structuredOutput: true }, efforts: ['none', 'low', 'medium', 'high'], strengths: { coding: 0, chat: 0.4, 'video-animation': -0.6 } },
    { match: 'claude-opus-5-5*', name: 'Claude Opus 5.5', tier: 'frontier', relCost: 0.6, caps, efforts: ALL, strengths: { coding: 0.7, chat: 0.4, 'video-animation': 0.9 } },
  ],
});
const MODES = Object.fromEntries(['coding', 'video-animation'].map((key) => [key, mode(key)]));

async function needToolSetup() {
  const h = harness({ subconscious: {} });
  h.org.add(agent(AGENT, 'Ada', { mode: 'coding' }));
  const chat = h.chats.create({ agentIds: [AGENT], createdBy: 'human' });
  const defaults = defaultSettings({ locale: 'en-US', timezone: 'UTC' });
  const settings = { ...defaults, routing: { ...defaults.routing, work: 'gemini-cli' } }; // a Work plan never connected here: no plan bonus
  const engines = new Map<EngineId, FakeEngine>([['codex', new FakeEngine('codex')], ['claude', new FakeEngine('claude')]]);
  engines.get('codex')!.lists.set('codex', [{ model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ALL }, { model: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: ['none', 'low', 'medium', 'high'] }]);
  engines.get('claude')!.lists.set('claude', [{ model: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ALL }]);
  const accounts = new FakeAccounts(h.clock, h.bus);
  accounts.upsert(account('acc_codex', 'codex'), false);
  accounts.upsert(account('acc_claude', 'claude'), false);
  const runs = new Journal({ db: h.db, bus: h.bus, clock: h.clock });
  const switches: Array<{ agentId: string; runId: string; note: string; target?: { modelId?: string; effort?: Effort } }> = [];
  const dispatcher = {
    activity: () => [{ agentId: AGENT, runId: 'run_tool', note: '', startedAt: 0, model: LUNA, effort: 'low' as Effort }],
    continueNow: (agentId: string, runId: string, note: string, target?: { modelId?: string; effort?: Effort }) => { switches.push({ agentId, runId, note, ...(target ? { target } : {}) }); return true; },
  };
  Object.assign(h.services, {
    settings: { get: () => settings }, accounts, runs, dispatcher, secrets: { use: async () => { throw new Error('no secret'); } },
    engines: { get: (id: EngineId) => engines.get(id)!, all: () => [...engines.values()] },
    modes: { get: (key: string) => { if (!MODES[key]) throw new Error(`unknown mode ${key}`); return MODES[key]; }, list: () => Object.values(MODES) },
  });
  const catalog = new Catalog({ services: () => h.services, priors: PRIORS, debounceMs: 0 });
  h.services.catalog = catalog;
  const router = new RouterImpl({ services: () => h.services });
  h.services.router = router;
  await catalog.refresh({ force: true });

  let seq = 0;
  const finish = (run: Omit<Run, 'id' | 'agentId' | 'conversationId' | 'trigger' | 'status'>) => {
    const id = `run_${++seq}`;
    runs.start({ id, agentId: AGENT, conversationId: chat.id, taskId: run.taskId, trigger: run.taskId ? 'task' : 'message' });
    runs.finish(id, { status: 'done', endedAt: h.clock.now(), ...run });
    h.clock.advance(60_000);
  };
  const turn = async (taskId?: string): Promise<RouteDecision> => {
    const plan = await planTurn(h.services, {
      runId: `plan_${seq + 1}`, agentId: AGENT, conversationId: chat.id, taskId, reason: taskId ? 'task' : 'message', notes: taskId ? [{ text: 'go on', at: 0 }] : [],
      signal: new AbortController().signal, control: { lastSeq: 0, steeredSeq: 0 },
    });
    assert.ok(plan);
    const route = await router.route(routeRequest(plan));
    if (plan.nextStepAt !== undefined) takeNextRoute(h.db, AGENT, plan.nextStepAt); // B-080: turn.ts takes the next step it read as the engine starts
    if (plan.nextModelAt !== undefined) takeNextModel(h.db, AGENT, plan.nextModelAt); // and the model I asked for, once a turn could apply it
    finish({ taskId, engine: route.engine, model: route.modelId, effort: route.effort, accountId: route.accountId, route: { reason: route.reason, by: route.by, category: route.category } });
    return route;
  };
  const tool = modelTools.find((item) => item.name === 'model.set')!;
  const ask = (args: Record<string, unknown>, patch: Partial<ToolContext> = {}): Promise<ToolOutput> => tool.run(args, {
    agent: h.org.get(AGENT)!, runId: 'run_tool', conversationId: chat.id, mode: 'coding', services: h.services, modelId: LUNA,
    signal: new AbortController().signal, status() {}, ...patch,
  } as ToolContext);
  return { ...h, chat, catalog, runs, finish, turn, ask, switches, dispatcher };
}

type Answer = { model?: string; modelId?: string; effort?: Effort; appliesTo: string; now?: string; stays?: string };
const ok = (output: ToolOutput): Answer => { assert.ok(!output.isError, JSON.stringify(output.content)); return output.structured as Answer; };
const err = (output: ToolOutput) => { assert.equal(output.isError, true); return String((output.content[0] as { text: string }).text); };

test('need stronger: the answer names the model and when it starts; the turn that starts my next context runs there, and I stay on it', async () => {
  const h = await needToolSetup();
  h.finish({ engine: 'codex', model: LUNA, effort: 'low', route: { reason: 'seed', by: 'rules', category: 'coding' } });
  const answer = ok(await h.ask({ need: 'stronger', reason: 'the tricky part' }));
  const named = h.catalog.get(answer.modelId!)!;
  assert.equal(named.tier, 'frontier');
  assert.equal(answer.model, named.name);
  assert.equal(answer.appliesTo, `${named.name} runs from my next context (after a fold or an hour of rest) and stays my model until I, my lead or the person names another; until then I stay on GPT-6 Luna; now: true moves me at once`);
  assert.equal(answer.now, undefined);
  const next = await h.turn();
  assert.equal(next.modelId, answer.modelId, 'the model the answer named');
  assert.equal(next.by, 'request');
  assert.match(next.reason, /asked for a stronger model/);
  // On the code before 17.11.2026 the turn after went back to Luna ("one step only"): 60 % of all switches were undone within two runs.
  const stays = await h.turn();
  assert.deepEqual([stays.modelId, stays.by], [answer.modelId, 'previous'], 'the model I am on');
  // for: task – the model is mine, not the task's: it starts the same way.
  const task = h.tasks.create({ conversationId: h.chat.id, title: 'Port the parser', assigneeId: AGENT, createdBy: 'human' });
  const onTask = ok(await h.ask({ need: 'stronger', for: 'task' }, { taskId: task.id }));
  assert.match(onTask.appliesTo, /runs from my next context/);
  assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM kv WHERE ns = 'next_route_task'")!.n, 0, 'nothing on the task');
  for (let i = 0; i < 2; i++) assert.equal((await h.turn(task.id)).modelId, onTask.modelId);
});

test('refusals store nothing: need with model, a need nothing meets', async () => {
  const h = await needToolSetup();
  const stored = () => h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM kv WHERE ns IN ('next_route', 'next_model', 'next_route_task')")!.n;
  assert.match(err(await h.ask({ need: 'stronger', model: OPUS })), /not both/);
  assert.match(err(await h.ask({})), /Give a need/);
  assert.match(err(await h.ask({ need: 'long_context' }, { modelId: OPUS })), /^No model with a longer context fits within my model policy right now – I stay on Claude Opus 5\.5/);
  assert.equal(stored(), 0);
});

test('13.11.2026: the person\'s suggestion in this chat routes nothing – model.set is what moves my turn there', async () => {
  const h = await needToolSetup();
  h.chats.update(h.chat.id, { settings: { modelHints: { [AGENT]: SOL } } }, 'human');
  const says = (body: string) => h.chats.send({ conversationId: h.chat.id, authorId: 'human', body });
  says('Port the parser, please.');
  const start = await h.turn();
  assert.notEqual(start.by, 'pin');
  assert.doesNotMatch(start.reason, /suggested/);
  assert.equal(ok(await h.ask({ model: SOL })).modelId, SOL, 'the suggested model, when I set it');
  const named = await h.turn();
  assert.deepEqual([named.modelId, named.by], [SOL, 'request']);
  const stronger = ok(await h.ask({ need: 'stronger' }));
  assert.equal(h.catalog.get(stronger.modelId!)!.tier, 'frontier', 'a need too');
  assert.equal((await h.turn()).modelId, stronger.modelId);
});

test('B-080: my own agent pin is my default – model.set picks another for the stretch my next fresh context starts', async () => {
  const h = await needToolSetup();
  h.finish({ engine: 'codex', model: LUNA, effort: 'low', route: { reason: 'seed', by: 'pin', category: 'coding' } });
  h.org.add({ ...h.org.get(AGENT)!, modelPolicy: { pin: LUNA } });
  const answer = ok(await h.ask({ need: 'stronger' }));
  assert.notEqual(answer.modelId, LUNA);
  assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM kv WHERE ns = 'next_model'")!.n, 1, 'stored as the model I asked for');
  const next = await h.turn();
  assert.equal(next.modelId, answer.modelId);
  assert.equal(next.by, 'request');
  assert.equal((await h.turn()).modelId, LUNA, 'at the boundary after it my pin again (no session is kept here: every turn starts anew)');
  const named = ok(await h.ask({ model: OPUS }));
  assert.equal(named.modelId, OPUS, 'a model I name');
  assert.equal((await h.turn()).modelId, OPUS);
});

test('stronger on the best model: it stays, one effort step up – said in the answer and kept for the turn', async () => {
  const h = await needToolSetup();
  h.finish({ engine: 'claude', model: OPUS, effort: 'high', route: { reason: 'seed', by: 'rules', category: 'video-animation' } });
  h.org.add({ ...h.org.get(AGENT)!, mode: 'video-animation' });
  h.dispatcher.activity = () => [{ agentId: AGENT, runId: 'run_tool', note: '', startedAt: 0, model: OPUS, effort: 'high' }];
  const answer = ok(await h.ask({ need: 'stronger' }, { modelId: OPUS, mode: 'video-animation' }));
  assert.equal(answer.modelId, OPUS);
  assert.equal(answer.effort, 'xhigh');
  assert.equal(answer.stays, 'No stronger model fits: I stay on Claude Opus 5.5 at effort xhigh.');
  const next = await h.turn();
  assert.equal(`${next.modelId}/${next.effort}`, `${OPUS}/xhigh`, 'not raised twice');
});

test('B-083 review: stronger on the best model leaves the person\'s effort suggestion – the answer names it', async () => {
  const h = await needToolSetup();
  h.finish({ engine: 'claude', model: OPUS, effort: 'high', route: { reason: 'seed', by: 'rules', category: 'video-animation' } });
  h.org.add({ ...h.org.get(AGENT)!, mode: 'video-animation' });
  Object.assign(h.services.settings.get(), { profile: { ...h.services.settings.get().profile, name: 'Stanislaus' } });
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Look again.', effort: 'high' }); // 26.11.2026: a pick is on one line only
  h.dispatcher.activity = () => [{ agentId: AGENT, runId: 'run_tool', note: '', startedAt: 0, model: OPUS, effort: 'high' }];
  const answer = ok(await h.ask({ need: 'stronger' }, { modelId: OPUS, mode: 'video-animation' })) as Answer & { suggestion?: string };
  assert.deepEqual([answer.modelId, answer.effort], [OPUS, 'xhigh']);
  assert.equal(answer.suggestion, 'Stanislaus picked effort high for their newest message – I take effort xhigh for this step.');
});

test('now: true continues at once through the dispatcher and says so; without it the next turn', async () => {
  const h = await needToolSetup();
  const answer = ok(await h.ask({ model: OPUS, effort: 'high', now: true }));
  assert.equal(answer.now, 'the new model takes over from my next step – or from my next turn, when this one has none left; on another engine my work goes on at once in a new turn on it', 'FIXES-3 C1: what holds when this turn has no request left');
  assert.deepEqual(h.switches, [{
    agentId: AGENT, runId: 'run_tool', note: 'I switched to Claude Opus 5.5 · high (model.set now) – I continue my work where I stopped; what I did so far is kept.',
    target: { modelId: OPUS, effort: 'high' }, // B-080: the dispatcher switches the running turn to it when its engine runs it
  }]);
  const vision = ok(await h.ask({ need: 'vision', now: true }));
  assert.equal(h.switches.length, 2);
  assert.match(h.switches[1].note, new RegExp(`^I switched to ${vision.model}`));
  // B-080 review: now acts on the running turn's own work – a request for another task waits for that task's turn.
  const task = h.tasks.create({ conversationId: h.chat.id, title: 'Port the parser', assigneeId: AGENT, createdBy: 'human' });
  const other = ok(await h.ask({ model: OPUS, task: task.id, now: true }));
  assert.equal(other.now, `my running turn is on other work – the model runs my next turn, its effort the next turn on task ${task.id}`);
  assert.equal(h.switches.length, 2, 'the running turn is not switched');
  const own = ok(await h.ask({ model: OPUS, task: task.id, now: true }, { taskId: task.id }));
  assert.match(own.now ?? '', /^the new model takes over from my next step – or from my next turn/);
  assert.equal(h.switches.length, 3, 'this turn\'s own task switches it');
  // B-083 review: a running turn keeps its temperature. A stance (Claude Code takes none) leaves the in-turn switch as it is;
  // one the model takes cuts the turn (no target) and the new turn runs on the stored request with it.
  takeNextRoute(h.db, AGENT);
  const stance = ok(await h.ask({ model: OPUS, temperature: 0.3, now: true })) as Answer & { temperatureNote?: string };
  assert.match(stance.now ?? '', /^the new model takes over from my next step – or from my next turn/);
  assert.match(stance.temperatureNote ?? '', /^Claude Opus 5\.5 samples at its own setting/);
  assert.equal(h.switches[3].target?.modelId, OPUS, 'model and effort switch inside the turn');
  const get = h.catalog.get.bind(h.catalog);
  Object.assign(h.catalog, { get: (id: string) => { const info = get(id); return info ? { ...info, engine: 'fake' } : info; } }); // a model that takes one
  const warm = ok(await h.ask({ temperature: 0.3, now: true })) as Answer & { temperatureNote?: string };
  Object.assign(h.catalog, { get });
  assert.deepEqual([warm.now, warm.temperatureNote], ['my work continues at once in a new turn with it', undefined]);
  assert.equal(h.switches.length, 5);
  assert.equal(h.switches[4].target, undefined, 'cut: the new turn starts with it');
  assert.match(h.switches[4].note, / · temperature 0\.3 \(model\.set now\) – I continue my work where I stopped/);
  const kept = h.db.get<{ value: string }>("SELECT value FROM kv WHERE ns = 'next_route' AND key = ?", [AGENT]);
  assert.equal(JSON.parse(kept!.value).temperature, 0.3, 'the stored request carries it to the new turn');
  (h.dispatcher as { continueNow?: unknown }).continueNow = undefined;
  assert.equal(ok(await h.ask({ effort: 'max', now: true })).now, 'cannot switch inside this turn – it applies from my next turn');
});

test('B-083 integration review: a part stores no request – its model.set is tried inside its turn without now, and the answer says what happened', async () => {
  const h = await needToolSetup();
  const split: ToolContext['split'] = { splitId: 'sp_1', groupId: 'sg_1', idx: 1, of: 2, title: 'One', parentRunId: 'run_parent', parentThread: h.chat.id, parentConversationId: h.chat.id, context: 'fork', firstTurn: true };
  const part = { split, conversationId: undefined };
  const answer = ok(await h.ask({ effort: 'high' }, part));
  assert.equal(takeNextRoute(h.db, AGENT), undefined, 'a part stores no request');
  assert.equal(h.switches.length, 1, 'tried without now');
  assert.ok(h.switches[0].target?.modelId, 'with a target: a part is never cut');
  assert.equal(answer.appliesTo, 'this part\'s turn');
  assert.equal(answer.now, 'the new model takes over from my next step in this part – a part with no step left ends on the model it has');
  // The part's lane takes only a target (dispatcher.ts continueNow); refused, nothing applies and the answer says so.
  h.dispatcher.continueNow = (agentId, runId, note, target) => { h.switches.push({ agentId, runId, note, ...(target ? { target } : {}) }); return false; };
  const refused = ok(await h.ask({ effort: 'max' }, part));
  assert.equal(refused.appliesTo, 'nothing – this part goes on as it is');
  assert.match(refused.now ?? '', /^my running turn stays on GPT-6 Luna – a part takes a new model inside its turn on the same engine and account/);
  h.dispatcher.continueNow = (agentId, runId, note, target) => { h.switches.push({ agentId, runId, note, ...(target ? { target } : {}) }); return target !== undefined; };
  const get = h.catalog.get.bind(h.catalog);
  Object.assign(h.catalog, { get: (id: string) => { const info = get(id); return info ? { ...info, engine: 'fake' } : info; } }); // a model that takes one
  const warm = ok(await h.ask({ temperature: 0.7 }, part)) as Answer & { temperature?: number };
  Object.assign(h.catalog, { get });
  assert.equal(h.switches[2].target, undefined, 'a running turn keeps its temperature');
  assert.deepEqual([warm.appliesTo, warm.temperature], ['nothing – this part goes on as it is', undefined]);
  assert.match(warm.now ?? '', /a running turn keeps its temperature/);
  assert.equal(takeNextRoute(h.db, AGENT), undefined);
});

test('B-083 D5: model "cheap" / "strong" is the need cheaper / stronger than the model I run on', async () => {
  const h = await needToolSetup();
  const stored = () => JSON.parse(h.db.get<{ value: string }>("SELECT value FROM kv WHERE ns = 'next_model' AND key = ?", [AGENT])!.value);
  const byNeed = ok(await h.ask({ need: 'cheaper' }, { modelId: OPUS }));
  const byWord = ok(await h.ask({ model: 'cheap' }, { modelId: OPUS }));
  assert.deepEqual([byWord.modelId, byWord.model], [byNeed.modelId, byNeed.model], 'the same answer as the need');
  assert.notEqual(byWord.modelId, OPUS);
  assert.deepEqual([stored().need, stored().from], ['cheaper', OPUS]);
  const strong = ok(await h.ask({ model: ' Strong ' }));
  assert.equal(h.catalog.get(strong.modelId!)!.tier, 'frontier', 'stronger than Luna');
  assert.deepEqual([stored().need, stored().from], ['stronger', LUNA]);
});

test('17.11.2026: in a live session the model I asked for waits – the reason names it; with now my next turn runs it there', async () => {
  const h = await needToolSetup();
  h.finish({ engine: 'codex', model: LUNA, effort: 'low', route: { reason: 'seed', by: 'rules', category: 'coding' } });
  new SessionStore(h.db).save({ agentId: AGENT, conversationId: 'main', engine: 'codex', ref: 'ses_1', generation: 1, cursorSeq: 0, model: LUNA, updatedAt: h.clock.now() });
  const waiting = () => h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM kv WHERE ns = 'next_model'")!.n;
  ok(await h.ask({ model: OPUS }));
  // On the code before 17.11.2026 this turn ran on Opus and wrote the whole context into its cache.
  const waits = await h.turn();
  assert.deepEqual([waits.modelId, waits.by], [LUNA, 'previous']);
  assert.match(waits.reason, /^continues on my model · Claude Opus 5\.5 from my next context/);
  assert.equal(waiting(), 1, 'it stays stored for my next boundary');
  ok(await h.ask({ model: OPUS, now: true }));
  const moved = await h.turn();
  assert.deepEqual([moved.modelId, moved.by], [OPUS, 'request'], 'now: the one request that moves the model inside a live session');
  assert.equal(waiting(), 0, 'used up');
});

test('B-083 D1: a part names a model that cannot run now – nothing switches, the part goes on as it is and says so', async () => {
  const h = await needToolSetup();
  (h.services.accounts as unknown as FakeAccounts).markLimited('acc_claude', h.clock.now() + 3600_000);
  const split: ToolContext['split'] = { splitId: 'sp_1', groupId: 'sg_1', idx: 1, of: 2, title: 'One', parentRunId: 'run_parent', parentThread: h.chat.id, parentConversationId: h.chat.id, context: 'fork', firstTurn: true };
  const answer = ok(await h.ask({ model: OPUS, effort: 'high' }, { split, conversationId: undefined })) as Answer & { instead?: string };
  assert.equal(h.switches.length, 0, 'never tried: no switch onto a model I did not name');
  assert.equal(answer.appliesTo, 'nothing – this part goes on as it is');
  assert.equal(answer.now, 'my running turn stays on GPT-6 Luna');
  assert.match(answer.instead ?? '', /\. This part goes on as it is\.$/);
  assert.match(answer.instead ?? '', /^Asked for Claude Opus 5\.5 – no account of it can run now/, 'the route\'s reason leads (T1: routing/unfit.ts askedMiss)');
  assert.equal(takeNextRoute(h.db, AGENT), undefined, 'nothing stored');
});
