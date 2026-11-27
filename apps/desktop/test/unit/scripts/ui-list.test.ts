// scripts/ui-list.mjs and ui-publish.mjs: the phone apps' list of their interface – every file with its sha256 and size,
// the list and dot-led names left out, SHELL and OLDEST_PC from the page's sources, the exact bytes the Ed25519
// signature covers (it verifies under the public half and fails for one changed byte), unsigned without a key (a stale
// signature goes), and the publish plan (only missing sha256 names upload, names no file needs any more go).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LIST, SIGNATURE, listBytes, pageNumbers, uiList, writeUiList } from '../../../scripts/ui-list.mjs';
import { publishPlan } from '../../../scripts/ui-publish.mjs';
import { OLDEST_PC } from '../../../src/ui/lib/pc-floor.ts';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

async function built(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ui-list-'));
  await mkdir(path.join(dir, 'chunks'));
  await writeFile(path.join(dir, 'index.html'), '<!doctype html>');
  await writeFile(path.join(dir, 'chunks', 'chat-ABCD1234.js'), 'export {}');
  await writeFile(path.join(dir, '.hidden'), 'no');
  await writeFile(path.join(dir, LIST), 'old list');
  return dir;
}

test('the list names every file with its sha256 and size, sorted, and the page\'s own numbers', async () => {
  const dir = await built();
  try {
    const { shell } = await pageNumbers();
    assert.ok(Number.isInteger(shell) && shell >= 1, 'SHELL of native-port.ts');
    const list = await uiList(dir, { n: 1_800_000_000 });
    assert.deepEqual(list, {
      n: 1_800_000_000, shell, needs: OLDEST_PC,
      files: { 'chunks/chat-ABCD1234.js': { sha256: sha('export {}'), bytes: 9 }, 'index.html': { sha256: sha('<!doctype html>'), bytes: 15 } },
    });
    assert.equal((await pageNumbers()).needs, OLDEST_PC);
    const now = Math.floor(Date.now() / 1000);
    assert.ok(Math.abs((await uiList(dir, { shell: 1, needs: '0.3.21' })).n - now) <= 2, 'n is the build time in seconds');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('signed: the signature covers the exact bytes of ui.json; unsigned removes a stale signature', async () => {
  const dir = await built();
  const keys = generateKeyPairSync('ed25519');
  const keyFile = path.join(dir, '..', `ui-key-${process.pid}.pem`);
  await writeFile(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  try {
    const { list, signed } = await writeUiList(dir, { key: keyFile, n: 7 });
    const bytes = await readFile(path.join(dir, LIST));
    const signature = await readFile(path.join(dir, SIGNATURE));
    assert.equal(signed, true);
    assert.equal(signature.length, 64, 'raw 64 bytes');
    assert.deepEqual(bytes, listBytes(list));
    assert.deepEqual(JSON.parse(bytes.toString('utf8')), list);
    assert.equal(verify(null, bytes, keys.publicKey, signature), true);
    const changed = Buffer.from(bytes);
    changed[changed.length - 2] ^= 1;
    assert.equal(verify(null, changed, keys.publicKey, signature), false);
    assert.equal('ui.json' in list.files || 'ui.json.sig' in list.files, false, 'the list leaves itself and its signature out');
    const again = await writeUiList(dir, { n: 8 });
    assert.equal(again.signed, false);
    assert.equal(existsSync(path.join(dir, SIGNATURE)), false, 'no stale signature beside an unsigned list');
    await assert.rejects(writeUiList(dir, { key: path.join(dir, 'index.html') }));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(keyFile, { force: true });
  }
});

test('the publish plan uploads only missing sha256 names and removes the ones no file names', () => {
  const files = { 'a.js': { sha256: 'a'.repeat(64), bytes: 1 }, 'b.js': { sha256: 'b'.repeat(64), bytes: 1 }, 'copy-of-b.js': { sha256: 'b'.repeat(64), bytes: 1 } };
  const plan = publishPlan(files, ['a'.repeat(64), 'c'.repeat(64), LIST, SIGNATURE]);
  assert.deepEqual(plan.upload, [{ sha256: 'b'.repeat(64), file: 'b.js' }]);
  assert.deepEqual(plan.remove, ['c'.repeat(64)]);
});
