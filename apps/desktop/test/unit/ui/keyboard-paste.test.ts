// FCMWSZNH: a picture from the Android keyboard's clipboard row (ui/pwa/keyboard-paste.ts) becomes a File for the
// focused field – image types only, at most 15 MB, the provider's name without folders, a made-up name otherwise.
// Owns: these assertions. Never: a WebView or a keyboard (that is the device check on the Samsung).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PASTE_MAX_CHARS, pastedPicture } from '../../../src/ui/pwa/keyboard-paste.ts';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');

test('a keyboard picture becomes an image file with its bytes and name', async () => {
  const file = pastedPicture({ t: 'paste', name: 'Screenshot_20261124.png', mime: 'image/png', data: png });
  assert.ok(file);
  assert.equal(file.name, 'Screenshot_20261124.png');
  assert.equal(file.type, 'image/png');
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
});

test('folders leave the name, and a missing name gets one from the type', () => {
  assert.equal(pastedPicture({ name: '/data/x/../clip.jpg', mime: 'image/jpeg', data: png })?.name, 'clip.jpg');
  assert.match(pastedPicture({ mime: 'image/svg+xml', data: png })?.name ?? '', /^pasted-\d+\.svg$/);
});

test('no file for other types, empty, broken or oversized data', () => {
  assert.equal(pastedPicture({ name: 'a.txt', mime: 'text/plain', data: png }), null);
  assert.equal(pastedPicture({ mime: 'image/*', data: png }), null);
  assert.equal(pastedPicture({ mime: 'image/png', data: '' }), null);
  assert.equal(pastedPicture({ mime: 'image/png', data: '%%%' }), null);
  assert.equal(pastedPicture({ mime: 'image/png', data: 'A'.repeat(PASTE_MAX_CHARS + 4) }), null);
  assert.equal(pastedPicture({ mime: 'image/png' }), null);
});
