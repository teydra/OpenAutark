// 25.11.2026 (task_3jyxzgfq, Stanislaus 24.11.: "wenn ich einen Plan deaktiviere, zum Beispiel Codex, geht es manchmal nicht mehr
// weiter – es soll automatisch umschalten"): the router never picks a switched-off account (routing/disabled-plan.test.ts), but a turn
// that already runs on the plan – or waits on it for a limit or a lost connection – heard nothing: it ended at the stall cut
// 10 minutes later (45 with a tool running). Now the attempt is cut the moment its account is switched off (agents/turn-attempt.ts,
// stall-watch.ts cutSwitchedOff), fails over to another account like any account failure (agents/turn.ts), the switched-off account is
// not cooled (accounts/failure.ts) and the log says once that the turn moved. Real AccountService, a router stub that asks it for
// candidates the way the real router does (turn-failover-chain.test.ts).
// Owns: these assertions only. Never: real engines, accounts, timers or sleeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { AccountServiceImpl, type AccountServiceDeps } from '../../../src/runtime/accounts/service.ts';
import { AccountRepo } from '../../../src/runtime/accounts/repo.ts';
import type { RouteRequest } from '../../../src/runtime/contracts.ts';
import type { EngineTurnInput, EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { account } from '../models/harness.ts';
import { setup, type Script } from './fixture.ts';

const SOL = 'gpt-6.1-sol';
const OPUS = 'claude-opus-5-5';

function world() {
  const h = setup();
  const unused = () => { throw new Error('not used in this test'); };
  const service = new AccountServiceImpl({
    db: h.db, bus: h.bus, clock: h.clock, paths: { accounts: 'accounts' }, engines: unused,
    finder: {} as AccountServiceDeps['finder'], supervisor: {} as AccountServiceDeps['supervisor'], secrets: {} as AccountServiceDeps['secrets'],
  });
  const now = h.clock.now();
  const repo = new AccountRepo(h.db);
  repo.save(account('acc_codex', 'codex', { label: 'Codex', priority: 0, createdAt: now }));
  repo.save(account('acc_claude', 'claude', { label: 'Claude Code', priority: 1, createdAt: now + 1 }));
  const calls: string[] = [];
  const scripts: Record<string, Script> = {};
  h.state.script = (input) => { calls.push(input.account.id); return (scripts[input.account.id] ?? (async () => ({ text: 'Done.', stop: 'done' })))(input); };
  const logged: Array<{ message: string; data: Record<string, unknown> }> = [];
  const log = h.services.log as unknown as { info: (message: string, data?: Record<string, unknown>) => void };
  const info = log.info.bind(log);
  log.info = (message, data) => { logged.push({ message, data: data ?? {} }); info(message, data); };
  Object.assign(h.services, {
    accounts: service,
    router: {
      route: async (request: RouteRequest) => {
        const codex = service.candidates('codex', SOL).map((item) => ({ item, modelId: `codex:${SOL}` }));
        const claude = service.candidates('claude', OPUS).map((item) => ({ item, modelId: `claude:${OPUS}` }));
        const pick = [...codex, ...claude].find(({ item }) => !request.exclude?.includes(item.id));
        if (!pick) throw new WorkforceError('unavailable', 'Every account that can run a suitable model is limited right now.');
        return { ...h.route, modelId: pick.modelId, accountId: pick.item.id };
      },
    },
  });
  const run = (runId: string) => new TurnExecutor(() => h.services).execute(h.request({ runId }));
  const failovers = () => h.items.filter((item) => item.kind === 'note' && (item.data as { failover?: unknown }).failover)
    .map((item) => (item.data as { failover: { fromAccount: string; toAccount: string; reason: string; switchedOff?: boolean } }).failover);
  return { ...h, service, calls, scripts, run, failovers, logged };
}

/** An engine turn that waits on its plan until it is cut (a limit retry, a lost connection) – the way the real engines answer an abort. */
const waitsUntilCut: Script = (input: EngineTurnInput) => new Promise<EngineTurnResult>((resolve) => {
  input.signal.addEventListener('abort', () => resolve({ text: '', stop: 'interrupted' }), { once: true });
});

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(check(), what);
}

/** The turn must end by itself; a hang is the failure this file is about. */
async function ends<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: the turn is still waiting on the switched-off plan`)), 3000); });
  try { return await Promise.race([promise, stuck]); } finally { clearTimeout(timer); }
}

test('Codex is switched off while a turn runs on it: the turn goes on the other plan at once, and the next turns start there', async () => {
  const w = world();
  w.scripts.acc_codex = waitsUntilCut;
  const first = w.run('run_1');
  await until(() => w.calls.includes('acc_codex'), 'the first turn runs on Codex');

  w.service.update('acc_codex', { enabled: false }); // the person's switch

  const outcome = await ends(first, 'turn 1');
  assert.equal(outcome.status, 'done');
  assert.deepEqual(w.calls, ['acc_codex', 'acc_claude'], 'the same turn went on to Claude Code');
  assert.deepEqual(w.failovers().map((item) => [item.fromAccount, item.toAccount, item.reason, item.switchedOff]), [['acc_codex', 'acc_claude', 'unavailable', true]]);
  const codex = w.service.get('acc_codex')!;
  assert.deepEqual([codex.enabled, codex.state, codex.coolingUntil], [false, 'disabled', undefined], 'switched off stays switched off: no cooling is written over it');
  const moved = w.logged.filter((entry) => entry.message === 'plan switched off – the turn goes on another account');
  assert.equal(moved.length, 1, 'once in the log');
  assert.deepEqual([moved[0].data.fromAccount, moved[0].data.toAccount, moved[0].data.pinned], ['acc_codex', 'acc_claude', false]);

  // several more turns: none stops, none asks the switched-off plan
  for (const runId of ['run_2', 'run_3', 'run_4']) assert.equal((await ends(w.run(runId), runId)).status, 'done');
  assert.deepEqual(w.calls, ['acc_codex', 'acc_claude', 'acc_claude', 'acc_claude', 'acc_claude']);
  assert.equal(w.failovers().length, 1, 'no further failover');
});

test('a plan switched off between the route and the start: the attempt does not wait on it', async () => {
  const w = world();
  w.scripts.acc_codex = waitsUntilCut;
  w.service.update('acc_codex', { enabled: false });
  // a router that still names it (a route made a moment earlier)
  const route = (w.services.router as { route: (request: RouteRequest) => Promise<unknown> }).route;
  let first = true;
  (w.services.router as { route: unknown }).route = async (request: RouteRequest) => {
    if (first) { first = false; return { ...w.route, modelId: `codex:${SOL}`, accountId: 'acc_codex' }; }
    return route(request);
  };
  const outcome = await ends(w.run('run_1'), 'turn 1');
  assert.equal(outcome.status, 'done');
  assert.deepEqual(w.calls, ['acc_claude'], 'the stale route never starts its engine');
  assert.deepEqual(w.failovers().map((item) => [item.fromAccount, item.toAccount, item.switchedOff]), [['acc_codex', 'acc_claude', true]]);
});

test('the only plan is switched off: the turn ends as a visible outage and new work starts when a plan is back', async () => {
  const w = world();
  w.service.update('acc_claude', { enabled: false });
  w.scripts.acc_codex = waitsUntilCut;
  const first = w.run('run_1');
  await until(() => w.calls.includes('acc_codex'), 'the turn runs on Codex');
  w.service.update('acc_codex', { enabled: false });
  const outcome = await ends(first, 'turn 1');
  assert.deepEqual(w.calls, ['acc_codex'], 'nothing else can run it');
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error, 'The account was switched off.');
  assert.ok(w.chats.messages(w.chat.id).some((message) => message.meta.status?.text.includes('The account was switched off.')), 'the chat says why it stopped');
  w.service.update('acc_claude', { enabled: true });
  assert.equal((await ends(w.run('run_2'), 'turn 2')).status, 'done');
});
