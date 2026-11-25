// 17.11.2026 (Konrad task_bgykyzcx): a plan login this PC found is OFFERED, never an account – so never used and never
// synced to the company's other PCs – until the person says "Use" (accounts.useFound); "Not here" (accounts.declineFound)
// keeps it out; accounts that exist stay as they are. The calls are the person's own click (window or phone), never an
// agent's `wf` or a script. A plan's extra usage (Account.extraUsage, migration 104) is the person's switch: off by default,
// refused where the provider has none, and a plan that may go on past its limit is no longer held by a used-up window.
// 17.11.2026 (#109): "Use" asks where the login goes – only on this PC or on all PCs of the company; the person changes it later in the row.
// 24.11.2026 (Konrad #830, 0.3.20): they are the person's own PCs – the default of a newly used login is all PCs of the company; only "Only on this PC" keeps it here.
// Owns: these assertions only. Never: a real CLI, account or login (the account harness's scripted CLIs).

import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { settingsPatch, syncedSettings } from '../../../src/runtime/devices/sync/settings.ts';
import assert from 'node:assert/strict';
import { HandlerTable, allowedScope, secureScope, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { register as registerProviders } from '../../../src/runtime/rpc/handlers/providers.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { RpcExtras } from '../../../src/runtime/rpc/extras.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import type { Account, LimitWindow, ProviderId } from '../../../src/shared/model/providers.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { extraUsageOf } from '../../../src/shared/model/charge.ts';
import { blockedUntil, inOverage, isHealthy, selectCandidates } from '../../../src/runtime/accounts/candidates.ts';
import { DismissedLogins } from '../../../src/runtime/accounts/dismissed.ts';
import { harness, row } from './harness.ts';

const T0 = Date.UTC(2026, 10, 17, 9, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CODEX = { key: 'codex:default', provider: 'codex', where: 'this-pc' };

// ------------------------------------------------------------------ found logins are offered, not used

test('a login found on this PC is no account: nothing uses it, nothing is checked, nothing is synced – until "Use"', async () => {
  const h = harness();
  const report = await h.service.detect();
  await h.settle();
  assert.deepEqual(report.found, [CODEX], 'Codex is signed in on this PC; Claude Code is installed but signed out: not offered');
  assert.deepEqual(h.repo.list(), [], 'no row: the device sync (devices/sync/tables.ts accounts) has nothing to hand to the company\'s other PCs');
  assert.deepEqual(h.checks, [], 'no check, so no token is touched here');
  assert.deepEqual(h.service.candidates('codex'), [], 'routing has nothing to pick');
  assert.deepEqual(h.service.lastDetection()?.found, [CODEX], 'the cached report offers it too');

  const account = await h.service.useFound('codex:default');
  await h.settle();
  assert.deepEqual([account.provider, account.auth, account.enabled, account.detected], ['codex', 'cli', true, true]);
  assert.equal(account.thisPcOnly, undefined, 'the default of "Use" (0.3.20): all PCs of the company – the account and its login go to the person\'s other PCs');
  assert.deepEqual(h.checks, [account.id], 'one check, after the person\'s word');
  assert.deepEqual(h.service.lastDetection()?.found, [], 'no longer on offer');
  assert.equal((await h.service.useFound('codex:default')).id, account.id, 'a second click returns the same account');
  assert.equal(h.repo.list().length, 1, 'nothing doubled');
});

test('"Not here": the login stays out of this company, stays on the PC, and "Add again" brings it back', async () => {
  const h = harness();
  await h.service.detect();
  await h.service.declineFound('codex:default');
  assert.deepEqual(new DismissedLogins(h.db, () => 0).list(), ['codex:default']);
  const report = await h.service.detect(true);
  assert.deepEqual([report.found, report.clis.find((cli) => cli.provider === 'codex')?.dismissed], [[], true], 'not offered again; the PC row says it is not used here');
  assert.deepEqual(h.repo.list(), []);
  const restarted = harness({ db: h.db }); // the same database after a restart
  assert.deepEqual((await restarted.service.detect()).found, []);
  const again = await h.service.add({ provider: 'codex', detected: true });
  assert.equal(again.provider, 'codex');
  assert.deepEqual(new DismissedLogins(h.db, () => 0).list(), []);
});

test('"Not here" reaches another PC, survives restart and rescans, and can be undone explicitly', async (t) => {
  const dirs = ['a', 'b'].map((name) => mkdtempSync(join(tmpdir(), `autark-decline-${name}-`)));
  t.after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
  const seed = harness();
  const [a, b] = dirs.map((dataDir) => new SettingsStore({ bus: seed.bus, clock: seed.clock, dataDir }));
  const left = harness({ settings: a });
  const right = harness({ settings: b });
  const copy = (from: SettingsStore, to: SettingsStore) => to.update(settingsPatch(to.get(), JSON.parse(JSON.stringify(syncedSettings(from.get())))));
  assert.deepEqual((await right.service.detect()).found, [CODEX], 'the other PC already has a cached offer');
  await left.service.declineFound('codex:default');
  assert.deepEqual(syncedSettings(a.get())['preferences.declinedLogins'], ['codex:default']);
  assert.deepEqual(new DismissedLogins(left.db, () => 0).list(), [], 'not stored in PC-local dismissal kv');
  copy(a, b);
  assert.deepEqual(right.service.lastDetection()?.found, [], 'even a cached scan reflects the synced decision');
  const reopened = new SettingsStore({ bus: seed.bus, clock: seed.clock, dataDir: dirs[1] });
  const restarted = harness({ db: right.db, settings: reopened });
  const scan = await restarted.service.detect(true);
  assert.deepEqual([scan.found, scan.clis.find((cli) => cli.provider === 'codex')?.dismissed], [[], true]);
  assert.deepEqual(restarted.repo.list(), []);
  await restarted.service.add({ provider: 'codex', detected: true });
  copy(reopened, a);
  assert.deepEqual(left.service.lastDetection()?.found, [CODEX], 'the deliberate Add again cleared the shared dismissal');
});

test('an offer that is gone fails clearly; what is not offered cannot be used or declined', async () => {
  const h = harness();
  await h.service.detect();
  await assert.rejects(h.service.useFound('claude:default'), /not offered any more/);
  await assert.rejects(h.service.declineFound('claude:default'), /not offered any more/);
  await assert.rejects(h.service.useFound('codex:../x'), /not offered any more/);
  assert.deepEqual(h.repo.list(), []);
});

test('accounts that exist stay as they are: a detect neither offers their login nor touches them', async () => {
  const h = harness();
  h.repo.save(row('acc_mine', { provider: 'codex', auth: 'cli', detected: true, state: 'ok', enabled: false, label: 'Codex privat', priority: 7 }));
  const mine = h.repo.get('acc_mine');
  const report = await h.service.detect();
  await h.settle();
  assert.deepEqual(report.found, [], 'this PC\'s Codex login is already an account here, even a switched-off one');
  assert.deepEqual(h.repo.get('acc_mine'), mine, 'unchanged');
  assert.deepEqual(h.checks, []);
});

test('the first-run flow still adds a plan on the person\'s explicit request (accounts.add without `detected`)', async () => {
  const h = harness();
  await h.service.detect();
  const account = await h.service.add({ provider: 'codex' });
  assert.equal(account.provider, 'codex');
  await h.service.detect(true);
  await h.settle();
  assert.deepEqual(h.repo.list().map((entry) => entry.id), [account.id], 'the account the person added is the only one: the PC\'s own login is offered, not added beside it');
});

// ------------------------------------------------------------------ the person's own click

const WINDOW: ClientScope = { kind: 'owner', person: true };
const OWNER: ClientScope = { kind: 'owner' };
const AGENT_WF: ClientScope = { kind: 'owner', person: true, agentId: 'agt_felix000001' };
const MAIN: ClientScope = { kind: 'owner', main: true };
const PHONE: ClientScope = { kind: 'device', deviceId: 'dev_full00000001', capabilities: ['todo', 'chat', 'tasks', 'settings', 'manage', 'permissions'], secure: true };
const PHONE_PLAIN: ClientScope = { kind: 'device', deviceId: 'dev_lan000000001', capabilities: ['settings'] };
const MCP: ClientScope = { kind: 'agent', agentId: 'agt_felix000001', runId: 'run_1' };

function handlers() {
  const table = new HandlerTable();
  registerProviders(table);
  const log: string[] = [];
  const services = {
    accounts: {
      useFound: async (key: string, options?: { thisPcOnly?: boolean }) => { log.push(`use ${key} ${JSON.stringify(options ?? {})}`); return { id: 'acc_x' }; },
      declineFound: async (key: string) => { log.push(`decline ${key}`); },
      add: async (input: { provider: string }) => { log.push(`add ${input.provider}`); return { id: 'acc_x' }; },
      update: (id: string, patch: object) => { log.push(`update ${id} ${JSON.stringify(patch)}`); return { id }; },
    },
  } as unknown as RuntimeServices;
  async function call(method: string, params: unknown, scope: ClientScope): Promise<unknown> {
    const entry = table.get(method)!;
    if (!allowedScope(entry.scope, scope)) throw new WorkforceError('forbidden', 'Not allowed');
    const ctx: HandlerContext = { scope, services, extras: { openPage: () => {} } as unknown as RpcExtras, topics: new Set(), signal: new AbortController().signal, secure: secureScope(scope) };
    return entry.handler(params as never, ctx);
  }
  return { call, log };
}
const forbidden = (promise: Promise<unknown>) => assert.rejects(promise, (error: unknown) => error instanceof WorkforceError && error.code === 'forbidden');

test('use, decline, add again and allowing extra usage are the person\'s click: the window and the secure phone – no agent\'s wf, no script', async () => {
  const { call, log } = handlers();
  assert.deepEqual(await call('accounts.useFound', { key: 'codex:default' }, WINDOW), { id: 'acc_x' });
  assert.deepEqual(await call('accounts.declineFound', { key: 'codex:default' }, PHONE), { ok: true });
  assert.deepEqual(await call('accounts.update', { id: 'acc_x', extraUsage: true }, WINDOW), { id: 'acc_x' });
  assert.deepEqual(log, ['use codex:default {"thisPcOnly":false}', 'decline codex:default', 'update acc_x {"extraUsage":true}'], 'the default goes in: all my PCs (0.3.20)');
  log.length = 0;
  assert.deepEqual(await call('accounts.useFound', { key: 'codex:default', thisPcOnly: true }, WINDOW), { id: 'acc_x' });
  assert.deepEqual(await call('accounts.update', { id: 'acc_x', thisPcOnly: true }, PHONE), { id: 'acc_x' });
  assert.deepEqual(log, ['use codex:default {"thisPcOnly":true}', 'update acc_x {"thisPcOnly":true}'], 'only on this PC stays the person\'s explicit choice');
  log.length = 0;

  for (const scope of [OWNER, MAIN, AGENT_WF, MCP, PHONE_PLAIN]) {
    for (const [method, params] of [
      ['accounts.useFound', { key: 'codex:default' }],
      ['accounts.declineFound', { key: 'codex:default' }],
      ['accounts.update', { id: 'acc_x', extraUsage: true }],
      ['accounts.update', { id: 'acc_x', thisPcOnly: true }], // which PCs get a login: the person's choice either way
      ['accounts.update', { id: 'acc_x', thisPcOnly: false }],
      ['accounts.useFound', { key: 'codex:default', thisPcOnly: false }],
      ['accounts.add', { provider: 'codex', detected: true }],
    ] as const) await forbidden(call(method, params, scope));
  }
  assert.deepEqual(log, [], 'nothing reached the service');

  // Switching it off, and everything else a script may do today, stays open: the person's switch off is never in the way.
  assert.deepEqual(await call('accounts.update', { id: 'acc_x', extraUsage: false }, OWNER), { id: 'acc_x' });
  assert.deepEqual(await call('accounts.update', { id: 'acc_x', enabled: false }, AGENT_WF), { id: 'acc_x' });
  assert.deepEqual(await call('accounts.add', { provider: 'codex' }, WINDOW), { id: 'acc_x' });
  await assert.rejects(call('accounts.useFound', { key: 1 }, WINDOW), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request');
  await assert.rejects(call('accounts.useFound', { key: 'k', extra: true }, WINDOW), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request');
});

// ------------------------------------------------------------------ where a used login goes (#109)

test('"Use" chooses: all PCs of the company (default since 0.3.20) or only this PC; the row changes it later; only a plan login has the choice', async () => {
  const h = harness();
  await h.service.detect();
  const kept = await h.service.useFound('codex:default', { thisPcOnly: true });
  assert.equal(kept.thisPcOnly, true, 'the person chose only this PC');
  assert.equal(h.repo.get(kept.id)?.thisPcOnly, true, 'stored in its own column');
  assert.equal(h.service.update(kept.id, { thisPcOnly: false }).thisPcOnly, undefined, 'on all PCs of the company');
  assert.equal(h.service.update(kept.id, { label: 'Codex privat' }).thisPcOnly, undefined, 'another change keeps it');
  assert.equal(h.service.update(kept.id, { thisPcOnly: true }).thisPcOnly, true, 'and back to this PC');
  assert.equal(harness({ db: h.db }).service.get(kept.id)?.thisPcOnly, true, 'also after a restart');

  const shared = harness();
  await shared.service.detect();
  const all = await shared.service.useFound('codex:default'); // no choice named: 0.3.20 – the person's own PCs
  assert.equal(all.thisPcOnly, undefined, 'without a choice: all PCs of the company');
  assert.equal(shared.repo.get(all.id)?.thisPcOnly, undefined, 'stored as shared');
  const named = harness();
  await named.service.detect();
  assert.equal((await named.service.useFound('codex:default', { thisPcOnly: false })).thisPcOnly, undefined, 'the person chose all PCs of the company');

  const k = harness();
  k.repo.save(row('acc_key', { provider: 'anthropic', auth: 'api_key' }));
  assert.throws(() => k.service.update('acc_key', { thisPcOnly: true }), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request');
  k.repo.save(row('acc_old', { provider: 'claude', auth: 'cli', detected: true }));
  assert.equal(k.service.get('acc_old')?.thisPcOnly, undefined, 'an account that exists stays shared');
});

// ------------------------------------------------------------------ extra usage

const win = (name: string, usedPercent: number, resetsAt?: number): LimitWindow => ({ name, windowMinutes: name.startsWith('5h') ? 300 : 10080, usedPercent, resetsAt });
const plan = (id: string, provider: ProviderId, patch: Partial<Account> = {}): Account => ({
  id, provider, label: id, auth: 'cli', state: 'ok', priority: 0, enabled: true, detected: false, createdAt: T0, ...patch,
});
const full = (extra: boolean, provider: ProviderId = 'claude', patch: Partial<Account> = {}) => plan(`acc_${provider}_${extra ? 'extra' : 'plain'}`, provider, {
  limits: { windows: [win('5h', 100, T0 + HOUR), win('weekly', 80, T0 + 3 * DAY)], readAt: T0 }, ...(extra ? { extraUsage: true } : {}), ...patch,
});
const ids = (accounts: Account[]) => accounts.map((account) => account.id);

test('extra usage: a plan the person allowed it for is not held by a used-up window; without the switch it waits as before', () => {
  const off = full(false);
  const on = full(true);
  assert.equal(blockedUntil(off, T0), T0 + HOUR);
  assert.equal(isHealthy(off, T0), false);
  assert.equal(blockedUntil(on, T0), undefined);
  assert.equal(isHealthy(on, T0), true);
  assert.equal(inOverage(on, T0), true);
  assert.equal(inOverage(off, T0), false, 'not allowed: not in overage');
  assert.equal(inOverage(on, T0 + 2 * HOUR), false, 'the window reset: back inside the plan');
  assert.deepEqual(ids(selectCandidates([off, on], 'claude', T0)), [on.id], 'only the allowed one stays a candidate');
});

test('extra usage: cooling still holds – a turn the provider refused (extra usage not switched on there, its cap reached) waits for the reset', () => {
  const refused = full(true, 'claude', { state: 'cooling', coolingUntil: T0 + 2 * HOUR });
  assert.equal(blockedUntil(refused, T0), T0 + 2 * HOUR);
  assert.deepEqual(ids(selectCandidates([refused], 'claude', T0)), []);
  assert.deepEqual(ids(selectCandidates([refused], 'claude', T0 + 2 * HOUR)), [refused.id], 'free again at the reset');
});

test('extra usage: a plan running on it comes behind every plan with quota left, ahead of nothing it was not ahead of before', () => {
  const fresh = plan('acc_fresh', 'claude', { priority: 5, limits: { windows: [win('5h', 10, T0 + HOUR), win('weekly', 20, T0 + 6 * DAY)], readAt: T0 } });
  const over = full(true, 'claude', { priority: 0, limits: { windows: [win('5h', 10, T0 + HOUR), win('weekly', 100, T0 + DAY)], readAt: T0 } });
  assert.deepEqual(ids(selectCandidates([over, fresh], 'claude', T0)), ['acc_fresh', over.id], 'quota left first, whatever the priority and the reset');
  const sameWeek = plan('acc_inside', 'claude', { priority: 9, limits: { windows: [win('weekly', 50, T0 + 2 * DAY)], readAt: T0 } });
  assert.deepEqual(ids(selectCandidates([over, sameWeek], 'claude', T0)), ['acc_inside', over.id]);
  const inside = full(true, 'claude', { limits: { windows: [win('5h', 10, T0 + HOUR), win('weekly', 30, T0 + 2 * DAY)], readAt: T0 } });
  assert.equal(inOverage(inside, T0), false);
  assert.deepEqual(ids(selectCandidates([inside, fresh], 'claude', T0)), [inside.id, 'acc_fresh'], 'switched on but not used up: ranked like any plan (reset first)');
});

test('extra usage: only a plan login of a provider that has it – a key, a Console-key login and other plan CLIs say why not', () => {
  assert.deepEqual(extraUsageOf(plan('a', 'claude', { plan: 'max' })), { ok: true });
  assert.deepEqual(extraUsageOf(plan('a', 'codex', { plan: 'pro' })), { ok: true });
  assert.deepEqual(extraUsageOf(plan('a', 'claude')), { ok: true }, 'a plan whose tier is not read yet');
  for (const account of [plan('a', 'codex', { plan: 'api' }), plan('a', 'openai', { auth: 'api_key' }), plan('a', 'anthropic', { auth: 'env' }), plan('a', 'ollama', { auth: 'local' }), plan('a', 'gemini-cli'), plan('a', 'copilot'), plan('a', 'kimi-cli')]) {
    const can = extraUsageOf(account);
    assert.equal(can.ok, false, `${account.provider} ${account.auth} ${account.plan ?? ''}`);
    if (!can.ok) assert.match(can.why, /.{30,}/, 'the switch shows a reason');
  }
  // routing never lets a key ride on the flag, even one that got it some other way
  const key = plan('acc_key', 'anthropic', { auth: 'api_key', extraUsage: true, limits: { windows: [win('weekly', 100, T0 + DAY)], readAt: T0 } });
  assert.equal(inOverage(key, T0), false);
  assert.equal(blockedUntil(key, T0), T0 + DAY, 'a key\'s used-up window is not a plan\'s');
});

test('extra usage: off by default, set and cleared through the service, stored in its own column, refused where there is none', async () => {
  const h = harness();
  h.repo.save(row('acc_claude', { provider: 'claude', auth: 'cli', plan: 'max' }));
  h.repo.save(row('acc_key', { provider: 'anthropic', auth: 'api_key' }));
  h.repo.save(row('acc_gem', { provider: 'gemini-cli', auth: 'cli' }));
  assert.equal(h.service.get('acc_claude')?.extraUsage, undefined, 'a new account has it off');

  assert.equal(h.service.update('acc_claude', { extraUsage: true }).extraUsage, true);
  assert.equal(new (h.repo.constructor as new (db: unknown) => typeof h.repo)(h.db).get('acc_claude')?.extraUsage, true, 'the column holds it');
  const restarted = harness({ db: h.db });
  assert.equal(restarted.service.get('acc_claude')?.extraUsage, true, 'also after a restart');
  assert.equal(h.service.update('acc_claude', { label: 'Claude privat' }).extraUsage, true, 'another change keeps it');
  assert.equal(h.service.update('acc_claude', { extraUsage: false }).extraUsage, undefined);

  for (const id of ['acc_key', 'acc_gem']) {
    assert.throws(() => h.service.update(id, { extraUsage: true }), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request' && error.message.length > 30);
    assert.equal(h.service.get(id)?.extraUsage, undefined, 'nothing stored');
  }
  assert.equal(h.service.update('acc_key', { extraUsage: false }).extraUsage, undefined, 'switching it off is always fine');
});
