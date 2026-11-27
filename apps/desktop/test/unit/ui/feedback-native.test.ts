// Feedback 16.11.2026 (F15, F22): the Android app takes the feedback shot of its own window over the port –
// the page asks {t:'shot'} and waits at most 2 s for {t:'shot', data} (a JPEG data URL) or {t:'shot', error}; no
// port, an error or anything that is no image gives no shot. The app's crash report ({t:'crash', text}) is
// replayed to a late subscriber until it is taken once (src/ui/pwa/native-port.ts, src/ui/feedback/bridge.ts).
// Owns: these assertions. Never: a real WebView or app.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoptPort, consumeNative, onNative, requestNativeShot, resetNativePort } from '../../../src/ui/pwa/native-port.ts';
import { nativeShotHere } from '../../../src/ui/feedback/bridge.ts';

const APP = (version: string) => `Mozilla/5.0 (Linux; Android 10; K) Chrome/131 Mobile Safari/537.36 AutarkAndroid/${version} (Android 16; samsung SM-S918B)`;

/** The app's side of the port: answers each page message with `answer` (nothing when it returns undefined). */
function fakeApp(t: { after(fn: () => void): void }, answer: (msg: Record<string, unknown>) => Record<string, unknown> | undefined) {
  const channel = new MessageChannel();
  const seen: Array<Record<string, unknown>> = [];
  channel.port2.onmessage = (event: MessageEvent) => {
    const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
    seen.push(msg);
    const reply = answer(msg);
    if (reply) channel.port2.postMessage(JSON.stringify(reply));
  };
  adoptPort(channel.port1);
  t.after(() => { resetNativePort(); channel.port2.close(); });
  return { seen, post: (msg: Record<string, unknown>) => channel.port2.postMessage(JSON.stringify(msg)) };
}

test('without a port there is no shot, at once', async () => {
  resetNativePort();
  const started = Date.now();
  assert.equal(await requestNativeShot(2000), null);
  assert.ok(Date.now() - started < 500);
  assert.equal(nativeShotHere(APP('0.3.15')), false, 'no port: the picker');
});

test('the app answers with its window as a JPEG data URL', async (t) => {
  const app = fakeApp(t, (msg) => (msg.t === 'shot' ? { t: 'shot', data: 'data:image/jpeg;base64,/9j/AAAA' } : undefined));
  assert.equal(await requestNativeShot(2000), 'data:image/jpeg;base64,/9j/AAAA');
  assert.deepEqual(app.seen, [{ t: 'shot' }]);
  assert.equal(nativeShotHere(APP('0.3.15')), true);
  assert.equal(nativeShotHere(APP('0.3.14')), true, 'the page is the app\'s own: no version of the app is checked');
  assert.equal(nativeShotHere('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)'), false);
});

test('an error, a non-image or no answer within the wait gives no shot', async (t) => {
  let reply: Record<string, unknown> | undefined = { t: 'shot', error: 'PixelCopy failed' };
  fakeApp(t, () => reply);
  assert.equal(await requestNativeShot(2000), null);
  reply = { t: 'shot', data: 'data:text/html;base64,PHNjcmlwdD4=' };
  assert.equal(await requestNativeShot(2000), null, 'only an image');
  reply = undefined;
  const started = Date.now();
  assert.equal(await requestNativeShot(80), null);
  assert.ok(Date.now() - started >= 70, 'waited for the answer');
});

test('two requests at once share the next answer', async (t) => {
  const app = fakeApp(t, (msg) => (msg.t === 'shot' && app.seen.length === 2 ? { t: 'shot', data: 'data:image/jpeg;base64,QUJD' } : undefined));
  const [a, b] = await Promise.all([requestNativeShot(2000), requestNativeShot(2000)]);
  assert.equal(a, 'data:image/jpeg;base64,QUJD');
  assert.equal(b, 'data:image/jpeg;base64,QUJD');
});

test('a crash report waits for a late subscriber and is taken once', async (t) => {
  const app = fakeApp(t, () => undefined);
  app.post({ t: 'crash', text: 'android.os.NetworkOnMainThreadException' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const got: unknown[] = [];
  const off = onNative('crash', (msg) => { got.push(msg.text); consumeNative('crash'); });
  assert.deepEqual(got, ['android.os.NetworkOnMainThreadException'], 'replayed to the host that mounted later');
  off();
  const again: unknown[] = [];
  onNative('crash', (msg) => again.push(msg.text))();
  assert.deepEqual(again, [], 'taken once: a later host does not open it again');
});
