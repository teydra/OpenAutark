// KI-Runde 17.11.2026 (package T, contract 6.4): what the tool texts carry for a brief and for the one-line list –
// phone.say opens with the ask, phone.key names the app phone's keys with notifications, a note from a part wakes its
// origin for a whole turn, a part's brief names what it carries and its model the piece, tasks take an effort and no
// model (Quests round 20.11.2026: tasks.add and tasks.update with for), `at` is the person's time – work among agents starts
// now –, an ask I answer with questions is unfinished (its to-do waits on the person), one tasks.update carries words,
// owner, wait and the end; caps: a brief 12,000, a result 4,000.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneTools } from '../../../src/runtime/phone/tools.ts';
import { splitTools } from '../../../src/runtime/tools/builtin/agents-split.ts';
import { taskTools } from '../../../src/runtime/tools/builtin/tasks.ts';
import { brief } from '../../../src/runtime/tools/builtin/tools-meta.ts';
import { validate } from '../../../src/runtime/tools/validate.ts';
import { SPLIT_LIMITS } from '../../../src/shared/model/splits.ts';
import type { ToolDef } from '../../../src/runtime/tools/types.ts';

const byName = new Map<string, ToolDef>([...phoneTools({} as never), ...splitTools, ...taskTools].map((tool) => [tool.name, tool]));
const def = (name: string) => byName.get(name)!;
const prop = (name: string, key: string) => (def(name).inputSchema as { properties: Record<string, Record<string, unknown>> }).properties[key];
const props = (name: string) => Object.keys((def(name).inputSchema as { properties: Record<string, unknown> }).properties);

test('phone: the one-line list carries the ask and the notification key', () => {
  assert.match(brief(def('phone.say').description), /^Asks the person on their phone, or shows my line there, in the Autark app's bubble/); // the ask opens the one-liner
  assert.match(brief(def('phone.key').description), /notifications, which shows what just arrived/);
  assert.match(String(prop('phone.key', 'key').description), /^Autark app: wakeup, back, home, recents, notifications, quick_settings, enter\./);
  assert.match(brief(def('phone.ui_tree').description), /^Reads the phone screen/);
});

test('splits: a note from a part wakes the origin for a whole turn; the brief names what it carries, the model the piece; 12,000 characters', () => {
  assert.match(def('agents.split_tell').description, /a note wakes my origin for a whole turn/);
  assert.match(def('agents.split').description, /a note from one wakes me for a whole turn/);
  const part = (prop('agents.split', 'parts') as { items: { properties: Record<string, { description?: string; maxLength?: number }> } }).items.properties;
  assert.match(String(part.brief.description), /for whom and why, what good looks like, what is known and decided, how it checks its result itself/);
  // Halb 21.11.2026: the piece's hardest step is its needs; a model by name instead
  assert.match(String(part.needs.description), /^What the piece's hardest step asks of whoever does it\. check: .+ chain: .+ judgment: .+$/);
  assert.equal(part.model.description, 'A model by name instead; unset, needs decides.');
  assert.match(def('agents.split').description, /A fresh part runs on the model its needs asks for, not on mine\./);
  assert.equal(SPLIT_LIMITS.briefChars, 12_000);
  assert.equal(part.brief.maxLength, 12_000);
});

test('tasks: an effort and no model on add and update; at is the person\'s time; one update carries words, owner, wait and the end', () => {
  for (const name of ['tasks.add', 'tasks.update']) {
    assert.ok(!props(name).includes('model') && props(name).includes('effort'), name);
    assert.match(String(prop(name, 'at').description), /^When the person does it, as their own words or their assistant set it; work among agents starts now\./, name); // FIXREAL 1
    assert.ok(!props(name).includes('dueAt'), name);
  }
  assert.match(String(prop('tasks.add', 'quest').description), /"new" makes this item itself the quest: its title is the goal, not a step, it holds no time, and its to-dos follow with further tasks\.add \{quest: <its id>\}/); // FIXREAL 2
  assert.match(def('tasks.add').description, /An ask I answer with questions is unfinished: its to-do waits on the person\./); // FIXREAL2 4 (REAL-2: six questions, nothing stored)
  assert.ok(validate({ title: 'x', model: 'cheap' }, def('tasks.add').inputSchema).length > 0, 'a model is refused');
  for (const key of ['for', 'status', 'waiting', 'result', 'quest', 'after']) assert.ok(props('tasks.update').includes(key), key);
  assert.match(def('tasks.update').description, /the moment it stops being true I change it/);
  assert.equal(prop('tasks.update', 'result').maxLength, 4_000);
});
