// B-057 R1-4 and S17, B-083 – what an agent's own turns are told about its parts. "## My parts" (context/split-section.ts
// activeSplitsLine, from SplitService.activeOn and the groups' views): its groups still at work (pending or running; B-080:
// from every chat, this thread's first, then newest first, at most 3; a group from another chat named "(split in
// "<title>")") with "k of N done, j running" (and "m not started yet"), and B-083 one line per part: status, model ·
// effort · temperature, its last step, its last note to me and the first line of its result once done; absent without
// such groups and for a part's own turn. Ultra is the agent's own call: one bullet of How I work (the Ultra
// CORE in short), ULTRA_NOTE only on older messages that carried the person's hint, and no section is a standing rule.
// Owns: these checks. Never: an engine or the real dispatcher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOLD_ORIGIN, splitThread } from '../../../src/shared/model/splits.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import { ACTIVE_HEADER, ACTIVE_TAIL, ULTRA_NOTE, activeSplitsLine, ultraNote } from '../../../src/runtime/context/split-section.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { RESOURCES } from '../store/helpers.ts';
import { volatileSections } from '../../../src/runtime/context/prompt-volatile.ts';
import { CHAT, part, splitAndEnd, world, type World } from './fixture.ts';

const TAIL = ACTIVE_TAIL;
const AVA = { id: 'ag_ava', name: 'Ava' } as Agent;

/** The volatile sections of Ava's turn on `thread` (only the split service and the chat are real here – the rest is skipped). */
function sections(w: World, thread: string) {
  const services = { splits: w.splits, runs: w.runs, chats: w.services.chats, clock: w.clock, log: { debug() {} } } as unknown as RuntimeServices;
  return volatileSections(services, { agent: AVA, conversationId: thread === CHAT ? CHAT : undefined, thread, route: { modelId: 'codex:gpt-6.1-sol', effort: 'high' } as never });
}

/** The group heads of the section (one per group, without the part lines). */
const heads = (text: string) => text.split('\n').filter((line) => line.startsWith('Group '));

test('My parts: per group its counts, per part its status, model · effort, result once done', () => {
  const w = world();
  const groupId = splitAndEnd(w, [part('A'), part('B'), part('C')], 'Review the release');
  const [a, b] = w.lanes.started;
  assert.deepEqual(w.splits.activeOn('ag_ava', CHAT), [{ id: groupId, goal: 'Review the release', thread: CHAT, conversationId: CHAT, status: 'running', parts: 3, done: 0, running: 3, waiting: 0, ended: 0 }]);
  assert.equal(activeSplitsLine(w.services, 'ag_ava', CHAT),
    `${ACTIVE_HEADER}\nGroup ${groupId} "Review the release" – 0 of 3 done, 3 running:\n- #1 A – working · chain\n- #2 B – working · chain\n- #3 C – working · chain\n${TAIL}`); // Halb 21.11.2026: not routed yet – the needs it asked for
  w.lanes.end(a, 'done', { answer: 'A is clean.\nDetails follow.' });
  w.lanes.end(b, 'failed', { error: 'The part failed.' });
  assert.equal(activeSplitsLine(w.services, 'ag_ava', CHAT), [
    ACTIVE_HEADER,
    `Group ${groupId} "Review the release" – 1 of 3 done, 1 running, 1 did not finish:`,
    '- #1 A – done · codex:gpt-6.1-sol · low · result: A is clean.',
    '- #2 B – failed (The part failed.) · codex:gpt-6.1-sol · low',
    '- #3 C – working · chain',
    TAIL,
  ].join('\n'));

  // A second group, split by a turn that has not ended yet: newest first.
  w.runs.start({ id: 'run_two', agentId: 'ag_ava', conversationId: CHAT, trigger: 'message' });
  const pending = w.splits.create(w.ctx({ runId: 'run_two' }), { goal: 'Check the docs', parts: [part('D'), part('E', { after: [1], effort: 'high', temperature: 0.3 })] });
  const line = activeSplitsLine(w.services, 'ag_ava', CHAT);
  assert.deepEqual(heads(line), [
    `Group ${pending.id} "Check the docs" – 2 parts, not started yet (they start when the turn that split them ends):`,
    `Group ${groupId} "Review the release" – 1 of 3 done, 1 running, 1 did not finish:`,
  ]);
  assert.match(line, /\n- #1 D – not started yet · chain\n- #2 E – waits for #1 · chain · high · temperature 0\.3/);
  assert.equal(w.splits.activeOn('ag_ava', CHAT, 1).length, 1, 'bounded');

  // Not there: other agents, a part's own thread.
  assert.equal(activeSplitsLine(w.services, 'ag_ben', CHAT), '');
  assert.equal(activeSplitsLine(w.services, 'ag_ava', splitThread(a)), '');
  assert.equal(activeSplitsLine(w.services, 'ag_ava', undefined), '');
  assert.equal(activeSplitsLine({} as RuntimeServices, 'ag_ava', CHAT), '', 'no split service wired');
});

test('B-083: a working part\'s last step and its last note to me', () => {
  const w = world();
  splitAndEnd(w, [part('Search'), part('Check')]);
  const [search] = w.lanes.started;
  const runId = w.lanes.lanes.get(search)!.runId;
  w.runs.item(runId, { kind: 'tool_call', name: 'agents.split_tell', data: { summary: `${TOLD_ORIGIN} the API changed in v2 – #2 should check v2` }, effectStatus: 'none' });
  w.runs.item(runId, { kind: 'tool_call', name: 'shell.exec', data: { summary: 'npm test -- api' }, effectStatus: 'none' });
  const line = activeSplitsLine(w.services, 'ag_ava', CHAT);
  assert.match(line, /\n- #1 Search – working · chain · last steps: shell\.exec npm test -- api · told me: "the API changed in v2 – #2 should check v2"\n/);
  assert.match(line, /\n- #2 Check – working · chain\n/);
});

test('review 08.11.: a working part shows what its turn runs on now (its activity row) – a run\'s model is written only when it ends', () => {
  const w = world();
  splitAndEnd(w, [part('A'), part('B', { effort: 'high' })]);
  const [a] = w.lanes.started;
  const row = { agentId: 'ag_ava', runId: w.lanes.lanes.get(a)!.runId, note: '', startedAt: 0, model: 'claude:claude-opus-5-5', modelName: 'Claude Opus 5.5', effort: 'medium', temperature: 0.3, split: { id: a } };
  const services = { ...w.services, dispatcher: { activity: () => [row] } } as unknown as RuntimeServices;
  assert.match(activeSplitsLine(services, 'ag_ava', CHAT), /\n- #1 A – working · Claude Opus 5\.5 · medium · temperature 0\.3\n- #2 B – working · chain · high\n/, 'not routed yet: what it was asked for');
});

test('B-080: a group split in another chat stands in the section of a turn there, named by its chat, this thread\'s groups first', () => {
  // Live 08.11.: a review run in the group chat saw only the round-1 group, said round 2a had not started and split the same 27 cases again.
  const w = world();
  const there = splitAndEnd(w, [part('A'), part('B')], 'Round 2a');
  const services = {
    ...w.services,
    chats: { get: (id: string) => (id === CHAT ? { id, title: 'Launch review', titleNamed: true, settings: {} } : undefined), members: () => [] },
    settings: { get: () => ({ profile: { name: 'Stanislaus' } }) },
  } as unknown as RuntimeServices;
  assert.deepEqual(heads(activeSplitsLine(services, 'ag_ava', 'ch_team', 'ch_team')), [`Group ${there} "Round 2a" (split in "Launch review") – 0 of 2 done, 2 running:`]);
  assert.equal(activeSplitsLine(services, 'ag_ava', 'task:task_1', CHAT).includes('(split in'), false, 'another thread of the same chat: no chat name');
  assert.match(activeSplitsLine(services, 'ag_ava', 'task:task_1'), /"Round 2a" \(split in "Launch review"\)/, 'a task thread outside that chat');
  assert.match(activeSplitsLine(w.services, 'ag_ava', 'ch_team', 'ch_team'), /"Round 2a" \(split in "(another chat|Untitled chat)"\)/, 'a chat whose title cannot be read is still named as elsewhere');

  // A group split on the team thread comes first there, although it is not the newest.
  w.runs.start({ id: 'run_team', agentId: 'ag_ava', conversationId: 'ch_team', trigger: 'message' });
  const here = w.splits.create(w.ctx({ runId: 'run_team', conversationId: 'ch_team', thread: 'ch_team' }), { goal: 'Team check', parts: [part('C'), part('D')] }).id;
  w.clock.advance(1000);
  w.runs.start({ id: 'run_three', agentId: 'ag_ava', conversationId: CHAT, trigger: 'message' });
  const newest = w.splits.create(w.ctx({ runId: 'run_three' }), { goal: 'Round 2b', parts: [part('E'), part('F')] }).id;
  assert.deepEqual(w.splits.activeOn('ag_ava', 'ch_team').map((group) => group.id), [here, newest, there]);
  assert.deepEqual(w.splits.activeOn('ag_ava', CHAT).map((group) => group.id), [newest, there, here]);
  assert.deepEqual(w.splits.activeOn('ag_ava', 'ch_team').map((group) => group.conversationId), ['ch_team', CHAT, CHAT]);
  assert.deepEqual(heads(activeSplitsLine(services, 'ag_ava', 'ch_team', 'ch_team')).map((head) => head.split(' – ')[0]), [
    `Group ${here} "Team check"`, `Group ${newest} "Round 2b" (split in "Launch review")`, `Group ${there} "Round 2a" (split in "Launch review")`,
  ]);
  assert.equal(activeSplitsLine(services, 'ag_ava', splitThread(w.lanes.started[0])), '', 'a part\'s own turn: none');
});

test('B-080: parts beyond the agent\'s four running ones are named as not started yet', () => {
  const w = world();
  const groupId = splitAndEnd(w, Array.from({ length: 6 }, (_, index) => part(`P${index + 1}`)), 'Review the release');
  assert.equal(w.splits.activeOn('ag_ava', CHAT)[0].waiting, 2);
  const line = activeSplitsLine(w.services, 'ag_ava', CHAT);
  assert.deepEqual(heads(line), [`Group ${groupId} "Review the release" – 0 of 6 done, 4 running, 2 not started yet:`]);
  assert.match(line, /\n- #5 P5 – waiting to start · chain\n- #6 P6 – waiting to start · chain\n/);
  w.lanes.end(w.lanes.started[0], 'done', { answer: 'P1' });
  assert.deepEqual(heads(activeSplitsLine(w.services, 'ag_ava', CHAT)), [`Group ${groupId} "Review the release" – 1 of 6 done, 4 running, 1 not started yet:`]);
});

test('a settled group leaves the section (its results come as the "Split results" block instead)', () => {
  const w = world();
  splitAndEnd(w, [part('A')]);
  assert.notEqual(activeSplitsLine(w.services, 'ag_ava', CHAT), '');
  w.lanes.end(w.lanes.started[0], 'done', { answer: 'A' });
  assert.deepEqual(w.splits.activeOn('ag_ava', CHAT), []);
  assert.equal(activeSplitsLine(w.services, 'ag_ava', CHAT), '');
});

test('the volatile prompt: "My parts" in the agent\'s own turn while groups work there, none otherwise or in a part\'s turn', () => {
  const w = world();
  assert.equal(sections(w, CHAT).some((section) => section.name === 'splits'), false, 'no groups: the prompt is as before');
  const groupId = splitAndEnd(w, [part('A'), part('B')]);
  const own = sections(w, CHAT).find((section) => section.name === 'splits');
  assert.match(own?.text ?? '', new RegExp(`^${ACTIVE_HEADER}\\nGroup ${groupId} "Review the release" – 0 of 2 done, 2 running:`));
  const inSplit = sections(w, splitThread(w.lanes.started[0]));
  assert.ok(inSplit.some((section) => section.name === 'split'), 'the part\'s own section');
  assert.equal(inSplit.some((section) => section.name === 'splits'), false, 'a part is not told about its own group as work of its own');
});

test('Ultra is my own call, never a rule: How I work names my parts once, a short note on an older hinted message', () => {
  // Owner 08.11.2026: "Die soll es einfach selbst erkennen" – the composer's Ultra cell goes; the agent sees it for itself.
  const how = readFileSync(path.join(RESOURCES, 'prompts', 'standard-agent.md'), 'utf8');
  const line = how.split('\n').find((text) => text.startsWith('- Parts of me (people call this Ultra) take pieces'))!; // 25.11.2026: opens with the parts, no longer with "I can work on several things at once and stay one"
  assert.ok(line, 'one bullet in How I work, the same in every mode');
  assert.match(line, /come back into me when they end/);
  assert.equal(ultraNote({ authorKind: 'human', meta: { ultra: true } }), ` ${ULTRA_NOTE}`);
  assert.equal(ULTRA_NOTE, '(the person thought splitting could help)');
  assert.equal(ultraNote({ authorKind: 'human', meta: {} }), '');
  assert.equal(ultraNote({ authorKind: 'agent', meta: { ultra: true } }), '', 'never on an agent\'s line');
  assert.equal(ultraNote({}), '');
  for (const text of [line, ULTRA_NOTE]) assert.doesNotMatch(text, /\b(must|rule|always|every substantive|first action|allowed)\b/i, 'no obligation');
  assert.equal(sections(world(), CHAT).some((section) => section.name === 'ultra' || /## Ultra/.test(section.text)), false, 'no Ultra section in the volatile prompt');
});
