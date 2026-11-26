// The subconscious's loop (subconscious/flow.ts, service.ts ask, wake.ts) with a fake decision model and fake vector and memory
// services: the model writes its own query and places and picks; it writes memory itself; the loop's stops; the cheap content
// check; failure isolation; memory.browse and memory.read as the main AI's tools word them; v1 (14.11.2026): the agent's card in
// the system text (B-078: the main AI's whole stable prompt until then), its thoughts and the catalog's hits opening a step, and
// knowledge.open of a skill.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RESOURCES, fixture } from '../context/fixture.ts';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import { SubconsciousImpl } from '../../../src/runtime/subconscious/service.ts';
import { SkillLibrary } from '../../../src/runtime/skills/service.ts';
import { FLOW_TOOLS, type FlowRun } from '../../../src/runtime/subconscious/tools.ts';
import { memoryFolders, parseCall, runFlow } from '../../../src/runtime/subconscious/flow.ts';
import { folderText } from '../../../src/runtime/tools/builtin/memory.ts';
import { loadedSkillText } from '../../../src/runtime/tools/builtin/skills.ts';
import type { SkillInfo } from '../../../src/shared/model/knowledge.ts';
import { hasContent } from '../../../src/runtime/subconscious/wake.ts';
import { TRACE_TOKENS, capTrace } from '../../../src/shared/model/subconscious.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';
import { SYSTEM_ID } from '../../../src/shared/ids.ts';
import type { RouteRequest, RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Engine, EngineTurnInput } from '../../../src/runtime/engines/types.ts';
import type { MemoryFile, MemoryFolder, MemoryWriteInput } from '../../../src/shared/model/memory.ts';
import type { VectorSearchInput } from '../../../src/shared/model/vectors.ts';

type Call = Parameters<StructuredRunner>[0];
/** One scripted step: a tool call, or an error the model throws. */
type Scripted = { tool: string; args?: Record<string, unknown> } | Error;

/** A model answering step by step; after its script it says done. */
function brain(steps: Scripted[]) {
  const calls: Call[] = [];
  const runner: StructuredRunner = async (call) => {
    calls.push(call);
    const next = steps.shift() ?? { tool: 'done' };
    if (next instanceof Error) throw next;
    const structured = { tool: next.tool, args: JSON.stringify(next.args ?? {}) };
    return { text: JSON.stringify(structured), structured, by: 'fake' };
  };
  return { runner, calls };
}

function setup(options: { decision?: Scripted[]; embedder?: boolean } = {}) {
  const f = fixture();
  f.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
  const searches: VectorSearchInput[] = [];
  const written: MemoryWriteInput[] = [];
  Object.assign(f.services, {
    vectors: {
      available: () => options.embedder !== false,
      embed: async () => ({ embedded: 1, reembedded: 0, unchanged: 0, skipped: [] }),
      search: async (input: VectorSearchInput) => {
        searches.push(input);
        return {
          hits: [
            { path: 'memory/company/billing.md', chunk: 0, snippet: 'Invoices go out on the 3rd.', score: 0.9 },
            { path: 'memory/company/lunch.md', chunk: 0, snippet: 'Lunch is at noon.', score: 0.4 },
          ],
          searched: { places: input.in, embeddedFiles: 2 },
        };
      },
    },
  });
  Object.assign(f.services.knowledge as object, {
    search: async (query: { text: string; folders?: string[] }) => { // vector.search's memory places
      searches.push({ query: query.text, in: query.folders ?? [] });
      return [
        { item: { id: 'company:billing.md', title: 'Billing', body: 'Invoices go out on the 3rd.' }, score: 0.9, why: '' },
        { item: { id: 'company:lunch.md', title: 'Lunch', body: 'Lunch is at noon.' }, score: 0.4, why: '' },
      ];
    },
    memoryWrite: (input: MemoryWriteInput) => { written.push(input); return { path: `${input.folder}/x.md`, outcome: 'created' as const }; },
    memoryBrowse: () => ({ path: '', folders: [], files: [] }),
    memoryRead: () => undefined,
    memoryForget: () => ({ removed: true }),
  });
  const decision = brain(options.decision ?? []);
  const subconscious = new SubconsciousImpl({ services: () => f.services, runner: decision.runner });
  const chat = f.chats.create({ agentIds: [f.vid.id], createdBy: 'human' });
  /** The person writes `text` in the chat; the main AI asks its subconscious about it. */
  const ask = (text: string, question = text) => {
    f.chats.send({ conversationId: chat.id, authorId: 'human', body: text });
    return subconscious.ask({ agent: f.vid, conversationId: chat.id, ask: question });
  };
  return { f, decision, subconscious, chat, ask, searches, written };
}

test('the decision model writes its own query and places, picks a hit; the answer holds only that hit', async () => {
  const t = setup({ decision: [
    { tool: 'vector.search', args: { query: 'when do invoices go out', in: ['memory/company'] } },
    { tool: 'done', args: { show: ['h1'] } },
  ] });
  const answer = await t.ask('Wann schicken wir die Rechnungen raus?');
  assert.deepEqual(t.searches, [{ query: 'when do invoices go out', in: ['memory/company'] }]);
  assert.ok(answer.includes('Invoices go out on the 3rd.'), answer);
  assert.ok(!answer.includes('Lunch'), 'what it did not pick stays out');
  assert.ok(t.decision.calls[1].prompt.includes('h1 (0.90) memory/company/billing.md'), 'the result comes back to the model');
  assert.ok(t.decision.calls[0].prompt.includes('The main AI asks: Wann schicken wir'));
  assert.ok(t.decision.calls[0].prompt.includes('Wann schicken wir'));
});

test('a search it does not pick shows nothing at all', async () => {
  const t = setup({ decision: [{ tool: 'vector.search', args: { query: 'x y', in: ['memory'] } }, { tool: 'done' }, { tool: 'done' }] });
  assert.equal(await t.ask('Wie heißt unser Steuerberater?'), 'The subconscious has nothing to add.');
});

test('one model writes memory itself and sees its own step; there is no route and no second brain', async () => {
  const t = setup({ decision: [{ tool: 'memory.write', args: { title: 'Steuerberater von Alex', text: 'Jonas Weber in Bonn.', folder: 'company' } }, { tool: 'done', args: { answer: 'Notiert.' } }] });
  await t.ask('Unser Steuerberater ist Jonas Weber in Bonn.', 'Halte den Steuerberater fest.');
  assert.equal(t.decision.calls.length, 2);
  assert.deepEqual(t.written.map((item) => [item.title, item.folder]), [['Steuerberater von Alex', 'company']]);
  assert.equal(t.decision.calls[0].effort, undefined, 'the Decisions use sets its own effort');
  assert.ok(t.decision.calls[1].prompt.includes('[1] memory.write'), t.decision.calls[1].prompt);
  assert.ok(!t.decision.calls[0].prompt.includes('I am:') && !t.decision.calls[0].system.includes('two brains'));
  assert.ok(!FLOW_TOOLS.some((tool) => tool.name === 'route'));
});

test('the loop stops at done and at its maximum of steps', async () => {
  const f = fixture();
  f.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
  const input = { agent: f.vid, thread: 't', maxSteps: 3 };
  const atDone = brain([{ tool: 'done', args: { answer: 'x' } }]);
  assert.deepEqual([(await runFlow(f.services, atDone.runner, input)).end, atDone.calls.length], ['done', 1]);
  const endless = brain(Array.from({ length: 9 }, () => ({ tool: 'memory.browse' })));
  const result = await runFlow(f.services, endless.runner, input);
  assert.deepEqual([result.end, result.steps, endless.calls.length], ['steps', 3, 3]);
});

test("before a turn without anyone's words: no model and no wait; only what was kept", async () => {
  const t = setup({ decision: [{ tool: 'done' }] });
  assert.equal(await t.subconscious.beforeTurn({ agent: t.f.vid, thread: 'main' }), undefined);
  assert.equal(t.decision.calls.length, 0);
  assert.equal(t.searches.length, 0, 'nothing searches on its own');
});

test('the cheap content check: never "ja bitte", a go-ahead or thanks', () => {
  for (const text of ['ja bitte', 'mach das', 'ok', 'Ja', 'passt', 'danke!', 'weiter', 'Ja, mach das bitte so.', 'go ahead and do it']) assert.equal(hasContent(text), false, text);
  for (const text of ['Rechnung an Müller schreiben', 'Wie heißt unser Steuerberater?', 'Steuerberater']) assert.equal(hasContent(text), true, text);
});

test('failures stay inside: a throwing brain or tool ends or informs the run, never the main AI\'s call', async () => {
  const t = setup({ decision: [new Error('model down'), new Error('model down')] });
  assert.equal(await t.ask('Unser Steuerberater ist Jonas Weber.'), 'The subconscious could not answer in time.');

  const told = setup({ decision: [{ tool: 'agent.tell', args: { text: 'Eine Notiz.' } }, new Error('model down'), new Error('model down')] });
  assert.equal(await told.ask('Rechnung an Müller schreiben'), 'Eine Notiz.', 'what it had stays');

  const broken = setup({ decision: [{ tool: 'memory.write', args: { title: 'T', text: 'x' } }, { tool: 'no.such', args: {} }, { tool: 'done', args: { answer: 'x' } }] });
  (broken.f.services.knowledge as unknown as { memoryWrite: unknown }).memoryWrite = () => { throw new Error('disk full'); };
  await broken.ask('Unser Steuerberater ist Jonas Weber.');
  assert.ok(broken.decision.calls[1].prompt.includes('memory.write failed: disk full'), 'the failing tool answers as text');
  assert.ok(broken.decision.calls[2].prompt.includes('Unknown tool no.such.'));

  const babble = brain([]);
  const nonsense: StructuredRunner = async (call) => { babble.calls.push(call); return { text: 'I think nothing.', by: 'fake' }; };
  const end = await runFlow(broken.f.services, nonsense, { agent: broken.f.vid, thread: 't' });
  assert.deepEqual([end.end, babble.calls.length], ['failed', 2]);
});

test('no model: nothing runs, nothing throws, and the main AI is told so when it asks', async () => {
  const f = fixture();
  f.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
  const subconscious = new SubconsciousImpl({ services: () => f.services, runner: false });
  assert.match(await subconscious.ask({ agent: f.vid, ask: 'Was weißt du über Rechnungen?' }), /no model/);
});

test('the prompt holds the tool list generated from the tools, and no list of memory: only the folders to write in', async () => {
  const t = setup({ decision: [{ tool: 'done' }] });
  await t.subconscious.ask({ agent: t.f.vid, ask: 'Was weißt du über Rechnungen?', context: 'none' });
  const { system, prompt, schema } = t.decision.calls[0];
  for (const tool of FLOW_TOOLS) assert.ok(system.includes(`- ${tool.name} ${tool.args} – ${tool.line}`), tool.name);
  assert.ok(!system.includes('{{tools}}'));
  assert.deepEqual((schema as { properties: { tool: { enum: string[] } } }).properties.tool.enum, FLOW_TOOLS.map((tool) => tool.name));
  assert.ok(prompt.includes(memoryFolders(t.f.vid).join(', ')));
});

test('brain answers: structured or text, args as JSON text or object; anything else is no call', () => {
  assert.deepEqual(parseCall({ text: '', structured: { tool: 'done', args: '{"show":["h1"]}' } }), { tool: 'done', args: { show: ['h1'] } });
  assert.deepEqual(parseCall({ text: 'Here: {"tool":"done","args":{"answer":"x"}}' }), { tool: 'done', args: { answer: 'x' } });
  assert.equal(parseCall({ text: 'nothing' }), undefined);
  assert.equal(parseCall({ text: '', structured: { tool: 'done', args: 'not json' } }), undefined);
});

test('a trace stays within its cap: the first calls first, cut rather than overflowing', () => {
  const long = 'x'.repeat(TRACE_TOKENS * 10);
  const capped = capTrace({ calls: [{ tool: 'subconscious', args: {}, output: 'kurz' }, { tool: 'vector.search', args: { query: 'q' }, output: long }, { tool: 'agent.tell', args: {}, output: 'gone' }] });
  assert.deepEqual(capped.calls.map((call) => call.tool), ['subconscious', 'vector.search']);
  assert.ok(JSON.stringify(capped).length <= TRACE_TOKENS * 4 + 120);
  assert.ok(capped.calls[1].output.endsWith('… [cut]'));
});

test('on real routes every step routes as the runtime (the Decisions use)', async () => {
  const f = fixture();
  f.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
  const asked: RouteRequest[] = [];
  const replies = [{ tool: 'nothing', args: '{}' }, { tool: 'done', args: '{}' }, { tool: 'done', args: '{}' }];
  const engine = { run: async (input: EngineTurnInput) => ({ text: '', structured: replies.shift(), stop: 'done' as const }) } as unknown as Engine;
  Object.assign(f.services, {
    router: { route: async (request: RouteRequest) => { asked.push(request); return { modelId: 'codex:luna', engine: 'codex', accountId: 'acc_1', effort: 'low', category: 'cheap-chat', reason: '', by: 'rules', alternatives: [] }; } },
    engines: { get: () => engine },
    accounts: { get: () => ({ id: 'acc_1' }), updateLimits: () => {}, markLimited: () => {}, markUnavailable: () => false },
    catalog: { get: () => ({ id: 'codex:luna', model: 'luna', efforts: ['low'] }), list: () => [{ available: true }] },
    paths: { temp: tmpdir() },
  } as unknown as Partial<RuntimeServices>);
  const subconscious = new SubconsciousImpl({ services: () => f.services });
  const answer = await subconscious.ask({ agent: f.vid, ask: 'Was weißt du über Rechnungen?', context: 'none' });
  assert.equal(answer, 'The subconscious has nothing to add.');
  assert.equal(asked.length, 3, 'told once that an empty done is no answer');
  for (const request of asked) {
    assert.equal(request.agent.id, SYSTEM_ID, 'the decision model: the Decisions use');
    assert.equal(request.previous, undefined, 'no effort of its own asked');
  }
});

test('memory.browse answers as the main AI\'s memory.browse (clipped), memory.read with the description', async () => {
  const t = setup();
  const file = (index: number, description?: string) => ({ path: `company/customers/c${index}.md`, title: `Customer ${index}`, ...(description ? { description } : {}), updated: Date.UTC(2026, 9, 1) });
  const folder: MemoryFolder = { path: 'company/customers', description: 'Who buys from us.', folders: [], files: [file(1, 'When an invoice to Müller is due.'), file(2)] };
  const big: MemoryFolder = { ...folder, files: Array.from({ length: 100 }, (_, index) => file(index, `When order ${index} is due, and what it needs.`)), more: true };
  const read: MemoryFile = { path: 'company/customers/c1.md', title: 'Customer 1', description: 'When an invoice to Müller is due.', text: 'Zahlt spät.', updated: 0 };
  let shown = folder;
  Object.assign(t.f.services.knowledge as object, { memoryBrowse: () => shown, memoryRead: () => read });
  const run = { services: t.f.services } as unknown as FlowRun;
  const tool = (name: string) => FLOW_TOOLS.find((entry) => entry.name === name)!;
  assert.equal(await tool('memory.browse').run({ folder: 'company/customers' }, run), folderText(folder));
  shown = big;
  const cut = await tool('memory.browse').run({}, run);
  assert.ok(cut.endsWith(' …') && folderText(big).startsWith(cut.slice(0, -2)) && cut.length < folderText(big).length, cut);
  assert.equal(await tool('memory.read').run({ path: 'company/customers/c1.md' }, run), 'Customer 1\nWhen an invoice to Müller is due.\nZahlt spät.');
});

test('B-080: memory.read pages a long file like knowledge.open – a 9,000-character file in three pages, each naming what follows', async () => {
  const t = setup();
  const long: MemoryFile = { path: 'company/long.md', title: 'Long', text: 'l'.repeat(9000), updated: 0 };
  Object.assign(t.f.services.knowledge as object, { memoryRead: () => long });
  const run = { services: t.f.services } as unknown as FlowRun;
  const read = FLOW_TOOLS.find((entry) => entry.name === 'memory.read')!;
  assert.match(read.line, /^One memory file, 3600 characters from the character "from"\.$/);
  const text = `Long\n${long.text}`;
  assert.equal(await read.run({ path: long.path }, run), `${text.slice(0, 3600)}\n[… ${text.length - 3600} more characters, from 3600]`);
  assert.equal(await read.run({ path: long.path, from: 3600 }, run), `${text.slice(3600, 7200)}\n[… ${text.length - 7200} more characters, from 7200]`);
  assert.equal(await read.run({ path: long.path, from: 7200 }, run), text.slice(7200));
});

const skill = (name: string, extra: Partial<SkillInfo> = {}): SkillInfo => ({ name, description: `When ${name.replace(/-/g, ' ')} is the work.`, source: 'builtin', path: `/skills/${name}`, modes: [], updatedAt: 0, ...extra });

test('v1: the agent\'s card follows the subconscious\'s own text in every step – stable first, the main AI\'s prompt no more; its thoughts and the catalog open the step', async () => {
  const t = setup();
  t.f.services.skills = new SkillLibrary({ paths: { workspace: path.join(tmpdir(), 'no-workspace-b078'), resources: RESOURCES }, clock: t.f.services.clock, home: '' });
  Object.assign(t.f.services.knowledge as object, {
    memoryRead: (file: string) => (file === `agents/${t.f.vid.id}/thoughts.md` ? { path: file, title: 'Thoughts', text: '- 2026-11-01: invoices late again\n- 2026-11-02: Vic likes short cuts', updated: 0 } : undefined),
  });
  const agent = { ...t.f.vid, instructions: '## My role\nIch schneide die Videos des Kanals.\n\n## What I have here\n- Alex 12.11.: Beim Schneiden gerne mit opus high.\n- Rechnungen gehen am 3. raus.' };
  t.f.services.runs.start({ id: 'run_on', agentId: agent.id, conversationId: t.chat.id, trigger: 'message' });
  t.f.services.runs.finish('run_on', { status: 'done', engine: 'codex', model: 'codex:gpt-6.1-sol', effort: 'high', inputTokens: 84_000, modelCalls: 2 });
  const task = t.f.tasks.create({ conversationId: t.chat.id, title: 'Intro schneiden', assigneeId: agent.id, createdBy: 'human' });
  t.f.chats.send({ conversationId: t.chat.id, authorId: 'human', body: '@Vic schneid das Intro', model: 'codex:luna', effort: 'low' });
  const two = brain([{ tool: 'memory.browse' }, { tool: 'done', args: { answer: 'x' } }]);
  await runFlow(t.f.services, two.runner, { agent, conversationId: t.chat.id, taskId: task.id, thread: 'main', mode: 'video', context: 'Person: render the remotion video with captions' });
  const [first, second] = two.calls;
  const card = first.system.slice(first.system.indexOf('# The agent I work beside'));
  assert.equal(card, [
    '# The agent I work beside',
    'Vic – Video editor, team Marketing; it works in the mode Video.',
    '',
    'What it has here – its standing facts and agreements with the person (its SYSTEM.md):',
    '- Alex 12.11.: Beim Schneiden gerne mit opus high.',
    '- Rechnungen gehen am 3. raus.',
    '',
    '## Now',
    '- It runs on codex · GPT-6.1 Sol · effort high.',
    '- Its task: "Intro schneiden" (open).',
    '- Alex picked Luna · effort low for it for their newest message – what they want now.', // 26.11.: the pick is made for one message
    '- Its context: about 42k tokens per model call.',
  ].join('\n'));
  assert.ok(!first.system.includes('Ich schneide die Videos') && !first.system.includes('# How I work') && !first.system.includes('<main-ai-prompt>'), 'its role text and the main AI\'s prompt stay out');
  assert.equal(first.system, second.system, 'the same system text in every step: its prefix caches');
  assert.ok(first.prompt.includes('My newest kept thoughts:\n- 2026-11-01: invoices late again\n- 2026-11-02: Vic likes short cuts'), first.prompt);
  assert.ok(/What the knowledge catalog holds[^\n]*\n[\s\S]*remotion-video/.test(first.prompt), first.prompt);
  assert.equal(first.temperature, 0.2, 'the model is asked for a low temperature');
});

test('knowledge.open opens one of the agent\'s skills whole on its route, a page at a time', async () => {
  const t = setup();
  const short = { info: skill('memory-hygiene'), body: 'Tidy memory now and then.' };
  const long = { info: skill('writing-skills'), body: 'w'.repeat(9000) };
  const asked: Array<[string, string | undefined]> = [];
  Object.assign(t.f.services, { skills: { ...t.f.services.skills, get: (name: string, viewerId?: string) => { asked.push([name, viewerId]); return [short, long].find((entry) => entry.info.name === name); } } });
  const run = { services: t.f.services, agent: t.f.vid } as unknown as FlowRun;
  const load = FLOW_TOOLS.find((entry) => entry.name === 'knowledge.open')!;
  assert.equal(await load.run({ name: 'memory-hygiene' }, run), loadedSkillText(short));
  assert.deepEqual(asked, [['memory-hygiene', t.f.vid.id]], 'the main AI\'s route');
  const text = loadedSkillText(long);
  assert.equal(await load.run({ name: 'writing-skills' }, run), `${text.slice(0, 3600)}\n[… ${text.length - 3600} more characters, from 3600]`);
  assert.equal(await load.run({ name: 'writing-skills', from: 3600 }, run), `${text.slice(3600, 7200)}\n[… ${text.length - 7200} more characters, from 7200]`);
  assert.equal(await load.run({ name: 'writing-skills', from: 7200 }, run), text.slice(7200));
  assert.equal(await load.run({ name: 'x' }, run), 'No skill x.');
  assert.equal(await load.run({}, run), 'knowledge.open needs a name.');
});
