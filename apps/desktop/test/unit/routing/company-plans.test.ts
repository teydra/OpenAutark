// Konrad 27.11.2026 (ORENDA): a company agent moved to an employee's PC runs there only on the plans its company shares with
// that PC (routing/company-plans.ts) – never on the person's own plan; with none here its turn fails with a visible reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { account, agent, mode, setup } from '../models/harness.ts';
import { Priors } from '../../../src/runtime/models/priors.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { Effort } from '../../../src/shared/model/providers.ts';

const ALL: Effort[] = ['low', 'medium', 'high', 'xhigh'];
const caps = { vision: true, tools: true, structuredOutput: true };
const PRIORS = Priors.parse({
  version: 'test-company-plans', categories: {},
  models: [
    { match: 'claude-opus-5-5*', name: 'Claude Opus 5.5', tier: 'frontier', relCost: 0.6, smarts: 94, caps, efforts: ALL, strengths: { chat: 0.4 } },
    { match: 'gpt-6.1-sol*', name: 'GPT-6.1 Sol', tier: 'frontier', relCost: 0.3, smarts: 93, caps, efforts: ALL, strengths: { chat: 0.4 } },
  ],
});
const COMPANY_PC = 'dev_company';

/** An employee's PC: the person's own Codex plan (their Work model) and, when `shared`, the company's Claude plan. */
async function world(shared = true) {
  const h = setup({ priors: PRIORS });
  const kv = new KvRepo(h.db);
  h.accounts.upsert(account('acc_own_codex', 'codex'), false);
  if (shared) {
    h.accounts.upsert(account('acc_company_claude', 'claude'), false);
    kv.set('sync.origin', 'accounts/acc_company_claude', COMPANY_PC, 1); // the row came from the employer (devices/sync/employee.ts planFrom)
  }
  kv.set('sync.origin', 'agents/ag_company', COMPANY_PC, 1); // the company's agent, moved here (fromEmployer)
  h.engine('codex').lists.set('codex', [{ model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ALL, vision: true }]);
  h.engine('claude').lists.set('claude', [{ model: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ALL, vision: true }]);
  await h.catalog.refresh({ force: true });
  h.settings.update({ routing: { work: 'codex' } }); // the person's Work model runs on their own plan
  return h;
}

test("a company agent on an employee's PC runs on the company's plan, never on the person's own", async () => {
  const h = await world();
  const company = await h.router.route({ agent: agent('ag_company'), mode: mode('chat') });
  assert.equal(company.accountId, 'acc_company_claude');
  const own = await h.router.route({ agent: agent('ag_own'), mode: mode('chat') });
  assert.equal(own.accountId, 'acc_own_codex'); // the person's agent: unchanged
  // a failover inside the turn stays on the company's plans too
  await assert.rejects(h.router.route({ agent: agent('ag_company'), mode: mode('chat'), exclude: ['acc_company_claude'] }), WorkforceError);
});

test("without a company plan here a company agent's turn does not start, and says why", async () => {
  const h = await world(false);
  await assert.rejects(h.router.route({ agent: agent('ag_company', { name: 'Mara' }), mode: mode('chat') }), (error: unknown) => {
    assert.ok(error instanceof WorkforceError);
    assert.equal(error.code, 'unavailable');
    assert.match(error.message, /^Mara works for the company and runs here only on plans the company shares with this PC/);
    assert.equal((error.details as { setup?: boolean } | undefined)?.setup, true);
    return true;
  });
  const own = await h.router.route({ agent: agent('ag_own'), mode: mode('chat') });
  assert.equal(own.accountId, 'acc_own_codex');
});

test("a company plan switched off here counts as none", async () => {
  const h = await world();
  h.accounts.upsert(account('acc_company_claude', 'claude', { enabled: false, state: 'disabled' }), false);
  await assert.rejects(h.router.route({ agent: agent('ag_company'), mode: mode('chat') }), /works for the company/);
});
