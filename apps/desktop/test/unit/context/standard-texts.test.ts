// The texts every agent starts from, after the KI-Runde 17.11.2026 (texts package, v1 = draft-b as the frame with
// draft-a's sentences merged in): both standards say the round's thoughts once each – the person's world, their attention,
// their words, minutes, what reaches them, one voice, the report, the program's reminder, the settled model, a part that
// answers inside the turn – say only what the runtime does, and are not longer than on 17.11.
// Its place in the tree is test/unit/context/; TEXTS_DIR points it at another resources folder.
// Owns: these assertions only. Never: writes resources.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const RESOURCES = process.env.TEXTS_DIR ?? path.resolve(import.meta.dirname, '../../../resources');
const read = (file: string): string => readFileSync(path.join(RESOURCES, file), 'utf8');
/** What a model reads of a file: comments out, as cleanTemplate does. */
const clean = (text: string): string => text.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').trim();
/** "# How I work" of a standard, up to its role part, rendered for a person. */
const how = (file: string): string => {
  const text = clean(read(file)).replaceAll('{{user_name}}', 'Alexandra');
  return text.slice(0, text.indexOf('\n## My role')).trim();
};
const part = (text: string, from: string, to?: string): string => text.slice(text.indexOf(from), to ? text.indexOf(to) : undefined);
/** A skill with its line breaks folded, so a sentence is found across wrapped lines. */
const skill = (name: string): string => read(`skills/${name}/SKILL.md`).replace(/\s+/g, ' ');

const AGENT = how('prompts/standard-agent.md');
const LEAD = how('prompts/standard-manager.md');
const BOTH: Array<[string, string]> = [['standard-agent', AGENT], ['standard-manager', LEAD]];

test('their world is theirs to know: what the person says about it is the fact, a risk is named once (employees-real §5.1)', () => {
  for (const [name, text] of BOTH) {
    const judgment = part(text, '## Judgment', '## Chats');
    assert.ok(judgment.includes('Their world is theirs to know.'), name);
    assert.ok(judgment.includes('is the fact I work with – they see what I cannot'), name);
    assert.ok(judgment.includes('I bring once, in a line, when it could cost them something they cannot take back, and go on with what they said'), name);
  }
});

test('their attention is the scarcest thing: what they made and what I reach – the linked phone – come before a task for them, which takes them seconds (owner-voice 1, employees-real §5.2)', () => {
  for (const [name, text] of BOTH) {
    assert.ok(text.includes('Their attention is the scarcest thing here'), name);
    assert.ok(text.includes('first look for in what they already made and in what'), name);
    assert.ok(text.includes('their linked phone among it'), name);
    assert.match(text, /a phone with phone use off (I|we) request once, they confirm – the normal way/, `${name}: a phone without phone use is requested once, the person confirms (Stanislaus 25.11.2026 18:01)`);
    assert.equal(text.split('request once, they confirm').length, 2, `${name}: the phone line stands once`);
    assert.match(text, /a to-do for them comes after (my|our) own way was tried, with what (I|we) tried in it, and takes them seconds/, name);
    assert.ok(!text.includes("I plan it into Alexandra's day"), `${name}: a task for them is no first way`);
  }
  const handoff = skill('human-minimal-handoff');
  assert.doesNotMatch(handoff, /bank-2fa|vo-part2|Open your banking app|enter the code the shop sent/, 'no example asks for a code or an approval on their phone');
  assert.match(handoff, /An item goes on their list after my own way was tried, and says what I tried/);
  assert.match(handoff, /Their face and voice I first take from what they already recorded/);
});

test('their words are theirs, my reading is mine; what I learn is marked as mine (owner-voice 3, employees-real §5.3, §6.4)', () => {
  for (const [name, text] of BOTH) {
    assert.ok(text.includes('Their words are theirs, my reading is mine. A question of theirs gets an answer; an idea is direction, not an order or a checklist'), name);
    assert.ok(text.includes('What they leave to me I decide inside what they said before; I attribute to them only what they said'), name);
    assert.ok(text.includes('in their words with the day and nothing of mine added'), name);
    assert.ok(text.includes('what I learn I mark as mine, with its day'), name);
  }
  assert.ok(AGENT.includes('a wish worded as a question gets its first real part done'), 'a question gets an answer, a wish worded as one gets work');
  assert.ok(!AGENT.includes('a question about doing something'), 'no second rule for questions');
  const own = skill('system-prompt');
  assert.match(own, /verbatim, with the day and the chat line they said it in – nothing of mine beside them/);
  assert.match(own, /under the person's name stands only what they said/);
  assert.match(own, /A lesson of my own stands under my role, marked as mine with its day/);
  assert.doesNotMatch(own, /What to keep to|One line to my manager or the person|The wake says so|First task:/);
});

test('we work in minutes: a time on our work comes from outside, a wait names who or what, the turn ends with a critical look (owner-voice 4, employees-real §5.4; Stanislaus 25.11.2026, VORHER M1–M4)', () => {
  const carrying = part(AGENT, '## Carrying work', '## Chats');
  assert.ok(carrying.includes('We work in minutes; I have no evening and no tomorrow.'));
  assert.ok(carrying.includes('comes from a customer, a provider, a release or Alexandra; one I would set myself is work I do now'));
  assert.ok(carrying.includes('It waits on a named person who owes the next step, another to-do, or a date the outside world set; my own order, a test I could run or an unsent question is my next step.'));
  assert.ok(carrying.includes('let the answer wake me instead of a clock'));
  assert.ok(carrying.includes('what I cannot finish, my lead hears at once, with why'));
  const leading = part(LEAD, '## Leading', '## Judgment');
  assert.ok(leading.includes('We work in minutes; none of us has an evening or a tomorrow. A colleague starts when briefed, and a time on our work comes from a customer, a provider, a release or Alexandra, not from me.'));
  assert.ok(leading.includes('ten at once all have an owner before my turn ends. Their quest stays mine until its last to-do is closed'));
  assert.ok(leading.includes('wake us on the answer instead of a clock'));
  for (const [name, text] of BOTH) {
    assert.ok(text.includes('Alexandra steers and prompts;'), `${name}: the CEO steers, the team holds it together`);
    assert.ok(text.includes("two tries are a way's limit, then comes another way or a one-line question to whoever knows"), name);
    assert.ok(text.includes('the obvious way and two untried ones'), name);
    assert.ok(text.includes('anyone else waiting gets my finding as a block the moment I have it'), name);
    assert.doesNotMatch(text, /lies days out|it waits on something real|a note to myself now/, `${name}: the old wording is gone`);
  }
  assert.match(skill('task-ownership'), /My own order, a check I could run, an unsent question or a time I chose is my next step, taken now/);
  assert.doesNotMatch(skill('task-ownership'), /A later look is a note to myself/);
});

test('the organisation is as deep as its work, not two levels (Stanislaus 25.11.2026)', () => {
  assert.ok(part(LEAD, '## Leading', '## Judgment').includes('The organisation is as deep as its work'));
  assert.doesNotMatch(LEAD, /two levels|a lead under a lead is one more relay/);
  const org = skill('org-setup-onboarding');
  assert.doesNotMatch(org, /two levels/);
  assert.match(org, /\*\*A lead under me\*\* when results wait on my look for hours/);
  assert.match(org, /\*\*One level less\*\* when a lead has one doer/);
});

test('what reaches the person is a result, a question only they can answer or a step only they can take; the closing words answer them (chat-noise F2, F7)', () => {
  for (const [name, text] of BOTH) {
    const chats = part(text, '## Chats', '## Trust and memory');
    assert.ok(chats.includes('What reaches them is a result, a question only they can answer, or a step only they can take'), name);
    assert.ok(chats.includes('`quiet` for what happens on the way'), name);
    assert.ok(chats.includes("A turn a person's line started, in which I addressed nothing, answers them with its closing words"), name);
    assert.ok(chats.includes('silence means it stands in the chat'), name);
    assert.doesNotMatch(text, /say in a line what I started|say so in a line and act|`quiet` for the record|I write when something changed for them/, name);
  }
  const chats = skill('chats');
  assert.doesNotMatch(chats, /Everything I write is my thinking|person gets a push|`quiet` is for the record|my subconscious or I set it|Noted: Kim/);
  assert.match(chats, /a person sees it as a reply to them, and only `push` rings/, 'an @mention of the person no longer rings (contract 5.7)');
  assert.match(chats, /The model stays a wish on their line, since mine is settled/, 'the chat pick is information, never a route (routing/router.ts)');
  // review 2, 17.11.2026: one name for where a model starts, and it stays – as model.set and agents.update say
  assert.match(chats, /runs from my next context, or at once with `now`, which reads my whole context again, and it stays my model until I, my lead or the person names another/);
  assert.match(skill('app-guide'), /runs from my next context and stays my model until I, my lead or the person names another/);
});

test("one voice: the lead of a piece of work speaks to the person for it; the next round is the maker's (chat-noise F10, prompt-assembly P13)", () => {
  assert.ok(AGENT.includes('One voice for one piece of work. The one who leads it speaks to Alexandra for it; my result reaches them through that lead unless they asked me themselves, and when they react to a piece of mine, the next round is mine.'));
  assert.ok(LEAD.includes("a colleague's result reaches them through me, with who made it, unless they asked the colleague themselves"));
  assert.ok(LEAD.includes("the next round is the maker's"));
  assert.doesNotMatch(read('agents/manager.md'), /what matters across the areas reaches them through me|me included/);
  assert.doesNotMatch(read('agents/head.md'), /The personal manager is the person's contact across areas|everything else I do myself/);
});

test("a lead's text is its own frame: Leading first; its turns carry the brief, the decision and the look at what came back; a part answers inside the turn (managers-konrad P1, P2; managers-clara 7.1–7.6; CONTRACT-2 10)", () => {
  const headings = [...LEAD.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(headings, ['Leading', 'Judgment', 'Chats', 'Trust and memory']);
  const opener = LEAD.split('\n')[1];
  assert.ok(opener.includes('the brief, the decision, the look at what came back') && opener.includes('My turns carry those; colleagues and parts of me bring the hours, each on the model its piece needs.'), 'said once, in the opening');
  assert.equal(LEAD.split('colleagues and parts of me bring the hours').length, 2, 'the hours thought stands once');
  const leading = part(LEAD, '## Leading', '## Judgment');
  for (const kept of ['I lead through the brief.', 'What my brief states as fact I have seen', 'what I assume I mark as mine',
    'My hands are for what takes less doing than explaining', 'A look-up or check my next step needs I hand to a part and go on with its answer inside my turn.',
    "A model is chosen where a context starts – a part, a new colleague –: the smallest that does the piece's hardest step as well as the strongest would; for a part I name what that step asks (its needs), and its model follows from that.",
    'A model I set for a colleague runs from its next context and stays until it, I or the person names another.',
    'Proof belongs to the one who did the work', 'A result I take the way its audience meets it', 'a good result I close without a line',
    "becomes that colleague's to-do in their words – their line stays with it –", "Every ask in Alexandra's line that I do not finish this turn becomes its own to-do in their words – one I finish and answer at once needs none", 'A decision in my area is mine']) {
    assert.ok(leading.includes(kept), `leading: ${kept}`);
  }
  assert.ok(LEAD.includes('How freely I act toward people follows how well I know the matter'), 'the bullet stays in both standards');
  assert.ok(AGENT.includes('How freely I act toward people follows how well I know the matter'));
  for (const gone of ['thank for it', 'do less of the volume myself', 'I am no relay', 'what to avoid', 'I do it now and completely', 'or take it to Alexandra where only they can']) {
    assert.ok(!LEAD.includes(gone), `gone: ${gone}`);
  }
});

test("the task's result is the report; a line to a colleague wakes them for a whole turn (managers-konrad P5, managers-clara 7.3, managers-lukas-paula B)", () => {
  assert.ok(AGENT.includes("A to-do's result is my report to whoever gave it; a line beside it is for what they have to decide."));
  assert.ok(LEAD.includes("A to-do's result is my colleague's report to me; a line beside it is for what I have to decide."));
  for (const [name, text] of BOTH) assert.ok(text.includes('A line to a colleague wakes them for a whole turn, so it changes what they do; thanks rides inside such a line.'), name);
  assert.doesNotMatch(skill('team-coordination'), /Who to report to|short thanks is enough|I report back with the result|thank for what someone did/);
  assert.match(skill('team-coordination'), /\*\*How they check it\*\* themselves/);
  assert.match(skill('task-ownership'), /The task's result is my report/);
  assert.doesNotMatch(skill('task-ownership'), /`model\.set` need|Their line, the task's end or the until moves it on/);
  assert.match(skill('task-ownership'), /Their line wakes me with the task and I move it on/, "a person's line no longer reopens a waiting task (contract 5.8)");
});

test('the reminder is one clause; the model is settled; a part pays for time or for cost (research-harness F5; contract 3; CONTRACT-2 10; Halb 21.11.2026)', () => {
  for (const [name, text] of BOTH) {
    assert.equal(text.split('system reminder').length, 2, `${name}: the reminder stands once`);
    assert.ok(text.includes('a system reminder that someone has not heard from me means my run log, which shows my steps by itself'), name);
    assert.ok(!text.includes("Model and effort are my subconscious's call"), name);
  }
  assert.ok(AGENT.includes('My model is settled for my kind of work – another one would read my whole context again – and the effort follows each turn'));
  assert.ok(LEAD.includes('Mine is settled for leading; when my work outgrows it, I say so.'));
  // Halb 21.11.2026: the two reasons for a part, time and cost, as facts – and the piece that stays with me
  assert.ok(AGENT.includes('Two things make a piece worth a part. Time: it moves on without my next thought, so it runs beside me.'));
  assert.ok(AGENT.includes('everything I read lands in my context and is read again on each of my later steps, on my model'));
  assert.ok(AGENT.includes('So a piece whose bulk I will not need afterwards – what it reads, clicks through or tries on the way – goes to a part, and I say what its hardest step asks.'));
  assert.ok(AGENT.includes('A piece that takes less doing than explaining, or hangs on what I am learning right now, stays with me: a part costs a start and a brief.'));
  assert.match(skill('splitting'), /\*\*Cost\.\*\* Everything I read lands in my context/, 'the skill says the same reasons');
  assert.match(skill('briefing'), /For a fresh part I say that step as its `needs`/);
  assert.match(skill('splitting'), /with `wait: true`, the parts start at once and the call comes back with each part's closing words/);
  assert.doesNotMatch(skill('app-guide'), /Routing picks model, effort and account per turn|A mode switch hands over a short checkpoint/);
  assert.doesNotMatch(read('modes/general.md'), /another mode's tools/);
  assert.match(read('modes/general.md'), /Every tool is in my reach/);
});

test('own voice, the person by name, abilities instead of tools – and not longer than on 17.11.', () => {
  for (const [name, text] of BOTH) {
    assert.doesNotMatch(text, /\byou\b|\byour\b|yourself|allowed|allows|only if|ask only|\bmust\b|\bnever\b/i, name);
    assert.doesNotMatch(text, /\bthe (human|owner|user)\b/i, name);
    assert.doesNotMatch(text, /always runs through|agents\.split|human\.ask|model\.set|schedules\.|wf send/, name);
    assert.ok(!text.includes('{{'), `${name}: {{user_name}} only`);
  }
  assert.ok(AGENT.length <= 11_590, `standard-agent "# How I work": ${AGENT.length} (17.11.: 10,732; 18.11. with "a line exists only as a block": 10,972; 20.11. with "a full path I write … opens with one tap": 11,072; 20.11. Quests: every ask its own to-do in a quest, waits on something real, a to-do's thread: 11,310; 21.11. Halb: a part pays for time or for cost – the owner's Ultra bullet: 11,587; 25.11. minutes, waits, a critic's look, two tries – shorter: 11,529; 25.11. phone use off – request once, they confirm, with two trims elsewhere: back under 11,590)`);
  assert.ok(LEAD.length <= 14_125, `standard-manager "# How I work": ${LEAD.length} (17.11.: 13,885; 18.11.: 14,125)`);
  const files = ['prompts/standard-agent.md', 'prompts/standard-manager.md', 'modes/general.md', 'agents/manager.md', 'agents/head.md', 'agents/content-creator.md', 'agents/video-editor.md',
    ...['app-guide', 'briefing', 'chats', 'head-of-staff', 'human-minimal-handoff', 'leading-coding', 'money', 'org-setup-onboarding', 'splitting', 'system-prompt', 'task-ownership', 'team-coordination']
      .map((name) => `skills/${name}/SKILL.md`)];
  const total = files.reduce((sum, file) => sum + clean(read(file)).length, 0);
  assert.ok(total <= 97_500, `the nineteen changed texts as a model reads them: ${total} characters (17.11.: 95,729; 18.11. with "a line exists only as a block" in both standards and the chats skill: 96,576; 20.11. Quests – the asks paragraph in both standards, the quest skills: 96,860; 21.11. Halb – time and cost of a part in the standards, splitting and briefing, needs; 25.11. the phone line in both standards, paid for by two trims in the Chats bullets: back under 97,500)`);
});
