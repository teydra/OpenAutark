// The call before a turn (subconscious/route-turn.ts routeTurn; service.ts lookFirst). 17.11.2026 – the model settles: the call
// sets the coming turn's effort and nothing else. Its answer lands as the subconscious's step for that one turn (agents/next-route.ts,
// by 'subconscious') with effort and reason; a model in an answer is never stored, the call's text and schema name none, and every
// field of the schema is one question. A failed, cut or late call sets nothing; a colleague's wake and a task's are labelled so. The
// service calls once on a person's message, on a colleague's with content when no person wrote, else on the turn's task; the turn
// waits for it at most ROUTE_WAIT_MS – and only while the lane's recent median is under FAST_MS: on a slow lane the turn starts at
// once, the call runs beside it only to pick hits, and its lines reach the next turn (hints.ts). Nothing runs after a turn,
// and each call leaves one info event with the model that answered and its tokens (hits and context: look.test.ts). An effort decided
// already – the agent's own step, its task's, its fixed effort – costs no call; a model the agent asked for that waits for its
// boundary decides no effort; a step set for an earlier message ends on the next turn. The call reads "What I have here" to the end
// and the person's language (a fact of its system prompt, FIXES-3 D1); it never sets the effort 'none', and its why stays out of
// the log; a turn a running call hands over does not wait for it (FIXES-3 D2).
// Owns: these assertions only. Never: real models, engines or network (the turn's wait runs on mocked timers).

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from '../chat/harness.ts';
import { fixture, model } from '../context/fixture.ts';
import { account } from '../models/harness.ts';
import { ROUTE_SYSTEM, routeSystem, routeTurn, standingWords, turnFacts } from '../../../src/runtime/subconscious/route-turn.ts';
import { FAST_MS, LOOK_MS, PROBE_TURNS, ROUTE_WAIT_MS, SubconsciousImpl } from '../../../src/runtime/subconscious/service.ts';
import { turnHints } from '../../../src/runtime/subconscious/hints.ts';
import { pendingRoute, setNextRoute, setTaskRoute } from '../../../src/runtime/agents/next-route.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';
import { redact } from '../../../src/runtime/system/log.ts';
import { helperAway, noteHelperRoute } from '../../../src/runtime/routing/helper-default.ts';
import { SYSTEM_ID } from '../../../src/shared/ids.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { ModelInfo } from '../../../src/shared/model/providers.ts';
import type { Run } from '../../../src/shared/model/runs.ts';

const LUNA = 'codex:gpt-6.1-luna';
const SOL = 'codex:gpt-6.1-sol';
const ADA = 'ag_ada';
const SAID = 'Bitte prüf den Vertrag für Müller, er unterschreibt morgen.';
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Lets pending work run until `ready` holds (the word search reads files before a call starts). */
const until = async (ready: () => boolean, what: string) => {
  for (let i = 0; i < 5000 && !ready(); i++) await flush();
  assert.ok(ready(), what);
};

/** Fake services around a real database and clock: two connected work models on one Codex plan account and the runs the prompt's lines read. */
function world(options: { runs?: Array<Partial<Run>>; models?: ModelInfo[]; agent?: Partial<Agent>; language?: string } = {}) {
  const h = harness();
  const ada = agent(ADA, 'Ada', { role: 'bookkeeper', ...options.agent });
  h.org.add(ada);
  const models = new Map((options.models ?? [model(LUNA, 'small', 'GPT-6.1 Luna'), model(SOL, 'frontier', 'GPT-6.1 Sol')]).map((info) => [info.id, info]));
  const runs = options.runs ?? [];
  const accounts = [account('acc_1', 'codex')];
  Object.assign(h.services, {
    catalog: { get: (id: string) => models.get(id), list: () => [...models.values()] },
    accounts: { list: () => accounts, candidates: () => accounts },
    runs: { list: () => runs },
    settings: { get: () => ({ profile: { name: 'Alex', timezone: 'UTC', ...(options.language ? { language: options.language } : {}) }, routing: { allowPaidFallback: false } }) },
  });
  const stored = () => pendingRoute(h.db, ADA, undefined, () => false);
  return { h, ada, stored };
}

const USAGE = { inputTokens: 1200, cachedInputTokens: 1000, outputTokens: 40 };

/** A decision model with one answer for every call: a JSON object, an error it throws, or 'hang' (it ends only when its call is cut). */
function answering(answer: Record<string, unknown> | Error | 'hang', gate?: Promise<void>) {
  const calls: Array<Parameters<StructuredRunner>[0]> = [];
  const runner: StructuredRunner = async (call) => {
    calls.push(call);
    if (gate) await gate;
    if (answer instanceof Error) throw answer;
    if (answer === 'hang') return new Promise((_resolve, reject) => call.signal?.addEventListener('abort', () => reject(new Error('cut')), { once: true }));
    return { text: JSON.stringify(answer), structured: answer, by: 'codex:gpt-6-luna', usage: USAGE };
  };
  return { runner, calls };
}

const pick = (effort: string, why = 'a contract the customer signs') => ({ hardest: 'the contract', fixed: false, shows: false, together: true, effort, why });
type Fields = { properties: Record<string, { description?: string; enum?: string[] }> };
/** The hit ids a call may pick (its schema's hints enum). */
const hintIds = (call: Parameters<StructuredRunner>[0]): string[] => (call.schema as { properties: { hints?: { items: { properties: { id: { enum: string[] } } } } } }).properties.hints?.items.properties.id.enum ?? [];

test('the answer lands as my subconscious\'s step for this one turn: its effort with its why – the call names no model, and a model in an answer is never stored', async () => {
  const w = world();
  // On the code before 17.11.2026 the call chose the turn's model: 77 switches, 64 on a live cache, 36 onto the small tier.
  const brain = answering({ ...pick('high', '  a contract\n the customer   signs '), model: 'GPT-6.1 Luna' });
  const look = await routeTurn(w.h.services, brain.runner, { agent: w.ada, said: SAID, deadlineMs: ROUTE_WAIT_MS });
  assert.equal(look?.line, 'effort high', 'the line names what it set; its why stays on the step');
  assert.deepEqual([look?.by, look?.usage], ['codex:gpt-6-luna', USAGE], 'the answering model and its tokens ride along for the log');
  const at = w.h.clock.now();
  assert.deepEqual(w.stored(), { effort: 'high', reason: 'a contract the customer signs', by: 'subconscious', at, stepAt: at });
  assert.equal(w.h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM kv WHERE ns = 'next_model'")!.n, 0);
  const [call] = brain.calls;
  assert.deepEqual([call.purpose, call.system, call.effort, call.deadlineMs], ['subconscious', ROUTE_SYSTEM, 'low', ROUTE_WAIT_MS]);
  const fields = (call.schema as Fields).properties;
  // Runde „Halb“ 21.11.2026: the three weights of ROUTE_SYSTEM are the answer's own questions (before: misread, decide)
  assert.deepEqual(Object.keys(fields), ['hardest', 'fixed', 'shows', 'together', 'effort', 'why'], 'no model among the fields');
  for (const [name, field] of Object.entries(fields)) assert.match(field.description ?? '', /^[A-Z][^?]*\?$/, `${name}: one question`);
  assert.match(call.prompt, /^Agent: Ada – bookkeeper \(mode general\)\./);
  assert.ok(call.prompt.includes(`The person's new message:\n${SAID}`), call.prompt);
  assert.ok(call.prompt.includes("The main AI's coming turn: no turn yet."), call.prompt);
  assert.ok(!call.prompt.includes('effort high at least'), 'no floor for a person\'s line');
  for (const gone of ['The models the turn can run on', 'What a switch costs', 'start model', 'GPT-6.1 Sol', 'GPT-6.1 Luna']) assert.ok(!call.prompt.includes(gone), `the prompt names no model: ${gone}`);
  for (const gone of [/The model follows the kind of work/, /Small:|Middle:|Strongest:/, /Staying on the model/, /reads the whole context uncached/, /the model \(its name exactly as listed\)/]) assert.doesNotMatch(ROUTE_SYSTEM, gone);
  assert.match(ROUTE_SYSTEM, /^I am the main AI's subconscious\. I set the effort a turn runs at/);
  assert.match(ROUTE_SYSTEM, /Each field is one question and I answer each on its own/);
});

test("Runde „Halb“: the effort text weighs the hardest step over the whole scale – the least it needs, no lean upward, no weight for who wrote; no condensing, no opened entries", () => {
  assert.match(ROUTE_SYSTEM, /Effort is how long the main AI thinks before each step: too little sends it down a wrong path that later turns follow, too much costs time and money on every step and changes nothing in the result – so I look for the least the hardest step needs\.\n\nI weigh three things/);
  assert.match(ROUTE_SYSTEM, /low: the way is fixed and the result can be held against what is given\. medium: the way is clear and a miss shows at once when the step runs – the normal for everyday work\. high: /);
  assert.match(ROUTE_SYSTEM, /max: the result itself is the point – a wording or a decision that has to be the best one – or xhigh fell short\. Neither the length of a message nor who wrote it changes the weight\./);
  assert.match(ROUTE_SYSTEM, /A hit I pick reaches the main AI as one line of mine: what it changes in this turn, in a sentence/);
  assert.match(ROUTE_SYSTEM, /so I pick every hit that could change what the turn does and leave those that only share its topic\./);
  // On the code before 21.11.2026: 461 of 493 efforts were high or xhigh.
  for (const gone of [/The first reply often settles/, /high – the normal for real work/, /One level up when/, /keep its context lean/, /An entry I open/, /the biggest items still whole/, /whether its job is done/]) assert.doesNotMatch(ROUTE_SYSTEM, gone);
});

test('an answer without a valid effort sets nothing', async () => {
  const w = world();
  assert.equal((await routeTurn(w.h.services, answering(pick('extreme')).runner, { agent: w.ada, said: SAID, deadlineMs: ROUTE_WAIT_MS }))?.line, undefined);
  assert.equal(w.stored(), undefined);
  await routeTurn(w.h.services, answering(pick('medium')).runner, { agent: w.ada, said: SAID, deadlineMs: ROUTE_WAIT_MS });
  assert.equal(w.stored()?.effort, 'medium');
});

test('a runner error, a cut call and an answer after the cut return undefined and set nothing', async () => {
  const w = world();
  assert.equal((await routeTurn(w.h.services, answering(new Error('model down')).runner, { agent: w.ada, said: SAID, deadlineMs: ROUTE_WAIT_MS }))?.line, undefined);
  const cut = new AbortController();
  const hanging = routeTurn(w.h.services, answering('hang').runner, { agent: w.ada, said: SAID, signal: cut.signal, deadlineMs: ROUTE_WAIT_MS });
  await flush();
  cut.abort();
  assert.equal(await hanging, undefined);
  let release = () => {};
  const late = answering(pick('high'), new Promise<void>((resolve) => { release = resolve; }));
  const stop = new AbortController();
  const routed = routeTurn(w.h.services, late.runner, { agent: w.ada, said: SAID, signal: stop.signal, deadlineMs: ROUTE_WAIT_MS });
  await flush();
  stop.abort();
  release();
  assert.equal(await routed, undefined, 'the turn runs already: a late answer shapes no later turn');
  assert.equal(w.stored(), undefined);
});

test("a colleague's wake is labelled as the colleague's message, not the person's", async () => {
  const w = world();
  const brain = answering(pick('low', 'a receipt to take note of'));
  await routeTurn(w.h.services, brain.runner, { agent: w.ada, said: 'Konrad: Die Rechnung ist raus.', from: 'colleague', deadlineMs: ROUTE_WAIT_MS });
  assert.ok(brain.calls[0].prompt.includes("The colleague's message that wakes the main AI:\nKonrad: Die Rechnung ist raus."), brain.calls[0].prompt);
  assert.ok(!brain.calls[0].prompt.includes("The person's new message:"));
  assert.equal(w.stored()?.effort, 'low');
});

test('service: a person\'s message calls the runner once and the turn waits at most ROUTE_WAIT_MS; the cut call sets nothing', async () => {
  const w = world();
  const brain = answering('hang');
  const impl = new SubconsciousImpl({ services: () => w.h.services, runner: brain.runner });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let waited = true;
    const turn = impl.beforeTurn({ agent: w.ada, thread: 'main', said: SAID }).finally(() => { waited = false; });
    await flush();
    assert.equal(brain.calls.length, 1);
    assert.equal(brain.calls[0].deadlineMs, ROUTE_WAIT_MS);
    mock.timers.tick(ROUTE_WAIT_MS - 1);
    await flush();
    assert.equal(waited, true, 'still within the wait');
    mock.timers.tick(1);
    assert.equal(await turn, undefined);
    assert.equal(brain.calls[0].signal?.aborted, true, 'the call is cut with the wait');
    await impl.settle();
    assert.equal(w.stored(), undefined);
  } finally { mock.timers.reset(); }
  const quick = world();
  const sure = answering(pick('high'));
  const fast = new SubconsciousImpl({ services: () => quick.h.services, runner: sure.runner });
  await fast.beforeTurn({ agent: quick.ada, thread: 'main', said: SAID });
  assert.equal(quick.stored()?.effort, 'high', 'an answer within the wait runs this turn');
  await fast.beforeTurn({ agent: quick.ada, thread: 'main', said: 'ja bitte' });
  assert.equal(sure.calls.length, 1, 'a bare go-ahead costs no call');
});

test('17.11.2026: the turn waits for the call only while the lane answers fast – on a slow lane it starts at once at its settled effort, the call runs beside it only to open what the work needs, and that reaches the next turn', async () => {
  const f = fixture();
  const ida = f.org.add(agent('ag_ida', 'Ida', { role: 'Assistant' }));
  for (const name of ['Nordlicht', 'Fjordblick', 'Seeufer', 'Bergwerk', 'Talgrund', 'Hafenkante', 'Wiesengrund']) f.knowledge.memoryWrite({ folder: 'company/partner', title: `Lieferant ${name}`, text: `Lieferant ${name}: Rechnungen nur als PDF, Zahlungsziel 30 Tage.` });
  const step = () => pendingRoute(f.services.db, ida.id, undefined, () => false);
  let slow = 6_000; // how long the lane takes to answer
  const calls: Array<Parameters<StructuredRunner>[0]> = [];
  const runner: StructuredRunner = async (call) => {
    calls.push(call);
    if (slow) await new Promise<void>((resolve) => setTimeout(resolve, slow));
    const asked = Object.keys((call.schema as Fields).properties);
    const hints = hintIds(call).slice(0, 1).map((id) => ({ id, line: 'Its invoices only as PDF.' }));
    const structured = { ...(asked.includes('effort') ? pick('xhigh') : {}), ...(asked.includes('hints') ? { hints } : {}) };
    return { text: JSON.stringify(structured), structured, by: 'claude:claude-haiku-5-5', usage: USAGE };
  };
  const impl = new SubconsciousImpl({ services: () => f.services, runner });
  const ask = (name: string) => impl.beforeTurn({ agent: ida, thread: 'main', said: `Was will Lieferant ${name} bei Rechnungen?` });
  const shown = () => turnHints(f.services, ida.id, 'main').map((hint) => hint.id);
  const routes = () => calls;
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    // Nothing measured yet: the turn waits. The lane takes 6 s – above FAST_MS.
    assert.ok(slow > FAST_MS);
    let first: Awaited<ReturnType<typeof ask>> | 'waiting' = 'waiting';
    const waiting = ask('Nordlicht').then((trace) => { first = trace; });
    await until(() => routes().length === 1, 'the call before the first turn started');
    assert.equal(first, 'waiting', 'the turn waits for its call');
    mock.timers.tick(slow);
    await waiting;
    assert.deepEqual(first, { calls: [] }, 'no tool call: its pick is a hint of this turn (the empty trace carries it back if the turn fails)');
    assert.equal(shown().length, 1, "the pick stands in this turn's \"## From my memory\"");
    assert.equal(step()?.effort, 'xhigh', 'the answer set this turn\'s effort');

    // On the code before 17.11.2026 every turn waited up to 12 s on this lane: 9.5 s on average, 30 % cut with nothing.
    const second = await ask('Fjordblick'); // resolves with no timer moved: the turn does not wait
    assert.equal(second, undefined, 'nothing waited for');
    assert.deepEqual(shown(), [], 'nothing picked in time for this turn');
    assert.equal(step(), undefined, 'no effort set: the turn runs at its settled effort (the step of the turn before ended)');
    await until(() => routes().length === 2, 'the call beside the second turn started');
    const beside = routes()[1];
    assert.deepEqual(Object.keys((beside.schema as Fields).properties), ['hints'], 'beside the turn the call is asked only what to hand over');
    assert.equal(beside.deadlineMs, LOOK_MS);
    // review 17.11.2026: the call is told its turn runs already and what it gives reaches the next one
    assert.ok(beside.prompt.includes("The main AI's turn has started already; the lines I give reach its next turn."), beside.prompt);
    mock.timers.tick(slow);
    await impl.settle();
    assert.equal(step(), undefined, 'a late answer sets no effort');
    await ask('Seeufer');
    assert.equal(shown().length, 1, 'what the late call picked reaches the next turn');
    assert.match(shown()[0], /fjordblick/);
    await until(() => routes().length === 3, 'the call beside the third turn started');
    mock.timers.tick(slow);
    await impl.settle();

    // The lane answers fast again: one answer under FAST_MS ends the slow stretch – the times before it were not this
    // lane's speed now – so the next turn waits again and gets its effort.
    slow = 0;
    await ask('Bergwerk');
    await impl.settle();
    assert.equal(step(), undefined, 'that turn ran beside its call');
    await ask('Talgrund');
    assert.equal(step()?.effort, 'xhigh', 'one fast answer after 6 s, 6 s, 6 s: the turn waits again and gets its effort');
  } finally { mock.timers.reset(); }
});

test('FIXES-3 D2: a turn a running call hands over starts at once at its settled effort – on a fast lane too, the call runs beside it as on a slow one, and what it opens reaches the next turn', async () => {
  const f = fixture();
  const ida = f.org.add(agent('ag_ida', 'Ida', { role: 'Assistant' }));
  for (const name of ['Nordlicht', 'Fjordblick']) f.knowledge.memoryWrite({ folder: 'company/partner', title: `Lieferant ${name}`, text: `Lieferant ${name}: Rechnungen nur als PDF, Zahlungsziel 30 Tage.` });
  const step = () => pendingRoute(f.services.db, ida.id, undefined, () => false);
  const calls: Array<Parameters<StructuredRunner>[0]> = [];
  const runner: StructuredRunner = async (call) => {
    calls.push(call);
    await new Promise<void>((resolve) => setTimeout(resolve, 3_000)); // a fast lane: under FAST_MS, measured live 2.2–5.9 s
    const asked = Object.keys((call.schema as Fields).properties);
    const hints = hintIds(call).slice(0, 1).map((id) => ({ id, line: 'Its invoices only as PDF.' }));
    const structured = { ...(asked.includes('effort') ? pick('xhigh') : {}), ...(asked.includes('hints') ? { hints } : {}) };
    return { text: JSON.stringify(structured), structured, by: 'codex:gpt-6-luna', usage: USAGE };
  };
  const impl = new SubconsciousImpl({ services: () => f.services, runner });
  const routes = () => calls;
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    // On the code before (real run 18.11.2026, real-calls.md finding 8) this turn waited 2.2–5.9 s for the call.
    let handed: Awaited<ReturnType<typeof impl.beforeTurn>> | 'waiting' = 'waiting';
    void impl.beforeTurn({ agent: ida, thread: 'main', said: 'Was will Lieferant Nordlicht bei Rechnungen?', callId: 'call_1' }).then((trace) => { handed = trace; });
    await until(() => routes().length === 1 && handed !== 'waiting', 'the turn does not wait for the call (no timer moved)');
    assert.equal(handed, undefined);
    assert.equal(step(), undefined, 'no effort set: it runs at its settled effort');
    assert.deepEqual(Object.keys((routes()[0].schema as Fields).properties), ['hints'], 'beside the turn the call is asked only what to hand over');
    assert.ok(routes()[0].prompt.includes("The main AI's turn has started already; the lines I give reach its next turn."));
    mock.timers.tick(3_000);
    await impl.settle();
    const waiting = impl.beforeTurn({ agent: ida, thread: 'main', said: 'Und Lieferant Fjordblick?' }); // a person's line in the chat: it waits on the fast lane
    await until(() => routes().length === 2, 'the call before the next turn started');
    assert.ok('effort' in (routes()[1].schema as Fields).properties, 'that one is waited for and sets the effort');
    mock.timers.tick(3_000);
    await waiting;
    const next = turnHints(f.services, ida.id, 'main').map((hint) => hint.id);
    assert.ok(next.some((id) => /nordlicht/.test(id)), 'what the call beside picked reaches the next turn');
    assert.ok(next.some((id) => /fjordblick/.test(id)), "with that turn's own pick first");
    assert.match(next[0], /fjordblick/);
  } finally { mock.timers.reset(); }
});

test('a slow lane is measured again by itself: beside every PROBE_TURNS-th turn the call runs also when the word search finds nothing, and no turn waits for it', async () => {
  const w = world();
  let ms = 6_000;
  let by = 'claude:claude-haiku-5-5';
  const calls: string[] = [];
  const runner: StructuredRunner = async (call) => {
    calls.push(call.prompt);
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    const structured = pick('high');
    return { text: JSON.stringify(structured), structured, by, usage: USAGE };
  };
  const impl = new SubconsciousImpl({ services: () => w.h.services, runner });
  /** One turn: 'waits' for its call, a call 'beside' it, or 'none'. */
  const turn = async () => {
    const before = calls.length;
    let done = false;
    const run = impl.beforeTurn({ agent: w.ada, thread: 'main', said: SAID }).then(() => { done = true; });
    for (let i = 0; i < 200 && !done && calls.length === before; i++) await flush();
    const waited = calls.length > before && !done;
    mock.timers.tick(ms);
    await run;
    for (let i = 0; i < 50 && calls.length === before; i++) await flush(); // a call beside the turn starts after it
    const called = calls.length > before;
    mock.timers.tick(ms);
    await impl.settle();
    return waited ? 'waits' : called ? 'beside' : 'none';
  };
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    assert.equal(await turn(), 'waits', 'nothing measured: the turn waits (6 s on this lane)');
    // On the code before (review 17.11.2026) a slow lane without hits ran no call again, so it was never measured again;
    // review 2: the probe turn then waited the lane's full time.
    const turns: string[] = [];
    for (let i = 0; i < PROBE_TURNS; i++) turns.push(await turn());
    assert.deepEqual(turns, [...Array(PROBE_TURNS - 1).fill('none'), 'beside'], 'the probe runs beside its turn and is measured');
    // another Decisions model answers the next probe fast: the turns wait again
    by = 'codex:gpt-6-luna';
    ms = 0;
    for (let i = 0; i < PROBE_TURNS - 1; i++) assert.equal(await turn(), 'none');
    assert.equal(await turn(), 'beside', 'the probe, answered by Luna at once');
    assert.equal(await turn(), 'waits', 'Luna is fast: the turn waits');
    // the times are kept per model that answers: Haiku back with 6 s finds its own slow times again
    by = 'claude:claude-haiku-5-5';
    ms = 6_000;
    assert.equal(await turn(), 'waits', 'the lane last measured was Luna');
    assert.equal(await turn(), 'none', 'Haiku answered: its own median is slow');
  } finally { mock.timers.reset(); }
});

test('service: a wake by colleagues only calls with the colleague label; a person\'s line goes first; a bare colleague line costs no call', async () => {
  const w = world();
  const brain = answering(pick('low', 'a report to take note of'));
  const impl = new SubconsciousImpl({ services: () => w.h.services, runner: brain.runner });
  await impl.beforeTurn({ agent: w.ada, thread: 'main', said: '', woke: 'Der Bericht für Q3 liegt in reports/q3.md, die Zahlen sind geprüft.' });
  assert.equal(brain.calls.length, 1);
  assert.ok(brain.calls[0].prompt.includes("The colleague's message that wakes the main AI:\nDer Bericht für Q3"), brain.calls[0].prompt);
  await impl.beforeTurn({ agent: w.ada, thread: 'main', said: SAID, woke: 'Der Bericht für Q3 liegt in reports/q3.md.' });
  assert.ok(brain.calls[1].prompt.includes(`The person's new message:\n${SAID}`));
  assert.ok(!brain.calls[1].prompt.includes('Der Bericht für Q3'), 'what the person wrote is the wake');
  await impl.beforeTurn({ agent: w.ada, thread: 'main', said: '', woke: 'ok, danke' });
  assert.equal(brain.calls.length, 2);
});

test('service: nothing runs after a turn; settle waits only for a call in flight', async () => {
  const w = world();
  let release = () => {};
  const brain = answering(pick('high'), new Promise<void>((resolve) => { release = resolve; }));
  const impl = new SubconsciousImpl({ services: () => w.h.services, runner: brain.runner });
  assert.equal('afterTurn' in impl, false, 'no hook after a turn');
  await impl.settle(); // nothing in flight: at once
  const turn = impl.beforeTurn({ agent: w.ada, thread: 'main', said: SAID });
  await flush();
  let settled = false;
  const settling = impl.settle().then(() => { settled = true; });
  await flush();
  assert.equal(settled, false, 'the call in flight ends first');
  release();
  await turn;
  await settling;
  assert.equal(w.stored()?.effort, 'high');
});

test('an effort decided already holds – my own step, my task\'s effort, my fixed effort: without hits no call; a model I asked for that waits for its boundary decides no effort', async () => {
  const w = world();
  const brain = answering(pick('low', 'a status to take note of'));
  const impl = new SubconsciousImpl({ services: () => w.h.services, runner: brain.runner });
  setNextRoute(w.h.db, ADA, { effort: 'high', temperature: 0.2, at: 1 }); // model.set
  await impl.beforeTurn({ agent: w.ada, thread: 'main', said: 'Status: Teil 1 ist fertig, die Zahlen stehen in reports/q3.md.' });
  assert.equal(brain.calls.length, 0, "the agent's own model.set holds");
  assert.deepEqual(w.stored(), { effort: 'high', temperature: 0.2, at: 1, stepAt: 1 });

  const held = world();
  Object.assign(held.h.services, { tasks: { get: (id: string) => (id === 'tk_1' ? { id, status: 'in_progress' } : undefined) } });
  setTaskRoute(held.h.db, ADA, 'tk_1', { effort: 'high', reason: 'given by Konrad', at: 1 });
  const other = answering(pick('low', 'a status to take note of'));
  const onTask = new SubconsciousImpl({ services: () => held.h.services, runner: other.runner });
  await onTask.beforeTurn({ agent: held.ada, thread: 'main', taskId: 'tk_1', said: SAID });
  assert.equal(other.calls.length, 0, "the task's effort holds its turns");
  await onTask.beforeTurn({ agent: held.ada, thread: 'main', said: SAID });
  assert.equal(other.calls.length, 1, 'off the task the call runs');

  const fixed = world({ agent: { modelPolicy: { effort: 'medium' } as Agent['modelPolicy'] } });
  const none = answering(pick('xhigh'));
  await new SubconsciousImpl({ services: () => fixed.h.services, runner: none.runner }).beforeTurn({ agent: fixed.ada, thread: 'main', said: SAID });
  assert.equal(none.calls.length, 0, 'my fixed effort is not the call\'s to change');
  assert.equal(fixed.stored(), undefined);

  // On the code before 17.11.2026 any stored request of mine held the whole turn; now the model waits and the effort is still set per turn.
  const waiting = world();
  setNextRoute(waiting.h.db, ADA, { modelId: SOL, at: 1 });
  const sets = answering(pick('high'));
  await new SubconsciousImpl({ services: () => waiting.h.services, runner: sets.runner }).beforeTurn({ agent: waiting.ada, thread: 'main', said: SAID });
  assert.equal(sets.calls.length, 1);
  assert.deepEqual([waiting.stored()?.modelId, waiting.stored()?.effort, waiting.stored()?.by, waiting.stored()?.modelAt], [SOL, 'high', 'subconscious', 1], 'my step beside the model that waits');
});

test('a step set for an earlier message ends on the next turn: a turn that failed before its engine hands nothing to the next', async () => {
  const w = world();
  const brain = answering(pick('low', 'a status to take note of'));
  const impl = new SubconsciousImpl({ services: () => w.h.services, runner: brain.runner });
  await impl.beforeTurn({ agent: w.ada, thread: 'main', said: '', woke: 'Der Bericht für Q3 liegt in reports/q3.md, die Zahlen sind geprüft.' });
  assert.equal(w.stored()?.effort, 'low'); // that turn fails before its engine: nothing takes the step
  await impl.beforeTurn({ agent: w.ada, thread: 'main', said: 'ja' });
  assert.equal(brain.calls.length, 1, 'a bare yes costs no call');
  assert.equal(w.stored(), undefined, "the person's turn does not run at the effort set for the colleague's line");
});

test("a wake with a task and nobody's words is weighed on its task with its own label; a person's line and a colleague's with content go first", async () => {
  const w = world();
  const brain = answering(pick('high', 'the books of a month'));
  const impl = new SubconsciousImpl({ services: () => w.h.services, runner: brain.runner });
  const TASK = 'Monatsabschluss Oktober\nKonrad hat die Belege abgelegt, die Buchungen fehlen noch.';
  await impl.beforeTurn({ agent: w.ada, thread: 'main', said: '', woke: '', taskText: TASK });
  assert.equal(brain.calls.length, 1);
  assert.ok(brain.calls[0].prompt.includes(`The task that wakes the main AI:\n${TASK}`), brain.calls[0].prompt);
  assert.ok(!brain.calls[0].prompt.includes("The person's new message:"));
  assert.equal(w.stored()?.effort, 'high');
  await impl.beforeTurn({ agent: w.ada, thread: 'main', said: '', woke: 'ok, danke', taskText: TASK });
  assert.ok(brain.calls[1].prompt.includes('The task that wakes the main AI:'), "a colleague's bare receipt: the task's work decides");
  await impl.beforeTurn({ agent: w.ada, thread: 'main', said: '', woke: 'Der Bericht für Q3 liegt in reports/q3.md, die Zahlen sind geprüft.', taskText: TASK });
  assert.ok(brain.calls[2].prompt.includes("The colleague's message that wakes the main AI:\nDer Bericht für Q3"));
  await impl.beforeTurn({ agent: w.ada, thread: 'main', said: 'ja bitte', taskText: TASK });
  assert.equal(brain.calls.length, 3, "a person's bare go-ahead is the wake, and it holds nothing to weigh");
  await impl.beforeTurn({ agent: w.ada, thread: 'main', said: '', woke: '' });
  assert.equal(brain.calls.length, 3, 'neither words nor a task: no call');
  assert.equal(w.stored(), undefined, 'and the step set for the earlier wake ended');
});

test("the person's standing words reach the call: What I have here whole, before the line about the coming turn – its last turn's model and effort and the effort the person suggested in the chat", async () => {
  const have = ['## My role', 'Bookkeeper.', '', '## What I have here', '- This PC is my workplace, all of it.', '- Alex 12.11.: Beim Programmieren gerne mit hohem effort.'].join('\n');
  const w = world({ agent: { instructions: have }, runs: [{ model: SOL, effort: 'high', status: 'done', startedAt: 1, endedAt: 1 }] });
  const brain = answering(pick('high'));
  await routeTurn(w.h.services, brain.runner, { agent: w.ada, said: SAID, deadlineMs: ROUTE_WAIT_MS });
  const [{ prompt }] = brain.calls;
  assert.ok(prompt.includes('What the agent has here – its standing facts and agreements (its SYSTEM.md):\n- This PC is my workplace, all of it.\n- Alex 12.11.: Beim Programmieren gerne mit hohem effort.\n'), prompt);
  assert.ok(prompt.includes("The main AI's coming turn: its last turn ran on GPT-6.1 Sol at effort high."), prompt);
  assert.ok(prompt.indexOf('What the agent has here') < prompt.indexOf("The main AI's coming turn:"), 'the same each turn, so before what changes');
  assert.match(ROUTE_SYSTEM, /in this chat or in the agent's standing facts and agreements – outweighs my weighing/);
  const chat = w.h.chats.create({ agentIds: [ADA], createdBy: 'human' });
  w.h.chats.send({ conversationId: chat.id, body: 'Please look', authorId: 'human', effort: 'medium' }); // 26.11.2026: a pick applies to one message – read off that line
  assert.match(turnFacts(w.h.services, w.ada, chat.id), /; Alex picked effort medium for their newest message /);
  w.h.chats.send({ conversationId: chat.id, body: 'And now?', authorId: 'human' });
  assert.doesNotMatch(turnFacts(w.h.services, w.ada, chat.id), /effort medium/, 'the next line is Auto: nothing stays'); 
  const plain = world();
  const bare = answering(pick('high'));
  await routeTurn(plain.h.services, bare.runner, { agent: plain.ada, said: SAID, deadlineMs: ROUTE_WAIT_MS });
  assert.ok(!bare.calls[0].prompt.includes('What the agent has here'), 'no such part, no such lines');

  // Reviews 14.11. (6 live SYSTEM.md files): agents keep their agreements under their own subheadings and in their own parts after it,
  // not by day, up to 15,181 characters – the app's own split (org/hire.ts splitAtHave) reads it to the end.
  const lines = Array.from({ length: 150 }, (_unused, index) => `- Line ${index}: ${'x'.repeat(60)}`);
  const WISH = '- Konrad 10.11.: Einen hohen effort bei Social Media.';
  const body = ['### Arbeitsweise und Vereinbarungen', ...lines.slice(0, 75), WISH, '### Erledigt', ...lines.slice(75), '## Vereinbarungen mit Konrad', '- Konrad 11.11.: Für Social Media effort high.'].join('\n');
  const long = world({ agent: { instructions: `# How I work\nTeam text.\n\n## My role\nSocial media.\n\n## What I have here\r\n${body.replace(/\n/g, '\r\n')}` } });
  const words = standingWords(long.h.services, long.ada);
  assert.equal(words, body, 'whole to the end, its subheadings and its own parts in it, CRLF read as LF');
  assert.ok(words.includes(WISH), 'a wish in the middle reaches the call');
  assert.ok(!words.includes('Team text') && !words.includes('Social media.'), 'nothing above it');
  const huge = world({ agent: { instructions: `## What I have here\n${'- y\n'.repeat(9_000)}` } });
  assert.ok(standingWords(huge.h.services, huge.ada).length <= 16_002, 'bounded');
});

test("the call never turns thinking off: no 'none' among the efforts it names, and a 'none' answer sets no effort", async () => {
  const w = world();
  const brain = answering(pick('none', 'a status to take note of'));
  assert.equal((await routeTurn(w.h.services, brain.runner, { agent: w.ada, said: SAID, deadlineMs: ROUTE_WAIT_MS }))?.line, undefined);
  assert.deepEqual((brain.calls[0].schema as Fields).properties.effort.enum, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(w.stored(), undefined);
});

test("FIXES-3 D1: the why is for the person – their language is a fact of the call's system prompt (stable, in front), and it says how heavy the turn is; without a profile language none is guessed", async () => {
  // Real run 18.11.2026: on an English profile the why came in Russian, French, Spanish and Polish and spoke of tools the call does not have.
  const w = world({ language: 'de' });
  const brain = answering(pick('high'));
  await routeTurn(w.h.services, brain.runner, { agent: w.ada, said: SAID, deadlineMs: ROUTE_WAIT_MS });
  assert.equal(brain.calls[0].system, `${ROUTE_SYSTEM}\n\nThe person's language is German, so my why and my lines are in German.`);
  assert.equal(routeSystem(w.h.services), brain.calls[0].system);
  assert.match(brain.calls[0].prompt, /^Agent: Ada – bookkeeper \(mode general\)\.\n/, 'the prompt carries no language line');
  assert.match(ROUTE_SYSTEM, /What wakes a turn is asked of the main AI, which does the work with its own tools; I do none of it and weigh how heavy it is\./);
  assert.match(ROUTE_SYSTEM, /why – how heavy this turn is for the main AI, in one short sentence the person reads in the run log; and the hits I pick/);
  assert.equal((brain.calls[0].schema as Fields).properties.why.description, 'How heavy is this turn, in one short sentence for the person?');
  const bare = world();
  const plain = answering(pick('high'));
  await routeTurn(bare.h.services, plain.runner, { agent: bare.ada, said: SAID, deadlineMs: ROUTE_WAIT_MS });
  assert.equal(plain.calls[0].system, ROUTE_SYSTEM, 'no profile language: no guess');
});

test('service: each call leaves one info event – the effort it set, cut, failed or held by request – with its wait, the model that answered and its tokens; a wake without content none', async () => {
  const events: Array<Record<string, unknown>> = [];
  const listened = () => {
    const w = world();
    Object.assign(w.h.services, { log: { debug() {}, warn() {}, error() {}, info: (message: string, data: Record<string, unknown>) => { if (message === 'subconscious route') events.push(data); } } });
    return w;
  };
  const set = listened();
  const impl = new SubconsciousImpl({ services: () => set.h.services, runner: answering(pick('high')).runner });
  await impl.beforeTurn({ agent: set.ada, thread: 'main', said: SAID });
  await impl.beforeTurn({ agent: set.ada, thread: 'main', said: 'ja bitte' });
  const failed = listened();
  await new SubconsciousImpl({ services: () => failed.h.services, runner: answering(new Error('model down')).runner }).beforeTurn({ agent: failed.ada, thread: 'main', said: SAID });
  const held = listened();
  setNextRoute(held.h.db, ADA, { effort: 'high', at: 1 });
  await new SubconsciousImpl({ services: () => held.h.services, runner: answering(pick('low')).runner }).beforeTurn({ agent: held.ada, thread: 'main', said: SAID });
  const cut = listened();
  const stop = new AbortController();
  const turn = new SubconsciousImpl({ services: () => cut.h.services, runner: answering('hang').runner }).beforeTurn({ agent: cut.ada, thread: 'main', said: '', taskText: 'Monatsabschluss Oktober, Buchungen fehlen.', signal: stop.signal });
  await flush();
  stop.abort();
  await turn;
  assert.deepEqual(events.map((event) => [event.agentId, event.wake, event.outcome]), [
    [ADA, 'person', 'effort high'], [ADA, 'person', 'failed'], [ADA, 'person', 'held by request'], [ADA, 'task', 'cut'],
  ]);
  // On the code before 17.11.2026 the line carried neither: the calls' own use was recorded nowhere.
  // As runtime.log writes it (system/log.ts redact): the counts survive its safety net for secret-looking keys (18.11.2026:
  // under inputTokens/cachedTokens/outputTokens every count of the real run's lines read '[redacted]').
  const written = redact(events[0]) as Record<string, unknown>;
  assert.equal(written.model, 'codex:gpt-6-luna');
  assert.deepEqual(written.use, { input: 1200, cached: 1000, output: 40 });
  assert.equal(events[1].model, undefined, 'no answer: no model to name');
  assert.ok(!JSON.stringify(events).includes('contract'), 'review 14.11.: the why (about the chat) stays out of the log');
  assert.ok(events.every((event) => typeof event.ms === 'number' && event.ms >= 0));
});

test('24.11.2026 (Konrad #390): while "auto" runs past the helper default a lane nobody measured is not known fast – the call runs beside the turn, never making it wait – and one measured fast waits again', async () => {
  const w = world();
  const HAIKU = 'claude:claude-haiku-5-5';
  // the router has put the helper calls on Haiku (its transition line is written by noteHelperRoute)
  noteHelperRoute(w.h.services, { agent: { id: SYSTEM_ID }, text: 'x' } as never, { modelId: HAIKU, by: 'rules', reason: 'cheap chat · strongest fit' } as never);
  assert.equal(helperAway(w.h.services), HAIKU);
  const calls: Array<Parameters<StructuredRunner>[0]> = [];
  const runner: StructuredRunner = async (call) => {
    calls.push(call);
    const structured = { ...pick('high'), hints: [] };
    return { text: JSON.stringify(structured), structured, by: HAIKU, usage: USAGE };
  };
  const impl = new SubconsciousImpl({ services: () => w.h.services, runner });
  const ask = () => impl.beforeTurn({ agent: w.ada, thread: 'main', said: SAID });
  // On the code before: a lane nobody measured always waited – the first Haiku call held the turn (and was 22 s).
  for (let i = 0; i < PROBE_TURNS - 1; i++) { await ask(); await impl.settle(); }
  assert.equal(w.stored(), undefined, 'no turn waited: nothing set its effort');
  assert.equal(calls.length, 0, 'beside the turn the call runs only when there is something to open');
  await ask(); // every PROBE_TURNS-th turn measures the lane beside the turn
  await impl.settle();
  assert.equal(calls.length, 1, 'the probe measured the lane');
  assert.equal(w.stored(), undefined, 'the probe ran beside its turn: still no effort');
  await ask(); // the lane answered under FAST_MS: the turn waits for it again
  assert.equal(w.stored()?.effort, 'high', 'a lane measured fast is waited for');
});