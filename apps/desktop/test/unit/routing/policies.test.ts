// Model policies: get/set round trips for the global, agent and chat+agent scopes, validation (B-083: pinBy),
// the chat suggestion (B-083: modelHints, temperature), the PolicyApi factory, and keyword category inference (RT8:
// cutting, podcasts, subtitles; B-080: a tie names no kind; B-083 D6: a medium word is one hint).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, setup } from '../models/harness.ts';
import { clearNextModel, pendingRoute } from '../../../src/runtime/agents/next-route.ts';
import { chatChoice, cleanPolicy, createPolicyApi, effectivePolicy, getPolicy, setPolicy } from '../../../src/runtime/routing/policies.ts';
import { defaultEffortFor, inferCategory, resolveCategory } from '../../../src/runtime/routing/categories.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';

const isBadRequest = (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request';

test('global default policy: set, get, clear', () => {
  const h = setup();
  assert.equal(getPolicy(h.services, {}), null);
  setPolicy(h.services, {}, { costMode: 'economy', ceilingTier: 'strong', effort: 'low' });
  // 23.10.2026: one global cost mode – the default policy's goes to Settings.routing.costMode.
  assert.deepEqual(getPolicy(h.services, {}), { ceilingTier: 'strong', effort: 'low' });
  assert.equal(h.settings.get().routing.costMode, 'economy');
  setPolicy(h.services, {}, {});
  assert.equal(getPolicy(h.services, {}), null);
  // 01.11.2026: one default model – a global pin is the Work use (settings.json routing.work).
  setPolicy(h.services, {}, { pin: 'claude:claude-opus-5-5' });
  assert.equal(h.settings.get().routing.work, 'claude:claude-opus-5-5');
  assert.deepEqual(getPolicy(h.services, {}), { pin: 'claude:claude-opus-5-5' });
});

test('an older stored global pin is no part of the global policy: reading it writes nothing, the Work use decides', () => {
  const h = setup();
  h.settings.update({ routing: { work: 'auto' } });
  h.db.run('INSERT INTO kv (ns, key, value, updated_at) VALUES (?, ?, ?, ?)', ['routing', 'default_policy', JSON.stringify({ pin: 'codex:gpt-6.1-sol', effort: 'low' }), 1]);
  assert.deepEqual(getPolicy(h.services, {}), { effort: 'low' });
  assert.equal(h.settings.get().routing.work, 'auto');
});

test('agent policy goes through org.update and comes back normalized', () => {
  const h = setup();
  h.agents.set('ag_1', agent('ag_1'));
  assert.equal(getPolicy(h.services, { agentId: 'ag_1' }), null);
  setPolicy(h.services, { agentId: 'ag_1' }, { pin: 'claude:claude-opus-5-5', effort: 'X-High' as never, floorTier: 'strong', prefer: ['a', 'a', 'b'] });
  assert.deepEqual(getPolicy(h.services, { agentId: 'ag_1' }), { pin: 'claude:claude-opus-5-5', effort: 'xhigh', floorTier: 'strong', prefer: ['a', 'b'] });
  assert.deepEqual(h.agents.get('ag_1')!.modelPolicy.pin, 'claude:claude-opus-5-5');
  setPolicy(h.services, { agentId: 'ag_1' }, { pin: 'auto' });
  assert.equal(getPolicy(h.services, { agentId: 'ag_1' }), null);
  assert.throws(() => setPolicy(h.services, { agentId: 'ag_missing' }, {}), (error: unknown) => error instanceof WorkforceError && error.code === 'not_found');
});

test('26.11.2026 agent page: a new start model applies from the next context; with now the next turn runs on it at once', () => {
  const h = setup();
  h.agents.set('ag_1', agent('ag_1'));
  const pending = () => pendingRoute(h.db, 'ag_1', undefined, () => false);
  // "From next context": the start model only – the router starts a context on it (settled-model.test.ts: off a boundary a
  // start model set since waits, at a boundary it runs); no request for the next turn
  setPolicy(h.services, { agentId: 'ag_1' }, { pin: 'claude:claude-opus-5-5' });
  assert.equal(h.agents.get('ag_1')!.modelPolicy.pin, 'claude:claude-opus-5-5');
  assert.equal(pending(), undefined);
  // "Now": the same start model, and the next turn runs on it inside the live session too (agents/next-route.ts `now`)
  setPolicy(h.services, { agentId: 'ag_1' }, { pin: 'codex:gpt-6.1-sol' }, { now: true });
  assert.equal(h.agents.get('ag_1')!.modelPolicy.pin, 'codex:gpt-6.1-sol');
  assert.deepEqual([pending()?.modelId, pending()?.now], ['codex:gpt-6.1-sol', true]);
  // (a later start model without now ends the ask – org/service.ts startModelSet, tested with the real org service)
  // Auto has nothing to switch to: no request, even with now
  clearNextModel(h.db, 'ag_1');
  setPolicy(h.services, { agentId: 'ag_1' }, {}, { now: true });
  assert.equal(pending(), undefined);
  // through the API the handler uses
  createPolicyApi(() => h.services).set({ agentId: 'ag_1' }, { pin: 'codex:gpt-6.1-sol' }, { now: true });
  assert.equal(pending()?.now, true);
});

test('validation rejects impossible bands and unknown values', () => {
  assert.throws(() => cleanPolicy({ floorTier: 'frontier', ceilingTier: 'small' }), isBadRequest);
  assert.throws(() => cleanPolicy({ costMode: 'cheap' }), isBadRequest);
  assert.throws(() => cleanPolicy({ effort: 'turbo' }), isBadRequest);
  assert.throws(() => cleanPolicy({ floorTier: 'huge' }), isBadRequest);
  assert.throws(() => cleanPolicy({ avoid: 'x' }), isBadRequest);
  assert.throws(() => cleanPolicy([]), isBadRequest);
  assert.deepEqual(cleanPolicy({ pin: '', effort: 'auto', unknown: 1 }), {});
});

test('B-083: cleanPolicy keeps who set the start model (pinBy), clipped; a malformed one is dropped', () => {
  assert.deepEqual(cleanPolicy({ pin: 'x:a', pinBy: { name: ' Stanislaus ', at: 5, extra: 1 } }), { pin: 'x:a', pinBy: { name: 'Stanislaus', at: 5 } });
  assert.deepEqual(cleanPolicy({ pinBy: { name: 'Konrad', at: 7, self: true } }).pinBy, { name: 'Konrad', at: 7, self: true });
  assert.equal(cleanPolicy({ pinBy: { name: 'x'.repeat(200), at: 1 } }).pinBy?.name.length, 80);
  for (const pinBy of [{ name: '', at: 1 }, { name: 'A' }, { name: 'A', at: Number.NaN }, 'A', ['A', 1]]) assert.equal(cleanPolicy({ pinBy }).pinBy, undefined);
  const h = setup();
  setPolicy(h.services, {}, { effort: 'low', pinBy: { name: 'A', at: 1 } });
  assert.deepEqual(getPolicy(h.services, {}), { effort: 'low' }, 'no pinBy at the global scope');
});

test('B-083: the chat suggestion – modelHints over an older models entry, effort and temperature; auto = none', () => {
  const h = setup();
  h.addChat('ch_1', ['ag_1'], { modelHints: { ag_1: 'x:hint' }, models: { ag_1: 'x:old' }, efforts: { ag_1: 'high' }, temperatures: { ag_1: 0.3 } });
  assert.deepEqual(chatChoice(h.services, 'ch_1', 'ag_1'), { pin: 'x:hint', effort: 'high', temperature: 0.3 });
  h.addChat('ch_2', ['ag_1'], { models: { ag_1: 'x:old' }, efforts: { ag_1: 'auto' }, temperatures: { ag_1: 0 } });
  assert.deepEqual(chatChoice(h.services, 'ch_2', 'ag_1'), { pin: 'x:old', effort: undefined, temperature: 0 }, "a stored 'auto' effort is none, not medium");
  h.addChat('ch_3', ['ag_1'], { modelHints: { ag_1: 'auto' }, temperatures: { ag_1: -1 } });
  assert.deepEqual(chatChoice(h.services, 'ch_3', 'ag_1'), { pin: undefined, effort: undefined });
  // 13.11.2026: information for the AI, never a route – the router's policy holds only my own start model
  assert.deepEqual(effectivePolicy(h.services, agent('ag_1', { modelPolicy: { pin: 'x:own' } })).pin, { modelId: 'x:own', source: 'agent' });
});

test('chat + agent scope stores only the composer choice and keeps other agents', () => {
  const h = setup();
  h.agents.set('ag_1', agent('ag_1'));
  h.agents.set('ag_2', agent('ag_2'));
  h.addChat('ch_1', ['ag_1', 'ag_2'], { models: { ag_2: 'codex:gpt-6.1-sol' }, efforts: { ag_2: 'high' }, mode: 'video' });
  setPolicy(h.services, { agentId: 'ag_1', conversationId: 'ch_1' }, { pin: 'claude:claude-opus-5-5', effort: 'max', ceilingTier: 'small' });
  const settings = h.conversations.get('ch_1')!.settings;
  assert.deepEqual(settings.models, { ag_2: 'codex:gpt-6.1-sol', ag_1: 'claude:claude-opus-5-5' });
  assert.deepEqual(settings.efforts, { ag_2: 'high', ag_1: 'max' });
  assert.equal(settings.mode, 'video');
  assert.deepEqual(getPolicy(h.services, { agentId: 'ag_1', conversationId: 'ch_1' }), { pin: 'claude:claude-opus-5-5', effort: 'max' });

  setPolicy(h.services, { agentId: 'ag_1', conversationId: 'ch_1' }, { pin: 'auto' });
  assert.deepEqual(h.conversations.get('ch_1')!.settings.models, { ag_2: 'codex:gpt-6.1-sol' });
  assert.deepEqual(h.conversations.get('ch_1')!.settings.efforts, { ag_2: 'high' });
  assert.equal(getPolicy(h.services, { agentId: 'ag_1', conversationId: 'ch_1' }), null);

  // A group needs the agent named; a 1:1 chat resolves its only agent.
  assert.throws(() => getPolicy(h.services, { conversationId: 'ch_1' }), isBadRequest);
  h.addChat('ch_2', ['ag_1']);
  const api = createPolicyApi(() => h.services);
  api.set({ conversationId: 'ch_2' }, { effort: 'low' });
  assert.deepEqual(api.get({ conversationId: 'ch_2' }), { effort: 'low' });
  assert.deepEqual(api.get({ agentId: 'ag_1', conversationId: 'ch_2' }), { effort: 'low' });
});

test('effective policy: the agent pin (the default model is the Work use); agent bounds override defaults', () => {
  const h = setup();
  setPolicy(h.services, {}, { pin: 'x:default', floorTier: 'strong', costMode: 'best', avoid: ['x:bad'], effort: 'low' });
  const a = agent('ag_1', { modelPolicy: { pin: 'x:own', ceilingTier: 'small', effort: 'high', avoid: ['x:worse'] } });
  const inChat = effectivePolicy(h.services, a);
  assert.deepEqual(inChat.pin, { modelId: 'x:own', source: 'agent' });
  assert.equal(inChat.agentEffort, 'high');
  assert.equal(inChat.defaultEffort, 'low');
  assert.equal(inChat.ceilingTier, 'small');
  assert.equal(inChat.floorTier, undefined, 'the default floor would contradict the agent ceiling');
  assert.equal(inChat.costMode, undefined, 'the default cost mode lives in Settings.routing (the router falls back to it)');
  assert.equal(h.settings.get().routing.costMode, 'best');
  assert.deepEqual(inChat.avoid.sort(), ['x:bad', 'x:worse']);
  assert.equal(effectivePolicy(h.services, agent('ag_2')).pin, undefined);
  assert.equal(h.settings.get().routing.work, 'x:default');
});

test('categories: the mode wins, the general chat category is refined by keywords', () => {
  assert.equal(inferCategory('Kannst du die Buchhaltung für die Rechnungen von März machen?'), 'business-workflows');
  assert.equal(inferCategory('Bitte recherchiere Studien zu Schlaf und Konzentration'), 'research');
  assert.equal(inferCategory('Fix the TypeScript stack trace in the repository'), 'coding');
  assert.equal(inferCategory('Erinnere mich morgen an den Termin beim Arzt'), 'personal-assistant');
  assert.equal(inferCategory('Write a caption for Instagram and a few hashtags'), 'social-media');
  // RT8: cutting, podcasts, thumbnails and subtitles are video work.
  assert.equal(inferCategory('Schneide den Podcast'), 'video-animation');
  assert.equal(inferCategory('Kannst du die Folge zusammenschneiden und ein Thumbnail machen?'), 'video-animation');
  assert.equal(inferCategory('Erstelle deutsche Untertitel'), 'video-animation');
  assert.equal(inferCategory('Add English subtitles, please'), 'video-animation');
  assert.equal(inferCategory('Schneid das Intro raus'), 'video-animation');
  assert.equal(inferCategory('Wir müssen uns heute entscheiden'), undefined); // "schneid" is not in "entscheiden"
  // A generic word counts once, and the surname is no cutting: these are no video work.
  assert.equal(inferCategory('Schreib eine Mail an Herrn Schneider, dass Herr Schneider morgen kommt'), undefined);
  assert.equal(inferCategory('Schreib Herrn Schneider eine Mail über den neuen Podcast'), undefined);
  assert.equal(inferCategory('Ich muss die Hecke schneiden und die Rosen zuschneiden'), undefined);
  assert.equal(inferCategory('Kannst du mir morgen die Haare schneiden? Nur kurz schneiden'), undefined);
  assert.equal(inferCategory('Welchen Podcast kannst du empfehlen? Am liebsten einen Podcast über Geschichte'), undefined);
  assert.equal(inferCategory('Plan the plan, plan it well'), undefined); // one generic word three times
  assert.equal(inferCategory('Please determine the best option'), undefined); // "termin" only at a word start
  assert.equal(inferCategory('Hey team, how are you?'), undefined); // one weak word is not enough
  assert.equal(inferCategory(''), undefined);
  assert.equal(resolveCategory('video-animation', 'summarize this'), 'video-animation');
  assert.equal(resolveCategory('chat', 'summarize this thread for me'), 'cheap-chat');
  assert.equal(resolveCategory('chat', 'hello'), 'chat');
  assert.equal(resolveCategory('custom-thing', undefined), 'chat');
  // B-047 D12: the manager mode's category is refined by the turn's text like 'chat'; without text it stays.
  assert.equal(resolveCategory('manager-planner', 'Recherchiere die Firma und vergleiche die Quellen'), 'research');
  assert.equal(resolveCategory('manager-planner', 'Hi, how are you?'), 'chat');
  assert.equal(resolveCategory('manager-planner', 'Plan the roadmap and delegate the milestones'), 'manager-planner');
  assert.equal(resolveCategory('manager-planner', undefined), 'manager-planner');
  assert.equal(defaultEffortFor('manager-planner'), 'high');
  assert.equal(defaultEffortFor('cheap-chat'), 'low');
  assert.equal(defaultEffortFor('research'), 'medium');
});

test('B-080: equal top scores name no kind – the table\'s first row (video) no longer wins a tie', () => {
  assert.equal(inferCategory('kein künstliches Notebook/Video-Gate, unabhängige Quellen-QA'), 'research', 'D6: the medium is one hint');
  assert.equal(resolveCategory('chat', 'Originalvideo … Quellen'), 'research');
  assert.equal(resolveCategory('manager-planner', 'Originalvideo … Quellen'), 'research');
  assert.equal(inferCategory('Schneide das Video in DaVinci und such Quellen dazu'), 'video-animation', 'a clear lead still names its kind');
  assert.equal(inferCategory('Erstelle Untertitel und nenne die Quellen'), undefined, 'video 3 = research 3');
  assert.equal(resolveCategory('chat', 'Erstelle Untertitel und nenne die Quellen'), 'chat');
});

test('B-083 D6: a word that names a medium (video, animation, podcast) is one hint – video work needs a craft hint beside it', () => {
  // Live outreach texts about creators who make videos: no video work.
  assert.equal(inferCategory('Kein persönlicher Podcast-/Videoauftritt; schreib die YouTube-Creator an'), undefined);
  assert.equal(inferCategory('Video nur bei echter Aufnahme'), undefined);
  assert.equal(inferCategory('Schreib den YouTubern, die Videos über KI machen, eine kurze Mail'), undefined);
  // The medium with a craft word is video work.
  assert.equal(inferCategory('Mach aus dem Podcast ein paar Reels'), 'video-animation');
  assert.equal(inferCategory('Render the video'), 'video-animation');
  assert.equal(inferCategory('Schneide das Video'), 'video-animation');
  assert.equal(inferCategory('Cut the video'), 'video-animation');
  // A craft word alone is one hint, and a clipboard is no clip.
  assert.equal(inferCategory('Cut the costs'), undefined);
  assert.equal(inferCategory('Cut and paste it to the clipboard'), undefined);
  assert.equal(inferCategory('Copy the video link to the clipboard'), undefined);
});
