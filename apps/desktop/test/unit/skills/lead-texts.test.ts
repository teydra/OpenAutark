// KI-Runde 17.11.2026 (texts v1: draft-b's test, fitted to the merged texts): the skills and role templates a lead and its colleagues read say what the standards say – a lead
// leads through its brief, proof belongs to the maker, the model is chosen where a context starts and a colleague keeps
// it, the task's result is the report, one voice toward the person, the person's attention after our own ways, the
// person's words kept verbatim in a SYSTEM.md. Evidence: the maintainers'
// readings of real managers' and employees' runs (kept private).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const RESOURCES = path.resolve(import.meta.dirname, '../../../resources');
/** A shipped text with its line breaks folded, so a sentence can be found across wrapped lines. */
const text = (file: string) => readFileSync(path.join(RESOURCES, file), 'utf8').replace(/\s+/g, ' ');
const skill = (name: string) => text(`skills/${name}/SKILL.md`);

test('a lead leads through its brief: no "me included", proof with the maker, a good result closed without a line', () => {
  assert.doesNotMatch(text('agents/manager.md'), /me included/);
  assert.doesNotMatch(text('agents/head.md'), /everything else I do myself/);
  assert.match(text('agents/head.md'), /For my area I speak to the person myself/, 'one voice: the head speaks for its area');
  assert.doesNotMatch(text('agents/manager.md'), /what matters across the areas reaches them through me/);
  assert.doesNotMatch(skill('head-of-staff'), /often me|report in a line|thank for the result/);
  assert.doesNotMatch(skill('leading-coding'), /I run or read the proof myself|code runs on a strong model with high or xhigh/);
  assert.match(skill('leading-coding'), /Proof belongs to the one who built it/);
  assert.match(skill('briefing'), /A good result I close without a line/);
  assert.match(skill('briefing'), /What I state as fact I have seen/);
  assert.match(skill('briefing'), /the way its audience meets it/);
});

test('the model is chosen where a context starts and a colleague keeps it', () => {
  assert.doesNotMatch(skill('briefing'), /leaving its model unset keeps mine/);
  assert.match(skill('briefing'), /A colleague keeps its model, because its context lives there/);
  assert.doesNotMatch(skill('org-setup-onboarding'), /runs on the same models as I do/);
  assert.match(skill('org-setup-onboarding'), /runs on the model its kind of work needs, which I name when I hire it/);
  assert.doesNotMatch(skill('task-ownership'), /the team's routing picks it/);
});

test('one report, one voice, a quiet way: the task\'s result reports, the closing words answer, status stays quiet', () => {
  const team = skill('team-coordination');
  assert.doesNotMatch(team, /Who to report to|a short thanks is enough|One thanks with the result is enough/);
  assert.match(team, /Its result is the report/);
  assert.doesNotMatch(team, /The lead of a piece of work speaks to them for it/, 'stands once, in both standards (25.11.2026)');
  assert.match(text('prompts/standard-agent.md'), /The one who leads it speaks to \{\{user_name\}\} for it; my result reaches them through that lead unless they asked me themselves/);
  assert.match(text('prompts/standard-manager.md'), /As its lead I speak to \{\{user_name\}\} for it; a colleague's result reaches them through me/);
  const chats = skill('chats');
  assert.doesNotMatch(chats, /Everything I write is my thinking|not saved up for the end|`quiet` is for the record/);
  assert.match(chats, /a turn a person's line started, in which I addressed nothing, answers them with its closing words/);
  assert.match(chats, /the next round is the maker's/);
  assert.doesNotMatch(chats, /my subconscious or I set it/);
});

test('the person\'s attention comes after our own ways; the examples ask only what is truly theirs', () => {
  const handoff = skill('human-minimal-handoff');
  assert.doesNotMatch(handoff, /Open your banking app|enter the code the shop sent to your phone|code only their phone or device has/);
  assert.match(handoff, /An item goes on their list after my own way was tried, and says what I tried/);
  assert.match(skill('team-coordination'), /with what we tried/);
  assert.match(skill('head-of-staff'), /says what we tried/);
  assert.match(handoff, /A task the person wrote stays theirs/); // no longer in How I work (25.11.2026)
  assert.doesNotMatch(text('agents/video-editor.md'), /When I need human footage or voice/);
  assert.match(text('agents/video-editor.md'), /I first take from what they already made/);
  assert.match(text('agents/content-creator.md'), /I first take from what they already recorded/);
});

test('a SYSTEM.md keeps the person\'s words verbatim, my lessons marked as mine; no line to the person about it', () => {
  const own = skill('system-prompt');
  assert.doesNotMatch(own, /One line to my manager or the person|The wake says so|\*\*First task:\*\*/);
  assert.match(own, /verbatim, with the day and the chat line they said it in – nothing of mine beside them/);
  assert.match(own, /A lesson of my own stands under my role, marked as mine/);
  assert.match(own, /The first piece of work goes to them as a task of its own/);
  assert.doesNotMatch(skill('org-setup-onboarding'), /gets one wake to look at the new one|when its mode is manager|I thank for what they did/);
  assert.match(skill('briefing'), /how they check it themselves before it comes/);
  assert.match(skill('briefing'), /The person's words as they said them, with the day/);
  assert.doesNotMatch(skill('briefing'), /The model is part of the brief/);
});

// Team-Call 21.11.2026 (owner: the first manager put manager-like agents on level two): "a colleague for an area that
// stays" in both standards and team-coordination made every hire an area of its own, so a doer with helpers led like a head.
// 25.11.2026 (Konrad's brief): the depth follows the amount of work – a head per area, topic leads under it where much comes in, a lead is no relay.
test('the organisation is as deep as its work: a head per area, topic leads where much comes in; the shape is explained and another proposed', () => {
  const lead = text('prompts/standard-manager.md');
  assert.match(lead, /The organisation is as deep as its work: a head per area with steady work/);
  assert.match(lead, /topic leads under a head once its area takes in more than it can brief and check itself/);
  assert.match(lead, /I explain this shape to whoever builds the team with me – \{\{user_name\}\}, an employee – and propose another before I build it/);
  assert.match(skill('org-setup-onboarding'), /depth follows the\s+amount of work/);
  assert.match(skill('org-setup-onboarding'), /A lead under me\*\* when results wait on my look for hours/);
  assert.match(skill('org-setup-onboarding'), /One level less\*\* when a lead has one doer or passes work on unchanged: a relay/);
  assert.match(skill('org-setup-onboarding'), /propose\s+another one before I build it; the shape they choose stands/);
  for (const file of ['prompts/standard-manager.md', 'prompts/standard-agent.md', 'skills/team-coordination/SKILL.md', 'agents/manager.md'])
    assert.doesNotMatch(text(file), /for an area that stays|I make its head|builds its own area|for example programming or social media/, file);
});
