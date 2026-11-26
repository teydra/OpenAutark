// Windows integration: real descendants, no elevation, no unrelated PID is ever terminated by the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { shellJobBroker, brokerPath } from '../../../src/runtime/system/shell-job.ts';
import { defaultShell, type ShellSpawn } from '../../../src/runtime/tools/builtin/files.ts';
import { runCommand } from '../../../src/runtime/tools/builtin/command.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';

test('broker discovery uses the app resource, not an installed service or cwd', () => {
  const base = path.resolve('parent with spaces', 'resources');
  assert.equal(brokerPath(path.join(base, 'app.asar', 'app', 'runtime.mjs'), false),
    path.join(base, 'app.asar.unpacked', 'resources', 'broker', 'AutarkDesktopBroker.exe'));
  assert.equal(brokerPath(path.join(base, 'src', 'runtime.mjs'), false), '');
});

const WIN = { skip: process.platform !== 'win32' || process.env.AUTARK_SHELL_JOB_TEST !== '1', timeout: 30_000 };
const quote = (text: string) => "'" + text.replaceAll("'", "''") + "'";
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw e;
  }
};

async function until<T>(check: () => T | undefined, problem: string): Promise<T> {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const result = check();
    if (result !== undefined) return result;
    assert.ok(Date.now() < deadline, problem);
    await wait(30);
  }
}

for (const end of ['timeout', 'cancel', 'control EOF'] as const) {
  test(`a Windows Job reaps root, child and grandchild on ${end}`, WIN, async (t) => {
    assert.ok(shellJobBroker(), 'CI must exercise the compiled job wrapper, not the compatibility fallback');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'autark-shell job-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const ready = path.join(dir, 'ready.json');
    const script = path.join(dir, 'tree.cjs');
    writeFileSync(script, `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const [role, ready, parent, root] = process.argv.slice(2);
      const start = (role, parent) => spawn(process.execPath, [__filename, role, ready, parent, root],
        { stdio: 'inherit', windowsHide: true, detached: true });
      if (role === 'root') {
        start('child', 0).unref();
        setTimeout(() => {}, 25_000);
      } else if (role === 'child') {
        start('leaf', process.pid);
        setTimeout(() => {}, 25_000);
      } else {
        fs.writeFileSync(ready, JSON.stringify([Number(root), Number(parent), process.pid]));
        process.stdout.write('tree ready\\n');
        setTimeout(() => {}, 25_000);
      }
    `);
    const command = `& ${quote(process.execPath)} ${quote(script)} root ${quote(ready)} 0 $PID; exit 17`;
    const readTree = (): number[] | undefined => {
      try {
        const pids: number[] = JSON.parse(readFileSync(ready, 'utf8'));
        assert.equal(new Set(pids).size, 3);
        assert.ok(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0));
        return pids;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
        throw error;
      }
    };
    const control = new AbortController();
    t.after(() => control.abort());
    // Concurrent control shell must survive cleanup of the tested tree.
    const neighbor = defaultShell("'neighbor'; Start-Sleep -Seconds 25", { cwd: dir, signal: control.signal });
    const neighborReady = once(neighbor.stdout!, 'data');

    if (end === 'timeout') {
      const limit = new AbortController();
      t.after(() => limit.abort());
      const ctx = {
        signal: limit.signal, status() {},
        services: {
          secrets: { redact: (text: string) => text },
          runs: { item() {} },
          subconscious: { toolTimeout: async () => {
            const pids = readTree();
            return pids?.every(alive)
              ? { action: 'abort', reason: 'Tree is running' }
              : { action: 'wait', seconds: 1, reason: 'Wait for the fixture to start' };
          } },
        },
      } as unknown as ToolContext;
      let close: Promise<unknown[]> | undefined;
      const shell: ShellSpawn = (cmd, opts) => {
        const child = defaultShell(cmd, opts);
        child.on('error', () => undefined); // runCommand handles the error; observe only close here
        close = new Promise((resolve) => child.once('close', (...args) => resolve(args)));
        return child;
      };
      const result = await runCommand(shell, ctx, { command, cwd: dir, timeoutSeconds: 1 });
      assert.match(JSON.stringify(result.content), /exit timeout/);
      await close;
    } else {
      const stop = new AbortController();
      t.after(() => stop.abort());
      const child = defaultShell(command, { cwd: dir, signal: stop.signal });
      const close = once(child, 'close');
      child.stdout?.resume();
      child.stderr?.resume();
      const pids = await until(readTree, 'fixture did not start');
      assert.ok(pids.every(alive), 'tree existed before cleanup');
      if (end === 'cancel') stop.abort();
      if (end === 'control EOF') child.stdin!.end(); // same EOF as abrupt runtime exit
      const [code] = await close;
      if (end === 'control EOF') assert.equal(code, 1);
    }

    const pids = await until(readTree, 'fixture never registered descendants');
    await until(() => pids.every((pid) => !alive(pid)) || undefined, 'one or more descendants outlived the job');
    assert.match(String((await neighborReady)[0]), /neighbor/);
    assert.ok(alive(neighbor.pid!), 'one call must not kill the other');
    const neighborClose = once(neighbor, 'close');
    control.abort();
    await neighborClose;
  });
}

test('a redirected Start-Process child survives a successful shell exit', WIN, async (t) => {
  assert.ok(shellJobBroker(), 'CI must use the real job wrapper');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'autark-shell detached-'));
  const ready = path.join(dir, 'ready'), stopFile = path.join(dir, 'stop');
  const script = path.join(dir, 'job.cjs');
  let pid: number | undefined;
  t.after(async () => {
    writeFileSync(stopFile, 'stop');
    if (pid !== undefined) await until(() => !alive(pid!) || undefined, 'detached fixture did not stop');
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(script, [
    "const fs = require('node:fs');",
    "const [ready, stop] = process.argv.slice(2);",
    "fs.writeFileSync(ready, String(process.pid));",
    "const timer = setInterval(() => { if (fs.existsSync(stop)) clearInterval(timer); }, 50);",
    "setTimeout(() => clearInterval(timer), 20_000).unref();",
  ].join('\n'));
  const quotedArgs = [script, ready, stopFile].map((arg) => '"' + arg + '"').join(' ');
  const command = [
    `$p = Start-Process -FilePath ${quote(process.execPath)} -ArgumentList ${quote(quotedArgs)} -WindowStyle Hidden -PassThru`,
    `-RedirectStandardOutput ${quote(path.join(dir, 'stdout.log'))} -RedirectStandardError ${quote(path.join(dir, 'stderr.log'))};`,
    '$p.Id; exit 17',
  ].join(' ');
  const controller = new AbortController();
  t.after(() => controller.abort());
  const child = defaultShell(command, { cwd: dir, signal: controller.signal });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  child.stdout?.on('data', (data: Buffer) => stdout.push(data));
  child.stderr?.on('data', (data: Buffer) => stderr.push(data));
  const [code] = await once(child, 'close');
  assert.equal(code, 17, Buffer.concat(stderr).toString('utf8'));
  pid = Number(Buffer.concat(stdout).toString('utf8').trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Start-Process returned its child PID');
  const running = await until(() => {
    try { return Number(readFileSync(ready, 'utf8')) || undefined; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }, 'normal exit reaped the detached child');
  assert.equal(running, pid);
  assert.ok(alive(pid), 'a normal shell return keeps Start-Process alive');
});
