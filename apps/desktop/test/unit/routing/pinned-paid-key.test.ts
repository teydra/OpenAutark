// Feedback 96AFD12B / D032C4C3 (24.11.2026): a start model that only a pay-per-use key could run (allowPaidFallback off, a plan
// connected) is replaced by a stand-in – as before (B-080/D3) – but the reason now says why, and the same key marked as a
// plan's credits (a compatible subscription such as Qwen Token Plan) runs the pin itself.
// Owns: these assertions only. Never: real engines, accounts or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { T0, account, agent, mode, setup } from '../models/harness.ts';
import { Priors } from '../../../src/runtime/models/priors.ts';
import { selectCandidates } from '../../../src/runtime/accounts/candidates.ts';
import { creditsPossible } from '../../../src/shared/model/charge.ts';
import type { EngineId } from '../../../src/shared/model/providers.ts';

const QWEN = 'compatible:qwen3.8-max';
const caps = { vision: true, tools: true, structuredOutput: true };
const PRIORS = Priors.parse({
  version: 'test-pinned-paid', categories: {},
  models: [
    { match: 'gpt-6.1-sol*', name: 'GPT-6.1 Sol', tier: 'frontier', relCost: 0.3, caps, efforts: ['low', 'medium', 'high'], strengths: { chat: 0.4 } },
    { match: 'qwen3.8-max*', name: 'Qwen 3.8 Max', tier: 'frontier', relCost: 0.3, caps, efforts: ['low', 'medium', 'high'], strengths: { chat: 0.4 } },
  ],
});

async function world(credits: boolean) {
  const h = setup({ priors: PRIORS });
  h.accounts.upsert(account('acc_codex', 'codex'), false);
  h.accounts.upsert(account('acc_qwen', 'compatible', { baseUrl: 'https://token-plan.example/v1', ...(credits ? { credits: true } : {}) }), false);
  h.accounts.candidates = (engine: EngineId, model?: string) => selectCandidates(h.accounts.accounts, engine, h.clock.now(), model);
  h.engine('codex').lists.set('codex', [{ model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high'] }]);
  h.engine('compatible').lists.set('compatible', [{ model: 'qwen3.8-max', name: 'Qwen 3.8 Max', efforts: ['low', 'medium', 'high'] }]);
  await h.catalog.refresh({ force: true });
  h.addChat('ch_1', ['ag_1']);
  const pinned = agent('ag_1', { modelPolicy: { pin: QWEN, pinBy: { name: 'ag_1', at: T0, self: true } } });
  return { ...h, route: () => h.router.route({ agent: pinned, mode: mode('chat'), conversationId: 'ch_1' }) };
}

test("a start model on a pay-per-use key waits behind the plan – and the reason says that", async () => {
  const h = await world(false);
  const route = await h.route();
  assert.equal(route.by, 'fallback');
  assert.equal(route.modelId, 'codex:gpt-6.1-sol');
  assert.match(route.reason, /^pinned model unavailable \(Qwen 3\.8 Max: only a pay-per-use key runs it\)/, route.reason);
});

test('the same key marked as a plan\'s credits runs the pin itself, no stand-in', async () => {
  const h = await world(true);
  const route = await h.route();
  assert.deepEqual([route.modelId, route.by, route.accountId], [QWEN, 'pin', 'acc_qwen'], route.reason);
  assert.doesNotMatch(route.reason, /unavailable/);
});

test('an OpenAI-compatible key can hold plan credits; a keyless endpoint and a pure gateway stay as they were', () => {
  assert.equal(creditsPossible(account('a', 'compatible')), true);
  assert.equal(creditsPossible(account('a', 'compatible', { auth: 'none' })), false, 'free already');
  assert.equal(creditsPossible(account('a', 'openrouter')), false);
});
