// Sign-in after a restart (22.11.2026): the app's half (computer/signin.ts) against a fake broker on a test pipe that mirrors
// the handshake, Sealer.Open and SignInOps of resources/broker/SignIn.cs; the broker's own logic (SignInPolicy, SignInPlanner)
// in C#, compiled with csc (signin-cs/SignInTests.cs); and the source rules: never Windows autologon, never Winlogon's
// DefaultPassword. No real password, no LSA, no registry, no UI Automation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { brokerLease, sealLine, type BrokerAccess } from '../../../src/runtime/computer/broker.ts';
import { brokerCall, claimSignInLock, LOCK_WINDOW_MS, RestartSignIn, secretIdOf, shouldLock, signInTool, SIGNIN_NS, type SignInStatus } from '../../../src/runtime/computer/signin.ts';
import { MemoryLogger } from '../fakes.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';

const mac = (key: Buffer, label: string, ...parts: Buffer[]) => createHmac('sha256', key).update(Buffer.concat([Buffer.from(label), ...parts])).digest();
let pipes = 0;
const pipeName = () => `\\\\.\\pipe\\autark-signin-test-${process.pid}-${++pipes}`;
const WINDOWS_PASSWORD = 'test-only-not-a-real-password';

interface FakeSignIn {
  pipe: string;
  key: Buffer;
  /** What the fake broker keeps (the LSA datum of SignIn.cs). */
  vault: { password?: string; lockAfter: boolean; pendingLock: boolean; lastSignInAt: number };
  lines: string[];
  ops: string[];
  close(): Promise<void>;
}

/** A fake worker for the signin_* ops: handshake and Sealer.Open as Worker.cs, LogonUser as "equals WINDOWS_PASSWORD". */
async function fakeSignInBroker(vault: Partial<FakeSignIn['vault']> = {}): Promise<FakeSignIn> {
  const key = randomBytes(32);
  const state: FakeSignIn['vault'] = { lockAfter: false, pendingLock: false, lastSignInAt: 0, ...vault };
  const lines: string[] = [];
  const ops: string[] = [];
  const pipe = pipeName();
  const status = (): SignInStatus => ({
    account: 'PC\\user', stored: state.password !== undefined, suspended: false, reason: '', failures: 0, lastResult: state.lastSignInAt ? 'signed_in' : '', lastAttemptAt: 0,
    lastSignInAt: state.lastSignInAt, lockAfter: state.lockAfter, pendingLock: state.pendingLock,
  });
  const server = net.createServer((socket) => {
    const serverNonce = randomBytes(16);
    let session: Buffer | undefined;
    let buffer = '';
    socket.write(`${JSON.stringify({ broker: 1, nonce: serverNonce.toString('base64') })}\n`);
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const message = JSON.parse(line);
        if (!session) {
          const clientNonce = Buffer.from(message.nonce, 'base64');
          assert.ok(timingSafeEqual(Buffer.from(message.hello, 'base64'), mac(key, 'hello', serverNonce, clientNonce)));
          session = mac(key, 'session', serverNonce, clientNonce);
          socket.write(`${JSON.stringify({ ready: true, protocol: 4, pid: 7, dpiAware: true, proof: mac(key, 'proof', serverNonce, clientNonce).toString('base64'), desktop: 'Default' })}\n`);
          continue;
        }
        lines.push(line);
        ops.push(message.op);
        let opened: string | undefined;
        const sealed = message.args?.sealed;
        if (sealed) {
          const iv = Buffer.from(sealed.iv, 'base64');
          const data = Buffer.from(sealed.data, 'base64');
          assert.ok(timingSafeEqual(Buffer.from(sealed.mac, 'base64'), mac(mac(session, 'mac'), `${message.id}\n${message.op}\n`, iv, data)));
          const decipher = createDecipheriv('aes-256-cbc', mac(session, 'enc'), iv);
          opened = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
        }
        const reply = (body: Record<string, unknown>) => socket.write(`${JSON.stringify({ id: message.id, ...body, desktop: 'Default' })}\n`);
        if (message.op === 'signin_store') {
          if (opened !== WINDOWS_PASSWORD) { reply({ ok: false, error: { code: 'wrong_password', message: 'Windows does not accept this password for the account.' } }); continue; }
          state.password = opened;
          if (typeof message.args.lockAfter === 'boolean') state.lockAfter = message.args.lockAfter;
        } else if (message.op === 'signin_clear') state.password = undefined;
        else if (message.op === 'signin_options') state.lockAfter = message.args.lockAfter;
        else if (message.op === 'signin_handled') state.pendingLock = false;
        reply({ ok: true, result: status() });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(pipe, resolve));
  return { pipe, key, vault: state, lines, ops, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const accessTo = (fake: FakeSignIn): BrokerAccess => ({ reachable: () => true, lease: (log) => brokerLease({ pipe: fake.pipe, key: fake.key, log }) });

class MemoryKv {
  readonly rows = new Map<string, unknown>();
  get<T>(ns: string, key: string): T | undefined { return this.rows.get(`${ns}/${key}`) as T | undefined; }
  set(ns: string, key: string, value: unknown): void { this.rows.set(`${ns}/${key}`, value); }
  delete(ns: string, key: string): boolean { return this.rows.delete(`${ns}/${key}`); }
}

function fakeSecrets(values: Record<string, string>) {
  const listeners = new Set<(id: string) => void>();
  const used: string[] = [];
  return {
    values, used,
    list: () => Object.keys(values).map((id) => ({ id, label: id, kind: 'password' as const, createdAt: 0 })),
    use: async (id: string) => { used.push(id); if (!(id in values)) throw new WorkforceError('not_found', 'Secret not found.'); return values[id]!; },
    observe: (listener: (id: string) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    tell: (id: string) => { for (const listener of listeners) listener(id); },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

test('the Windows password leaves the app only sealed (signin_store)', () => {
  const session = randomBytes(32);
  const line = sealLine(JSON.stringify({ id: 4, op: 'signin_store', args: { password: WINDOWS_PASSWORD, lockAfter: true } }), session);
  assert.doesNotMatch(line, new RegExp(WINDOWS_PASSWORD));
  const request = JSON.parse(line);
  assert.equal(request.op, 'signin_store');
  assert.equal(request.args.lockAfter, true);
  assert.equal(request.args.password, undefined);
  assert.ok(request.args.sealed.mac);
});

test('brokerCall: one request over its own connection; a refused password is a forbidden error with the broker\'s code', { skip: process.platform !== 'win32' }, async () => {
  const fake = await fakeSignInBroker();
  try {
    const log = new MemoryLogger();
    const status = await brokerCall<SignInStatus>(accessTo(fake), log, 'signin_status');
    assert.equal(status.stored, false);
    await assert.rejects(brokerCall(accessTo(fake), log, 'signin_store', { password: 'wrong' }), (error: WorkforceError) => error.code === 'forbidden' && error.details?.code === 'wrong_password');
    await assert.rejects(brokerCall(accessTo(fake), log, 'type', {}), /Unknown broker op/);
    assert.doesNotMatch(JSON.stringify(log.entries), /wrong|test-only/);
  } finally { await fake.close(); }
});

test('turning it on: the catalog value goes to the broker sealed, the choice is kept by id only', { skip: process.platform !== 'win32' }, async () => {
  const fake = await fakeSignInBroker();
  const secrets = fakeSecrets({ sec_win: WINDOWS_PASSWORD });
  const kv = new MemoryKv();
  const signIn = new RestartSignIn({ broker: () => accessTo(fake), secrets, kv, log: new MemoryLogger(), now: () => 1000 });
  try {
    const status = await signIn.enable({ secretId: 'sec_win', lockAfter: true, agentId: 'ag_1' });
    assert.equal(status.stored, true);
    assert.equal(fake.vault.password, WINDOWS_PASSWORD);
    assert.equal(fake.vault.lockAfter, true);
    assert.deepEqual(kv.get(SIGNIN_NS, 'config'), { secretId: 'sec_win', lockAfter: true });
    assert.ok(fake.lines.every((line) => !line.includes(WINDOWS_PASSWORD)));
    assert.doesNotMatch(JSON.stringify([...kv.rows.values()]), /test-only/);
  } finally { await fake.close(); }
});

test('the tool says plainly when Windows refuses the password and stores nothing', { skip: process.platform !== 'win32' }, async () => {
  const fake = await fakeSignInBroker();
  const kv = new MemoryKv();
  const signIn = new RestartSignIn({ broker: () => accessTo(fake), secrets: fakeSecrets({ sec_old: 'an-old-password' }), kv, log: new MemoryLogger(), now: () => 1000 });
  try {
    const tool = signInTool(signIn);
    const output = await tool.run({ secret: 'secret://sec_old' }, { agent: { id: 'ag_1' } } as never);
    assert.match(output.content[0]!.type === 'text' ? output.content[0]!.text : '', /does not accept that password/);
    assert.equal(fake.vault.password, undefined);
    assert.equal(kv.get(SIGNIN_NS, 'config'), undefined);
  } finally { await fake.close(); }
});

test('the broker\'s copy follows the catalog: a changed value is handed over again, a removed one is forgotten', { skip: process.platform !== 'win32' }, async () => {
  const fake = await fakeSignInBroker();
  const secrets = fakeSecrets({ sec_win: WINDOWS_PASSWORD, sec_other: 'x' });
  const kv = new MemoryKv();
  const signIn = new RestartSignIn({ waitForDesktop: async () => {}, broker: () => accessTo(fake), secrets, kv, log: new MemoryLogger(), now: () => 1000 });
  try {
    await signIn.enable({ secretId: 'sec_win', agentId: 'ag_1' });
    assert.equal(fake.vault.lockAfter, true, 'locking right after the sign-in is the default');
    await signIn.start();
    fake.ops.length = 0;
    secrets.tell('sec_other');
    await settle();
    assert.deepEqual(fake.ops, [], 'another secret changing touches nothing');
    secrets.tell('sec_win');
    await settle();
    assert.deepEqual(fake.ops, ['signin_store']);
    delete secrets.values.sec_win;
    secrets.tell('sec_win');
    await settle();
    assert.deepEqual(fake.ops, ['signin_store', 'signin_clear']);
    assert.equal(fake.vault.password, undefined);
    assert.equal(kv.get(SIGNIN_NS, 'config'), undefined);
  } finally { signIn.stop(); await fake.close(); }
});

test('two apps starting after an automatic sign-in issue one lock, even when their broker requests overlap', { skip: process.platform !== 'win32' }, async () => {
  const now = Date.now();
  const fake = await fakeSignInBroker({ password: WINDOWS_PASSWORD, lockAfter: true, pendingLock: true, lastSignInAt: now - 60_000 });
  let locks = 0;
  const start = () => new RestartSignIn({
    broker: () => accessTo(fake), secrets: fakeSecrets({}), kv: new MemoryKv(), log: new MemoryLogger(), now: () => now,
    waitForDesktop: async () => {}, bootAt: () => now - 120_000, lock: async () => { locks++; },
  });
  const first = start(), second = start(), restarted = start();
  try {
    await Promise.all([first.start(), second.start()]);
    assert.equal(locks, 1);
    assert.equal(fake.ops.filter(op => op === 'signin_handled').length, 1);
    await restarted.start();
    assert.equal(locks, 1);
  } finally { first.stop(); second.stop(); restarted.stop(); await fake.close(); }
});

test('the same sign-in event can be claimed by only one company at a time', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'wf-signin-claim-'));
  try {
    const claims = (await Promise.all([claimSignInLock(123, directory), claimSignInLock(123, directory)])).filter(Boolean);
    assert.equal(claims.length, 1);
    await claims[0]?.();
    assert.ok(await claimSignInLock(123, directory));
    assert.ok(await claimSignInLock(456, directory), 'a stale claim cannot affect a later logon');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('shouldLock: only the current boot’s recent successful Autark sign-in with the wish and feature still enabled', () => {
  const now = 50_000_000, bootAt = now - LOCK_WINDOW_MS - 100;
  const status: SignInStatus = {
    account: 'PC\\user', stored: true, suspended: false, reason: '', failures: 0, lastResult: 'signed_in',
    lastAttemptAt: now - 1000, lastSignInAt: now - 1000, lockAfter: true, pendingLock: true,
  };
  assert.equal(shouldLock(status, now, bootAt), true);
  for (const update of [
    { lockAfter: false }, { pendingLock: false }, { stored: false }, { suspended: true }, { lastResult: 'user_present' },
    { lastSignInAt: now - LOCK_WINDOW_MS - 1 }, { lastSignInAt: 0 }, { lastSignInAt: now + 1 },
  ]) assert.equal(shouldLock({ ...status, ...update }, now, bootAt), false);
  assert.equal(shouldLock(status, now, now - 500), false, 'a previous boot’s marker cannot lock a later manual sign-in');
});

test('without the broker it says so instead of pretending', async () => {
  const signIn = new RestartSignIn({ broker: () => undefined, secrets: fakeSecrets({ sec_win: WINDOWS_PASSWORD }), kv: new MemoryKv(), log: new MemoryLogger(), now: () => 0 });
  await assert.rejects(signIn.enable({ secretId: 'sec_win', agentId: 'ag_1' }), (error: WorkforceError) => error.code === 'unavailable');
  await assert.rejects(signIn.enable({ secretId: 'sec_none', agentId: 'ag_1' }), (error: WorkforceError) => error.code === 'not_found');
  assert.equal(await signIn.disable(), undefined);
  assert.equal(secretIdOf('secret://sec_a8aeabe8'), 'sec_a8aeabe8');
  assert.equal(secretIdOf('sec_x'), 'sec_x');
  assert.equal(secretIdOf('no spaces allowed'), undefined);
});

test('the broker never uses Windows autologon: no AutoAdminLogon, no Winlogon DefaultPassword, its own local-only LSA name', () => {
  const sources = ['Broker.cs', 'Worker.cs', 'SignIn.cs'].map((file) => readFileSync(path.join('resources', 'broker', file), 'utf8'));
  const code = sources.map((source) => source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')).join('\n');
  assert.doesNotMatch(code, /AutoAdminLogon|"DefaultPassword"|DefaultUserName|Winlogon\\\\/);
  assert.match(code, /SecretName = "L\$AutarkDesktopBroker\.SignIn"/);
  assert.match(readFileSync('resources/broker/build.ps1', 'utf8'), /'SignIn\.cs'/);
  assert.match(sources[0]!, /role == "signin"/);
  assert.match(sources[1]!, /SignInOps\.Handles\(op\)/);
});

const csc = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

test('the broker\'s policy and sign-in screen planner (C#, SignIn.cs)', { skip: process.platform !== 'win32' || !existsSync(csc) }, () => {
  // Compiled in memory and run inside PowerShell (signin-cs/run.ps1): a fresh unsigned test exe may be held by Smart App Control.
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join('test', 'unit', 'computer', 'signin-cs', 'run.ps1')], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, `${run.error?.message ?? ''}${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /ALL PASS/);
  assert.ok((run.stdout.match(/^PASS /gm) ?? []).length >= 25, run.stdout);
});
