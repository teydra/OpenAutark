// Sicher-Runde 19.11.2026: Claude Code agent turns in Secure mode – `--permission-mode default` + `--permission-prompts host`,
// `--settings` allow rules for the open folders and a deny for the closed one, read folders as `--add-dir`; each
// `can_use_tool` request is answered from the gate (Bash → commands, Read → read with its file, the hub's tools without
// the gate), a control_cancel_request gets no answer. Trust mode and helper turns keep today's flags.
// Owns: these assertions only. Never starts a real binary (scripted CLI from claude-fixture.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEAN_SETTINGS } from '../../../src/runtime/engines/claude/lean.ts';
import { nativeStep, rulePath, secureArgs, secureSettings } from '../../../src/runtime/engines/claude/permissions.ts';
import { turnInput } from './fakes.ts';
import { TEMP, claudeAccount, claudeSetup, until } from './claude-fixture.ts';
import { WAITING, fakeSecurity } from './security-fake.ts';

const HUB = { url: 'http://127.0.0.1:4555/mcp', token: 'hub-token-for-test' };
const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const input = (patch: Record<string, unknown> = {}) => turnInput({ model: 'claude-opus-5-5', account: claudeAccount(), cwd: '/work', mcp: HUB, ...patch });
const ask = (id: string, tool: string, toolInput: Record<string, unknown>) => ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: tool, input: toolInput, tool_use_id: `tu_${id}` } });
const responses = (lines: unknown[]) => lines.filter((line: any) => line?.type === 'control_response') as any[];

test('claude secure: rule paths are Claude Code\'s absolute form (// + POSIX; Windows drive lower case); parentheses get none', () => {
  assert.equal(rulePath('C:\\Users\\Ann\\Docs\\', 'win32'), '//c/Users/Ann/Docs');
  assert.equal(rulePath('D:\\', 'win32'), '//d');
  assert.equal(rulePath('/home/ann/docs/', 'linux'), '//home/ann/docs');
  assert.equal(rulePath('C:\\Program Files (x86)\\App', 'win32'), undefined);
  assert.equal(rulePath('\\\\server\\share', 'win32'), undefined);
});

test('claude secure: settings allow the open folders, the hub, open switches – and deny edits in the closed folder', () => {
  const chosen = JSON.parse(secureSettings({ mode: 'secure', read: ['/work', '/docs'], write: ['/work'], commands: 'ask', web: 'yes', closed: ['/data/security'] }, 'linux'));
  assert.equal(chosen.disableAllHooks, true, 'still no hooks');
  assert.deepEqual(chosen.permissions.allow, ['mcp__workforce', 'Read(//work/**)', 'Read(//docs/**)', 'Edit(//work/**)', 'WebSearch', 'WebFetch']);
  assert.deepEqual(chosen.permissions.deny, ['Edit(//data/security/**)']);
  const open = JSON.parse(secureSettings({ mode: 'secure', read: 'all', write: 'all', commands: 'yes', web: 'ask', closed: [] }, 'linux'));
  assert.deepEqual(open.permissions.allow, ['mcp__workforce', 'Read', 'Edit', 'Bash', 'PowerShell']);
  assert.equal(open.permissions.ask, undefined);
  const guarded = JSON.parse(secureSettings({ mode: 'secure', read: 'all', write: ['/work'], commands: 'ask', web: 'ask', closed: [], guarded: ['/work/skills'] } as any, 'linux'));
  assert.deepEqual(guarded.permissions.ask, ['Edit(//work/skills/**)'], 'setup inside an open folder still asks');
  assert.deepEqual(secureArgs({ mode: 'secure', read: ['/work', '/docs'], write: [], commands: 'ask', web: 'ask', closed: [] }),
    ['--permission-mode', 'default', '--permission-prompts', 'host', '--add-dir', '/work', '--add-dir', '/docs']);
  assert.deepEqual(secureArgs({ mode: 'secure', read: 'all', write: [], commands: 'ask', web: 'ask', closed: [] }), ['--permission-mode', 'default', '--permission-prompts', 'host']);
});

test('claude secure (25.11.2026): web chosen – a search is allowed, WebFetch only for the chosen sites, the rest goes to the gate', () => {
  const scope = { mode: 'secure' as const, read: ['/work'], write: ['/work'], commands: 'ask' as const, closed: [] as string[] };
  const chosen = JSON.parse(secureSettings({ ...scope, web: 'chosen', sites: ['example.com', 'bad site/x'] }, 'linux'));
  assert.deepEqual(chosen.permissions.allow.filter((rule: string) => rule.startsWith('Web')), ['WebSearch', 'WebFetch(domain:example.com)'], 'a malformed entry makes no rule');
  const asks = JSON.parse(secureSettings({ ...scope, web: 'ask' }, 'linux'));
  assert.deepEqual(asks.permissions.allow.filter((rule: string) => rule.startsWith('Web')), [], 'ask: a search asks too');
  assert.deepEqual(nativeStep('WebFetch', { url: 'https://WWW.Example.com/page', prompt: 'x' }).site, 'example.com');
  assert.equal(nativeStep('WebSearch', { query: 'autark' }).web, 'search', 'a search names no site and passes in chosen');
});

test('claude secure: native tools map to switches with their files', () => {
  assert.deepEqual(nativeStep('Read', { file_path: '/x/a.pdf' }), { capability: 'read', paths: ['/x/a.pdf'], summary: 'Read /x/a.pdf' });
  assert.equal(nativeStep('Grep', { pattern: 'TODO', path: '/x' }).summary, 'Search TODO in /x');
  assert.deepEqual(nativeStep('Write', { file_path: '/x/b.ts', content: '…' }), { capability: 'write', paths: ['/x/b.ts'], summary: 'Write /x/b.ts' });
  assert.equal(nativeStep('Edit', { file_path: '/x/b.ts' }).capability, 'write');
  assert.deepEqual(nativeStep('PowerShell', { command: 'Remove-Item x' }), { capability: 'commands', paths: [], summary: 'Run: Remove-Item x' });
  assert.equal(nativeStep('WebSearch', { query: 'autark' }).capability, 'web');
  assert.equal(nativeStep('Glob', { pattern: '*.md' }, '/elsewhere').paths[0], '/elsewhere', 'the blocked path when the call names none');
  assert.equal(nativeStep('SomethingNew', {}).capability, 'commands', 'an unknown tool asks like a command');
});

test('claude secure: a Trust-mode company and no service keep bypassPermissions and the lean settings', async () => {
  for (const security of [fakeSecurity({ mode: 'trust' }).lookup, undefined]) {
    const h = claudeSetup({}, { security });
    assert.equal((await h.engine.run(input().input)).stop, 'done');
    const [call] = h.cli.of('turn');
    assert.equal(flag(call.args, '--permission-mode'), 'bypassPermissions');
    assert.equal(flag(call.args, '--settings'), LEAN_SETTINGS);
    assert.equal(call.args.includes('--permission-prompts'), false);
    assert.equal(call.args.includes('--add-dir'), false);
  }
});

test('claude secure (25.11.2026): an agent turn in Secure mode runs with TMP, TEMP and TMPDIR at the own temp folder; Trust keeps the PC\'s', async () => {
  for (const mode of ['secure', 'trust'] as const) {
    const h = claudeSetup({}, { security: fakeSecurity({ mode, gate: () => ({ ok: true }) }).lookup });
    await h.engine.run(input().input);
    const env = h.cli.of('turn')[0].options.env ?? {};
    const temps = Object.entries(env).filter(([key]) => /^(tmp|temp|tmpdir)$/i.test(key));
    if (mode === 'secure') assert.deepEqual(temps.sort(), [['TEMP', TEMP], ['TMP', TEMP], ['TMPDIR', TEMP]], 'each once, at <data>/tmp');
    else assert.ok(temps.every(([, value]) => value !== TEMP), 'Trust: the PC\'s own temp, untouched');
  }
});

test('claude secure: a helper turn keeps --permission-prompts none in Secure mode', async () => {
  const fake = fakeSecurity();
  const h = claudeSetup({}, { security: fake.lookup });
  await h.engine.run(input({ mcp: undefined, tools: [] }).input);
  const [call] = h.cli.of('turn');
  assert.equal(flag(call.args, '--permission-prompts'), 'none');
  assert.equal(flag(call.args, '--settings'), LEAN_SETTINGS);
  assert.equal(fake.gates.length, 0);
});

test('claude secure: each can_use_tool request is answered from the gate; the hub without it; a cancelled one gets no answer', async () => {
  const fake = fakeSecurity({
    gate: (request) => (request.capability === 'read' ? { ok: true } : request.capability === 'web' ? new Promise<never>((_, reject) => request.signal?.addEventListener('abort', () => reject(new Error('stopped')))) : { ok: false, text: WAITING }),
  });
  const h = claudeSetup({
    exit: false,
    turn: () => [
      ask('r1', 'Bash', { command: 'npm install' }),
      ask('r2', 'Read', { file_path: '/elsewhere/a.pdf' }),
      ask('r3', 'mcp__workforce__tasks__create', { title: 'x' }),
      ask('r4', 'Read', { file_path: '/work/notes.md' }),
      ask('r5', 'WebSearch', { query: 'autark' }),
      { type: 'control_cancel_request', request_id: 'r5' },
    ],
  }, { security: fake.lookup });
  const running = h.engine.run(input().input);
  await until(() => responses(h.cli.of('turn')[0]?.child.lines ?? []).length >= 4);
  const call = h.cli.of('turn')[0];
  assert.equal(flag(call.args, '--permission-mode'), 'default');
  assert.equal(flag(call.args, '--permission-prompts'), 'host');
  const deny: string[] = JSON.parse(flag(call.args, '--settings')!).permissions.deny;
  assert.equal(deny.length, 1);
  assert.match(deny[0]!, /^Edit\(\/\/(c\/)?data\/security\/\*\*\)$/, 'this platform\'s rule form (Windows resolves /data to C:)');
  const byId = new Map(responses(call.child.lines).map((line) => [line.response.request_id, line.response]));
  assert.deepEqual(byId.get('r1'), { subtype: 'success', request_id: 'r1', response: { behavior: 'deny', message: WAITING } });
  assert.deepEqual(byId.get('r2')!.response, { behavior: 'allow', updatedInput: { file_path: '/elsewhere/a.pdf' } });
  assert.deepEqual(byId.get('r3')!.response, { behavior: 'allow', updatedInput: { title: 'x' } }, 'our tools: the registry gates them');
  assert.deepEqual(byId.get('r4')!.response.behavior, 'allow', 'an open file passes without a request');
  assert.equal(byId.has('r5'), false, 'the CLI no longer waits for a cancelled request');
  assert.deepEqual(fake.gates.map((g) => [g.capability, g.summary, g.path, g.agentId]), [
    ['commands', 'Run: npm install', undefined, 'ag_1'],
    ['read', 'Read /elsewhere/a.pdf', '/elsewhere/a.pdf', 'ag_1'],
    ['web', 'Search the web: autark', undefined, 'ag_1'],
  ]);
  assert.ok(fake.gates.every((g) => g.signal instanceof AbortSignal && g.fingerprint.startsWith('claude:')), 'tied to the turn, with a fingerprint');
  call.child.send({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 's' });
  call.child.exit(0);
  assert.equal((await running).stop, 'done');
});

test('claude secure: the same tool with the same input has the same fingerprint', async () => {
  const fake = fakeSecurity();
  const h = claudeSetup({ exit: false, turn: () => [ask('a', 'Bash', { command: 'ls' }), ask('b', 'Bash', { command: 'ls' }), ask('c', 'Bash', { command: 'dir' })] }, { security: fake.lookup });
  const running = h.engine.run(input().input);
  await until(() => responses(h.cli.of('turn')[0]?.child.lines ?? []).length >= 3);
  const [a, b, c] = fake.gates.map((g) => g.fingerprint);
  assert.equal(a, b);
  assert.notEqual(a, c);
  const call = h.cli.of('turn')[0];
  call.child.send({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 's' });
  call.child.exit(0);
  await running;
});
