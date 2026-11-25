// Sicher-Runde 19.11.2026: Codex agent turns in Secure mode – Codex's write sandbox (`workspaceWrite` + the open folders as
// writableRoots, the network open; full access when files are open everywhere), 'untrusted' when commands ask, and every
// approval request answered from the gate for this one step (a file change with the files of its started item, a command
// as `commands`). Trust mode and read turns keep today's answers.
// Owns: these assertions only. Never: a real Codex (scripted app-server over fakes.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { turnPermissions } from '../../../src/runtime/engines/codex/isolation.ts';
import { fakeFinder, fakeSpawn, testSupervisor, turnInput } from './fakes.ts';
import { fakeSecurity } from './security-fake.ts';

/** An app-server whose turn starts a file change, asks for it and for a command, and ends once both are answered. */
function appServer() {
  const requests: any[] = [];
  const replies = new Map<number, any>();
  const { spawn } = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (msg.id !== undefined && !msg.method) {
        replies.set(msg.id, msg.result);
        if (replies.size === 2) child.send({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'completed' } } });
        return;
      }
      requests.push(msg);
      if (msg.method === 'initialize') child.send({ id: msg.id, result: { userAgent: 'fake' } });
      else if (msg.method === 'thread/start') child.send({ id: msg.id, result: { thread: { id: 'thr_1' } } });
      else if (msg.method === 'turn/start') {
        child.send({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } });
        setImmediate(() => {
          const base = { threadId: 'thr_1', turnId: 'turn_1' };
          child.send({ method: 'item/started', params: { ...base, item: { type: 'fileChange', id: 'f1', status: 'inProgress', changes: [{ path: '/work/a.ts', kind: { type: 'update' } }, { path: '/elsewhere/x.ts', kind: { type: 'add' } }] } } });
          child.send({ id: 901, method: 'item/fileChange/requestApproval', params: { ...base, itemId: 'f1', startedAtMs: 1 } });
          child.send({ id: 902, method: 'item/commandExecution/requestApproval', params: { ...base, itemId: 'c1', startedAtMs: 1, command: 'npm install', cwd: '/work' } });
        });
      } else if (msg.id !== undefined) child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
    };
  });
  return { spawn, requests, replies };
}

const engine = (spawn: any, security?: () => any) => new CodexEngine({
  supervisor: testSupervisor(spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/tmp', version: '0.2.0', realpath: async (dir) => dir,
  ...(security ? { security } : {}),
});

test('codex secure: the turn\'s sandbox and approval policy follow the security scope', () => {
  assert.deepEqual(turnPermissions('full', { write: ['/work', 'relative'], commands: 'ask' }), {
    approvalPolicy: 'untrusted', approvalsReviewer: 'user',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/work'], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
  });
  // 25.11.2026: the PC's temp folders are no write root in Secure mode; the sandbox's network only when the web is open everywhere
  assert.equal((turnPermissions('full', { write: ['/work'], commands: 'ask', web: 'yes' }).sandboxPolicy as any).networkAccess, true);
  assert.equal((turnPermissions('full', { write: ['/work'], commands: 'ask', web: 'chosen' }).sandboxPolicy as any).networkAccess, false);
  assert.equal((turnPermissions('full', { write: ['/work'], commands: 'ask', web: 'ask' }).sandboxPolicy as any).networkAccess, false);
  assert.equal(turnPermissions('full', { write: ['/work'], commands: 'yes' }).approvalPolicy, 'on-request');
  assert.deepEqual(turnPermissions('full', { write: 'all', commands: 'yes' }).sandboxPolicy, { type: 'dangerFullAccess' });
  assert.deepEqual(turnPermissions('read', { write: 'all', commands: 'yes' }).sandboxPolicy, { type: 'readOnly', networkAccess: false }, 'a read turn stays read-only');
  assert.deepEqual(turnPermissions('full'), { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } }, 'Trust mode: as today');
});

test('codex secure: approval requests go through the gate, for this step only', async () => {
  const fake = fakeSecurity({ gate: (request) => (request.capability === 'write' ? { ok: true } : { ok: false, text: 'waiting' }) });
  const server = appServer();
  const e = engine(server.spawn, fake.lookup);
  const result = await e.run(turnInput().input);
  await e.dispose();
  assert.equal(result.stop, 'done');
  const start = server.requests.find((r) => r.method === 'turn/start').params;
  assert.equal(start.approvalPolicy, 'untrusted');
  assert.deepEqual(start.sandboxPolicy, { type: 'workspaceWrite', writableRoots: ['/work'], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
  assert.deepEqual(server.replies.get(901), { decision: 'accept' }, 'never for the session');
  assert.deepEqual(server.replies.get(902), { decision: 'decline' });
  assert.deepEqual(fake.gates.map((g) => [g.capability, g.path, g.summary]), [
    ['write', '/elsewhere/x.ts', 'Edit /work/a.ts, /elsewhere/x.ts'],
    ['commands', undefined, 'Run: npm install'],
  ]);
  assert.ok(fake.gates.every((g) => g.agentId === 'ag_1' && g.signal instanceof AbortSignal && g.fingerprint.startsWith('codex:')));
});

test('codex secure (25.11.2026): a Secure-mode thread\'s shells get TMP, TEMP and TMPDIR at the own temp folder; Trust keeps the PC\'s', async () => {
  for (const mode of ['secure', 'trust'] as const) {
    const server = appServer();
    const e = new CodexEngine({
      supervisor: testSupervisor(server.spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/tmp', version: '0.2.0', realpath: async (dir) => dir,
      security: fakeSecurity({ mode, gate: () => ({ ok: true }) }).lookup, tempDir: '/data/tmp', shellEnv: { GIT_X: '1' },
    });
    await e.run(turnInput().input);
    await e.dispose();
    const set = server.requests.find((r) => r.method === 'thread/start').params.config.shell_environment_policy.set;
    assert.equal(set.GIT_X, '1', `${mode}: the safe git env stays`);
    if (mode === 'secure') assert.deepEqual([set.TMP, set.TEMP, set.TMPDIR], ['/data/tmp', '/data/tmp', '/data/tmp']);
    else assert.deepEqual([set.TMP, set.TEMP, set.TMPDIR], [undefined, undefined, undefined]);
  }
});

test('codex secure: a Trust-mode company keeps full access and accepts for the session at once', async () => {
  const fake = fakeSecurity({ mode: 'trust' });
  const server = appServer();
  const e = engine(server.spawn, fake.lookup);
  assert.equal((await e.run(turnInput().input)).stop, 'done');
  await e.dispose();
  const start = server.requests.find((r) => r.method === 'turn/start').params;
  assert.equal(start.approvalPolicy, 'on-request');
  assert.deepEqual(start.sandboxPolicy, { type: 'dangerFullAccess' });
  assert.deepEqual(server.replies.get(901), { decision: 'acceptForSession' });
  assert.deepEqual(server.replies.get(902), { decision: 'acceptForSession' });
  assert.equal(fake.gates.length, 0);
});

test('codex secure: commands open → a command approval is Codex leaving the sandbox – asked as a write', async () => {
  const fake = fakeSecurity({ scope: { commands: 'yes' }, gate: () => ({ ok: true }) });
  const server = appServer();
  const e = engine(server.spawn, fake.lookup);
  await e.run(turnInput().input);
  await e.dispose();
  assert.equal(server.requests.find((r) => r.method === 'turn/start').params.approvalPolicy, 'on-request');
  assert.deepEqual(fake.gates.map((g) => [g.capability, g.summary]).at(-1), ['write', 'Run outside the sandbox: npm install']);
  assert.deepEqual(server.replies.get(902), { decision: 'accept' });
});
