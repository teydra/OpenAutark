// task_7ja3mcr6 (24.11. and 27.11.2026: an unquoted `cmd /c rd /s /q` under "…\Autark Companies\…" split at its space and
// deleted "…\Roaming\Autark"): files.delete (tools/builtin/files-delete.ts) on throwaway folders in the temp folder, with
// spaces in every path – the incident rebuilt (root "…\X Companies\company-2\workspace", bait "…\X" with a sentinel file),
// a company data folder, a junction to the outside, a way through a link, a data copy, the cleanup it is for, and the dry run.
// Owns: these assertions only. Never: touches anything outside its own temp folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileTools } from '../../../src/runtime/tools/builtin/files.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import { deleteLine } from '../../../src/runtime/context/environment.ts';
import { runDelete } from '../../../src/runtime/tools/builtin/files-delete.ts';
import { deleteZones } from '../../../src/runtime/files/delete-zones.ts';
import { planTree, removeTree } from '../../../src/runtime/files/delete-tree.ts';

const link = (target: string, at: string) => symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');

function world(t: { after(fn: () => void): void }) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'wf-delete guard-')));
  t.after(() => rmSync(base, { recursive: true, force: true })); // Node's rm removes links as links
  const first = path.join(base, 'X'); // the bait: the first company's folder, what the split path reached
  const companies = path.join(base, 'X Companies');
  const data = path.join(companies, 'company-2');
  const workspace = path.join(data, 'workspace');
  const outside = path.join(base, 'outside target');
  for (const dir of [first, workspace, path.join(data, 'tmp'), outside]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(first, 'sentinel.txt'), 'stays');
  writeFileSync(path.join(first, 'workforce.db'), 'x');
  writeFileSync(path.join(data, 'workforce.db'), 'x');
  writeFileSync(path.join(outside, 'sentinel.txt'), 'stays');
  const ctx = {
    agent: { id: 'ag_a', name: 'Ada' }, runId: 'r1', mode: 'general', signal: new AbortController().signal, status: () => undefined,
    services: {
      paths: { data, workspace, temp: path.join(data, 'tmp'), accounts: path.join(companies, 'logins') },
      host: { app: { companies: { first, dir: companies }, packaged: false, executable: process.execPath, resourcesDir: path.join(base, 'resources'), dataDir: data, version: '0', } },
      secrets: { redact: (value: string) => value },
    },
  } as unknown as ToolContext;
  const tool = fileTools().find((entry) => entry.name === 'files.delete')!;
  const run = async (args: Record<string, unknown>) => {
    const out = await tool.run(args as never, ctx) as ToolOutput;
    const part = out.content[0];
    return { text: part.type === 'text' ? part.text : '', error: out.isError === true };
  };
  return { base, first, companies, data, workspace, outside, run };
}

test('files.delete: the incident rebuilt – the path a split at the space reached ("…\\X") is refused, its sentinel stays', async (t) => {
  const w = world(t);
  const r = await w.run({ path: w.first });
  assert.equal(r.error, true);
  assert.match(r.text, /^REFUSED .* is the first company's data folder/);
  assert.equal(readFileSync(path.join(w.first, 'sentinel.txt'), 'utf8'), 'stays');
  const relative = await w.run({ path: 'X' });
  assert.match(relative.text, /not an absolute path/, 'a relative path is no literal path');
});

test('files.delete: company data folders, the folder holding them and a file inside one are refused', async (t) => {
  const w = world(t);
  for (const [target, why] of [[w.data, /this company's data folder/], [w.companies, /is the folder of this PC's other companies/], [w.base, /holds/], [path.join(w.data, 'workforce.db'), /lies inside this company's data folder/]] as const) {
    const r = await w.run({ path: target });
    assert.equal(r.error, true, target);
    assert.match(r.text, why);
  }
  assert.ok(existsSync(path.join(w.data, 'workforce.db')) && existsSync(path.join(w.first, 'sentinel.txt')));
  const ws = await w.run({ path: w.workspace });
  assert.match(ws.text, /is the workspace .*itself: what lies inside it can go/);
  assert.ok(existsSync(w.workspace));
});

test('files.delete: a junction inside the target goes as a link alone – what it points to outside stays', async (t) => {
  const w = world(t);
  const withLink = path.join(w.workspace, 'with a link');
  mkdirSync(withLink);
  link(w.outside, path.join(withLink, 'link to outside'));
  const dry = await w.run({ path: withLink, dryRun: true });
  assert.match(dry.text, /^WOULD DELETE .*1 links removed as links/);
  const r = await w.run({ path: withLink });
  assert.equal(r.error, false, r.text);
  assert.ok(!existsSync(withLink));
  assert.equal(readFileSync(path.join(w.outside, 'sentinel.txt'), 'utf8'), 'stays');
});

test('files.delete: a way through a link is refused; the link itself goes as a link', async (t) => {
  const w = world(t);
  const hop = path.join(w.workspace, 'jump here');
  link(w.outside, hop);
  const through = await w.run({ path: path.join(hop, 'sentinel.txt') });
  assert.match(through.text, /passes the link/);
  const intoFirst = path.join(w.workspace, 'to first');
  link(w.first, intoFirst);
  assert.match((await w.run({ path: path.join(intoFirst, 'sentinel.txt') })).text, /^REFUSED/);
  const r = await w.run({ path: hop });
  assert.match(r.text, /^DELETED .* the link alone/);
  assert.ok(!existsSync(hop));
  assert.equal(readFileSync(path.join(w.outside, 'sentinel.txt'), 'utf8'), 'stays');
  assert.equal(readFileSync(path.join(w.first, 'sentinel.txt'), 'utf8'), 'stays');
});

test('files.delete: the cleanup it is for – a worktree with spaces, node_modules, dist and a read-only file – goes whole', async (t) => {
  const w = world(t);
  const tree = path.join(w.workspace, 'my worktree with spaces');
  mkdirSync(path.join(tree, 'node_modules', 'a b', 'c'), { recursive: true });
  mkdirSync(path.join(tree, 'dist'));
  writeFileSync(path.join(tree, 'node_modules', 'a b', 'c', 'f.txt'), 'x');
  const locked = path.join(tree, 'dist', 'locked.txt');
  writeFileSync(locked, 'x');
  chmodSync(locked, 0o444);
  const scratch = path.join(w.data, 'tmp', 'run 1');
  mkdirSync(scratch);
  const r = await w.run({ paths: [path.join(tree, 'dist'), tree, scratch] });
  assert.equal(r.error, false, r.text);
  assert.equal(r.text.split('\n').filter((line) => line.startsWith('DELETED')).length, 3, r.text);
  assert.ok(!existsSync(tree) && !existsSync(scratch) && existsSync(w.workspace));
});

test('files.delete: dryRun names what would go and deletes nothing', async (t) => {
  const w = world(t);
  const tree = path.join(w.workspace, 'old build');
  mkdirSync(path.join(tree, 'sub'), { recursive: true });
  writeFileSync(path.join(tree, 'sub', 'a.txt'), 'abc');
  writeFileSync(path.join(tree, 'b.txt'), 'abc');
  const r = await w.run({ path: tree, dryRun: true });
  assert.equal(r.error, false);
  assert.match(r.text, /^WOULD DELETE .*old build – 2 files in 2 folders/);
  assert.ok(existsSync(path.join(tree, 'sub', 'a.txt')));
});

test('files.delete reaches agents: a More tools line of at most 90 characters, a delete category, and the environment fact line', () => {
  const tool = fileTools().find((entry) => entry.name === 'files.delete')!;
  const first = tool.description.split(/(?<=\.)\s/)[0];
  assert.ok(first.length <= 90, first);
  assert.equal(tool.category, 'delete');
  assert.equal(deleteLine(new Set(['files.read'])), '', 'not offered: no line');
  assert.match(deleteLine(new Set(['files.delete'])), /^Deleting: files\.delete .*splits an unquoted path at its spaces\.$/);
});

test('files.delete: a data copy inside a folder stops the whole folder; wildcards, missing paths and mixed calls', async (t) => {
  const w = world(t);
  const backup = path.join(w.workspace, 'backup of first');
  mkdirSync(path.join(backup, 'inner'), { recursive: true });
  writeFileSync(path.join(backup, 'notes.txt'), 'x');
  writeFileSync(path.join(backup, 'inner', 'workforce.db'), 'x');
  const r = await w.run({ path: backup });
  assert.match(r.text, /holds a data folder/);
  assert.ok(existsSync(path.join(backup, 'notes.txt')), 'nothing of it went');
  assert.match((await w.run({ path: path.join(w.workspace, '*') })).text, /wildcard/);
  assert.match((await w.run({ path: path.join(w.workspace, 'not there') })).text, /does not exist/);
  const good = path.join(w.workspace, 'second target');
  mkdirSync(good);
  const mixed = await w.run({ paths: [good, w.first] });
  assert.equal(mixed.error, true);
  assert.ok(!existsSync(good) && existsSync(path.join(w.first, 'sentinel.txt')));
});

// ---- review of PR #49 (28.11.2026): the findings, one test each

test('M1 (files.delete): a `\\\\?\\` prefix is the same file – refused where the plain path is, no wildcard where it is allowed', { skip: process.platform !== 'win32' }, async (t) => {
  const w = world(t);
  const tree = path.join(w.workspace, 'prefixed tree');
  mkdirSync(tree);
  writeFileSync(path.join(tree, 'a.txt'), 'x');
  const kept = await w.run({ path: `\\\\?\\${w.first}` });
  assert.match(kept.text, /^REFUSED .* is the first company's data folder/);
  assert.equal(readFileSync(path.join(w.first, 'sentinel.txt'), 'utf8'), 'stays');
  const r = await w.run({ path: `\\\\?\\${tree}` });
  assert.equal(r.error, false, r.text);
  assert.ok(!existsSync(tree));
  assert.match((await w.run({ path: `\\\\?\\${path.join(w.workspace, '*')}` })).text, /wildcard/, 'a real wildcard behind the prefix is still one');
});

test('M5: a throwaway copy with a data mark in the temp folder or a workspace goes with dataCopy: true; real data never does', async (t) => {
  const w = world(t);
  const copy = path.join(w.workspace, 'copy of data');
  mkdirSync(path.join(copy, 'inner'), { recursive: true });
  writeFileSync(path.join(copy, 'inner', 'workforce.db'), 'x');
  writeFileSync(path.join(copy, 'notes.txt'), 'x');
  const refused = await w.run({ path: copy });
  assert.match(refused.text, /holds a data folder/);
  assert.match(refused.text, /dataCopy: true/, 'the refusal names the way');
  const dry = await w.run({ path: copy, dryRun: true, dataCopy: true });
  assert.match(dry.text, /^WOULD DELETE .*holds a data copy: .*inner.*workforce\.db/);
  assert.ok(existsSync(path.join(copy, 'notes.txt')));
  const done = await w.run({ path: copy, dataCopy: true });
  assert.equal(done.error, false, done.text);
  assert.ok(!existsSync(copy));

  // the temp folder: an e2e run's workforce.db and a browser profile copy
  const e2e = mkdtempSync(path.join(os.tmpdir(), 'workforce-e2e delete test-'));
  t.after(() => rmSync(e2e, { recursive: true, force: true }));
  writeFileSync(path.join(e2e, 'workforce.db'), 'x');
  mkdirSync(path.join(e2e, 'profile'));
  writeFileSync(path.join(e2e, 'profile', 'Local State'), '{}');
  assert.match((await w.run({ path: e2e })).text, /REFUSED .*holds a data folder.*dataCopy: true/);
  assert.match((await w.run({ path: path.join(e2e, 'profile'), dataCopy: false })).text, /REFUSED/);
  const gone = await w.run({ paths: [path.join(e2e, 'profile'), e2e], dataCopy: true });
  assert.equal(gone.error, false, gone.text);
  assert.ok(!existsSync(e2e));

  // never: the real data, whatever the flag says
  for (const target of [w.first, w.data, path.join(w.companies, 'another company'), w.companies, w.base]) {
    mkdirSync(target, { recursive: true });
    const r = await w.run({ path: target, dataCopy: true });
    assert.equal(r.error, true, target);
    assert.match(r.text, /^REFUSED/, target);
  }
  assert.equal(readFileSync(path.join(w.first, 'sentinel.txt'), 'utf8'), 'stays');
  assert.ok(existsSync(path.join(w.data, 'workforce.db')));
  const sub = path.join(w.data, 'real subfolder');
  mkdirSync(sub);
  writeFileSync(path.join(sub, 'workforce.db'), 'x');
  assert.match((await w.run({ path: sub, dataCopy: true })).text, /^REFUSED .* lies inside this company's data folder/, 'a subfolder of the data folder stays');
  assert.ok(existsSync(sub));
});

test('M5: dataCopy lifts nothing outside the temp folder and the workspaces (the person\'s home, a real profile place)', async (t) => {
  const w = world(t);
  const elsewhere = path.join(w.base, 'elsewhere');
  const profile = path.join(elsewhere, 'a profile');
  mkdirSync(profile, { recursive: true });
  writeFileSync(path.join(profile, 'Local State'), '{}');
  const zones = deleteZones({ platform: process.platform, data: w.data, workspace: w.workspace, temp: path.join(w.data, 'tmp'), companies: { first: w.first, dir: w.companies }, home: elsewhere, env: {}, tmp: path.join(w.base, 'only-temp') });
  const out = await runDelete([profile], false, zones, new AbortController().signal, true);
  const text = out.content[0].type === 'text' ? out.content[0].text : '';
  assert.match(text, /^REFUSED .* dataCopy only lifts this inside the temp folder or a workspace/);
  assert.ok(existsSync(path.join(profile, 'Local State')));
  const dry = await runDelete([profile], true, zones, new AbortController().signal, false);
  assert.match(dry.content[0].type === 'text' ? dry.content[0].text : '', /does not go this way/);
});

test('L4: a junction to a kept folder goes as a link alone, by its own path; the folder it points to stays whole', async (t) => {
  const w = world(t);
  const intoFirst = path.join(w.workspace, 'to first');
  const intoData = path.join(w.workspace, 'to data');
  link(w.first, intoFirst);
  link(w.data, intoData);
  const dry = await w.run({ path: intoFirst, dryRun: true });
  assert.match(dry.text, /^WOULD DELETE .*a link: the link alone/);
  const r = await w.run({ paths: [intoFirst, intoData] });
  assert.equal(r.error, false, r.text);
  assert.equal(r.text.split('\n').filter((line) => /^DELETED .* the link alone/.test(line)).length, 2, r.text);
  assert.ok(!existsSync(intoFirst) && !existsSync(intoData));
  assert.equal(readFileSync(path.join(w.first, 'sentinel.txt'), 'utf8'), 'stays');
  assert.ok(existsSync(path.join(w.data, 'workforce.db')));
  // a link that itself lies in a kept folder still does not go
  const inside = path.join(w.data, 'kept link');
  link(w.outside, inside);
  assert.match((await w.run({ path: inside })).text, /^REFUSED .* lies inside this company's data folder/);
  assert.ok(existsSync(inside));
});

test('L5: a stopped call leaves the rest alone; the walk counts and deletes whole trees', async (t) => {
  const w = world(t);
  const tree = path.join(w.workspace, 'big tree');
  for (let i = 0; i < 30; i++) { mkdirSync(path.join(tree, `d ${i}`), { recursive: true }); for (let j = 0; j < 20; j++) writeFileSync(path.join(tree, `d ${i}`, `f${j}.txt`), 'abc'); }
  const plan = await planTree(tree);
  assert.deepEqual([plan.files, plan.folders, plan.bytes], [600, 31, 1800]);
  const stopped = new AbortController();
  stopped.abort();
  const early = await removeTree(tree, stopped.signal);
  assert.equal(early.failed?.code, 'ABORTED');
  assert.ok(existsSync(path.join(tree, 'd 0', 'f0.txt')), 'nothing went once the signal was set');
  const out = await runDelete([tree], false, deleteZones({ platform: process.platform, data: w.data, workspace: w.workspace, companies: { first: w.first, dir: w.companies } }), stopped.signal);
  assert.match(out.content[0].type === 'text' ? out.content[0].text : '', /^STOPPED/);
  assert.ok(existsSync(tree));
  const done = await removeTree(tree);
  assert.deepEqual([done.failed, done.removed], [undefined, 631]);
  assert.ok(!existsSync(tree));
});
