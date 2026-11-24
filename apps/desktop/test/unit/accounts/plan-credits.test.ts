// B-083 plan credits: an API key whose organisation holds a plan's monthly API credits (Account.credits) is charged
// like a plan by the one charge rule (shared/model/charge.ts accountCharge – booking, routing and the UI), routing
// uses it like a plan whose headroom is unknown (score.ts costFactor, pool.ts: no spill-over; candidates.ts lists it before
// paying keys), the providers' "credit
// used up" answers cool the account for a day (engines/http/common.ts), and the flag is stored and set through
// accounts.update's service path (repo column, migration 095).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountCharge, creditsPossible } from '../../../src/shared/model/charge.ts';
import { costFactor, isPaid, scoreModel, UNKNOWN_HEADROOM } from '../../../src/runtime/routing/score.ts';
import { buildPool } from '../../../src/runtime/routing/pool.ts';
import { selectCandidates } from '../../../src/runtime/accounts/candidates.ts';
import { recordAccountFailure } from '../../../src/runtime/accounts/failure.ts';
import { CREDIT_COOLDOWN_MS, CREDIT_EXHAUSTED_COOLDOWN_MS, HttpEngineError, creditError, postJson, statusError, turnError } from '../../../src/runtime/engines/http/common.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { Account, EngineId, ModelInfo, ProviderId } from '../../../src/shared/model/providers.ts';
import { harness, row } from './harness.ts';

const NOW = Date.UTC(2026, 10, 8, 18, 0, 0);
const DAY = 24 * 60 * 60_000;

function account(id: string, provider: ProviderId, patch: Partial<Account> = {}): Account {
  return {
    id, provider, label: id, auth: provider === 'codex' || provider === 'claude' ? 'cli' : provider === 'ollama' ? 'local' : 'api_key',
    state: 'ok', priority: 0, enabled: true, detected: false, createdAt: NOW, ...patch,
  };
}

function model(provider: ProviderId, id: string, engine: EngineId, accounts: string[], patch: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: `${provider}:${id}`, provider, model: id, name: id, engine, efforts: ['medium'], caps: {}, tier: 'frontier',
    relCost: 0.6, strengths: { coding: 0.5 }, available: true, accounts, ...patch,
  };
}

test('charge: both rules agree; plan credits turn a paid key or a Console login into a plan, nothing else changes', () => {
  const cases: Array<[Account, string]> = [
    [account('a', 'anthropic'), 'paid'],
    [account('a', 'anthropic', { credits: true }), 'plan'],
    [account('a', 'openai', { auth: 'env', credits: true }), 'plan'],
    [account('a', 'claude', { plan: 'api' }), 'paid'],
    [account('a', 'claude', { plan: 'api', credits: true }), 'plan'],
    [account('a', 'claude', { plan: 'max' }), 'plan'],
    [account('a', 'claude', { plan: 'max', credits: true }), 'plan'],
    [account('a', 'codex', { plan: 'api' }), 'paid'],
    [account('a', 'ollama', { credits: true }), 'free'],
    [account('a', 'compatible', { auth: 'none', credits: true }), 'free'],
    [account('a', 'openrouter'), 'paid'],
  ];
  for (const [item, want] of cases) {
    assert.equal(accountCharge(item), want, `${item.provider} ${item.auth} ${item.plan ?? ''} credits=${item.credits}`);
  }
});

test('charge: only pay-per-use accounts of providers whose plans include API credits can hold them – also while switched on', () => {
  assert.equal(creditsPossible(account('a', 'anthropic')), true);
  assert.equal(creditsPossible(account('a', 'anthropic', { credits: true })), true, 'the switch stays to switch it off again');
  assert.equal(creditsPossible(account('a', 'openai', { auth: 'env' })), true);
  assert.equal(creditsPossible(account('a', 'claude', { plan: 'api' })), false,
    'Claude Code with a Console key: its engine reports used-up credits as a plain failure, so the login would never cool');
  assert.equal(creditsPossible(account('a', 'claude', { plan: 'max' })), false, 'a plan login is a plan already');
  assert.equal(creditsPossible(account('a', 'codex', { plan: 'api' })), false, 'Codex with a key spends no plan credits');
  assert.equal(creditsPossible(account('a', 'openrouter')), false);
  assert.equal(creditsPossible(account('a', 'ollama')), false);
});

test('score: a key with plan credits is no spill-over and costs like a plan whose headroom is unknown', () => {
  const key = account('acc_key', 'anthropic');
  const credits = { ...key, credits: true };
  assert.deepEqual([isPaid(key), costFactor(key, NOW)], [true, 1]);
  assert.deepEqual([isPaid(credits), costFactor(credits, NOW, 'claude-opus-5-5')], [false, UNKNOWN_HEADROOM]);
  const login = account('acc_console', 'claude', { plan: 'api', credits: true });
  assert.equal(costFactor(login, NOW), UNKNOWN_HEADROOM, 'a Console login with credits too, whatever its windows say');
  const unknownPlan = account('acc_plan', 'claude', { plan: 'max' });
  assert.equal(costFactor(credits, NOW), costFactor(unknownPlan, NOW), 'the same as a plan without limit data');
  const opus = model('anthropic', 'claude-opus-5-5', 'anthropic', ['acc_key']);
  const score = (on: Account) => scoreModel({ model: opus, account: on, category: 'coding', costMode: 'balanced', preferred: false, now: NOW });
  assert.ok(score(credits) > score(key), 'the credits are cheaper at the margin than paying per token');
});

test('pool: the credits key competes like a plan; a plain key of the same provider stays the spill-over', () => {
  const credits = account('acc_credits', 'anthropic', { credits: true });
  const plain = account('acc_plain', 'anthropic', { priority: -1 });
  const plan = account('acc_codex', 'codex', { plan: 'pro' });
  const models = [model('anthropic', 'claude-opus-5-5', 'anthropic', []), model('codex', 'gpt-6.1-sol', 'codex', [])];
  const services = (accounts: Account[], allowPaidFallback = false) => ({
    settings: { get: () => ({ routing: { allowPaidFallback } }) },
    accounts: { candidates: (engine: EngineId, name?: string) => selectCandidates(accounts, engine, NOW, name) },
    engines: { get: () => ({ caps: { structured: true } }) },
  }) as unknown as RuntimeServices;
  const pool = (accounts: Account[], allowPaidFallback = false) => buildPool({
    s: services(accounts, allowPaidFallback), models, category: 'coding', policy: { avoid: [] },
  }).entries.map((entry) => `${entry.model.id}@${entry.accounts.map((item) => item.id).join('+')}`);

  assert.deepEqual(pool([plan, plain]), ['codex:gpt-6.1-sol@acc_codex'], 'without credits the key waits behind the plan');
  assert.deepEqual(pool([plan, plain, credits]), ['anthropic:claude-opus-5-5@acc_credits', 'codex:gpt-6.1-sol@acc_codex'],
    'with credits the key stands next to the plan; the plain key stays out although it comes first by priority');
  assert.deepEqual(pool([plain, credits]), ['anthropic:claude-opus-5-5@acc_credits'], 'the credits are spent before a paying key');
  assert.deepEqual(pool([plain, credits], true), ['anthropic:claude-opus-5-5@acc_credits+acc_plain'],
    'paying keys allowed in Settings: the credits still come first although the plain key has the better priority');
  const cooling = { ...credits, state: 'cooling' as const, coolingUntil: NOW + DAY };
  assert.deepEqual(pool([plan, plain, cooling]), ['codex:gpt-6.1-sol@acc_codex'], 'used up: the plan carries on, the key still waits');
  assert.deepEqual(pool([plain, cooling]), ['anthropic:claude-opus-5-5@acc_plain'], 'nothing else left: the paying key is the spill-over');
});

test('candidates: accounts that pay per use come behind plans, plan credits and free ones, whatever their priority', () => {
  const ids = (list: Account[]) => list.map((item) => item.id);
  const plain = account('acc_plain', 'anthropic', { priority: -1 });
  const credits = account('acc_credits', 'anthropic', { credits: true, priority: 3 });
  assert.deepEqual(ids(selectCandidates([plain, credits], 'anthropic', NOW)), ['acc_credits', 'acc_plain']);
  assert.deepEqual(ids(selectCandidates([plain, { ...credits, credits: false }], 'anthropic', NOW)), ['acc_plain', 'acc_credits'],
    'two paying keys: the priority decides as before');
  const apiLogin = account('acc_console', 'claude', { plan: 'api' });
  const max = account('acc_max', 'claude', { plan: 'max', priority: 1 });
  assert.deepEqual(ids(selectCandidates([apiLogin, max], 'claude', NOW)), ['acc_max', 'acc_console'],
    'a Console login pays per use: the subscription goes first');
});

const fetchOf = (status: number, body: string, headers: Record<string, string> = {}) => async () => new Response(body, { status, headers });
const refused = (status: number, body: string, headers?: Record<string, string>) =>
  postJson(fetchOf(status, body, headers), 'http://x/v1/messages', {}, {}, new AbortController().signal).then(
    () => assert.fail('the request was refused'),
    (error: unknown) => { assert.ok(error instanceof HttpEngineError); return error.data; },
  );

test('errors: the providers\' "credit used up" answers are a limit with a day of cooling; other refusals stay as they were', async () => {
  const anthropic = await refused(400, '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}');
  assert.deepEqual(anthropic, creditError());
  assert.deepEqual([anthropic.code, anthropic.retryAfterMs], ['rate_limited', CREDIT_EXHAUSTED_COOLDOWN_MS]);
  assert.equal(CREDIT_EXHAUSTED_COOLDOWN_MS, DAY);
  assert.ok(!/Plans & Billing|invalid_request/.test(anthropic.message), 'the provider\'s body never reaches the error');

  const quota = await refused(429, '{"error":{"message":"You exceeded your current quota.","type":"insufficient_quota","code":"insufficient_quota"}}', { 'retry-after': '3' });
  assert.deepEqual([quota.code, quota.retryAfterMs], ['rate_limited', DAY], 'a Retry-After of seconds does not shorten the day');
  const exhausted = await refused(429, '{"error":{"code":"credit_balance_exhausted","message":"Credit balance exhausted"}}');
  assert.deepEqual([exhausted.code, exhausted.retryAfterMs], ['rate_limited', DAY]);

  const busy = await refused(429, '{"error":{"code":"rate_limit_exceeded"}}', { 'retry-after': '3' });
  assert.deepEqual([busy.code, busy.retryAfterMs], ['rate_limited', 3000], 'a plain rate limit keeps its hint');
  assert.deepEqual(await refused(400, '{"error":{"message":"max_tokens: too large"}}'), statusError(400));
  // only the providers' fields count: a body echoing the words (a request about this very code, an upstream text) stays a 400
  assert.deepEqual(await refused(400, '{"error":{"message":"invalid content: Your credit balance is too low, insufficient_quota"}}'), statusError(400));
  assert.deepEqual(await refused(400, '{"error":{"message":"bad input {\\"code\\":\\"insufficient_quota\\"}"}}'), statusError(400));
  const echoed = await refused(429, '{"error":{"code":"rate_limit_exceeded","message":"retry: \\"credit_balance_exhausted\\""}}', { 'retry-after': '3' });
  assert.deepEqual([echoed.code, echoed.retryAfterMs], ['rate_limited', 3000]);
  assert.deepEqual(await refused(402, ''), statusError(402));
  assert.equal(statusError(402).retryAfterMs, CREDIT_COOLDOWN_MS, 'B-079\'s 402 stays as it was');
  assert.equal(turnError(new HttpEngineError(anthropic), new AbortController().signal).stop, 'limit');
});

test('errors: a used-up credit puts the account into cooling for a day', () => {
  const key = account('acc_credits', 'anthropic', { credits: true });
  const marked: Array<[string, number]> = [];
  const accounts = { get: () => key, markLimited: (id: string, until: number) => { marked.push([id, until]); }, markUnavailable: () => false };
  const result = { stop: 'limit', error: creditError() } as unknown as EngineTurnResult;
  assert.equal(recordAccountFailure({ accounts, clock: { now: () => NOW } } as never, key, 'claude-opus-5-5', result), 'limit');
  assert.deepEqual(marked, [['acc_credits', NOW + DAY]]);
});

test('store: accounts.update\'s service path sets and clears the flag; the row keeps it (migration 095)', () => {
  const h = harness();
  h.repo.save(row('acc_key', { provider: 'anthropic', auth: 'api_key' }));
  assert.equal('credits' in h.service.get('acc_key')!, false, 'off: no field at all');
  assert.equal(h.service.update('acc_key', { credits: true }).credits, true);
  assert.equal(h.repo.get('acc_key')?.credits, true, 'stored in the table');
  assert.equal(h.service.update('acc_key', { label: 'Console' }).credits, true, 'another change keeps it');
  assert.equal(accountCharge(h.service.get('acc_key')), 'plan');
  h.service.update('acc_key', { credits: false });
  assert.equal('credits' in h.repo.get('acc_key')!, false);
  assert.equal(accountCharge(h.service.get('acc_key')), 'paid');
});

test('store: a mark on an account without plan credits is refused, so real pay-per-use spend is never booked as plan', () => {
  const h = harness();
  h.repo.save(row('acc_router', { provider: 'openrouter', auth: 'api_key' }));
  h.repo.save(row('acc_console', { provider: 'claude', auth: 'cli', plan: 'api' }));
  h.repo.save(row('acc_codex', { provider: 'codex', auth: 'cli', plan: 'api' }));
  for (const id of ['acc_router', 'acc_console', 'acc_codex']) {
    assert.throws(() => h.service.update(id, { credits: true }), (error: { code?: string }) => error.code === 'bad_request', id);
    assert.equal('credits' in h.repo.get(id)!, false);
    assert.equal(h.service.update(id, { credits: false }).enabled, true, 'switching off always passes');
  }
  assert.equal(accountCharge(h.service.get('acc_router')), 'paid');
});

test('store: a subscription key of an OpenAI-compatible endpoint (Qwen Token Plan) can be marked as a plan – feedback D032C4C3', () => {
  const h = harness();
  h.repo.save(row('acc_qwen', { provider: 'compatible', auth: 'api_key' }));
  assert.equal(accountCharge(h.service.get('acc_qwen')), 'paid', 'unmarked: pay per use, as before');
  assert.equal(h.service.update('acc_qwen', { credits: true }).credits, true);
  assert.equal(accountCharge(h.service.get('acc_qwen')), 'plan');
});
