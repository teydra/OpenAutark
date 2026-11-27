// Feedback 16.11.2026 (F22, system-Q1): a report says where it was written – the Android app with its version, Android
// version and device (from the shell's user agent suffix, 0.3.15+), the iPhone web app, a browser or the PC window –
// with the screen, the language and the user agent, in one line of at most 400 characters (src/ui/feedback/client.ts).
// Owns: these assertions. Never: a real browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEEDBACK_CLIENT_MAX } from '../../../src/shared/model/feedback-delivery.ts';
import { androidShell, clientFacts } from '../../../src/ui/feedback/client.ts';
import type { ClientEnv } from '../../../src/ui/feedback/client.ts';

const WEBVIEW = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36';
const NEW_APP = `${WEBVIEW} AutarkAndroid/0.3.15 (Android 16; samsung SM-S918B)`;
const OLD_APP = `${WEBVIEW} AutarkAndroid/0.3.12`;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

const env = (change: Partial<ClientEnv>): ClientEnv => ({ userAgent: '', hosted: false, desktop: false, width: 412, height: 915, pixelRatio: 3, language: 'de', ...change });

test('the Android shell names its version and, from 0.3.15 on, its system and device', () => {
  assert.deepEqual(androidShell(NEW_APP), { version: '0.3.15', system: 'Android 16', device: 'samsung SM-S918B' });
  assert.deepEqual(androidShell(OLD_APP), { version: '0.3.12' }, 'an older app: only its version');
  assert.equal(androidShell(IPHONE), null);
});

test('one line: where, screen, language, user agent', () => {
  assert.equal(clientFacts(env({ userAgent: NEW_APP })), `Android app 0.3.15 · Android 16 · samsung SM-S918B · 412×915 @3x · de · ${NEW_APP}`);
  assert.match(clientFacts(env({ userAgent: OLD_APP })), /^Android app 0\.3\.12 · 412×915 @3x · de · /);
  assert.match(clientFacts(env({ userAgent: IPHONE, hosted: true, width: 390, height: 844 })), /^iPhone web app · iOS 18\.1 · 390×844 @3x · de · /);
  assert.match(clientFacts(env({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0', width: 1280, height: 800, pixelRatio: 2, language: 'en-US' })), /^browser · 1280×800 @2x · en-US · Mozilla/);
  assert.equal(clientFacts(env({ desktop: true, width: 1600, height: 900, pixelRatio: 1, language: undefined })), 'PC window · 1600×900', 'no ratio at 1, nothing empty');
  assert.equal(clientFacts(env({ desktop: true, width: 1600.4, height: 899.6, pixelRatio: 1.2500001 })), 'PC window · 1600×900 @1.25x · de');
});

test('the line never passes the runtime\'s limit', () => {
  const line = clientFacts(env({ userAgent: `${NEW_APP} ${'x'.repeat(800)}` }));
  assert.equal(line.length, FEEDBACK_CLIENT_MAX);
  assert.ok(line.endsWith('…'));
  assert.ok(line.startsWith('Android app 0.3.15 · Android 16 · samsung SM-S918B'), 'the facts come first and stay');
});
