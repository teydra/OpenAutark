// A disabled account is excluded even while the model catalog is stale. A pin may use a stand-in, but the reason must be visible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeLine } from '../../../src/runtime/agents/route-line.ts';
import { account, agent, mode, setup } from '../models/harness.ts';
import { Priors } from '../../../src/runtime/models/priors.ts';
import type { Effort } from '../../../src/shared/model/providers.ts';

const ALL: Effort[] = ['low', 'medium', 'high', 'xhigh'];
const caps = { vision: true, tools: true, structuredOutput: true };
const PRIORS = Priors.parse({
  version: 'test-disabled', categories: {},
  models: [
    { match: 'claude-opus-5-5*', name: 'Claude Opus 5.5', tier: 'frontier', relCost: 0.6, smarts: 94, caps, efforts: ALL, strengths: { chat: 0.4 } },
    { match: 'gpt-6.1-sol*', name: 'GPT-6.1 Sol', tier: 'frontier', relCost: 0.3, smarts: 93, caps, efforts: ALL, strengths: { chat: 0.4 } },
  ],
});

async function world() {
  const h = setup({ priors: PRIORS });
  h.accounts.upsert(account('acc_codex', 'codex'), false);
  h.accounts.upsert(account('acc_claude', 'claude'), false);
  h.engine('codex').lists.set('codex', [{ model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ALL, vision: true }]);
  h.engine('claude').lists.set('claude', [{ model: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ALL, vision: true }]);
  await h.catalog.refresh({ force: true });
  return h;
}
const off = (h: Awaited<ReturnType<typeof world>>) => h.accounts.upsert(account('acc_codex', 'codex', { enabled: false, state: 'disabled' }), false);

test('a disabled Codex plan cannot start a turn, even if the catalog still lists its models', async () => {
  const h = await world();
  off(h);
  h.settings.update({ routing: { work: 'codex' } });
  const route = await h.router.route({ agent: agent('ag_2'), mode: mode('chat') });
  assert.equal(route.accountId, 'acc_claude');
});

test('a disabled start model gets a visible stand-in, also on the first turn', async () => {
  const h = await world();
  const modelId = 'codex:gpt-6.1-sol';
  const pinned = agent('ag_1', { modelPolicy: { pin: modelId } });
  off(h);
  for (const previous of [undefined, { modelId, effort: 'high' as const }]) {
    const decision = await h.router.route({ agent: pinned, mode: mode('chat'), ...(previous ? { previous, boundary: false } : {}) });
    assert.equal(decision.accountId, 'acc_claude');
    assert.equal(decision.by, 'fallback');
    assert.match(decision.reason, /pinned model unavailable/);
    const line = routeLine(decision, 'Claude Opus 5.5', previous, { agent: 'Sam' });
    assert.match(line?.text ?? '', /Claude Opus 5.5.*(?:pinned model unavailable|cannot run now)/);
  }
  assert.equal(pinned.modelPolicy?.pin, modelId);
  h.accounts.upsert(account('acc_codex', 'codex'), false);
  const recovered = await h.router.route({ agent: pinned, mode: mode('chat') });
  assert.equal(recovered.accountId, 'acc_codex');
});
