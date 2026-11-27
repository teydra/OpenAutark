// 0.3.19 (23.11.2026): main's waker registration (src/main/waker.ts) – the file the desktop broker service reads to keep a
// wake helper alive while the app is closed: one per data folder, written while "Wake while closed" is on, removed when it
// is off, nothing outside the installed Windows app. Owns: these assertions. Never: the broker or a real helper.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyWaker, wakerFile, type WakerDeps } from '../../../src/main/waker.ts';

const deps = (root: string, over: Partial<WakerDeps> = {}): WakerDeps => ({
  platform: 'win32', packaged: true, testMode: false, localAppData: root, exe: 'C:\\Program Files\\Autark\\Autark.exe',
  script: 'C:\\Program Files\\Autark\\resources\\app.asar.unpacked\\app\\sleeper.mjs', dataDir: 'C:\\Users\\x\\AppData\\Roaming\\Autark Companies\\company-2',
  args: ['--company=company-2'], ...over,
});

test('wakerFile: one per data folder under AutarkDesktopBroker\\wakers, the same for a differently cased path', () => {
  const a = wakerFile('C:\\L', 'C:\\Users\\x\\AppData\\Roaming\\Autark');
  assert.match(a, /^C:\\L\\AutarkDesktopBroker\\wakers\\[0-9a-f]{16}\.json$/);
  assert.equal(wakerFile('C:\\L', 'c:\\users\\X\\appdata\\roaming\\autark'), a);
  assert.notEqual(wakerFile('C:\\L', 'C:\\Users\\x\\AppData\\Roaming\\Autark Companies\\company-2'), a);
});

test('applyWaker: written while on (the broker contract), removed when off; skipped in a dev run, test mode or elsewhere', async (t) => {
  if (process.platform !== 'win32') { t.skip('Windows paths'); return; }
  const root = mkdtempSync(path.join(os.tmpdir(), 'waker-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const d = deps(root);
  const file = wakerFile(root, d.dataDir);
  assert.equal(await applyWaker(true, d), 'written');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { v: 1, exe: d.exe, script: d.script, data: d.dataDir, args: ['--company=company-2'] });
  assert.equal(await applyWaker(false, d), 'removed');
  assert.equal(existsSync(file), false);
  // 0.3.22: a build with the slim native helper names it; the broker uses it when the file is there, else the Node helper
  const helper = 'C:\\Program Files\\Autark\\resources\\app.asar.unpacked\\resources\\broker\\AutarkWakeHelper.exe';
  assert.equal(await applyWaker(true, deps(root, { helper })), 'written');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { v: 1, exe: d.exe, script: d.script, data: d.dataDir, args: ['--company=company-2'], helper });
  assert.equal(await applyWaker(true, d), 'written');
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(file, 'utf8')), 'helper'), false, 'no helper key when the build has none');
  assert.equal(await applyWaker(false, d), 'removed');
  assert.equal(await applyWaker(true, deps(root, { script: undefined })), 'removed', 'a build without the helper registers nothing');
  for (const over of [{ packaged: false }, { testMode: true }, { platform: 'linux' }, { localAppData: undefined }]) {
    assert.equal(await applyWaker(true, deps(root, over)), 'skipped', JSON.stringify(over));
  }
  assert.equal(existsSync(file), false);
});
