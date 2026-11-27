// Measures the wake helper's memory at idle, and one real wake through a real meeting server, on Windows. Not a unit test: run by
// .github/workflows/wake-helper-memory.yml (a CI runner has no Smart App Control, so a fresh exe runs) and by hand on a PC that may run
// the exe (the signed build). Prints a Markdown report; with --out also writes the numbers as JSON. Never prints a key.
//   node measure.mjs --exe <AutarkWakeHelper.exe> [--relay wss://…/autark] [--minutes 5] [--out result.json]
//   node measure.mjs --pid <a running helper's pid>  (only the idle numbers: the helper was started by the broker, say)
// Working set and private bytes are reported SEPARATELY (the target "under 20 MB" holds for each), plus the private working set.
//
// The helper is started with its own throwaway key and data folder, a stand-in app (a tiny exe), against `--relay` (default: the real
// meeting server): it registers there, idles `--minutes`, then a signed wake from a throwaway pinned key (the production RelayClient
// and signWake) must start the stand-in app; the time from sending to the app's first line is reported.

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
const relay = option('relay', 'wss://telecoding-relay.onrender.com/autark');
const minutes = Number(option('minutes', '5'));
const out = option('out');
if (!exe && !attach) { console.error('usage: node measure.mjs --exe <AutarkWakeHelper.exe> | --pid <pid> [--relay wss://…] [--minutes 5] [--out file.json]'); process.exit(2); }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'); // apps/desktop
const src = (rel) => import(pathToFileURL(path.join(root, 'src', rel)).href);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = (what) => console.error(`${new Date().toISOString()} ${what}`);
const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;

/** Working set, private bytes and private working set of one process, by the same numbers Task Manager and Get-Process show. */
function sample(pid) {
  const script = `$p = Get-Process -Id ${pid} -ErrorAction Stop; $c = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter 'IDProcess=${pid}';`
    + ` [pscustomobject]@{ ws = $p.WorkingSet64; pb = $p.PrivateMemorySize64; pws = [int64]$c.WorkingSetPrivate; threads = $p.Threads.Count; handles = $p.HandleCount } | ConvertTo-Json -Compress`;
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (run.status !== 0) throw new Error(`sampling ${pid} failed: ${run.stderr || run.stdout}`);
  const value = JSON.parse(run.stdout.trim());
  return { at: new Date().toISOString(), workingSetMB: mb(value.ws), privateBytesMB: mb(value.pb), privateWorkingSetMB: mb(value.pws), threads: value.threads, handles: value.handles };
}

const samples = [];
let child; let work; let result;
try {
  let pid = attach ? Number(attach) : undefined;
  let session;
  if (exe) {
    if (!existsSync(exe)) throw new Error(`no such file: ${exe}`);
    const { generateEd25519, rawPublic, exportPrivate, b64url, fingerprintOf, signEd25519 } = await src('runtime/devices/keys.ts');
    work = mkdtempSync(path.join(tmpdir(), 'wf-measure-'));
    const data = path.join(work, 'data');
    mkdirSync(path.join(data, 'logs'), { recursive: true });
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
    session = { phoneKey, phonePub, helperPub, stubOut, data };
    child = spawn(exe, [path.join(data, 'wake.json'), '--app', stubExe, '--', '--company=company-9'], { env: { ...process.env, STUB_OUT: stubOut }, stdio: 'ignore', windowsHide: true });
    pid = child.pid;
    stamp(`helper started, pid ${pid}`);
  }

  // the sending side: the production RelayClient
  let client; let entry; let fp;
  if (session) {
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
    client.configure(relay);
    await Promise.race([up, sleep(120_000).then(() => { throw new Error('no connection to the meeting server in 120 s'); })]);
    fp = wakeFpOf(session.helperPub);
    const started = Date.now();
    for (;;) {
      entry = (await client.find(remoteIdOf(fp)).catch(() => [])).find((found) => found.fp === fp && found.pub === session.helperPub);
      if (entry) break;
      if (Date.now() - started > 120_000) throw new Error('the helper never showed up at the meeting server');
      await sleep(500);
    }
    stamp('the helper waits at the meeting server');
  }

  // idle: a sample every 30 s after a first one 10 s in; the last one is the "after N minutes" value
  const idleStart = Date.now();
  await sleep(10_000);
  samples.push({ afterSeconds: 10, ...sample(pid) });
  while (Date.now() - idleStart < minutes * 60_000) {
    await sleep(Math.min(30_000, minutes * 60_000 - (Date.now() - idleStart)));
    samples.push({ afterSeconds: Math.round((Date.now() - idleStart) / 1000), ...sample(pid) });
    stamp(`idle ${samples.at(-1).afterSeconds} s: ws ${samples.at(-1).workingSetMB} MB, private bytes ${samples.at(-1).privateBytesMB} MB`);
  }
  const last = samples.at(-1);

  // one real wake at the end (it ends the helper)
  let wake;
  if (session) {
    const { signWake } = await src('runtime/devices/wake-sign.ts');
    const keys = await src('runtime/devices/keys.ts');
    const sign = (data) => keys.signEd25519(session.phoneKey.privateKey, data);
    const sentAt = Date.now();
    const reply = await client.request(fp, entry.box, signWake(sign, fp, entry.box, sentAt, keys.b64url(randomBytes(18))), { timeoutMs: 20_000 });
    let appAt;
    while (Date.now() - sentAt < 20_000) {
      if (existsSync(session.stubOut) && readFileSync(session.stubOut, 'utf8').includes('START --company=company-9')) { appAt = Date.now() - sentAt; break; }
      await sleep(10);
    }
    wake = { reply, appStartedAfterMs: appAt };
    stamp(`wake: ${JSON.stringify(wake)}`);
    client.stop();
  }
  result = { exe: exe ? path.basename(exe) : `pid ${attach}`, relay: exe ? relay : undefined, minutes, afterMinutes: { workingSetMB: last.workingSetMB, privateBytesMB: last.privateBytesMB, privateWorkingSetMB: last.privateWorkingSetMB, threads: last.threads, handles: last.handles }, samples, wake };
} finally {
  if (child && child.exitCode === null) child.kill();
  await sleep(300);
  if (work) try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a stand-in still ends */ }
}

if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
const row = (sampleValue) => `| ${sampleValue.afterSeconds} s | ${sampleValue.workingSetMB} | ${sampleValue.privateBytesMB} | ${sampleValue.privateWorkingSetMB} | ${sampleValue.threads} |`;
console.log(`## Wake helper at idle – ${result.exe}${result.relay ? ` against ${result.relay}` : ''}\n`);
console.log(`**After ${minutes} min: working set ${result.afterMinutes.workingSetMB} MB, private bytes ${result.afterMinutes.privateBytesMB} MB** (private working set ${result.afterMinutes.privateWorkingSetMB} MB, ${result.afterMinutes.threads} threads, ${result.afterMinutes.handles} handles). Target: each under 20 MB.\n`);
console.log('| idle | working set MB | private bytes MB | private working set MB | threads |\n|---|---|---|---|---|');
for (const value of samples) console.log(row(value));
if (result.wake) console.log(`\nWake: ${JSON.stringify(result.wake.reply)}; the stand-in app started ${result.wake.appStartedAfterMs ?? 'NEVER'} ms after the wake was sent.`);
process.exit(result.wake && (result.wake.reply?.ok !== true || result.wake.appStartedAfterMs === undefined) ? 1 : 0);
