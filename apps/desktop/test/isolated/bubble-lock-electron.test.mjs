// The macOS bubble lock (src/main/bubble-owner.ts, task_0fkwakw9) inside real Electron main processes, as the app runs
// it: two Electron "companies" on one lock file – the first holds it and starts a long-lived child, the second waits;
// the first is killed (a crash): the second takes over although the first one's child still runs (no descriptor
// inherited, also not by Electron's own helper processes); the second quits normally (app.quit → dispose): a plain
// Node company takes over. The module is bundled with esbuild as it is, nothing mocked; the lock file lives in a fresh
// temp folder, never in the person's Library. macOS only (macos-15 runner, .github/workflows/mac-bubble-lock.yml).
// Owns: these assertions only. Never: starts the app itself or opens a bubble.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const SOURCE = path.join(import.meta.dirname, '../../src/main/bubble-owner.ts');
const mac = process.platform === 'darwin';

async function until(check, ms, what) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('Electron main processes: one holds the macOS flock; a kill and a normal quit each hand it on', { skip: mac ? false : 'macOS only', timeout: 120_000 }, async (t) => {
  const { build } = await import('esbuild');
  const { holdBubbleLock } = await import('../../src/main/bubble-owner.ts');
  const electron = createRequire(import.meta.url)('electron'); // the binary's path, from Node
  const dir = mkdtempSync(path.join(os.tmpdir(), 'autark-bubble-electron-'));
  const address = path.join(dir, 'lock', 'bubble.lock');
  const children = [];
  const grandchildren = [];
  try {
    await build({ entryPoints: [SOURCE], bundle: true, platform: 'node', format: 'esm', outfile: path.join(dir, 'app', 'bubble-owner.mjs'), logLevel: 'error' });
    writeFileSync(path.join(dir, 'app', 'main.mjs'), `import { app } from 'electron';
import { spawn } from 'node:child_process';
import { holdBubbleLock } from './bubble-owner.mjs';
const say = (line) => process.stdout.write(line + '\\n');
app.dock?.hide();
app.on('window-all-closed', () => undefined);
app.whenReady().then(() => {
  const lock = holdBubbleLock({ address: process.env.BUBBLE_LOCK, pollMs: 100, retryMs: 60000, log: (line) => say('log ' + line), onOwn: () => {
    const child = spawn('sleep', ['60'], { stdio: 'ignore', detached: true }); child.unref();
    say('child ' + child.pid); say('owned electron ' + process.versions.electron);
  } });
  app.on('before-quit', () => lock.dispose());
  process.stdin.on('data', (data) => { if (String(data).includes('quit')) app.quit(); });
  say('ready');
});
`);
    const start = (label) => {
      const proc = spawn(electron, [path.join(dir, 'app', 'main.mjs')], { env: { ...process.env, BUBBLE_LOCK: address, ELECTRON_ENABLE_LOGGING: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
      children.push(proc);
      let out = '', err = '';
      proc.stdout.on('data', (chunk) => { out += chunk; });
      proc.stderr.on('data', (chunk) => { err += chunk; });
      const exited = new Promise((resolve) => proc.once('exit', resolve));
      return {
        proc, exited, out: () => out, owned: () => /owned electron/.test(out), ready: () => out.includes('ready'),
        grandchild: () => Number(/child (\d+)/.exec(out)?.[1]) || null,
        why: () => `${label} stdout: ${out.slice(-600)} stderr: ${err.slice(-600)}`,
      };
    };

    const first = start('first');
    await until(first.owned, 60_000, 'the first Electron company to hold it').catch((error) => { throw new Error(`${error.message}; ${first.why()}`); });
    t.diagnostic(first.out().split('\n').find((line) => line.startsWith('owned')) ?? '');
    const firstChild = first.grandchild();
    grandchildren.push(firstChild);
    const second = start('second');
    await until(second.ready, 60_000, 'the second Electron company to start').catch((error) => { throw new Error(`${error.message}; ${second.why()}`); });
    await pause(1000);
    assert.equal(second.owned(), false, `held by the first: ${second.why()}`);
    assert.match(second.out(), /held by another company: waiting/);

    first.proc.kill('SIGKILL'); // a crash of the Electron main process
    await first.exited;
    assert.equal(alive(firstChild), true, 'the first one\'s child still runs');
    await until(second.owned, 10_000, 'the second Electron company taking over after the kill').catch((error) => { throw new Error(`${error.message}; ${second.why()}`); });
    grandchildren.push(second.grandchild());

    let mine = 0;
    const here = holdBubbleLock({ address, onOwn: () => mine++, log: () => undefined, pollMs: 100, retryMs: 60_000 });
    try {
      await pause(600);
      assert.equal(mine, 0, 'held by the second Electron company');
      second.proc.stdin.write('quit\n'); // a normal quit: before-quit disposes the lock
      await until(() => mine === 1, 15_000, 'the Node company taking over after the Electron quit').catch((error) => { throw new Error(`${error.message}; ${second.why()}`); });
      await second.exited;
      assert.equal(second.proc.signalCode, null, 'the second quit by itself');
    } finally {
      here.dispose();
    }
  } finally {
    for (const proc of children) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    for (const pid of grandchildren) if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
