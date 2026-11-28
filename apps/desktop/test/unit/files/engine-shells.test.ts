// task_t7wes5sf (after PR #49): the delete guard sits in front of shell.exec only (files/shell-deletes.ts). It covers the
// engines because Autark starts them without a native shell: Claude Code keeps only Read, Edit, Write, Glob, Grep and
// WebSearch (claude/lean.ts, no hooks), every Codex agent, split and helper thread has its shell features off
// (codex/helper-thread.ts). This tripwire fails when a native shell comes back on any of these ways – then the same check
// (shellDeleteRefusal) has to be put in front of that shell first (docs/DELETE_GUARD.md, "The engines' own tools").
// Live proof with the installed engines: test/live/engine-delete-guard.test.ts.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORE_TOOLS, LEAN_SETTINGS, coreTools, promptArgs } from '../../../src/runtime/engines/claude/lean.ts';
import { AGENT_FEATURES_KEPT, agentThread, helperThread, imageThread } from '../../../src/runtime/engines/codex/helper-thread.ts';

const WHY = 'the delete guard checks only shell.exec – a native shell needs shellDeleteRefusal in front of it first (docs/DELETE_GUARD.md)';
const CLAUDE_SHELLS = ['Bash', 'PowerShell', 'Agent', 'Task'];
const CODEX_SHELLS = ['shell_tool', 'unified_exec', 'shell_snapshot', 'shell_zsh_fork', 'js_repl'];

test('Claude Code: an agent turn has no native shell, a helper turn no tool, and no hook runs', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    for (const name of CLAUDE_SHELLS) assert.ok(!coreTools(platform).includes(name), `${name} on ${platform}: ${WHY}`);
  }
  for (const name of CLAUDE_SHELLS) assert.ok(!CORE_TOOLS.includes(name), `${name}: ${WHY}`);
  const agent = promptArgs('p.md', coreTools());
  assert.equal(agent[agent.indexOf('--tools') + 1], CORE_TOOLS.join(','));
  const helper = promptArgs(undefined, []);
  assert.equal(helper[helper.indexOf('--tools') + 1], '', 'a helper turn has no built-in tool');
  assert.deepEqual(JSON.parse(LEAN_SETTINGS), { disableAllHooks: true }, 'no hook of any settings level runs in a turn');
});

test('Codex: agent, split and resumed threads have the shell features off, also against a config that turns them on', () => {
  for (const name of CODEX_SHELLS) assert.ok(!AGENT_FEATURES_KEPT.includes(name), `${name}: ${WHY}`);
  const plain = agentThread({});
  const forced = agentThread({ config: { features: Object.fromEntries(CODEX_SHELLS.map((name) => [name, true])) } });
  for (const settings of [plain, forced]) {
    const features = settings.config.features as Record<string, boolean>;
    for (const name of CODEX_SHELLS) assert.equal(features[name], false, `features.${name}: ${WHY}`);
  }
});

test('Codex: helper and image threads have no environment (no shell or patch tool) and the shell features off', () => {
  for (const settings of [helperThread({}), imageThread({})]) {
    assert.deepEqual(settings.environments, [], WHY);
    const features = settings.config.features as Record<string, boolean>;
    for (const name of ['shell_tool', 'unified_exec', 'shell_snapshot']) assert.equal(features[name], false, `features.${name}: ${WHY}`);
  }
});
