// B-080 – Codex engine (engines/codex/engine.ts, turn.ts): setModel sends turn/settings/update for the running turn
// (its thread and turn id, the nearest effort the model lists) and is true only when Codex answers 'applied' – then the
// turn's events say so; 'targetUnavailable', a refusal or a turn not started yet is false. A new agent thread is
// announced after thread/start ('session'); a resumed one is not.
// Owns: these assertions only. Never: a real Codex binary.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { account, fakeFinder, fakeSpawn, testSupervisor, tick, turnInput, type FakeChild } from './fakes.ts';

function appServer(settings: (params: any) => { result?: unknown; error?: unknown }) {
  const state = { requests: [] as any[], turn: Promise.withResolvers<() => void>() };
  const { spawn } = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (msg.method) state.requests.push(msg);
      if (msg.id === undefined || !msg.method) return;
      const answer = (body: Record<string, unknown>) => child.send({ id: msg.id, ...body });
      switch (msg.method) {
        case 'initialize': answer({ result: { userAgent: 'fake' } }); break;
        case 'thread/start': answer({ result: { thread: { id: 'thr_1' } } }); break;
        case 'thread/resume': answer({ result: { thread: { id: msg.params.threadId } } }); break;
        case 'model/list': answer({ result: { data: [{ model: 'gpt-x', displayName: 'GPT X', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'xhigh' }] }], nextCursor: null } }); break;
        case 'turn/start':
          answer({ result: { turn: { id: 'turn_1', status: 'inProgress' } } });
          state.turn.resolve(() => complete(child, msg.params.threadId));
          break;
        case 'turn/settings/update': answer(settings(msg.params)); break;
        default: answer({ error: { code: -32601, message: 'nope' } });
      }
    };
  });
  return { spawn, state };
}

const complete = (child: FakeChild, threadId: string) => child.send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn_1', status: 'completed' } } });
const engine = (spawn: any) => new CodexEngine({ supervisor: testSupervisor(spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/tmp', version: '0.2.0' });

/** Wait for the actual RPC, not a number of event-loop turns (startup also does real file I/O). */
function untilTurn(state: { turn: { promise: Promise<() => void> } }, running: ReturnType<CodexEngine['run']>) {
  return Promise.race([
    state.turn.promise,
    running.then((result) => assert.fail(`Codex ended before turn/start: ${JSON.stringify(result)}`)),
  ]);
}

test('codex: setModel switches the running turn through turn/settings/update – true only when applied', { timeout: 10_000 }, async () => {
  const statuses = ['applied', 'targetUnavailable'];
  const fake = appServer(() => ({ result: { status: statuses.shift() } }));
  const e = engine(fake.spawn);
  await e.listModels(account()); // the model's efforts (model/list)
  const { input, events } = turnInput({ model: 'gpt-x', effort: 'medium' });
  assert.equal(await e.setModel('run_1', 'gpt-x', 'high'), false, 'no turn runs yet');
  const running = e.run(input);
  const finish = await untilTurn(fake.state, running);
  await tick();
  assert.equal(await e.setModel('run_1', 'gpt-x', 'high'), true);
  const update = fake.state.requests.find((r) => r.method === 'turn/settings/update');
  assert.deepEqual(update.params, { threadId: 'thr_1', turnId: 'turn_1', model: 'gpt-x', effort: 'medium' }, 'the nearest effort the model lists');
  assert.deepEqual(events.filter((event: any) => event.type === 'model'), [{ type: 'model', model: 'gpt-x', effort: 'high' }]);
  assert.equal(await e.setModel('run_1', 'gpt-x', 'xhigh'), false, "'targetUnavailable' is no switch");
  assert.equal(events.filter((event: any) => event.type === 'model').length, 1);
  finish();
  assert.equal((await running).stop, 'done');
  await e.dispose();
});

test('codex: a refused turn/settings/update is false', { timeout: 10_000 }, async () => {
  const fake = appServer(() => ({ error: { code: -32600, message: 'unsupported field' } }));
  const e = engine(fake.spawn);
  const { input, events } = turnInput({ model: 'gpt-x' });
  const running = e.run(input);
  const finish = await untilTurn(fake.state, running);
  await tick();
  assert.equal(await e.setModel('run_1', 'gpt-y', 'medium'), false);
  assert.equal(events.some((event: any) => event.type === 'model'), false);
  finish();
  await running;
  await e.dispose();
});

test('codex: a new agent thread is announced after thread/start; a resumed one is not', { timeout: 10_000 }, async (t) => {
  const fake = appServer(() => ({ result: { status: 'applied' } }));
  const e = engine(fake.spawn);
  t.after(() => e.dispose());
  const fresh = turnInput();
  const first = e.run(fresh.input);
  const finishFirst = await untilTurn(fake.state, first);
  assert.deepEqual(fresh.events.filter((event: any) => event.type === 'session'), [{ type: 'session', ref: 'thr_1', generation: 1 }]);
  finishFirst();
  assert.equal((await first).stop, 'done');
  fake.state.turn = Promise.withResolvers<() => void>();
  const resumed = turnInput({ session: { ref: 'thr_1', generation: 1 } });
  const second = e.run(resumed.input);
  const finishSecond = await untilTurn(fake.state, second);
  finishSecond();
  assert.equal((await second).stop, 'done');
  assert.equal(resumed.events.some((event: any) => event.type === 'session'), false);
});
