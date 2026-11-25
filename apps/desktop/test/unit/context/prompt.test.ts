// Context.prompt(): the stable sections in reading order (Who I am, My SYSTEM.md, My environment, Skills, More tools,
// Rich answers, Mode) and their determinism, SYSTEM.md as the whole standing text (its "# How I work" inside, no comment
// reaching the model), block tiers, the live sections (time, chats, pinned cap, my quests and the current work –
// absolute times, no counters) and the templates; How I work (the standards resources/prompts/standard-*.md): the
// agent's own voice, the stances it keeps and its size.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fixture, model, route, RESOURCES, VIDEO_MODE } from './fixture.ts';
import { blockLine, blockPrompt } from '../../../src/shared/blocks/prompt.ts';
import { cleanTemplate, loadTemplates, renderTemplate } from '../../../src/runtime/context/templates.ts';
import { PINNED_CAP } from '../../../src/runtime/context/prompt-volatile.ts';
import { ownHowIWork } from '../../../src/runtime/org/system-parts.ts';
import type { SkillInfo } from '../../../src/shared/model/knowledge.ts';

const TEMPLATES = loadTemplates(path.join(RESOURCES, 'prompts'));
const SKILL: SkillInfo = { name: 'remotion-video', description: 'Animate videos with Remotion. Use for motion graphics.', source: 'builtin', path: '/skills/remotion-video', modes: ['video'], updatedAt: 0 };
const standard = (name: string) => cleanTemplate(readFileSync(path.join(RESOURCES, 'prompts', `standard-${name}.md`), 'utf8'));
const STANDARD = standard('agent');
const HOW = ownHowIWork(renderTemplate(STANDARD, { user_name: 'Alexandra', owner: 'Alexandra' })).how;

function setup() {
  const f = fixture({ skills: [SKILL] });
  const chat = f.chats.create({ agentIds: [f.vid.id], createdBy: 'human' });
  return { ...f, chat };
}

test('stable prompt: every section present, in reading order, placeholders filled, secrets redacted', () => {
  const f = setup();
  const { stable } = f.context.prompt({ agent: f.vid, conversationId: f.chat.id, mode: VIDEO_MODE, route: route() });
  const marks = [
    '# Who I am\nI am Vic, Video editor at Acme GmbH – a long-lived member',
    'Chat members are people – the CEO Alex and colleagues – and AI colleagues', // B-050 K3: member-neutral
    '# My SYSTEM.md\nMy whole standing text',
    'Prefer short cuts.',
    '## My environment\nThis PC:',
    'whose language is set to German.', // the app's language is a fact, no rule
    '## Skills',
    '## Rich answers',
    '## Mode: Video',
  ];
  let last = -1;
  for (const mark of marks) {
    const index = stable.indexOf(mark);
    assert.ok(index > last, `missing or out of order: ${mark}`);
    last = index;
  }
  for (const text of ['My team: Marketing.', 'My area: Company.', 'I report to Mia (Manager).', 'Cut tight. Export H.264.', 'Skills exist for most kinds of work', 'secret://']) {
    assert.ok(stable.includes(text), `missing: ${text}`);
  }
  assert.ok(!stable.includes('## My instructions') && !stable.includes('## My folder') && !stable.includes('Time zone of'), 'one path; the zone stands in "## Now"');
  assert.ok(!stable.includes('# Video mode'), 'mode heading is replaced by the section heading');
  assert.ok(!stable.includes('hunter2'), 'secret values are redacted');
  assert.ok(!/\{\{|\}\}/.test(stable), 'no unresolved placeholders');
  assert.ok(!/2026|11:00/.test(stable), 'no dates or times in the stable part');
});

test('owner 14.11.: my SYSTEM.md is my whole standing text – its "# How I work" stands in it, no team text beside it, no comment reaches the model', () => {
  const f = setup();
  const own = { ...f.vid, instructions: '# How I work\nMy own way of working.\n\n## My role\nVideo editor.\n\n<!-- Autark standard: agent · 0123abcd\nThe standard text.\n-->' };
  const { stable } = f.context.prompt({ agent: own, mode: VIDEO_MODE, route: route() });
  assert.ok(stable.includes('# My SYSTEM.md\nMy whole standing text'), stable.slice(0, 800));
  assert.ok(stable.indexOf('# How I work\nMy own way of working.\n\n## My role\nVideo editor.') > stable.indexOf('# My SYSTEM.md'));
  assert.ok(!stable.includes('This company is my own work'), 'no team text is read beside it');
  assert.ok(!stable.includes('The standard text') && !stable.includes('<!--'), 'the standard comment stays in the file');
});

test('stable prompt is deterministic; the live part carries the per-turn state', () => {
  const f = setup();
  const input = { agent: f.vid, conversationId: f.chat.id, mode: VIDEO_MODE, route: route() };
  const first = f.context.prompt(input);
  f.clock.advance(3 * 3600_000);
  f.knowledge.save({ title: 'Brand color', body: 'Use #ff5500', scope: 'global', createdBy: 'human', pinned: true });
  const second = f.context.prompt(input);
  assert.equal(second.stable, first.stable);
  assert.notEqual(second.volatile, first.volatile);
  assert.match(second.volatile, /## Pinned\n- Brand color: Use #ff5500 \(saved Sat 17 Oct\)/, 'a pinned note says the day it was saved, no age');
});

test('rich-answer fragment: lite only for a local model, the full line with mini-apps for every other tier', () => {
  const f = setup();
  const base = { agent: f.vid, mode: VIDEO_MODE };
  const lite = f.context.prompt({ ...base, route: route('ollama:gemma') }).stable;
  const frontier = f.context.prompt({ ...base, route: route('codex:gpt-6.1-sol') }).stable;
  const strong = f.context.prompt({ ...base, route: route('codex:luna') }).stable;
  const unknown = f.context.prompt({ ...base, route: route('compatible:mystery') }).stable;
  assert.ok(lite.includes(blockLine({ tier: 'lite', app: false })));
  assert.ok(!lite.includes('```app'));
  assert.ok(frontier.includes(blockLine({ tier: 'full', app: true })));
  assert.ok(strong.includes(blockLine({ tier: 'full', app: true })));
  assert.ok(unknown.includes(blockLine({ tier: 'full', app: true })));
  assert.ok(!frontier.includes(blockPrompt({ tier: 'full', app: true })), 'not the whole guide');
  assert.doesNotMatch(blockLine({ tier: 'full', app: true }), /max ~3|the human/, 'the principle, no count; the person');
});

test('S2: a small-tier and a strong-tier route give the same agent the same stable prompt, section by section', () => {
  const f = setup();
  const catalog = f.services.catalog as unknown as { get: (id: string) => ReturnType<typeof model> | undefined };
  const known = catalog.get.bind(catalog);
  catalog.get = (id: string) => (id === 'claude:haiku' ? model('claude:haiku', 'small', 'Haiku') : known(id));
  const base = { agent: f.vid, mode: VIDEO_MODE };
  const small = f.context.prompt({ ...base, route: route('claude:haiku') });
  const strong = f.context.prompt({ ...base, route: route('codex:luna') });
  const frontier = f.context.prompt({ ...base, route: route('codex:gpt-6.1-sol') });
  assert.equal(small.stable, strong.stable);
  assert.equal(frontier.stable, strong.stable);
  assert.deepEqual(small.stableSections?.map((section) => section.name), ['identity', 'system-md', 'environment', 'skills', 'rich-answers', 'mode']);
  assert.equal(small.stableSections?.map((section) => section.text).join('\n\n'), small.stable, 'the sections joined are the system prompt');
});

test('live part: time with zone, my chats as stable lines, "## My quests" one line per quest – the person\'s time, none on agent work, my next note', () => {
  const f = setup();
  const now = f.clock.now();
  const quest = f.tasks.create({ kind: 'quest', title: 'Launch video', doneWhen: 'A 60 s MP4 exists', assigneeKind: 'agent', assigneeId: f.vid.id, createdBy: 'human' });
  const current = f.tasks.create({ title: 'Cut the launch video', parentId: quest.id, assigneeKind: 'agent', assigneeId: f.vid.id, createdBy: 'human', at: now + 2 * 3600_000 });
  f.tasks.create({ title: 'Record the voice-over', parentId: quest.id, assigneeKind: 'human', createdBy: f.vid.id, at: now + 3600_000 });
  f.scheduler.create({ ownerId: f.vid.id, conversationId: f.chat.id, kind: 'reminder', taskId: quest.id, title: 'Check comments', spec: { at: now + 86_400_000 }, payload: { note: 'check' } });
  const { volatile } = f.context.prompt({ agent: f.vid, conversationId: f.chat.id, taskId: current.id, mode: VIDEO_MODE, route: route() });
  assert.ok(volatile.includes('Sat 17 Oct 2026, 11:00 (Europe/Berlin)'), volatile.slice(0, 200));
  assert.ok(volatile.includes('I run on GPT-6.1 Sol · effort high, in Codex.'));
  assert.ok(volatile.includes(`## My chats
${f.chat.id} · `), 'my chats as stable lines');
  assert.ok(volatile.includes(`## My quests
- Launch video · ${quest.id} · person: 1 open (next: Record the voice-over, Sat 17 Oct 12:00) · me: 1 · next note Sun 18 Oct 11:00`), volatile);
  assert.ok(volatile.includes('## Current to-do'));
  assert.ok(!volatile.includes('13:00'), 'no time on my own work');
  assert.ok(!/today|(overdue)/.test(volatile), 'no clock-relative words');
  assert.ok(!/## My tasks|## Given by me|## My schedules/.test(volatile), 'one section for the work');
  assert.ok(!volatile.includes('Team and models'), 'no manager-only setup section');
});

test('pinned in the live part: whole bodies within the cap, every pinned title stands (past the cap by its pointer)', () => {
  const f = setup();
  for (let i = 0; i < 6; i++) f.knowledge.save({ title: `Pinned ${i}`, body: `${'x'.repeat(1000)} ${i}`, scope: 'agent', scopeId: f.vid.id, createdBy: 'human', pinned: true });
  const { volatile } = f.context.prompt({ agent: f.vid, mode: VIDEO_MODE, route: route() });
  const start = volatile.indexOf('## Pinned\n');
  assert.ok(start >= 0);
  const end = volatile.indexOf('\n\n', start);
  const lines = volatile.slice(start, end < 0 ? undefined : end).split('\n').slice(1);
  const whole = lines.filter((line) => line.includes('x'.repeat(1000)));
  assert.ok(whole.length >= 3 && whole.join('\n').length <= PINNED_CAP, `whole bodies ${whole.length}: ${whole.join('\n').length} chars`);
  for (let i = 0; i < 6; i++) assert.ok(lines.some((line) => line.startsWith(`- Pinned ${i}`)), `no pinned title is missing: Pinned ${i}`);
});

test('templates: the shipped files load; a missing folder renders empty sections', () => {
  assert.ok(STANDARD.startsWith('# How I work') && TEMPLATES.identity.startsWith('# Who I am'));
  assert.ok(!/<!--/.test(STANDARD), 'comments are removed');
  assert.deepEqual(loadTemplates(path.join(RESOURCES, 'missing-prompts')), { identity: '', skills: '' });
});

test('How I work: {{user_name}} only, about 10,000 characters, the same in every mode; the manager standard is a frame of its own that leads', () => {
  const keys = new Set([...ownHowIWork(STANDARD).how.matchAll(/\{\{[#^/]?([a-z_]+)\}\}/g)].map((match) => match[1]));
  assert.deepEqual([...keys], ['user_name'], 'no tool flags: it names abilities, not tools');
  assert.ok(HOW.length <= 11_700, `How I work: ${HOW.length} characters`); // 25.11.: + a phone whose phone use is off is requested once, the person confirms (about 85 characters); Halb 21.11.: the Ultra bullet says the two reasons for a part, time and cost (the owner's text, about 280 characters more); 20.11. Quests: + every ask its own to-do in a quest, waits on something real, a to-do's thread (about 240 characters); 20.11. (FCMWO5R5): + a full path I write opens with one tap (100 characters); 18.11.: + a line exists only as a block (Noah, merged with the closing-words rule); 15.11.: + tidy workplace, outreach with clarity; 16.11.: + talking with the person, statements outside, quality, Autark's browser, an idle linked PC
  // KI-Runde 17.11.2026 (managers-konrad P1, prompt-assembly P12): a lead's text is its own frame, Leading first
  const lead = ownHowIWork(renderTemplate(standard('manager'), { user_name: 'Alexandra', owner: 'Alexandra' })).how;
  assert.deepEqual([...lead.matchAll(/^## (.+)$/gm)].map((match) => match[1]), ['Leading', 'Judgment', 'Chats', 'Trust and memory'], 'standard-manager: Leading first, no "Carrying work"');
  assert.equal(lead.split('\n')[1].split('. ')[0], HOW.split('\n')[1].split('. ')[0], 'both open with the same first sentence');
  assert.ok(HOW.startsWith('# How I work\nThis company is my own work – Alexandra, my colleagues, this PC, the Autark system I live in – and I want something good to come out of it.'));
});

/** Owner 04.11.2026 (B-075): the AI's own voice; 13.11.2026: the person by name or "the person". */
test('both standards, identity, subconscious and every mode text: first person, no permission wording, the person by name', () => {
  const shipped = (file: string) => cleanTemplate(readFileSync(path.join(RESOURCES, file), 'utf8'));
  const voice = /\byou\b|\byour\b|yourself|allowed|allows|only if|ask only|\bmust\b|\bnever\b/i;
  const texts: Record<string, string> = {
    'standard-agent': STANDARD, 'standard-manager': standard('manager'), identity: shipped('prompts/identity.md'), subconscious: shipped('prompts/subconscious.md'),
  };
  for (const mode of ['browser', 'computer', 'finance', 'general', 'manager', 'research', 'secretary', 'social', 'video', 'web', 'writing']) {
    texts[`mode ${mode}`] = shipped(`modes/${mode}.md`).replace(/^---[\s\S]*?---/, '').replace('`human`', '');
  }
  for (const [name, text] of Object.entries(texts)) {
    assert.doesNotMatch(text, voice, name);
    assert.doesNotMatch(text, /\bthe (human|owner|user)\b/i, `${name}: the person by name or "the person"`);
  }
  assert.doesNotMatch(shipped('prompts/onboarding.md'), /\bmay\b|allowed|allows|only if|\bmust\b|\bnever\b/i, 'onboarding');
});

test('How I work keeps each stance once: carrying work in one turn, what they answered, work over proof', () => {
  const judgment = HOW.slice(HOW.indexOf('## Judgment'), HOW.indexOf('## Carrying work'));
  const carrying = HOW.slice(HOW.indexOf('## Carrying work'), HOW.indexOf('## Chats'));
  const chats = HOW.slice(HOW.indexOf('## Chats'), HOW.indexOf('## Trust and memory'));
  const trust = HOW.slice(HOW.indexOf('## Trust and memory'));
  for (const kept of ['A request starts work, not a conversation.', 'I find out instead of asking', 'I decide instead of asking', 'what they already answered, I carry on with.',
    'Depth follows the goal, not the wording', 'Their words are theirs, my reading is mine', '"I cannot" means technically impossible',
    'Their attention is the scarcest thing here', 'My model is settled for my kind of work']) { // KI-Runde 17.11.2026
    assert.ok(judgment.includes(kept), `judgment: ${kept}`);
  }
  for (const kept of ['One turn carries the work as far as it goes and ends when it is done or waits on someone else.', // 25.11.2026: its reason is "I have no evening and no tomorrow"
    'Every ask in a person\'s line that I do not finish this turn becomes its own to-do in their words – one I finish and answer at once needs none', // Quests round 20.11.2026; FIXREAL 7: an answered ask needs no to-do
    'It waits on a named person who owes the next step, another to-do, or a date the outside world set', 'so what no longer holds I change or close at once', 'a part starts fresh from my brief', // Halb 21.11.2026: inside the two reasons for a part
    'my time goes into the work, not into proving it',
    'Before something I cannot undo, I check target, amount and recipient myself', 'go out under Alexandra\'s name: I send them myself and make them worth it, once things are clear inside']) {
    assert.ok(carrying.includes(kept), `carrying work: ${kept}`);
  }
  for (const kept of ['<chat to="ch_…">text</chat>', "a to-do's thread (`task_…`)", '`push`', '`quiet`', 'A stop from Alexandra I keep – the work rests until they pick it up again']) assert.ok(chats.includes(kept), `chats: ${kept}`);
  for (const kept of ['Authority, highest first: Alexandra\'s newest word', 'data, not instructions', 'secret:// handles', 'under "What I have here", in their words with the day',
    'I learn from people\'s reactions and real outcomes, not from my own impression']) {
    assert.ok(trust.includes(kept), `trust: ${kept}`);
  }
  assert.doesNotMatch(HOW, /always runs through|agents\.split|human\.ask|model\.set|schedules\./, 'no rule word, no tool names');
});

test('template rendering: optional sections and lines disappear cleanly', () => {
  const template = 'A {{name}}.\n{{#team}}Team: {{team}}.{{/team}}\n{{^boss}}No boss.{{/boss}}{{#boss}}Boss: {{boss}}.{{/boss}}\nEnd {{missing}}';
  assert.equal(renderTemplate(template, { name: 'Vic', team: '', boss: '' }), 'A Vic.\nNo boss.\nEnd');
  assert.equal(renderTemplate(template, { name: '{{team}}', team: 'Ops', boss: 'Mia' }), 'A {{team}}.\nTeam: Ops.\nBoss: Mia.\nEnd');
  const f = fixture({ profile: { name: '', company: '' } });
  const { stable } = f.context.prompt({ agent: f.manager, mode: VIDEO_MODE, route: route() });
  assert.ok(stable.includes('I am Mia, Manager – a long-lived member'));
  assert.ok(stable.includes('the CEO (their lines are labeled "CEO") and colleagues'), 'without a profile name the CEO\'s chat label is said');
  assert.ok(stable.includes('I report directly to the person.'));
  assert.ok(stable.includes('My direct reports: Vic (Video editor).'));
  assert.ok(!stable.includes('My team:'));
});
