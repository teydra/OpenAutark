// 28.11.2026 (agents printed runtime.json with `Get-Content`; the owner token reached the model provider, the run journal and
// the engine transcript): the real tool path – Registry.call → shell.exec / files.read (a real child process, real pipes) →
// finalizeOutput → the run journal – never carries the owner token of this runtime or of a sibling company, nor the wake key.
//  - shell.exec prints runtime.json / wake.json (stdout and stderr): the tool result and every journal row hold the mark
//    ("‹secret:runtime-token›", "‹secret:wake-key›"), never the value;
//  - files.read of the same files: the same;
//  - the sibling company restarts (a new runtime.json): the new token is masked at the next call after the interval;
//  - control: another 64-hex string (a commit hash, a sha256) comes out unchanged, and so do the file's port and pid.
// Owns: these assertions only. Never: a real token or the real runtime.json of this PC – a temp folder with synthetic values;
// a failing assertion names the case, never the value.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setup, WORKSPACE } from './helpers.ts';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import { fileTools } from '../../../src/runtime/tools/builtin/files.ts';
import { SecretVault } from '../../../src/runtime/secrets/service.ts';
import { INTERVAL_MS, RUNTIME_TOKEN_MARK, WAKE_KEY_MARK } from '../../../src/runtime/secrets/runtime-values.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';

const hex = (seed: string) => seed.repeat(Math.ceil(64 / seed.length)).slice(0, 64);
const OWN = hex('0123456789abcdef');
const SIBLING = hex('feedface');
const SIBLING_NEW = hex('cafebabe');
const COMMIT = hex('deadbeef'); // a 64-hex string that is no token
const WAKE_KEY = Buffer.from(hex('5eed')).toString('base64');
const SECRETS = [OWN, SIBLING, SIBLING_NEW, WAKE_KEY];

const host = {
  encrypt: async (plain: string) => Uint8Array.from(Buffer.from(plain, 'utf8'), (byte) => byte ^ 0x5a),
  decrypt: async (cipher: Uint8Array) => Buffer.from(Uint8Array.from(cipher, (byte) => byte ^ 0x5a)).toString('utf8'),
};

const textOf = (output: ToolOutput): string => (output.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('\n');
/** Fails with the case's name – never with the value. */
function leaks(text: string, where: string): void {
  for (const [index, secret] of SECRETS.entries()) assert.ok(!text.includes(secret), `${where}: secret #${index} is in the text`);
}

function rig() {
  const h = setup();
  const root = mkdtempSync(path.join(tmpdir(), 'runtime-token-'));
  const first = path.join(root, 'first');
  const dir = path.join(root, 'Companies');
  const own = path.join(dir, 'company-2');
  const sibling = path.join(dir, 'company-3');
  for (const folder of [first, own, sibling]) mkdirSync(folder, { recursive: true });
  let tick = Date.UTC(2026, 10, 28) / 1000;
  const write = (file: string, text: string) => { writeFileSync(file, text); utimesSync(file, ++tick, tick); };
  const runtime = (folder: string, token: string) => write(path.join(folder, 'runtime.json'), JSON.stringify({ port: 4711, token, pid: 4242, at: '2026-11-28T00:00:00.000Z' }));
  runtime(own, OWN);
  runtime(sibling, SIBLING);
  write(path.join(own, 'wake.json'), `${JSON.stringify({ v: 1, relay: 'wss://meet.example', key: { pub: 'public-half', pkcs8: WAKE_KEY }, pins: [] })}\n`);
  write(path.join(own, 'commit.txt'), `HEAD ${COMMIT}\n`);

  const vault = new SecretVault({ db: h.db, host, clock: h.clock });
  vault.maskRuntimeValues({ dataDir: own, companies: { first, dir }, launchToken: OWN });
  const services = h.services as RuntimeServices;
  services.secrets = vault;
  services.paths = { workspace: WORKSPACE, data: own } as RuntimeServices['paths'];
  const journal: Array<{ kind: string; name?: string; data: unknown }> = [];
  services.runs = { item: (_runId: string, item: { kind: string; name?: string; data: unknown }) => { journal.push(item); return { id: `ri_${journal.length}` }; }, updateItem: () => undefined } as unknown as RuntimeServices['runs'];

  const registry = new Registry({ services: () => services });
  for (const tool of fileTools()) registry.register(tool);
  const base: Omit<ToolContext, 'services'> = { agent: h.org.require('ag_tom'), runId: 'run_1', conversationId: h.chat.id, mode: 'general', signal: new AbortController().signal, status: () => {} };
  let serial = 0;
  const call = (name: string, args: Record<string, unknown>) => registry.call(name, args, base, `c${++serial}`);
  // What an agent types to print a file (stdout), or to print it on stderr.
  const win = process.platform === 'win32';
  const print = (file: string) => (win ? `Get-Content -Raw '${file}'` : `cat '${file}'`);
  const printErr = (file: string) => (win ? `[Console]::Error.Write((Get-Content -Raw '${file}'))` : `cat '${file}' 1>&2`);
  return { h, root, own, sibling, journal, call, print, printErr, runtime, clock: h.clock, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('shell.exec printing runtime.json and wake.json (stdout and stderr): tool result and journal carry the marks, never the values', async () => {
  const r = rig();
  try {
    const ownFile = path.join(r.own, 'runtime.json');
    const wakeFile = path.join(r.own, 'wake.json');
    const siblingFile = path.join(r.sibling, 'runtime.json');
    const out = textOf(await r.call('shell.exec', { cwd: r.root, command: r.print(ownFile) }));
    leaks(out, 'shell.exec runtime.json');
    assert.ok(out.includes(RUNTIME_TOKEN_MARK) && out.includes('"port":4711') && out.includes('"pid":4242'), 'the mark stands where the token was; port and pid are shown');

    const sibling = textOf(await r.call('shell.exec', { cwd: r.root, command: r.print(siblingFile) }));
    leaks(sibling, 'shell.exec sibling runtime.json');
    assert.ok(sibling.includes(RUNTIME_TOKEN_MARK), 'the sibling company\'s token is masked');

    const wake = textOf(await r.call('shell.exec', { cwd: r.root, command: r.print(wakeFile) }));
    leaks(wake, 'shell.exec wake.json');
    assert.ok(wake.includes(WAKE_KEY_MARK) && wake.includes('public-half'), 'the private key is masked, the public half is shown');

    const err = textOf(await r.call('shell.exec', { cwd: r.root, command: r.printErr(ownFile) }));
    leaks(err, 'shell.exec runtime.json on stderr');
    assert.ok(err.includes(RUNTIME_TOKEN_MARK), 'stderr is masked too');

    leaks(JSON.stringify(r.journal), 'run journal');
    const results = r.journal.filter((item) => item.kind === 'tool_result');
    assert.equal(results.length, 4, 'four results journaled');
    assert.ok(results.every((item) => JSON.stringify(item.data).includes('‹secret:')), 'each journal row holds a mark');
  } finally { r.done(); }
});

test('files.read of runtime.json, wake.json and the sibling\'s runtime.json: the same marks', async () => {
  const r = rig();
  try {
    for (const file of [path.join(r.own, 'runtime.json'), path.join(r.own, 'wake.json'), path.join(r.sibling, 'runtime.json')]) {
      const out = textOf(await r.call('files.read', { path: file }));
      leaks(out, `files.read ${path.basename(file)}`);
      assert.ok(out.includes(RUNTIME_TOKEN_MARK) || out.includes(WAKE_KEY_MARK), `files.read ${path.basename(file)}: a mark stands there`);
    }
    leaks(JSON.stringify(r.journal), 'run journal');
  } finally { r.done(); }
});

test('control: another 64-hex string is printed unchanged', async () => {
  const r = rig();
  try {
    const out = textOf(await r.call('shell.exec', { cwd: r.root, command: r.print(path.join(r.own, 'commit.txt')) }));
    assert.ok(out.includes(`HEAD ${COMMIT}`), 'a commit hash is no token');
    assert.ok(!out.includes('‹secret:'), 'no mark on a text without a secret');
    const read = textOf(await r.call('files.read', { path: path.join(r.own, 'commit.txt') }));
    assert.ok(read.includes(`HEAD ${COMMIT}`) && !read.includes('‹secret:'), 'files.read leaves it too');
  } finally { r.done(); }
});

test('the sibling company restarts: its new token is masked at the next call after the interval, the old one stays masked', async () => {
  const r = rig();
  try {
    const siblingFile = path.join(r.sibling, 'runtime.json');
    await r.call('shell.exec', { cwd: r.root, command: r.print(siblingFile) }); // the first look
    r.runtime(r.sibling, SIBLING_NEW); // company-3 starts again: a new token
    r.clock.advance(INTERVAL_MS);
    const out = textOf(await r.call('shell.exec', { cwd: r.root, command: r.print(siblingFile) }));
    leaks(out, 'after the restart');
    assert.ok(out.includes(RUNTIME_TOKEN_MARK), 'the new token is masked');
    const old = textOf(await r.call('files.read', { path: siblingFile }));
    leaks(old, 'files.read after the restart');
    leaks(JSON.stringify(r.journal), 'run journal after the restart');
  } finally { r.done(); }
});
