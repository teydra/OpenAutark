// Sicher-Runde 19.11.2026: the wake helper's program (bundled as app/sleeper.mjs, started by main/sleeper.ts as
// `ELECTRON_RUN_AS_NODE=1 <Autark.exe> sleeper.mjs <data>/wake.json -- <the app's own start arguments>`, and since 0.3.19
// by the broker service the same way, as the person, whenever neither the app nor a helper runs – resources/broker/Waker.cs).
// It reads the helper's file, ends at once when the app is running already (run-state.json 'running' with a live pid,
// sleeper-life.ts) or another helper holds this data folder (sleeper.json), and otherwise runs the helper (sleeper.ts)
// until a wake starts the app, the app starts by itself (run-state.json turns 'running': a directory watch, no polling)
// or another helper takes its key over. 0.3.19 (23.11.2026): it also starts the app for scheduled work – next-due.json,
// keeps a short grace for work due around a forced exit (sleeper-life.ts dueStartAt) – in the background.
// Its few lines go to <data>/logs/sleeper.log (never a key); <data>/sleeper.json carries its pid while it runs.
// Owns: the helper process – its file, its mark, its app start (the Node switch removed, so the app starts as the app) and its end.
// Never: loads the runtime, the database or a window, or starts the app for anything but a wake or work that came due.

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { NEXT_DUE_FILE, RUN_STATE_FILE, SLEEPER_FILE, type RunState, type SleeperMark } from '../../shared/model/launch.ts';
import { Sleeper } from './sleeper.ts';
import { appRunning, dueDelay, dueStartAt, launchOnce, otherHelper } from './sleeper-life.ts';
import { parseWakeFile } from './wake-sign.ts';

const [file = '', ...rest] = process.argv.slice(2);
const appArgs = rest[0] === '--' ? rest.slice(1) : rest;
const dir = path.dirname(path.resolve(file || '.'));
const startedAt = Date.now();
const read = (target: string) => { try { return readFileSync(target, 'utf8'); } catch { return ''; } };
const json = <T>(name: string): Partial<T> | undefined => { try { return JSON.parse(read(path.join(dir, name))) as Partial<T>; } catch { return undefined; } };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException)?.code === 'EPERM'; } };
const runState = () => json<RunState>(RUN_STATE_FILE);
const running = () => appRunning(runState(), alive);
const log = (line: string) => {
  try { mkdirSync(path.join(dir, 'logs'), { recursive: true }); appendFileSync(path.join(dir, 'logs', 'sleeper.log'), `${new Date().toISOString()} ${line}\n`); } catch { /* no log */ }
};
const markFile = path.join(dir, SLEEPER_FILE);
const unmark = () => { if (json<SleeperMark>(SLEEPER_FILE)?.pid === process.pid) { try { rmSync(markFile, { force: true }); } catch { /* gone */ } } };

const wake = file ? parseWakeFile(read(file)) : undefined;
if (!wake || running() || otherHelper(json<SleeperMark>(SLEEPER_FILE), process.pid, alive)) process.exit(0);
try {
  const temp = `${markFile}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ pid: process.pid, at: startedAt } satisfies SleeperMark)}\n`, 'utf8');
  renameSync(temp, markFile);
} catch { /* no mark: the broker may start a second helper, which the meeting server's key handover (4009) ends */ }

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // the app starts as the app
const startApp = launchOnce(running, (args: string[]) => {
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env });
  child.on('error', (error) => log(`app launch failed: ${error.name}`));
  child.unref();
});
const sleeper = new Sleeper({
  file: wake!,
  socket: (url) => new WebSocket(url, { maxPayload: 70 * 1024, handshakeTimeout: 10_000, perMessageDeflate: false }),
  startApp: () => startApp(appArgs),
  exit: () => { log('ending'); unmark(); process.exit(0); },
  log,
});

// Scheduled work: next-due.json is the runtime's last word (it does not change while the app is closed)
const dueAt = dueStartAt(json<{ at: number | null }>(NEXT_DUE_FILE)?.at, startedAt, runState());
const armDue = () => {
  if (dueAt === undefined) return;
  setTimeout(() => {
    if (Date.now() < dueAt) { armDue(); return; }
    if (!running()) { log('scheduled work is due: starting the app'); startApp(['--background', ...appArgs]); }
    setTimeout(() => sleeper.end(), 1_000);
  }, dueDelay(dueAt, Date.now()));
};
if (dueAt !== undefined) log(`scheduled work starts the app at ${new Date(dueAt).toISOString()}`);
armDue();

try {
  watch(dir, (_event, name) => { if (name === RUN_STATE_FILE && running()) sleeper.end(); });
} catch { /* no watch: the helper waits on; a wake while the app runs only shows its window (single instance) */ }
process.on('exit', unmark);
log(`started (pid ${process.pid})`);
sleeper.start();
