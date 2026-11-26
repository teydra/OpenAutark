// Owner 19.11.2026 ("Call läuft weiter, wenn man die App verlässt"): closing the app window while voice is live hides it
// (src/main/window-voice.ts VoiceHold); the close happens once the voice ends while it is still hidden; showing it again
// calls that off; a quit lets go (every close closes); a page that is gone has no voice. Plus the wiring in window.ts
// and desktop.ts, read from the source (no Electron here).
// Owns: these assertions only. Never: real windows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VoiceHold } from '../../../src/main/window-voice.ts';

const read = (file: string) => readFileSync(new URL(`../../../src/${file}`, import.meta.url), 'utf8');

test('without voice a close closes; with voice it hides and the close comes when the voice ends', () => {
  const hold = new VoiceHold();
  assert.equal(hold.close(), 'close');
  assert.equal(hold.setLive(true), false);
  assert.equal(hold.close(), 'hide');
  assert.equal(hold.setLive(true), false, 'still talking');
  assert.equal(hold.setLive(false), true, 'the voice ended: the waiting close is due');
  assert.equal(hold.setLive(false), false, 'only once');
  assert.equal(hold.close(), 'close');
});

test('voice ending without a close asked for closes nothing; showing the window calls the waiting close off', () => {
  const hold = new VoiceHold();
  hold.setLive(true);
  assert.equal(hold.setLive(false), false);
  hold.setLive(true);
  assert.equal(hold.close(), 'hide');
  hold.shown();
  assert.equal(hold.setLive(false), false, 'the person brought the window back');
});

test('a quit lets go: a close during a call closes; a page that is gone has no voice', () => {
  const quit = new VoiceHold();
  quit.setLive(true);
  quit.letGo();
  assert.equal(quit.close(), 'close');
  const gone = new VoiceHold();
  gone.setLive(true);
  assert.equal(gone.close(), 'hide');
  gone.pageGone();
  assert.equal(gone.setLive(false), false, 'the page went with its window: nothing waits');
  assert.equal(gone.close(), 'close');
});

test('wiring: the window asks the hold at close and on voice changes; the quit, an update and the session end let go', () => {
  const window = read('main/window.ts');
  assert.match(window, /if \(this\.voice\.close\(\) === 'close'\) return;\s*event\.preventDefault\(\);[^\n]*\n\s*window\.hide\(\);/);
  assert.match(window, /if \(this\.voice\.setLive\(on\)\) this\.browserWindow\?\.close\(\);/);
  assert.match(window, /this\.voice\.shown\(\);/);
  assert.match(window, /private goneNow\(\): void \{\n\s*this\.voice\.pageGone\(\);/);
  // Windows sign-out/shutdown and the system's shutdown let go before the windows close
  assert.match(window, /window\.on\('query-session-end', \(\) => this\.voice\.letGo\(\)\);/);
  assert.match(window, /window\.on\('session-end', \(\) => this\.voice\.letGo\(\)\);/);
  assert.match(window, /powerMonitor\.on\('shutdown', \(\) => this\.voice\.letGo\(\)\);/);
  assert.ok(window.indexOf("window.on('session-end'") < window.indexOf("window.on('close'"), 'registered before the close handler');
  const desktop = read('main/desktop.ts');
  assert.match(desktop, /app\.on\('before-quit', beforeDesktopQuit\(\{[\s\S]*?begin: \(\) => \{ mainWindow\.letGo\(\);/);
  assert.match(desktop, /before-quit-for-update', \(\) => \{ desktopUpdates\.markUpdateQuit\(\); mainWindow\.letGo\(\); \}/);
});
