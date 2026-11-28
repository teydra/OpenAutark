// 28.11.2026 (Mac test of 0.3.22): the feedback video's dialog came over the very first screen of the iPhone web app, before
// anything was seen. native.ts firstVideoHere: the first start only counts, the second plays it, once; a start counts once per page
// load (the shell mounts its overlays afresh on a layout change).
// Owns: these assertions only. Never: the dialog or the tour.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstVideoHere, STARTS_KEY, VIDEO_SEEN_KEY } from '../../../src/ui/pwa/native.ts';

const store = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, data };
};

test('the first start shows no video; the second plays it; later starts never again', () => {
  const storage = store();
  assert.equal(firstVideoHere(true, storage), false, 'first start: nothing over the first screen');
  assert.equal(storage.data.get(STARTS_KEY), '1');
  assert.equal(firstVideoHere(true, storage), false, 'the same page load (overlays mounted afresh) is no second start');
});

test('a later page load plays it once', () => {
  // each page load is a new call with the storage of the origin – the counted set is per storage object, so a fresh view of the same data is a new load
  const data = { [STARTS_KEY]: '1' };
  const second = store(data);
  assert.equal(firstVideoHere(true, second), true, 'second start');
  assert.equal(second.data.get(VIDEO_SEEN_KEY), '1');
  assert.equal(firstVideoHere(true, second), false);
  const third = store({ ...data, [VIDEO_SEEN_KEY]: '1' });
  assert.equal(firstVideoHere(true, third), false, 'third start');
});

test('never outside the iPhone web app, and never when the storage cannot keep it', () => {
  assert.equal(firstVideoHere(false, store({ [STARTS_KEY]: '1' })), false);
  assert.equal(firstVideoHere(true, null), false);
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(firstVideoHere(true, broken), false);
});
