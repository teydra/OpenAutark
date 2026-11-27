// The slim wake helper for Windows (resources/broker/WakeHelper.cs → AutarkWakeHelper.exe, 0.3.22): the same protocol as
// runtime/devices/sleeper.ts, in a program that idles under 20 MB instead of the Node helper's 113 MB.
// 1. The pure logic in C# (JSON, Ed25519/X25519/HKDF/AES-GCM against the RFC and NIST vectors, wake file, wake check, throttle, the
//    decision for every frame, life rules) – compiled in memory and run in PowerShell (wake-helper-cs/run.ps1).
// 2. The source rules: one start of one program, the registered one; no shell, no regex, no ClientWebSocket.
// 3. End to end, on Windows, with a stand-in meeting server (ws on 127.0.0.1) and a stand-in app: wakes made with THIS repository's
//    TypeScript (signWake, toBox, sealJson) reach the C# helper; the stand-in app starts for a real wake only, with the registered
//    arguments only; unsigned, wrongly signed, stale, repeated and foreign-session wakes start nothing and get no answer.
// Owns: these assertions and their throwaway data folders. Never: touches the person's Autark, its data folders or the broker service.

import { test, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { b64url, exportPrivate, fingerprintOf, fromB64url, generateEd25519, rawPublic, signEd25519, verifyEd25519 } from '../../../src/runtime/devices/keys.ts';
import { signWake, wakeFpOf } from '../../../src/runtime/devices/wake-sign.ts';
import { RelayClient } from '../../../src/runtime/devices/rendezvous/relay-client.ts';
import { remoteIdOf } from '../../../src/runtime/remote/id.ts';
import { PAIR_INFO, boxSigned, helloText, openJson, sealJson, toBox, type CounterCipher } from '../../../src/runtime/devices/rendezvous/seal.ts';

const framework = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const csc = path.join(framework, 'csc.exe');
const code = (file: string) => readFileSync(path.join('resources', 'broker', file), 'utf8').split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
const windows = process.platform === 'win32' && existsSync(csc);

test('source rules: it starts the one registered program, through no shell, and holds no heavy parts', () => {
  const helper = code('WakeHelper.cs');
  assert.equal((helper.match(/Process\.Start\(/g) ?? []).length, 1, 'one place starts a program');
  assert.match(helper, /new ProcessStartInfo\(appExe, args\.ToString\(\)\)/, 'the registered app, nothing else');
  assert.match(helper, /UseShellExecute = false/);
  assert.match(helper, /EnvironmentVariables\.Remove\("ELECTRON_RUN_AS_NODE"\)/, 'the app starts as the app');
  assert.doesNotMatch(helper, /cmd\.exe|powershell|ShellExecute = true|"runas"/i);
  assert.doesNotMatch(helper, /System\.Text\.RegularExpressions|Regex|ClientWebSocket|System\.Linq|HttpClient|WebClient/, 'no regex, no LINQ, no heavy network classes');
  assert.doesNotMatch(helper, /LocalSystem|CreateProcessAsUser|WTSQueryUserToken|TOKEN_|Impersonate/, 'it never handles tokens: it runs as the person it was started as');
  assert.doesNotMatch(helper, /Console\.Write|\bkey\b.*Log\(/, 'no key in a log line');
  // what a wake carries: only op, at, nonce and sig are read
  const check = helper.slice(helper.indexOf('public static bool Check('), helper.indexOf('const int MaxSeen'));
  assert.deepEqual([...check.matchAll(/(?:Str|Num)\(o, "(\w+)"\)/g)].map((match) => match[1]).sort(), ['at', 'nonce', 'op', 'sig']);
  const pair = helper.slice(helper.indexOf('string Pair('), helper.indexOf('// =====', helper.indexOf('string Pair(')));
  assert.deepEqual([...pair.matchAll(/(?:Str|Num)\(frame, "(\w+)"\)/g)].map((match) => match[1]).sort(), ['c', 'e', 'from'], 'the frame: sender, ephemeral key and sealed body');
  assert.doesNotMatch(pair, /error|stale|forbidden|REFUSED/, 'nothing is answered to a request that is no real wake');
});

test('build.ps1 builds the helper beside the broker, from WakeHelper.cs alone, unpacked like it', () => {
  const build = readFileSync(path.join('resources', 'broker', 'build.ps1'), 'utf8');
  assert.match(build, /AutarkWakeHelper\.exe/);
  assert.match(build, /WakeHelper\.cs/);
  assert.match(build, /System\.Numerics\.dll/);
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { build: { asarUnpack: string[] } };
  assert.ok(manifest.build.asarUnpack.includes('resources/broker/*.exe'), 'every exe in resources/broker ships unpacked (and is signed by the content-based PE pass)');
});

test('the helper\'s logic (C#, WakeHelper.cs): vectors, wake file, wake check, throttle, every frame, life rules', { skip: !windows }, () => {
  // Compiled in memory and run inside PowerShell (wake-helper-cs/run.ps1): a fresh unsigned test exe may be held by Smart App Control.
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join('test', 'unit', 'computer', 'wake-helper-cs', 'run.ps1')], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, `${run.error?.message ?? ''}${run.stdout}${run.stderr}`);
  assert.doesNotMatch(run.stdout, /^FAIL /m, run.stdout);
  assert.match(run.stdout, /ALL PASS/);
});

// ------------------------------------------------------------------------------------------------ end to end (Windows)

const work = windows ? mkdtempSync(path.join(tmpdir(), 'wf-wake-helper-')) : '';
const helperExe = path.join(work, 'AutarkWakeHelper.exe');
const stubExe = path.join(work, 'stub-app.exe');
const stubMjs = path.join(work, 'stub-app.mjs');
const hostScript = path.resolve('test', 'unit', 'computer', 'wake-helper-cs', 'host.ps1');
const running = new Set<ChildProcess>();
const relays = new Set<FakeRelay>();
let built: string | undefined;
/**
 * A PC with Smart App Control (teydra-server) refuses every fresh unsigned exe, so neither the helper nor a compiled stand-in app
 * can run there: the helper's code then runs in PowerShell (host.ps1, compiled in memory) and the stand-in app is Node with a script
 * (the same log line). Everywhere else (CI) the real AutarkWakeHelper.exe and a real stand-in exe run.
 */
let hosted = false;

function build(): string | undefined {
  if (built !== undefined || !windows) return built;
  const stubSource = path.join(work, 'Stub.cs');
  const stubLine = `"START " + string.Join("|", a) + " NODE=" + (Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE") ?? "") + "\\n"`;
  writeFileSync(stubSource, `using System; using System.IO; using System.Threading;
class Stub { static void Main(string[] a) {
  File.AppendAllText(Environment.GetEnvironmentVariable("STUB_OUT"), ${stubLine});
  string hold = Environment.GetEnvironmentVariable("STUB_HOLD_MS"); if (hold != null) Thread.Sleep(int.Parse(hold));
} }\n`);
  writeFileSync(stubMjs, `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.STUB_OUT, 'START ' + process.argv.slice(2).join('|') + ' NODE=' + (process.env.ELECTRON_RUN_AS_NODE ?? '') + '\\n');
if (process.env.STUB_HOLD_MS) setTimeout(() => {}, Number(process.env.STUB_HOLD_MS));\n`);
  const references = ['System.dll', 'System.Core.dll', 'System.Numerics.dll'].map((name) => `/reference:${path.join(framework, name)}`);
  const one = spawnSync(csc, ['/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', '/warn:4', `/out:${helperExe}`, ...references, path.join('resources', 'broker', 'WakeHelper.cs')], { encoding: 'utf8' });
  const two = spawnSync(csc, ['/nologo', '/target:exe', `/out:${stubExe}`, stubSource], { encoding: 'utf8' });
  built = one.status === 0 && two.status === 0 ? '' : `${one.stdout}${one.stderr}${two.stdout}${two.stderr}`;
  hosted = Boolean(spawnSync(helperExe, [], { timeout: 10_000 }).error);
  return built;
}

/** The stand-in app: a real exe, or (where fresh exes are refused) Node with a script – its executable and the arguments it needs first. */
const appExe = () => (hosted ? process.execPath : stubExe);
const appPrefix = () => (hosted ? [stubMjs] : []);

after(() => {
  for (const child of running) child.kill();
  for (const relay of relays) relay.close();
  if (work) try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a stub still ends */ }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(what: string, condition: () => boolean, ms = 8_000): Promise<number> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > ms) assert.fail(`timeout waiting for ${what}`);
    await sleep(25);
  }
  return Date.now() - started;
}

interface Key { privateKey: ReturnType<typeof generateEd25519>['privateKey']; pub: string; fp: string }
function newKey(): Key {
  const pair = generateEd25519();
  const raw = rawPublic(pair.publicKey);
  return { privateKey: pair.privateKey, pub: b64url(raw), fp: fingerprintOf(raw) };
}

/** A stand-in meeting server: challenge, signed hello, ready, and the helper's sealed 'pair' traffic. */
class FakeRelay {
  readonly server: WebSocketServer;
  connections = 0;
  readonly closes: number[] = [];
  readonly replies: Array<Record<string, unknown>> = [];
  hello?: { pub: string; box: string; fp: string; wakeFp: string; findable: unknown; peers: unknown; signedOk: boolean };
  socket?: WebSocket;
  pongs = 0;
  private nextRef = 1;
  readonly listening: Promise<void>;

  constructor() {
    this.server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 70 * 1024 });
    this.listening = new Promise((resolve) => this.server.once('listening', () => resolve()));
    relays.add(this);
    this.server.on('connection', (ws: WebSocket) => {
      this.connections++;
      this.socket = ws;
      this.hello = undefined;
      const challenge = randomBytes(12).toString('hex');
      ws.send(JSON.stringify({ t: 'challenge', n: challenge }));
      ws.on('pong', () => { this.pongs++; });
      ws.on('close', (code: number) => { this.closes.push(code); });
      ws.on('message', (data: Buffer) => {
        const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
        if (frame.t === 'hello') {
          const pub = fromB64url(String(frame.pub));
          const signedOk = pub.length === 32 && verifyEd25519(pub, Buffer.from(helloText(challenge), 'utf8'), fromB64url(String(frame.sig))) && boxSigned(String(frame.pub), frame.box, frame.boxSig);
          this.hello = { pub: String(frame.pub), box: String(frame.box), fp: fingerprintOf(pub), wakeFp: wakeFpOf(String(frame.pub)), findable: frame.findable, peers: frame.peers, signedOk };
          if (signedOk) ws.send(JSON.stringify({ t: 'ready', online: [] }));
          else ws.close();
        } else if (frame.t === 'pairReply') this.replies.push(frame);
      });
    });
  }

  get url(): string { return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}/autark`; }
  close(): void { for (const client of this.server.clients) client.terminate(); this.server.close(); }

  /** What a waking device sends: a sealed wake through the server's 'pair' forwarding, as `from`. Returns the frame and the cipher that opens the answer. */
  pair(from: string, body: (box: string, wakeFp: string) => unknown, box = this.hello!.box): { frame: Record<string, unknown>; cipher: CounterCipher; ref: number } {
    const { e, cipher } = toBox(box, PAIR_INFO);
    const ref = this.nextRef++;
    return { frame: { t: 'pair', ref, from, e, c: sealJson(cipher, body(box, this.hello!.wakeFp)) }, cipher, ref };
  }

  deliver(frame: unknown): void { this.socket!.send(JSON.stringify(frame)); }
}

interface Session { dir: string; data: string; relay: FakeRelay; phone: Key; stranger: Key; helper?: ChildProcess; out: string; exited: () => boolean; exitCode: () => number | null | undefined; stubLog: () => string[] }

async function session(t: TestContext, options: { relay?: FakeRelay; dir?: string } = {}): Promise<Session> {
  assert.equal(build(), '', `build: ${built}`);
  const dir = options.dir ?? mkdtempSync(path.join(work, 's-'));
  const data = path.join(dir, 'data');
  mkdirSync(path.join(data, 'logs'), { recursive: true });
  const relay = options.relay ?? new FakeRelay();
  await relay.listening;
  const phone = newKey();
  const pair = generateEd25519();
  writeFileSync(path.join(data, 'wake.json'), JSON.stringify({ v: 1, relay: relay.url, key: { pub: b64url(rawPublic(pair.publicKey)), pkcs8: exportPrivate(pair.privateKey) }, pins: [{ fp: phone.fp, pub: phone.pub }] }));
  const out = path.join(dir, 'stub.log');
  const s: Session = { dir, data, relay, phone, stranger: newKey(), out, exited: () => false, exitCode: () => undefined, stubLog: () => (existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean) : []) };
  t.diagnostic(`session ${path.basename(dir)}`);
  return s;
}

/** The helper's process: the real exe, or (hosted) PowerShell running the same code. `app` defaults to the stand-in app. */
function spawnHelper(s: Session, extra: string[], app: string | undefined, env: NodeJS.ProcessEnv): ChildProcess {
  const appPath = app ?? appExe();
  const args = [path.join(s.data, 'wake.json'), '--app', appPath, '--', ...(app === undefined ? appPrefix() : []), ...extra];
  const options = { env: { ...process.env, STUB_OUT: s.out, ELECTRON_RUN_AS_NODE: '1', ...env }, stdio: 'ignore' as const, windowsHide: true };
  return hosted
    ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', hostScript, ...args], options)
    : spawn(helperExe, args, options);
}

function startHelper(s: Session, extra: string[] = ['--company=company-9'], app?: string, env: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawnHelper(s, extra, app, env);
  let ended: number | null | undefined;
  child.once('exit', (c) => { ended = c; running.delete(child); });
  s.helper = child; s.exited = () => ended !== undefined; s.exitCode = () => ended;
  running.add(child);
  return child;
}

const wakeBody = (signer: Key, at = Date.now(), nonce = b64url(randomBytes(18))) => (box: string, wakeFp: string) =>
  signWake((data) => signEd25519(signer.privateKey, data), wakeFp, box, at, nonce);

test('a real wake starts the registered app – with the registered arguments only – and is answered; the helper then ends and removes its mark', { skip: !windows }, async (t) => {
  const s = await session(t);
  startHelper(s);
  await waitFor('the helper at the meeting server', () => s.relay.hello !== undefined);
  assert.equal(s.relay.hello!.signedOk, true, 'its hello carries a valid signature over the challenge and over its box key');
  assert.equal(s.relay.hello!.findable, true);
  assert.deepEqual(s.relay.hello!.peers, []);
  assert.ok(existsSync(path.join(s.data, 'sleeper.json')), 'its mark');
  const sleeperMark = JSON.parse(readFileSync(path.join(s.data, 'sleeper.json'), 'utf8')) as { pid: number };
  assert.equal(sleeperMark.pid, s.helper!.pid);
  // a wake with smuggled parameters: a command, a path, arguments, another company
  const smuggled = (box: string, wakeFp: string) => ({ ...wakeBody(s.phone)(box, wakeFp), exe: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'calc'], cmd: 'calc.exe', company: 'company-1', argv: ['--evil'] });
  const { frame, cipher, ref } = s.relay.pair(s.phone.fp, smuggled);
  const sentAt = Date.now();
  s.relay.deliver(frame);
  const ms = await waitFor('the stand-in app', () => s.stubLog().length > 0);
  t.diagnostic(`wake -> app started after ${Date.now() - sentAt} ms (polled ${ms} ms)`);
  assert.deepEqual(s.stubLog(), ['START --company=company-9 NODE=']);
  await waitFor('the answer', () => s.relay.replies.length > 0);
  assert.equal(s.relay.replies[0]!.ref, ref);
  assert.equal(s.relay.replies[0]!.error, undefined);
  assert.deepEqual(openJson(cipher, s.relay.replies[0]!.c), { ok: true });
  await waitFor('the helper to end', () => s.exited(), 5_000);
  assert.equal(s.exitCode(), 0);
  assert.equal(existsSync(path.join(s.data, 'sleeper.json')), false, 'its mark is gone');
  const log = readFileSync(path.join(s.data, 'logs', 'sleeper.log'), 'utf8');
  assert.match(log, /woken by a linked PC/);
  assert.doesNotMatch(log, new RegExp(readFileSync(path.join(s.data, 'wake.json'), 'utf8').match(/"pkcs8":"([^"]+)"/)![1]!), 'no key in the log');
  assert.equal(s.stubLog().length, 1, 'once');
  const closed = s.relay.closes;
  t.diagnostic(`socket closes: ${closed.join(',')}`);
});

test('unsigned, wrongly signed, foreign, stale, undecryptable and other-session wakes start nothing and get no answer; then a real one still works', { skip: !windows }, async (t) => {
  const s = await session(t);
  startHelper(s);
  await waitFor('the helper at the meeting server', () => s.relay.hello !== undefined);
  const now = Date.now();
  const frames = [
    // a key that is no pin: validly signed, but not a pin
    s.relay.pair(s.stranger.fp, wakeBody(s.stranger)),
    // a pin's name, another key's signature
    s.relay.pair(s.phone.fp, wakeBody(s.stranger)),
    // a pin's name, no signature
    s.relay.pair(s.phone.fp, () => ({ op: 'wake', at: now, nonce: b64url(randomBytes(18)) })),
    // stale: a real signature, two minutes old
    s.relay.pair(s.phone.fp, wakeBody(s.phone, now - 120_000)),
    // signed for another session's box key
    s.relay.pair(s.phone.fp, (_box, wakeFp) => signWake((data) => signEd25519(s.phone.privateKey, data), wakeFp, b64url(randomBytes(32)), now, b64url(randomBytes(18)))),
  ];
  for (const { frame } of frames) s.relay.deliver(frame);
  // sealed to a box key that is not this session's: cannot be opened
  const foreign = toBox(b64url(randomBytes(32)), PAIR_INFO);
  s.relay.deliver({ t: 'pair', ref: 99, from: s.phone.fp, e: foreign.e, c: sealJson(foreign.cipher, { op: 'wake' }) });
  s.relay.deliver({ t: 'pair', ref: 100, from: s.phone.fp, e: 'x', c: 'y' });
  s.relay.deliver({ t: 'pair', ref: 101, from: s.phone.fp });
  s.relay.deliver({ t: 'pair', ref: 102, e: foreign.e, c: 'AAAA' });
  s.relay.deliver({ t: 'nonsense' });
  await sleep(1_500);
  assert.deepEqual(s.stubLog(), [], 'nothing started');
  assert.deepEqual(s.relay.replies, [], 'and nothing was answered – not even a refusal');
  assert.equal(s.exited(), false, 'the helper goes on waiting');
  // the fakes from the pin used up its burst (6): a real wake right now is throttled too (dropped, no answer); one token later (5 s) it passes
  const early = s.relay.pair(s.phone.fp, wakeBody(s.phone));
  s.relay.deliver(early.frame);
  await sleep(500);
  assert.deepEqual(s.stubLog(), [], 'throttled: nothing started');
  assert.deepEqual(s.relay.replies, []);
  await sleep(5_500);
  const real = s.relay.pair(s.phone.fp, wakeBody(s.phone));
  s.relay.deliver(real.frame);
  await waitFor('the stand-in app', () => s.stubLog().length > 0);
  await waitFor('the answer', () => s.relay.replies.length > 0);
  assert.deepEqual(openJson(real.cipher, (s.relay.replies[0] as Record<string, unknown>).c), { ok: true });
  assert.deepEqual(s.stubLog(), ['START --company=company-9 NODE=']);
});

test('a repeated wake does nothing: the same sealed frame in a new session, and the same signed wake sealed again', { skip: !windows }, async (t) => {
  const s = await session(t);
  startHelper(s);
  await waitFor('the helper at the meeting server', () => s.relay.hello !== undefined);
  const at = Date.now();
  const nonce = b64url(randomBytes(18));
  const first = s.relay.pair(s.phone.fp, wakeBody(s.phone, at, nonce));
  s.relay.deliver(first.frame);
  await waitFor('the stand-in app', () => s.stubLog().length === 1);
  await waitFor('the helper to end', () => s.exited(), 5_000);
  // a new helper session (new box key) in the same data folder gets the old frame again
  // (the wake.json of the first session stays: only the process is new)
  startHelper(s);
  await waitFor('the second helper at the meeting server', () => s.relay.connections >= 2 && s.relay.hello !== undefined);
  s.relay.deliver(first.frame);
  // the same signed body sealed once more to the new session's box: its signature covers the old box, so it does not hold
  s.relay.deliver(s.relay.pair(s.phone.fp, () => ({ op: 'wake', at, nonce, sig: (first.frame.c as string).slice(0, 80) })).frame);
  await sleep(1_500);
  assert.equal(s.stubLog().length, 1, 'the app was started once');
  assert.equal(s.relay.replies.length, 1, 'only the first wake was answered');
  assert.equal(s.exited(), false);
  s.helper!.kill();
});

test('while the app runs (run-state.json names a live process with the app\'s image), the helper ends at once and opens no connection', { skip: !windows }, async (t) => {
  const s = await session(t);
  // the app runs already (a live process with the app's image name, named in run-state.json): the helper ends at once, opens no connection
  const holder = spawn(appExe(), appPrefix(), { env: { ...process.env, STUB_OUT: s.out, STUB_HOLD_MS: '20000' }, stdio: 'ignore', windowsHide: true });
  running.add(holder);
  await waitFor('the stand-in app', () => s.stubLog().length === 1);
  writeFileSync(path.join(s.data, 'run-state.json'), JSON.stringify({ state: 'running', at: Date.now(), pid: holder.pid }));
  startHelper(s);
  await waitFor('the helper to end', () => s.exited(), 5_000);
  assert.equal(s.exitCode(), 0);
  assert.equal(s.relay.connections, 0, 'no connection while the app runs');
  assert.equal(existsSync(path.join(s.data, 'sleeper.json')), false);
  holder.kill();
});

test('the app starting while the helper waits ends the helper (run-state.json), a second helper in the same data folder ends at once, a broken file or a missing app ends it without a connection', { skip: !windows }, async (t) => {
  const s = await session(t);
  startHelper(s);
  await waitFor('the helper at the meeting server', () => s.relay.hello !== undefined);
  const first = s.helper!;
  // second helper, same folder: ends at once
  const second = spawnHelper(s, ['--company=company-9'], undefined, {});
  running.add(second);
  const code = await new Promise<number | null>((resolve) => second.once('exit', resolve));
  assert.equal(code, 0);
  assert.equal(s.relay.connections, 1, 'the second never connected');
  assert.equal(first.exitCode, null, 'the first goes on');
  // the app starts by itself: its run-state names a live process with the app's image name
  const holder = spawn(appExe(), appPrefix(), { env: { ...process.env, STUB_OUT: s.out, STUB_HOLD_MS: '20000' }, stdio: 'ignore', windowsHide: true });
  running.add(holder);
  await waitFor('the stand-in app', () => holder.pid !== undefined && s.stubLog().length === 1);
  writeFileSync(path.join(s.data, 'run-state.json'), JSON.stringify({ state: 'running', at: Date.now(), pid: holder.pid }));
  await waitFor('the first helper to end', () => s.exited(), 5_000);
  holder.kill();
  // a broken file and a missing app: nothing runs, nothing connects
  const broken = await session(t);
  writeFileSync(path.join(broken.data, 'wake.json'), '{"v":1,"relay":"ws://127.0.0.1:1/x"}');
  startHelper(broken);
  await waitFor('the helper with a broken file to end', () => broken.exited(), 5_000);
  assert.equal(broken.exitCode(), 0);
  const noApp = await session(t);
  startHelper(noApp, ['--company=company-9'], path.join(noApp.dir, 'missing', 'Autark.exe'));
  await waitFor('the helper without its app to end', () => noApp.exited(), 5_000);
  assert.equal(noApp.relay.connections, 0);
});

test('scheduled work: a due time that fell between a forced close and the helper\'s start starts the app with --background, then the helper ends', { skip: !windows }, async (t) => {
  const s = await session(t);
  if (hosted) { t.skip('hosted (Smart App Control): the stand-in app is Node, which would take --background as its own option; the real exe runs it in CI'); return; }
  const dead = spawnSync(appExe(), appPrefix(), { env: { ...process.env, STUB_OUT: path.join(s.dir, 'dead.log') } }); // a pid that is gone
  writeFileSync(path.join(s.data, 'run-state.json'), JSON.stringify({ state: 'running', at: Date.now() - 90_000, pid: dead.pid ?? 4_000_000 }));
  writeFileSync(path.join(s.data, 'next-due.json'), JSON.stringify({ at: Date.now() - 30_000 }));
  startHelper(s);
  await waitFor('the stand-in app', () => s.stubLog().length > 0);
  assert.deepEqual(s.stubLog(), ['START --background|--company=company-9 NODE=']);
  await waitFor('the helper to end', () => s.exited(), 6_000);
  assert.equal(s.exitCode(), 0);
});

test('the connection: it answers pings, reconnects after a drop with a new box key, ends when the server hands its key over (4009), and refuses a frame over 70 KB', { skip: !windows }, async (t) => {
  const s = await session(t);
  startHelper(s);
  await waitFor('the helper at the meeting server', () => s.relay.hello !== undefined);
  s.relay.socket!.ping();
  await waitFor('a pong', () => s.relay.pongs > 0, 3_000);
  const firstBox = s.relay.hello!.box;
  s.relay.socket!.terminate();
  await waitFor('a new connection', () => s.relay.connections === 2 && s.relay.hello !== undefined, 8_000);
  assert.notEqual(s.relay.hello!.box, firstBox, 'a new session has a new box key');
  assert.equal(s.relay.hello!.signedOk, true);
  s.relay.socket!.send('x'.repeat(80 * 1024));
  await waitFor('a third connection after the oversized frame', () => s.relay.connections === 3 && s.relay.hello !== undefined, 8_000);
  assert.equal(s.exited(), false);
  s.relay.socket!.close(4009);
  await waitFor('the helper to end', () => s.exited(), 5_000);
  assert.equal(s.exitCode(), 0);
  assert.equal(s.stubLog().length, 0, 'it never started the app');
});

// ------------------------------------------------------------------------------------------------ the real meeting server
// WAKE_HELPER_RELAY=wss://…/autark: the helper registers a throwaway key at the REAL meeting server (TLS included) and is woken by this
// repository's own RelayClient – the sending side of the Wake button (runtime/devices/wake.ts sendWake). Not part of `npm test`: the
// meeting server is a public service (Render, cold start up to a minute); run by hand or by .github/workflows/wake-helper-memory.yml.
const realRelay = process.env.WAKE_HELPER_RELAY;

async function senderOf(s: Session, url: string): Promise<{ client: RelayClient; entry: () => Promise<{ fp: string; pub: string; box: string } | undefined>; fp: string }> {
  const noop = () => undefined;
  const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log } as never;
  let client: RelayClient | undefined;
  const up = new Promise<void>((resolve) => {
    client = new RelayClient({
      identity: { publicKey: Buffer.from(s.phone.pub, 'base64url'), sign: (data) => Buffer.from(signEd25519(s.phone.privateKey, data)) },
      log,
      events: { changed: () => { if (client?.state().status === 'connected') resolve(); }, presence: noop, incoming: noop, pair: async () => ({ ok: false }) },
    });
  });
  client!.configure(url);
  await Promise.race([up, sleep(90_000).then(() => assert.fail('no connection to the meeting server in 90 s'))]);
  const helperPub = (JSON.parse(readFileSync(path.join(s.data, 'wake.json'), 'utf8')) as { key: { pub: string } }).key.pub;
  const fp = wakeFpOf(helperPub);
  const entry = async () => (await client!.find(remoteIdOf(fp))).find((found) => found.fp === fp && found.pub === helperPub);
  return { client: client!, entry, fp };
}

async function findHelper(entry: () => Promise<{ fp: string; pub: string; box: string } | undefined>, differentFrom?: string) {
  const started = Date.now();
  for (;;) {
    const found = await entry().catch(() => undefined);
    if (found && found.box !== differentFrom) return found;
    if (Date.now() - started > 90_000) assert.fail('the helper never showed up at the meeting server');
    await sleep(500);
  }
}

const refused = async (promise: Promise<unknown>) => { try { await promise; } catch { return true; } return false; };

test('through the real meeting server: a real wake starts the app (smuggled parameters ignored); unsigned, wrongly signed, stale and replayed wakes start nothing and get no answer', { skip: !windows || !realRelay, timeout: 600_000 }, async (t) => {
  const s = await session(t);
  const wake = JSON.parse(readFileSync(path.join(s.data, 'wake.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(path.join(s.data, 'wake.json'), JSON.stringify({ ...wake, relay: realRelay }));
  const { client, entry, fp } = await senderOf(s, realRelay!);
  t.after(() => client.stop());
  const sign = (data: Uint8Array) => signEd25519(s.phone.privateKey, data);
  startHelper(s);
  const first = await findHelper(entry);
  t.diagnostic(`the helper waits at the real meeting server (${hosted ? 'hosted' : 'exe'})`);
  // not real wakes: no signature / another key's signature / two minutes old
  const now = Date.now();
  const stranger = newKey();
  const fakes: unknown[] = [
    { op: 'wake', at: now, nonce: b64url(randomBytes(18)) },
    signWake((data) => signEd25519(stranger.privateKey, data), fp, first.box, now, b64url(randomBytes(18))),
    signWake(sign, fp, first.box, now - 120_000, b64url(randomBytes(18))),
  ];
  for (const body of fakes) assert.equal(await refused(client.request(fp, first.box, body, { timeoutMs: 3_000 })), true, 'no answer');
  assert.deepEqual(s.stubLog(), [], 'nothing started');
  assert.equal(s.exited(), false, 'the helper goes on waiting');
  // a real wake with smuggled parameters: the registered app starts, with the registered arguments only
  const real = { ...signWake(sign, fp, first.box, Date.now(), b64url(randomBytes(18))), exe: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'calc'], cmd: 'calc.exe', company: 'company-1' };
  const sentAt = Date.now();
  const reply = await client.request(fp, first.box, real, { timeoutMs: 20_000 });
  assert.deepEqual(reply, { ok: true });
  await waitFor('the stand-in app', () => s.stubLog().length > 0);
  t.diagnostic(`real wake: answered and app started ${Date.now() - sentAt} ms after sending`);
  assert.deepEqual(s.stubLog(), ['START --company=company-9 NODE=']);
  await waitFor('the helper to end', () => s.exited(), 10_000);
  assert.equal(s.exitCode(), 0);
  // replay: the same signed wake against the next session of the helper (new box key) does nothing; a fresh one still works
  startHelper(s);
  const second = await findHelper(entry, first.box);
  assert.equal(await refused(client.request(fp, second.box, real, { timeoutMs: 3_000 })), true, 'a replay gets no answer');
  assert.equal(s.stubLog().length, 1, 'still the one start');
  assert.deepEqual(await client.request(fp, second.box, signWake(sign, fp, second.box, Date.now(), b64url(randomBytes(18))), { timeoutMs: 20_000 }), { ok: true });
  await waitFor('the second start', () => s.stubLog().length === 2);
  await waitFor('the second helper to end', () => s.exited(), 10_000);
});
