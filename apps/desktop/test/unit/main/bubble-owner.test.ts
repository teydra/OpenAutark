// One bubble per person on this PC (src/main/bubble-owner.ts, task_zbnv2b3h; macOS task_0fkwakw9): the lock's address
// is the same for every company of one person and product and different for another person or a development run; on
// macOS it is a file in the person's Library, elsewhere (but Windows and Linux) there is none; of several companies
// starting at once exactly one holds it; when the holder lets go (a normal quit) or its process is killed (a crash) the
// next one waiting takes it over, one at a time; a waiter that quits never takes it; a holder whose bubble fails to open
// lets the lock go to a waiting company. Real locks on a test-only address (a named pipe on Windows, an abstract socket
// on Linux, an flock on a file in a fresh temp folder on macOS) and real child processes for the abrupt end – nothing
// touches the address of a running company or the person's own Library. macOS alone: the flock is one another program
// sees (Python's fcntl.flock), no child process inherits it, the file stays and is private. (The EOPNOTSUPP fallback is not
// reachable on a runner: APFS and even devfs take the lock.)
// Owns: these assertions only. Never: opens a bubble or reads a company's data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { O_EXLOCK, bubbleLockAddress, holdBubbleLock, isLockFile, type BubbleLock } from '../../../src/main/bubble-owner.ts';

const SOURCE = path.join(import.meta.dirname, '../../../src/main/bubble-owner.ts');
const MODULE = pathToFileURL(SOURCE).href;
const platform = process.platform;
const mac = platform === 'darwin';
const noLock = platform !== 'win32' && platform !== 'linux' && !mac ? 'no bubble lock on this platform (the first company alone)' : false;
const notMac = mac ? false : 'macOS flock only';
const POLL = 100; // a waiting macOS company tries again this often here (2 s in the app)
let count = 0;
const temp: string[] = [];
process.on('exit', () => { for (const dir of temp) rmSync(dir, { recursive: true, force: true }); });
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'autark-bubble-test-'));
  temp.push(dir);
  return dir;
}
/** A fresh address only this test uses. */
function testAddress(): string {
  const name = `autark-bubble-test-${process.pid}-${++count}-${Math.random().toString(36).slice(2, 8)}`;
  if (mac) return path.join(tempDir(), 'bubble', `${name}.lock`); // the folder is made by the lock, as in the Library
  return platform === 'win32' ? `\\\\.\\pipe\\${name}` : `\0${name}`;
}

async function until(check: () => boolean, ms = 5000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function lock(address: string, onOwn: () => void = () => undefined, retryMs = 60_000): BubbleLock {
  return holdBubbleLock({ address, onOwn, log: () => undefined, retryMs, pollMs: POLL });
}

/** A company in a process of its own: says "owned" when it holds the lock; with child, it then starts a long-lived child. */
function company(address: string, child = false): { child: ChildProcess; owned: () => boolean; grandchild: () => number | null; exited: Promise<void> } {
  const onOwn = child
    ? `() => { const c = spawn('sleep', ['60'], { stdio: 'ignore', detached: true }); c.unref(); process.stdout.write('child ' + c.pid + '\\nowned\\n'); }`
    : `() => process.stdout.write('owned\\n')`;
  const code = `import { holdBubbleLock } from ${JSON.stringify(MODULE)}; import { spawn } from 'node:child_process';
    holdBubbleLock({ address: ${JSON.stringify(address)}, retryMs: 60000, pollMs: ${POLL}, log: () => {}, onOwn: ${onOwn} });
    setInterval(() => {}, 1000);`;
  const proc = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  proc.stdout!.on('data', (chunk: Buffer) => { out += chunk.toString(); });
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  return { child: proc, owned: () => out.includes('owned'), grandchild: () => Number(/child (\d+)/.exec(out)?.[1]) || null, exited };
}

test('the address: one per person and product, a development run apart, the platform\'s own kind; a Library file on macOS', () => {
  const scope = { platform: 'win32' as NodeJS.Platform, home: 'C:\\Users\\Heess', product: 'Autark', packaged: true };
  const win = bubbleLockAddress(scope);
  assert.match(win ?? '', /^\\\\\.\\pipe\\autark-bubble-[0-9a-f]{20}$/);
  assert.equal(bubbleLockAddress({ ...scope, home: 'c:\\users\\HEESS' }), win, 'Windows paths ignore case');
  assert.notEqual(bubbleLockAddress({ ...scope, home: 'C:\\Users\\Other' }), win, 'another person');
  assert.notEqual(bubbleLockAddress({ ...scope, packaged: false }), win, 'a development run');
  assert.notEqual(bubbleLockAddress({ ...scope, product: 'Other' }), win, 'another product');
  assert.match(bubbleLockAddress({ ...scope, platform: 'linux', home: '/home/s' }) ?? '', /^\0autark-bubble-[0-9a-f]{20}$/);
  // macOS: an flock on a file that stays, beside (never inside) the companies' folders; never $TMPDIR, which the system cleans
  const macScope = { ...scope, platform: 'darwin' as NodeJS.Platform, home: '/Users/s' };
  const file = bubbleLockAddress(macScope) ?? '';
  assert.match(file, /^\/Users\/s\/Library\/Application Support\/Autark Bubble\/autark-bubble-[0-9a-f]{20}\.lock$/);
  assert.notEqual(bubbleLockAddress({ ...macScope, packaged: false }), file, 'a development run');
  assert.notEqual(bubbleLockAddress({ ...macScope, home: '/Users/t' }), file, 'another person');
  assert.equal(isLockFile(file), true);
  assert.equal(isLockFile(win!), false);
  assert.equal(isLockFile(bubbleLockAddress({ ...scope, platform: 'linux', home: '/home/s' })!), false);
  assert.equal(bubbleLockAddress({ ...scope, platform: 'freebsd', home: '/home/s' }), null);
});

test('the lock code never removes a file (the macOS stale-socket race stays out)', () => {
  assert.doesNotMatch(readFileSync(SOURCE, 'utf8'), /\bunlink|\brmSync|\brmdir|\brm\(|\bunlinkSync/);
});

test('several companies at once: exactly one holds it; each normal quit hands it to exactly one more', { skip: noLock }, async () => {
  const address = testAddress();
  const owners: number[] = [];
  const locks = Array.from({ length: 5 }, (_, index) => lock(address, () => owners.push(index)));
  try {
    await until(() => owners.length === 1, 5000, 'a first owner');
    await pause(300);
    assert.equal(owners.length, 1, 'one bubble');
    assert.deepEqual(locks.map((each, index) => each.owned ? index : -1).filter((index) => index >= 0), owners);
    for (let round = 2; round <= 5; round++) {
      locks[owners.at(-1)!]!.dispose();
      await until(() => owners.length === round, 5000, `owner ${round}`);
      await pause(300);
      assert.equal(owners.length, round, 'never two at a time');
      assert.equal(locks.filter((each) => each.owned).length, 1);
    }
    assert.equal(new Set(owners).size, 5, 'every company had it once, in turn');
  } finally {
    for (const each of locks) each.dispose();
  }
});

test('a waiting company that quits never takes it over', { skip: noLock }, async () => {
  const address = testAddress();
  let firstOwned = 0, secondOwned = 0;
  const first = lock(address, () => firstOwned++);
  await until(() => firstOwned === 1);
  const second = lock(address, () => secondOwned++);
  await pause(300);
  second.dispose();
  first.dispose();
  await pause(600);
  assert.equal(secondOwned, 0);
  assert.equal(second.owned, false);
  const third = lock(address, () => undefined);
  try { await until(() => third.owned, 5000, 'the free lock'); } finally { third.dispose(); }
});

test('the bubble fails to open: the lock goes to a waiting company, and the failed one tries again later', { skip: noLock }, async () => {
  const address = testAddress();
  let failedTries = 0, waiterOwned = 0;
  const failing = lock(address, () => { failedTries++; throw new Error('no window'); }, 400);
  await until(() => failedTries === 1, 5000, 'the first, failing owner');
  assert.equal(failing.owned, false, 'no lock without a bubble');
  const waiter = lock(address, () => waiterOwned++);
  try {
    await until(() => waiterOwned === 1, 5000, 'the working company taking it');
    assert.equal(waiter.owned, true);
    const triesBefore = failedTries;
    await pause(1200); // the failing one retries every 400 ms but finds it held
    assert.equal(failedTries, triesBefore, 'held elsewhere: no second bubble attempt');
    assert.equal(failing.owned, false);
    waiter.dispose();
    await until(() => failedTries > triesBefore, 5000, 'the failed company trying again once it is free');
  } finally {
    waiter.dispose();
    failing.dispose();
  }
});

test('the holder\'s process is killed: a running company takes over at once, the others keep waiting', { skip: noLock }, async () => {
  const address = testAddress();
  const holder = company(address);
  try {
    await until(holder.owned, 10_000, 'the child company to hold it');
    const others = [company(address), company(address)];
    let mine = 0;
    const here = lock(address, () => mine++);
    try {
      await pause(800);
      assert.equal(mine, 0, 'held elsewhere');
      assert.equal(others.filter((each) => each.owned()).length, 0);
      holder.child.kill('SIGKILL'); // a crash: no dispose, the operating system frees it
      await holder.exited;
      await until(() => mine + others.filter((each) => each.owned()).length >= 1, 5000, 'the takeover');
      await pause(500);
      assert.equal(mine + others.filter((each) => each.owned()).length, 1, 'exactly one new bubble');
      // and on: whoever holds it now dies or quits, the next one takes it
      const nextOwner = others.find((each) => each.owned());
      if (nextOwner) { nextOwner.child.kill('SIGKILL'); await nextOwner.exited; } else here.dispose();
      const rest = others.filter((each) => each !== nextOwner);
      await until(() => (nextOwner ? mine : 0) + rest.filter((each) => each.owned()).length >= 1, 5000, 'the second takeover');
    } finally {
      here.dispose();
      for (const each of others) { each.child.kill('SIGKILL'); await each.exited; }
    }
  } finally {
    holder.child.kill('SIGKILL');
  }
});

// ---------------------------------------------------------------- macOS: the flock itself

test('macOS: O_EXLOCK is XNU\'s 0x20, and the lock is a real flock another program sees (Python fcntl.flock)', { skip: notMac }, async () => {
  const python = spawnSync('python3', ['-c', 'import os; print(os.O_EXLOCK, os.O_NONBLOCK, os.O_CLOEXEC)'], { encoding: 'utf8' });
  assert.equal(python.status, 0, python.stderr);
  assert.deepEqual(python.stdout.trim().split(' ').map(Number), [O_EXLOCK, constants.O_NONBLOCK, 0x01000000], 'the flags as the system headers have them');
  const address = testAddress();
  const flock = `import fcntl, sys\nf = open(sys.argv[1], 'a')\ntry:\n  fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB); print('free')\nexcept BlockingIOError:\n  print('held')`;
  const probe = () => spawnSync('python3', ['-c', flock, address], { encoding: 'utf8' }).stdout.trim();
  const held = lock(address);
  try {
    await until(() => held.owned, 5000, 'the lock');
    assert.equal(probe(), 'held', 'another process cannot flock the file while a company holds it');
    // and a raw open with the same flags, as a second company would do it, fails at once instead of waiting
    assert.throws(() => openSync(address, constants.O_RDWR | constants.O_NONBLOCK | O_EXLOCK), (error: NodeJS.ErrnoException) => error.code === 'EAGAIN');
  } finally {
    held.dispose();
  }
  assert.equal(probe(), 'free', 'dispose let it go');
  assert.equal(existsSync(address), true, 'the file stays: nothing is removed');
});

test('macOS: no child process inherits it – a killed holder\'s long-lived child does not keep the bubble', { skip: notMac }, async () => {
  const address = testAddress();
  const holder = company(address, true);
  let grandchild: number | null = null;
  let mine = 0;
  let here: BubbleLock | null = null;
  try {
    await until(holder.owned, 10_000, 'the child company to hold it');
    here = lock(address, () => mine++); // only now: the child company must be the holder
    grandchild = holder.grandchild();
    assert.ok(grandchild && alive(grandchild), 'the holder started a child that outlives it');
    await pause(400);
    assert.equal(mine, 0, 'held elsewhere');
    holder.child.kill('SIGKILL');
    await holder.exited;
    assert.equal(alive(grandchild!), true, 'the child still runs');
    await until(() => mine === 1, 5000, 'the takeover while the holder\'s child still runs (O_CLOEXEC)');
  } finally {
    here?.dispose();
    holder.child.kill('SIGKILL');
    if (grandchild && alive(grandchild)) process.kill(grandchild, 'SIGKILL');
  }
});

test('macOS: the path is made private in a fresh home, and a file left by a crashed holder is taken as it is', { skip: notMac }, async () => {
  const home = tempDir(); // never the person's own Library
  const address = bubbleLockAddress({ platform: 'darwin', home, product: 'Autark', packaged: true })!;
  const first = lock(address);
  try {
    await until(() => first.owned, 5000, 'the lock in a fresh home');
    assert.equal(statSync(path.dirname(address)).mode & 0o777, 0o700, 'the folder is the person\'s alone');
    assert.equal(statSync(address).mode & 0o077, 0, 'the file is the person\'s alone');
  } finally {
    first.dispose();
  }
  const leftover = testAddress();
  const dir = path.dirname(leftover);
  mkdirSync(dir, { recursive: true });
  writeFileSync(leftover, ''); // a stale lock file, as a crash leaves it
  const second = lock(leftover);
  try { await until(() => second.owned, 5000, 'the stale file\'s lock'); } finally { second.dispose(); }
});

