// B-049 F4 (TOOLS-CORE) – core sets and the engine offer, over the real shipped modes and tool groups:
// - every core name of every shipped mode is a real tool with a reason; each mode's direct offer is small and
//   holds the contract's always-list (where the mode allows it) plus tools.find / tools.call;
// - offerFor keeps specsFor's order, adds the execution core for engines without own tools, learned names only
//   where the mode allows them; shell.exec stays reachable for CLI engines (a linked PC's terminal); the manager keeps
//   its org tools directly;
// - the has_* flags and the environment stay truthful: tools reachable through tools.call count, and one line says so;
// - B-050 K10: chat.read and chat.direct are direct in every mode that allows them, together under 600 tokens of spec.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import { builtinTools } from '../../../src/runtime/tools/builtin/index.ts';
import { deviceTools } from '../../../src/runtime/devices/tools.ts';
import { BASE_CORE, CALL_TOOL, FIND_TOOL, MODE_CORE, coreNames, coreReason } from '../../../src/runtime/tools/core-sets.ts';
import { MORE_TOOLS_HEADER, moreToolsSection, rankTools } from '../../../src/runtime/tools/builtin/tools-meta.ts';
import { environmentSection } from '../../../src/runtime/context/environment.ts';
import { ModeLibrary } from '../../../src/runtime/modes/service.ts';
import { ManualClock } from '../fakes.ts';
import { agent } from '../chat/harness.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolSpec } from '../../../src/runtime/tools/types.ts';

/** Names a core set may carry before their tool exists (offered once it does). */
const PENDING = new Set<string>();
const CODEX = { ownTools: true, via: 'native' as const };
const HUB = { ownTools: true, via: 'mcp' as const };
const HTTP = { ownTools: false, via: 'native' as const };
const ALWAYS = ['tasks.add', 'tasks.update', 'tasks.list', 'tasks.remind', 'chat.read', 'chat.direct', 'web.fetch', 'knowledge.find', 'knowledge.open'];
/** Direct only for an engine without its own file and web tools (Claude Code and Codex bring theirs). */
const OWN_ENGINE_HAS = ['files.read', 'files.search', 'web.search'];

function rig() {
  const stub = new Proxy({}, { get: () => () => undefined }) as never;
  const services = { org: { list: () => [], get: () => undefined }, log: { debug() {}, info() {}, warn() {}, error() {} } } as unknown as RuntimeServices;
  const registry = new Registry({ services: () => services });
  for (const tool of [...builtinTools(), ...deviceTools({ computer: stub, browser: stub, phone: stub })]) registry.register(tool);
  const modes = new ModeLibrary({ resources: path.resolve('resources'), clock: new ManualClock() });
  const agentIn = (mode: string) => agent(`ag_${mode}`, 'X', { mode });
  return { registry, modes, agentIn, services };
}

const names = (specs: ToolSpec[]) => specs.map((spec) => spec.name);
const chars = (specs: ToolSpec[]) => specs.reduce((sum, spec) => sum + JSON.stringify(spec).length, 0);

test('every core name is a real tool with a reason; each mode offers a small core with the meta tools', () => {
  const { registry, modes, agentIn } = rig();
  const keys = modes.list().map((mode) => mode.key);
  assert.ok(keys.length >= 11, 'the shipped modes');
  for (const key of keys) {
    const mode = modes.get(key);
    for (const name of coreNames(mode, HTTP)) {
      if (!PENDING.has(name)) assert.ok(registry.get(name), `${key}: core tool ${name} exists`);
      assert.ok(coreReason(mode, name), `${key}: ${name} says why it is direct`);
    }
    const all = registry.specsFor(agentIn(key), mode, CODEX);
    const offer = registry.offerFor(agentIn(key), mode, CODEX);
    // 24 before skills.find (F5) joined the base – social had 25 since – and B-050 K10 added chat.read and chat.direct;
    // B-057's agents.split is no core tool (owner 30.10.2026: the agent does not need it all the time – tools.find reaches it).
    assert.ok(offer.length <= 27, `${key}: ${offer.length} direct tools`);
    assert.ok(chars(offer) < chars(all) / 2, `${key}: the direct offer is far smaller than everything the mode allows`);
    assert.ok(names(offer).includes(FIND_TOOL) && names(offer).includes(CALL_TOOL), `${key}: tools.find and tools.call`);
    const allowed = new Set(names(all));
    for (const name of ALWAYS) if (allowed.has(name)) assert.ok(names(offer).includes(name), `${key}: ${name} is always direct`);
    assert.deepEqual(names(offer), names(all).filter((name) => names(offer).includes(name)), `${key}: specsFor order (prompt caching)`);
  }
  for (const name of ALWAYS) assert.ok(Object.hasOwn(BASE_CORE, name), `${name} is in the base`);
});

test('offerFor: the engine decides the execution core (every engine reaches the rest); learned names join where the mode allows them', () => {
  const { registry, modes, agentIn } = rig();
  const general = modes.get('general');
  const tom = agentIn('general');
  const codex = names(registry.offerFor(tom, general, CODEX));
  const hub = names(registry.offerFor(tom, general, HUB));
  const http = names(registry.offerFor(tom, general, HTTP));
  assert.ok(!codex.includes('files.write') && codex.includes('shell.exec'), 'Codex brings its own file tools; shell.exec is in the base core (a linked PC, a stored secret – KI-Runde 17.11.2026)');
  assert.ok(!hub.includes('files.write'), 'the hub engine brings its own tools too');
  assert.ok(http.includes('files.write') && http.includes('shell.exec') && http.includes('files.list'), 'an engine without own tools gets ours');
  for (const name of OWN_ENGINE_HAS) {
    assert.ok(http.includes(name), `HTTP: ${name} direct`);
    assert.ok(!codex.includes(name) && !hub.includes(name), `Claude/Codex: ${name} only through tools.call (they read, search and browse with their own)`);
  }
  // 04.11.2026: a linked PC's terminal for every engine – direct since KI-Runde 17.11.2026 (25 lookups by name).
  // B-080 (exec-env-gaps): files.write too – a screenshot's bytes leave a Codex script through it, not the command line.
  for (const engine of [CODEX, HUB]) {
    const reachable = registry.specsFor(tom, general, engine);
    assert.ok(names(reachable).includes('shell.exec') && names(reachable).includes('files.write'), 'shell.exec and files.write reachable');
    assert.equal(rankTools(reachable, 'run a command in the terminal of my linked pc', 1)[0]?.name, 'shell.exec', 'tools.find finds it');
    assert.equal(rankTools(reachable, 'save a screenshot image to a file', 1)[0]?.name, 'files.write', 'tools.find finds files.write for bytes');
    for (const query of ['run a command', 'terminal command', 'run a powershell script']) assert.equal(rankTools(reachable, query, 1)[0]?.name, 'shell.exec', query);
  }
  assert.ok(codex.includes('tasks.remind') && !codex.includes('calendar.list') && names(registry.specsFor(tom, general, CODEX)).includes('calendar.list'), 'tasks.remind is direct, the calendar reachable');

  const learned = names(registry.offerFor(tom, general, CODEX, ['calendar.list', 'computer.click', 'phone.say', 'no.such']));
  assert.ok(learned.includes('calendar.list') && learned.includes('computer.click'), 'a learned tool joins, in every mode');
  assert.ok(!learned.includes('phone.say') && !learned.includes('no.such'), 'never one that cannot work here');

  const writing = names(registry.offerFor(agentIn('writing'), modes.get('writing'), CODEX));
  assert.ok(!writing.includes('ui.help') && !writing.includes('agents.handoff'), 'writing has no general essentials');
});


test('tools reachable through tools.call count as offered; the prompt lists the usual tools in one line', () => {
  const { registry, modes, agentIn, services } = rig();
  Object.assign(services, { tools: registry, paths: { workspace: 'C:/ws' }, permissions: { settings: () => ({ quarantine: 'never' }) } });
  const tom = agentIn('general');
  const general = modes.get('general');
  const usable = registry.specsFor(tom, general);
  const offered = new Set(names(usable));
  assert.ok(offered.has('calendar.connect'), 'calendar.connect is reachable (not direct)');
  assert.ok(![...offered].some((name) => name.startsWith('schedules.') || name.startsWith('todos.')), 'Quests round: the old schedule and to-do tools are gone');
  assert.ok(offered.has('decide'));
  assert.ok(!names(registry.offerFor(tom, general, CODEX)).includes('decide'), 'decide runs through tools.call');
  const direct = new Set(names(registry.offerFor(tom, general, CODEX)));
  const list = moreToolsSection(usable, direct);
  assert.ok(list.startsWith(`${MORE_TOOLS_HEADER}\n`), list.slice(0, 100));
  const listed = (name: string) => new RegExp(`(^|\n|· )${name.replace(/\./g, '\.')} – `).test(list);
  assert.ok(listed('files.read') && listed('web.search') && listed('calendar.connect'), 'usual reachable tools stand in the list');
  assert.ok(!listed(FIND_TOOL) && !listed(CALL_TOOL) && !listed('web.fetch'), 'meta and direct tools are not repeated');
  assert.ok(!listed('decide'), 'rare tools stay reachable but do not stand in the list');
  for (const entry of list.split('\n').slice(1).flatMap((line) => line.split(' · '))) assert.ok(entry.split(' – ').slice(1).join(' – ').length <= 101, entry);
  const learned = new Set(names(registry.offerFor(tom, general, CODEX, ['calendar.connect'])));
  assert.ok(!moreToolsSection(usable, learned).includes('calendar.connect – '), 'a learned tool that became direct leaves the list');
  assert.equal(moreToolsSection(usable, new Set(['chat.read'])), '', 'no list without tools.call');
  assert.equal(moreToolsSection(usable, direct), list, 'the same tools give the same text');
  const section = environmentSection(services, { agent: tom, mode: general, route: { engine: 'codex' } as never }, offered, { platform: 'linux', version: '', release: '6.8', hostname: 'pc' });
  assert.ok(!section.includes('web.search'), 'Codex searches with its own: no second search named');
  assert.ok(!/\d+ tools/.test(section), 'no counts in the stable part');
});

test('the default shortlist hides the 15 on-demand tools and only deduplicates known native web search', () => {
  const onDemand = [
    'vector.search', 'vector.embed', 'library.find', 'library.open', 'library.publish', 'library.rate',
    'patterns.find', 'patterns.load', 'decide', 'telegram.connect', 'media.segments', 'media.describe',
    'spaces.list', 'spaces.save', 'browser.save_secret',
  ];
  const tools = [...onDemand, 'chat.call', 'people.list', 'web.search', 'web.fetch'].map((name) => ({
    name, description: 'Does something useful.', inputSchema: {},
  }));
  const viaCall = new Set([CALL_TOOL, FIND_TOOL]);
  for (const engine of ['codex', 'claude', 'acp', 'openai', undefined]) {
    const list = moreToolsSection(tools, viaCall, engine);
    for (const name of onDemand) assert.ok(!list.includes(`${name} –`), name);
    assert.match(list, /^I can find other tools .* with tools\.find\.$/m);
    assert.match(list, /^chat\.call –/m, 'live calls stay visible');
    assert.match(list, /^people\.list –/m, 'the once-used tool stays visible');
    assert.match(list, /web\.fetch –/);
    assert.equal(list.includes('web.search –'), engine !== 'codex' && engine !== 'claude', engine);
  }
  const onlyHidden = moreToolsSection(tools.slice(0, onDemand.length), viaCall, 'claude');
  assert.match(onlyHidden, /^I can find other tools .* with tools\.find\.$/m, 'a hint even when none of the listed tools qualify');
  assert.equal(moreToolsSection(tools.slice(0, 1), new Set([...viaCall, onDemand[0]]), 'claude'), '', 'a learned on-demand tool is already directly offered');
});

test('B-050 K10: chat.read and chat.direct join the base core for less than 600 tokens of spec (chars / 4)', () => {
  const { registry } = rig();
  const specs = ['chat.read', 'chat.direct'].map((name) => registry.get(name)!).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
  for (const name of ['chat.read', 'chat.direct']) assert.ok(Object.hasOwn(BASE_CORE, name), name);
  assert.ok(chars(specs) / 4 < 600, `${chars(specs)} characters`);
});
