// Measures the wake helper's memory at idle, and one real wake through a real meeting server, on Windows. Not a unit test: run by
// .github/workflows/wake-helper-memory.yml (a CI runner has no Smart App Control, so a fresh exe runs) and by hand on a PC that may run
// the exe (the signed build). Prints a Markdown report; with --out also writes the numbers as JSON. Never prints a key.
//   node measure.mjs --exe <AutarkWakeHelper.exe> [--relay wss://…/autark | --fake] [--minutes 5] [--env NAME=VALUE]… [--out result.json]
//   node measure.mjs --pid <a running helper's pid>  (only the idle numbers: the helper was started by the broker, say)
// Working set and private bytes are reported SEPARATELY (the target "under 20 MB" holds for each), plus the private working set.
//
// The helper is started with its own throwaway key and data folder, a stand-in app (a tiny exe), against `--relay` (default: the real
// meeting server): it registers there, idles `--minutes`, then a signed wake from a throwaway pinned key (the production RelayClient
// and signWake) must start the stand-in app; the time from sending to the app's first line is reported. `--fake` uses a local
// stand-in server over plain ws instead (no TLS, no wake): it shows how much of the memory is the connection's TLS.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(`--${name}`); return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback; };
const exe = option('exe');
const attach = option('pid');
const fake = args.includes('--fake');
const realRelay = option('relay', 'wss://telecoding-relay.onrender.com/autark');
const minutes = Number(option('minutes', '5'));
const out = option('out');
// like production (broker supervisor and sleeper.ts start the helper with these two GC settings); `--plain` starts it without
const gcEnv = args.includes('--plain') ? {} : { COMPlus_gcConcurrent: '0', COMPlus_GCgen0size: '100000' };
const extraEnv = { ...gcEnv, ...Object.fromEntries(args.flatMap((value, at) => (value === '--env' && args[at + 1]?.includes('=') ? [args[at + 1].split(/=(.*)/s).slice(0, 2)] : []))) };
if (!exe && !attach) { console.error('usage: node measure.mjs --exe <AutarkWakeHelper.exe> | --pid <pid> [--relay wss://… | --fake] [--minutes 5] [--env NAME=VALUE] [--out file.json]'); process.exit(2); }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'); // apps/desktop
const src = (rel) => import(pathToFileURL(path.join(root, 'src', rel)).href);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = (what) => console.error(`${new Date().toISOString()} ${what}`);
const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;

/** Working set, private bytes and private working set of one process, by the same numbers Task Manager and Get-Process show. */
function sample(pid, modules = false) {
  const script = `$p = Get-Process -Id ${pid} -ErrorAction Stop; $c = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter 'IDProcess=${pid}';`
    + ` $m = if (${modules ? '$true' : '$false'}) { @($p.Modules | Sort-Object ModuleMemorySize -Descending | Select-Object -First 12 | ForEach-Object { $_.ModuleName + ' ' + [int]($_.ModuleMemorySize / 1024) + 'K' }) } else { @() };`
    + ` [pscustomobject]@{ ws = $p.WorkingSet64; pb = $p.PrivateMemorySize64; pws = [int64]$c.WorkingSetPrivate; threads = $p.Threads.Count; handles = $p.HandleCount; modules = $m; moduleCount = $p.Modules.Count } | ConvertTo-Json -Compress`;
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (run.status !== 0) throw new Error(`sampling ${pid} failed: ${run.stderr || run.stdout}`);
  const value = JSON.parse(run.stdout.trim());
  return { at: new Date().toISOString(), workingSetMB: mb(value.ws), privateBytesMB: mb(value.pb), privateWorkingSetMB: mb(value.pws), threads: value.threads, handles: value.handles, moduleCount: value.moduleCount, modules: value.modules };
}

/** A stand-in meeting server over plain ws: challenge, ready after hello, a ping every 30 s like the real one. */
async function fakeServer() {
  const { WebSocketServer } = await import('ws');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 70 * 1024 });
  await new Promise((resolve) => server.once('listening', resolve));
  server.on('connection', (socket) => {
    socket.send(JSON.stringify({ t: 'challenge', n: randomBytes(12).toString('hex') }));
    const timer = setInterval(() => { try { socket.ping(); } catch { /* closing */ } }, 30_000);
    socket.on('close', () => clearInterval(timer));
    socket.on('message', (data) => {
      try {
        const frame = JSON.parse(data.toString('utf8'));
        if (frame.t === 'hello') socket.send(JSON.stringify({ t: 'ready', online: [] }));
        else if (frame.t === 'find') socket.send(JSON.stringify({ t: 'found', ref: frame.ref, entries: [] })); // the helper's own keep-alive, answered like relay.ts does
      } catch { /* not ours */ }
    });
  });
  return { url: `ws://127.0.0.1:${server.address().port}/autark`, close: () => { for (const socket of server.clients) socket.terminate(); server.close(); } };
}

const samples = [];
let child; let work; let result; let helperLog = ''; let stand; let regionsText = '';
try {
  let pid = attach ? Number(attach) : undefined;
  let session;
  if (exe) {
    if (!existsSync(exe)) throw new Error(`no such file: ${exe}`);
    const { generateEd25519, rawPublic, exportPrivate, b64url, fingerprintOf } = await src('runtime/devices/keys.ts');
    work = mkdtempSync(path.join(tmpdir(), 'wf-measure-'));
    const data = path.join(work, 'data');
    mkdirSync(path.join(data, 'logs'), { recursive: true });
    if (fake) stand = await fakeServer();
    const relay = stand ? stand.url : realRelay;
    const helperKey = generateEd25519();
    const phoneKey = generateEd25519();
    const phonePub = b64url(rawPublic(phoneKey.publicKey));
    const helperPub = b64url(rawPublic(helperKey.publicKey));
    writeFileSync(path.join(data, 'wake.json'), JSON.stringify({ v: 1, relay, key: { pub: helperPub, pkcs8: exportPrivate(helperKey.privateKey) }, pins: [{ fp: fingerprintOf(rawPublic(phoneKey.publicKey)), pub: phonePub }] }));
    // a tiny stand-in app: appends a line to STUB_OUT
    const framework = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
    const stubCs = path.join(work, 'Stub.cs');
    const stubExe = path.join(work, 'stub-app.exe');
    writeFileSync(stubCs, 'using System; using System.IO; class Stub { static void Main(string[] a) { File.AppendAllText(Environment.GetEnvironmentVariable("STUB_OUT"), "START " + string.Join("|", a) + "\\n"); } }\n');
    const csc = spawnSync(path.join(framework, 'csc.exe'), ['/nologo', '/target:exe', `/out:${stubExe}`, stubCs], { encoding: 'utf8' });
    if (csc.status !== 0) throw new Error(`stub build failed: ${csc.stdout}${csc.stderr}`);
    const stubOut = path.join(work, 'stub.log');
    session = { phoneKey, phonePub, helperPub, stubOut, data, relay };
    child = spawn(exe, [path.join(data, 'wake.json'), '--app', stubExe, '--', '--company=company-9'], { env: { ...process.env, ...extraEnv, STUB_OUT: stubOut }, stdio: 'ignore', windowsHide: true });
    pid = child.pid;
    stamp(`helper started, pid ${pid}${Object.keys(extraEnv).length ? ` with ${Object.keys(extraEnv).join(', ')}` : ''}${fake ? ' (stand-in server, plain ws)' : ''}`);
  }

  // the sending side: the production RelayClient (not with the stand-in server: it does not forward)
  let client; let find;
  if (session && !fake) {
    const { RelayClient } = await src('runtime/devices/rendezvous/relay-client.ts');
    const { wakeFpOf } = await src('runtime/devices/wake-sign.ts');
    const { remoteIdOf } = await src('runtime/remote/id.ts');
    const keys = await src('runtime/devices/keys.ts');
    const noop = () => undefined;
    const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log };
    const up = new Promise((resolve) => {
      client = new RelayClient({
        identity: { publicKey: Buffer.from(session.phonePub, 'base64url'), sign: (data) => Buffer.from(keys.signEd25519(session.phoneKey.privateKey, data)) },
        log, events: { changed: () => { if (client?.state().status === 'connected') resolve(); }, presence: noop, incoming: noop, pair: async () => ({ ok: false }) },
      });
    });
    client.configure(session.relay);
    await Promise.race([up, sleep(120_000).then(() => { throw new Error('no connection to the meeting server in 120 s'); })]);
    const fp = wakeFpOf(session.helperPub);
    // like the Wake button: find the helper (and its CURRENT box key) right when the wake is sent
    find = async (patient) => {
      const started = Date.now();
      for (;;) {
        const entry = (await client.find(remoteIdOf(fp)).catch(() => [])).find((found) => found.fp === fp && found.pub === session.helperPub);
        if (entry || !patient || Date.now() - started > 120_000) return { fp, entry };
        await sleep(500);
      }
    };
    if (!(await find(true)).entry) throw new Error('the helper never showed up at the meeting server');
    stamp('the helper waits at the meeting server');
  } else if (fake) await sleep(3_000);

  // idle: a sample every 30 s after a first one 10 s in; the last one is the "after N minutes" value
  const idleStart = Date.now();
  await sleep(10_000);
  samples.push({ afterSeconds: 10, ...sample(pid) });
  while (Date.now() - idleStart < minutes * 60_000) {
    await sleep(Math.min(30_000, Math.max(0, minutes * 60_000 - (Date.now() - idleStart))));
    const modules = Date.now() - idleStart >= minutes * 60_000 - 1_000;
    samples.push({ afterSeconds: Math.round((Date.now() - idleStart) / 1000), ...sample(pid, modules) });
    stamp(`idle ${samples.at(-1).afterSeconds} s: ws ${samples.at(-1).workingSetMB} MB, private bytes ${samples.at(-1).privateBytesMB} MB`);
  }
  const last = samples.at(-1);
  if (args.includes('--regions')) {
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(path.dirname(fileURLToPath(import.meta.url)), 'regions.ps1'), '-ProcessId', String(pid)], { encoding: 'utf8', windowsHide: true });
    regionsText = run.status === 0 ? run.stdout.trim() : `regions failed: ${run.stderr || run.stdout}`;
  }

  // one real wake at the end (it ends the helper)
  let wake;
  if (session && !fake) {
    const { signWake } = await src('runtime/devices/wake-sign.ts');
    const keys = await src('runtime/devices/keys.ts');
    const sign = (data) => keys.signEd25519(session.phoneKey.privateKey, data);
    const sentAt = Date.now();
    const { fp, entry } = await find(false);
    if (!entry) wake = { reply: 'the helper is no longer found at the meeting server', appStartedAfterMs: undefined };
    else {
      let reply;
      try { reply = await client.request(fp, entry.box, signWake(sign, fp, entry.box, Date.now(), keys.b64url(randomBytes(18))), { timeoutMs: 20_000 }); } catch (error) { reply = String(error?.message ?? error); }
      let appAt;
      while (Date.now() - sentAt < 20_000) {
        if (existsSync(session.stubOut) && readFileSync(session.stubOut, 'utf8').includes('START --company=company-9')) { appAt = Date.now() - sentAt; break; }
        await sleep(10);
      }
      wake = { reply, appStartedAfterMs: appAt };
    }
    stamp(`wake: ${JSON.stringify(wake)}`);
    client.stop();
  }
  // How often the helper (re)connected while it idled: every "ready" logs one line, a watchdog drop logs "connection ended: IOException: ended".
  // The server's protocol pings do not keep the helper's 90 s watchdog quiet (winhttp.dll answers them itself), so without the helper's own
  // keep-alive it would drop and reconnect (with a new box key) about every 90 s.
  let connections; let watchdogDrops;
  try {
    const lines = readFileSync(path.join(session?.data ?? '', 'logs', 'sleeper.log'), 'utf8').trim().split('\n');
    connections = lines.filter((line) => line.includes('waiting for a wake at the meeting server')).length;
    watchdogDrops = lines.filter((line) => line.includes('connection ended: IOException: ended')).length;
    helperLog = lines.slice(args.includes('--log') ? -300 : -12).join('\n');
  } catch { /* no log */ }
  result = { connections: session ? { atTheMeetingServer: connections, watchdogDrops, idleMinutes: minutes } : undefined,
 exe: exe ? path.basename(exe) : `pid ${attach}`, relay: session ? (fake ? 'stand-in server (plain ws)' : session.relay) : undefined, env: extraEnv, minutes, afterMinutes: { workingSetMB: last.workingSetMB, privateBytesMB: last.privateBytesMB, privateWorkingSetMB: last.privateWorkingSetMB, threads: last.threads, handles: last.handles, moduleCount: last.moduleCount }, modules: last.modules, samples: samples.map(({ modules: _modules, ...rest }) => rest), wake };
} finally {
  if (child && child.exitCode === null) child.kill();
  stand?.close();
  await sleep(300);
  if (work) try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a stand-in still ends */ }
}

if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
const row = (value) => `| ${value.afterSeconds} s | ${value.workingSetMB} | ${value.privateBytesMB} | ${value.privateWorkingSetMB} | ${value.threads} |`;
console.log(`## Wake helper at idle – ${result.exe}${result.relay ? ` against ${result.relay}` : ''}${Object.keys(result.env).length ? ` with ${Object.entries(result.env).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}\n`);
console.log(`**After ${minutes} min: working set ${result.afterMinutes.workingSetMB} MB, private bytes ${result.afterMinutes.privateBytesMB} MB** (private working set ${result.afterMinutes.privateWorkingSetMB} MB, ${result.afterMinutes.threads} threads, ${result.afterMinutes.handles} handles, ${result.afterMinutes.moduleCount} modules). Target: each under 20 MB.\n`);
console.log('| idle | working set MB | private bytes MB | private working set MB | threads |\n|---|---|---|---|---|');
for (const value of samples) console.log(row(value));
if (result.modules?.length) console.log(`\nLargest modules: ${result.modules.join(', ')}`);
if (result.connections) console.log(`\n**Connections: ${result.connections.atTheMeetingServer} registration(s) at the meeting server in ${minutes} min of idle, ${result.connections.watchdogDrops} dropped by the watchdog** (more than one registration means a reconnect with a new box key; a watchdog drop must be 0).`);
if (result.wake) console.log(`\nWake: ${JSON.stringify(result.wake.reply)}; the stand-in app started ${result.wake.appStartedAfterMs ?? 'NEVER'} ms after the wake was sent.`);
if (regionsText) console.log(`\nWhere the private memory sits:\n${regionsText}`);
if (helperLog) console.log(`\nHelper log (tail):\n\`\`\`\n${helperLog}\n\`\`\``);
const wakeFailed = result.wake && (result.wake.reply?.ok !== true || result.wake.appStartedAfterMs === undefined);
const dropped = (result.connections?.watchdogDrops ?? 0) > 0;
if (dropped) console.error('FAIL: the watchdog dropped an idle connection (the helper must keep its own connection alive)');
process.exit(wakeFailed || dropped ? 1 : 0);
