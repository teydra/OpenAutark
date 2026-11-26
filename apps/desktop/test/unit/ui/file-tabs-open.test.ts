// The ways to a path (src/ui/workspace/file-tabs.ts, B-081): Open on reopens the same path on another PC in the tab's
// own place; a picture met as a file opens in the Media tab in place; an app-own file meant to be made opens straight in
// the editor, any other missing path on the not-found page; a similar path of that page opens as what it is; a linked
// PC's file is saved to this PC (that PC stores it, this PC shows the copy in its folder), and off the desktop every file
// offers its save.
// Owns: these assertions only. Never: a real PC, a socket or a window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PathRead } from '../../../src/shared/api/methods-files.ts';
import { rpc } from '../../../src/ui/lib/rpc.ts';
import { session } from '../../../src/ui/lib/session.ts';
import { docFor, openFileTab, openNear, openPathOn, releaseDoc, saveHere, saveHereWords, savesHere, showable, showInMedia } from '../../../src/ui/workspace/file-tabs.ts';
import { openPanel, tabsOf } from '../../../src/ui/workspace/pages.ts';

const SPACE = 'global';
const ids = () => tabsOf(SPACE).map((tab) => tab.id);

test('Open on puts the same path of another PC in the tab\'s place, and back', () => {
  openPanel({ kind: 'tasks' }, undefined, SPACE);
  openFileTab('/notes/a.md', undefined, SPACE);
  openPanel({ kind: 'screen' }, undefined, SPACE);
  const before = ids();
  const at = before.indexOf('file:/notes/a.md');
  openPathOn({ id: 'file:/notes/a.md', kind: 'file', path: '/notes/a.md' }, 'dev_tower', SPACE);
  assert.equal(ids()[at], 'file@dev_tower:/notes/a.md', 'same place');
  assert.equal(ids().length, before.length, 'nothing else moved');
  openPathOn({ id: 'file@dev_tower:/notes/a.md', kind: 'file', path: '/notes/a.md' }, undefined, SPACE);
  assert.deepEqual(ids(), before);

  openPanel({ kind: 'folder', path: '/notes' }, undefined, SPACE);
  openPathOn({ id: 'folder:/notes', kind: 'folder', path: '/notes' }, 'dev_tower', SPACE);
  assert.ok(ids().includes('folder@dev_tower:/notes'));
  assert.ok(!ids().includes('folder:/notes'));
});

test('a picture, video, audio file or PDF can be shown in the Media tab, in the file tab\'s place', () => {
  assert.equal(showable('C:\\shots\\a.PNG'), true);
  assert.equal(showable('/v/clip.mp4'), true);
  assert.equal(showable('/d/report.pdf'), true);
  assert.equal(showable('/d/notes.md'), false);
  openFileTab('/shots/b.png', undefined, SPACE, 'dev_tower');
  const at = ids().indexOf('file@dev_tower:/shots/b.png');
  showInMedia('/shots/b.png', 'file@dev_tower:/shots/b.png', SPACE, 'dev_tower');
  assert.equal(ids()[at], 'media@dev_tower:/shots/b.png');
  const media = tabsOf(SPACE)[at] as { kind: string; path?: string; device?: string };
  assert.deepEqual([media.kind, media.path, media.device], ['media', '/shots/b.png', 'dev_tower']);
});

test('an app-own file meant to be made opens in the editor; another missing path on the not-found page', async () => {
  Object.assign(rpc, {
    call: async (method: string, params: { path: string }): Promise<PathRead> => {
      if (method !== 'files.readPath') throw new Error(method);
      return { path: params.path, state: 'missing', size: 0, stamp: '', near: [] };
    },
  });
  openFileTab('/data/settings.json', undefined, SPACE, undefined, { create: true });
  const made = docFor('/data/settings.json');
  await made.load();
  assert.equal(made.state.value.phase, 'text');
  releaseDoc(made);
  const again = docFor('/data/settings.json');
  assert.notEqual(again, made, 'a fresh doc after its tab went');
  await again.load();
  assert.equal(again.state.value.phase, 'text', 'still made, when shown again');

  openFileTab('/data/typo.json', undefined, SPACE);
  const typo = docFor('/data/typo.json');
  await typo.load();
  assert.equal(typo.state.value.phase, 'missing');
  typo.create(); // the page's Create
  assert.deepEqual([typo.state.value.phase, typo.state.value.fresh], ['text', true], 'Create: the empty editor, Ctrl+S makes it');
});

test('a linked PC\'s file is brought here: stored there, its copy shown in its folder here', async (t) => {
  t.after(() => { session.value = null; });
  session.value = { kind: 'owner', capabilities: [], secure: true, allowedMethods: [] };
  const calls: Array<[string, unknown]> = [];
  Object.assign(rpc, {
    call: async (method: string, params: unknown) => {
      calls.push([method, params]);
      if (method === 'files.uploadPath') return { id: 'f'.repeat(64), name: 'report.zip', mime: 'application/zip', size: 3 };
      if (method === 'files.open') return { ok: true };
      throw new Error(method);
    },
  });
  assert.equal(savesHere('dev_tower', true), true, 'a linked PC\'s file on the desktop');
  assert.equal(savesHere(undefined, true), false, 'this PC\'s own file: nothing to save');
  assert.equal(savesHere(undefined, false), true, 'off the desktop (the phone) every file');
  assert.equal(saveHereWords(true).label, 'Show a copy here', 'the desktop\'s copy lives in temp for a day: no "save" in its name');
  assert.match(saveHereWords(true).hint ?? '', /for a day/);
  assert.equal(saveHereWords(false).hint, undefined, 'the phone\'s save is lasting');
  await saveHere('C:\\work\\report.zip', 'dev_tower', true);
  assert.deepEqual(calls, [
    ['files.uploadPath', { path: 'C:\\work\\report.zip', device: 'dev_tower' }],
    ['files.open', { id: 'f'.repeat(64), reveal: true }],
  ]);
});

test('a similar path opens as what it is, in the not-found tab\'s place on the same PC', () => {
  openFileTab('/notes/gone.md', undefined, SPACE, 'dev_tower');
  const id = 'file@dev_tower:/notes/gone.md';
  const at = ids().indexOf(id);
  openNear({ path: '/notes/old', folder: true }, id, SPACE, 'dev_tower');
  assert.equal(ids()[at], 'folder@dev_tower:/notes/old');
  openNear({ path: '/notes/shot.PNG', folder: false }, 'folder@dev_tower:/notes/old', SPACE, 'dev_tower');
  assert.equal(ids()[at], 'media@dev_tower:/notes/shot.PNG', 'a picture in the Media tab');
  openNear({ path: '/notes/gone.txt', folder: false }, 'media@dev_tower:/notes/shot.PNG', SPACE, 'dev_tower');
  assert.equal(ids()[at], 'file@dev_tower:/notes/gone.txt');
});
