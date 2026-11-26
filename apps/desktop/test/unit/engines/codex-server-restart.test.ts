// engines/codex/server.ts: a running app-server restarts between turns – never during one – when its home's login file
// changed (it then runs on the login that is there) or when PowerShell 7 arrived after it started (Windows).
// Owns: these assertions. Never starts a real binary (scripted app-server over fakes.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexServer } from '../../../src/runtime/engines/codex/server.ts';
import type { Executable } from '../../../src/runtime/accounts/executables.ts';
import { fakeSpawn, testSupervisor } from './fakes.ts';

/** A scripted app-server that answers initialize. */
function appServer() {
  return fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (msg.method === 'initialize') child.send({ id: msg.id, result: { userAgent: 'codex_cli_rs/0.167.0' } });
    };
  });
}

function codexServer(home: string, fake: ReturnType<typeof fakeSpawn>, env: NodeJS.ProcessEnv = { PATH: '/bin' }, lifecycle?: ConstructorParameters<typeof CodexServer>[0]['lifecycle']): CodexServer {
  return new CodexServer({
    key: 'acc_test', home, executable: { command: '/bin/codex', prefixArgs: [], path: '/bin/codex' } as unknown as Executable,
    supervisor: testSupervisor(fake.spawn), cwd: '/data/engine-cwd', version: '0.2.0', env, lifecycle,
  });
}

test('the app-server starts with the server-wide config only and CODEX_HOME set to the account\'s home', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'wf-codex-home-'));
  try {
    const fake = appServer();
    const server = codexServer(home, fake);
    await server.rpc();
    assert.ok(fake.calls[0].args.includes('project_root_markers=[]'));
    assert.ok(!fake.calls[0].args.some((arg) => arg.startsWith('mcp_servers')), 'nothing of a person\'s config.toml is named');
    assert.equal(fake.calls[0].options.env?.CODEX_HOME, home);
    await server.dispose();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a running app-server restarts between turns when its login file changed, never during a turn', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'wf-codex-home-'));
  try {
    writeFileSync(path.join(home, 'auth.json'), '{"tokens":{"refresh_token":"a"}}');
    writeFileSync(path.join(home, 'config.toml'), 'model = "x"\n');
    const fake = appServer();
    const server = codexServer(home, fake);
    const first = await server.rpc();
    writeFileSync(path.join(home, 'config.toml'), 'model = "y"\n# longer\n');
    assert.equal(await server.rpc(), first, 'another file of the home: the same process');
    const end = server.beginTurn();
    writeFileSync(path.join(home, 'auth.json'), '{"tokens":{"refresh_token":"newer one"}}');
    assert.equal(await server.rpc(), first, 'a turn runs: never cut');
    end();
    const fresh = await server.rpc();
    assert.notEqual(fresh, first, 'between turns: restarted');
    assert.equal(fake.calls.length, 2);
    assert.equal(await server.rpc(), fresh, 'started with it: no further restart');
    await server.dispose();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a Windows app-server started before PowerShell 7 was there restarts between turns once it is', { skip: process.platform !== 'win32' ? 'Windows only' : undefined }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'wf-codex-home-'));
  try {
    const user = path.join(home, 'local', 'Microsoft', 'powershell');
    const env = { PATH: path.join(home, 'nothing'), LOCALAPPDATA: path.join(home, 'local'), ProgramFiles: path.join(home, 'programs') };
    const fake = appServer();
    const server = codexServer(home, fake, env);
    const first = await server.rpc();
    assert.equal(await server.rpc(), first, 'no PowerShell 7 yet: the same process');
    const end = server.beginTurn();
    mkdirSync(user, { recursive: true });
    writeFileSync(path.join(user, 'pwsh.exe'), '');
    assert.equal(await server.rpc(), first, 'a turn runs: never cut');
    end();
    const fresh = await server.rpc();
    assert.notEqual(fresh, first, 'between turns: restarted');
    assert.equal(fake.calls.length, 2);
    assert.ok(String(fake.calls[1].options.env?.PATH).endsWith(`;${user}`), 'the new process has PowerShell 7 last on PATH');
    assert.equal(await server.rpc(), fresh, 'started with it: no further restart');
    await server.dispose();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a cold account check and intervals without a turn hold are distinct measurements', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'wf-codex-idle-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const samples: Array<[string, Record<string, unknown>]> = [];
  const server = codexServer(home, appServer(), undefined, (name, details) => samples.push([name, details]));
  t.after(() => server.dispose());
  await server.rpc('account-check');
  await server.rpc();
  const one = server.beginTurn(), two = server.beginTurn();
  one();
  assert.equal(samples.length, 2, 'one cold start, one idle sample before the first hold');
  two();
  await server.dispose();
  assert.deepEqual(samples[0], ['codex server cold start', { account: 'acc_test', reason: 'account-check' }]);
  assert.deepEqual(samples.slice(1).map(([name, data]) => [name, data.end]), [
    ['codex server without a turn hold', 'hold'], ['codex server without a turn hold', 'clear'],
  ]);
  assert.ok(samples.slice(1).every(([, { durationMs }]) => typeof durationMs === 'number' && durationMs >= 0));
});
