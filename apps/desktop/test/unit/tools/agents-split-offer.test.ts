// B-057 – agents.split over the real shipped modes and tool groups: allowed in every mode, and since KI-Runde
// 17.11.2026 a core tool with split_tell (measured: they were the tools agents looked up by name again and again),
// while its results tool stays reachable through tools.find / tools.call on every engine kind;
// what parts are stands once in How I work (resources/prompts/how-i-work.md);
// tools.find ranks it first for parallel work, and a reviewer agent – which only reads and reports – is not offered it.
// Owns: these assertions only. Never: runs a tool.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import { builtinTools } from '../../../src/runtime/tools/builtin/index.ts';
import { rankTools } from '../../../src/runtime/tools/builtin/tools-meta.ts';
import { BASE_CORE, coreReason } from '../../../src/runtime/tools/core-sets.ts';
import { readFileSync } from 'node:fs';
import { ModeLibrary } from '../../../src/runtime/modes/service.ts';
import { ManualClock } from '../fakes.ts';
import { agent } from '../chat/harness.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';

const ENGINES = [{ ownTools: true, via: 'native' as const }, { ownTools: true, via: 'mcp' as const }, { ownTools: false, via: 'native' as const }];

test('agents.split and split_tell are direct in every shipped mode; split_results is reachable there', () => {
  const tools = builtinTools();
  const services = { org: { list: () => [], get: () => undefined }, log: { debug() {}, info() {}, warn() {}, error() {} } } as unknown as RuntimeServices;
  const registry = new Registry({ services: () => services });
  for (const tool of tools) registry.register(tool);
  const modes = new ModeLibrary({ resources: path.resolve('resources'), clock: new ManualClock() });
  // KI-Runde 17.11.2026 (32 calls of agents.split and 209 of split_tell through tools.call, 49 lookups by name): both direct.
  for (const name of ['agents.split', 'agents.split_tell']) assert.equal(Object.hasOwn(BASE_CORE, name), true, name);
  assert.equal(Object.hasOwn(BASE_CORE, 'agents.split_results'), false, 'the results come back by themselves');
  for (const mode of modes.list()) {
    const info = modes.get(mode.key);
    const tom = agent(`ag_${mode.key}`, 'X', { mode: mode.key });
    for (const engine of ENGINES) {
      const offer = registry.offerFor(tom, info, engine).map((spec) => spec.name);
      for (const name of ['agents.split', 'agents.split_tell']) assert.ok(offer.includes(name), `${mode.key}: ${name} direct on ${JSON.stringify(engine)}`);
      assert.ok(!offer.includes('agents.split_results'), `${mode.key}: split_results through tools.call on ${JSON.stringify(engine)}`);
      assert.ok(offer.includes('tools.find') && offer.includes('tools.call'), `${mode.key}: reachable through the meta tools on ${JSON.stringify(engine)}`);
    }
    assert.ok(coreReason(info, 'agents.split'), `${mode.key}: its core reason`);
    const all = registry.specsFor(tom, info).map((spec) => spec.name);
    for (const name of ['agents.split', 'agents.split_results', 'agents.split_tell']) assert.ok(all.includes(name), `${mode.key}: ${name}`);
  }
  const specs = tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
  assert.equal(rankTools(specs, 'split the work into parallel workers', 3)[0]?.name, 'agents.split');
  const how = readFileSync(new URL('../../../resources/prompts/standard-agent.md', import.meta.url), 'utf8');
  assert.match(how, /Parts of me \(people call this Ultra\) take pieces/, 'How I work says what parts are');
});
