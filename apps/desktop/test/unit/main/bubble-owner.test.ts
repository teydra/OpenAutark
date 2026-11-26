// One bubble per person on this PC (src/main/bubble-owner.ts, task_zbnv2b3h): the lock's address is the same for every
// company of one person and product and different for another person or a development run; macOS and other platforms
// get no address (the first company alone shows the bubble, as before – no socket file, nothing removed); of several
// companies starting at once exactly one holds it; when the holder lets go (a normal quit) or its process is killed (a
// crash) the next one waiting takes it over, one at a time; a waiter that quits never takes it; a holder whose bubble
// fails to open lets the lock go to a waiting company. Real sockets on a test-only address (a named pipe on Windows, an
// abstract socket on Linux), and real child processes for the abrupt end – nothing touches the address of a running
// company. Where there is no lock (macOS), the socket tests are skipped.
// Owns: these assertions only. Never: opens a bubble or reads a company's data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bubbleLockAddress, holdBubbleLock, type BubbleLock } from '../../../src/main/bubble-owner.ts';

const SOURCE = path.join(import.meta.dirname, '../../../src/main/bubble-owner.ts');
const MODULE = pathToFileURL(SOURCE).href;
const platform = process.platform;
const noLock = platform !== 'win32' && platform !== 'linux' ? 'no bubble lock on this platform (the first company alone)' : false;
let count = 0;
/** A fresh address only this test uses. */
function testAddress(): string {
  const name = `autark-bubble-test-${process.pid}-${++count}-${Math.random().toString(36).slice(2, 8)}`;
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

function lock(address: string, onOwn: () => void = () => undefined, retryMs = 60_000): BubbleLock {
  return holdBubbleLock({ address, onOwn, log: () => undefined, retryMs });
}

/** A company in a process of its own: says "owned" when it holds the lock. */
function company(address: string): { child: ChildProcess; owned: () => boolean; exited: Promise<void> } {
  const code = `import { holdBubbleLock } from ${JSON.stringify(MODULE)};
    holdBubbleLock({ address: ${JSON.stringify(address)}, retryMs: 60000, log: () => {}, onOwn: () => process.stdout.write('owned\\n') });
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout!.on('data', (chunk: Buffer) => { out += chunk.toString(); });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return { child, owned: () => out.includes('owned'), exited };
}

test('the address: one per person and product, a development run apart, the platform\'s own kind; none on macOS', () => {
  const scope = { platform: 'win32' as NodeJS.Platform, home: 'C:\\Users\\Heess', product: 'Autark', packaged: true };
  const win = bubbleLockAddress(scope);
  assert.match(win ?? '', /^\\\\\.\\pipe\\autark-bubble-[0-9a-f]{20}$/);
  assert.equal(bubbleLockAddress({ ...scope, home: 'c:\\users\\HEESS' }), win, 'Windows paths ignore case');
  assert.notEqual(bubbleLockAddress({ ...scope, home: 'C:\\Users\\Other' }), win, 'another person');
  assert.notEqual(bubbleLockAddress({ ...scope, packaged: false }), win, 'a development run');
  assert.notEqual(bubbleLockAddress({ ...scope, product: 'Other' }), win, 'another product');
  assert.match(bubbleLockAddress({ ...scope, platform: 'linux', home: '/home/s' }) ?? '', /^\0autark-bubble-[0-9a-f]{20}$/);
  // macOS: a socket file would survive a crash, and removing a stale one races (two owners); the first company alone
  assert.equal(bubbleLockAddress({ ...scope, platform: 'darwin', home: '/Users/s' }), null);
  assert.equal(bubbleLockAddress({ ...scope, platform: 'freebsd', home: '/home/s' }), null);
});

test('the lock code never removes a file (the macOS stale-socket race stays out)', () => {
  assert.doesNotMatch(readFileSync(SOURCE, 'utf8'), /\bunlink|\brmSync|from 'node:fs'/);
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
