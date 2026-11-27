// 10.11.2026 (CEO screenshot, Samsung, Android app): "Not paired" showed the old list and "Pair it again…" with no button –
// the recovery row was iPhone-only (inHostedApp). Both phone apps now get it; "Not paired" names it "Pair again".
// Feedback 16.11.2026 F15: Pair again in the Android app pairs over the company ('add') instead of forgetting it first;
// a refusal (4401) goes to the app ('refused') so it tries the company's next PC.
// Sicher-Runde 19.11.2026 (D1, D4, D5): "Not paired" (4401) and a PC that does not know the phone yet (4404) no longer
// replace the shell – they are a line in the status line (shell/connection-line.ts, texts in connection-line.test.ts)
// with Pair again; 4404 goes to the Android app as 'refused' too, so it tries the company's next PC.
// Owner 27.11.2026: the interface is the phone app's own; a PC too old for it is sent off like a refusal (lib/rpc.ts
// turnedAway), and every phone app with a port hears it (the iPhone app answers 'refused' as well).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { signal } from '@preact/signals';
import { isPhoneApp, pairAgain, reportRefusals } from '../../../src/ui/pwa/native.ts';
import { adoptPort, resetNativePort } from '../../../src/ui/pwa/native-port.ts';

const app = readFileSync(new URL('../../../src/ui/App.tsx', import.meta.url), 'utf8');

class FakePort {
  sent: unknown[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage(data: unknown) { this.sent.push(data); }
  close() { /* nothing to close */ }
}

test('the shell stays for 4401 and 4404: only a removed phone (4403) gets a screen of its own; no Forget, no read-only My day', () => {
  assert.equal(typeof isPhoneApp, 'function');
  assert.doesNotMatch(app, /OfflineTodos|offline-view|forgetThisPhone|>Forget/, 'the old "only My day" screen is gone, and with it its Forget');
  assert.match(app, /if \(refused === 4403\) return <AccessRequest removed \/>;/);
  assert.doesNotMatch(app, /refused === 4401|refused === 4404/, 'a refusal is a status line, not a screen');
  assert.match(app, /useEffect\(\(\) => reportRefusals\(rpc\), \[\]\);/);
});

test('Pair again: the Android app gets "add" (its pairing over this company); the iPhone web app and an app without its port forget', () => {
  const page = globalThis as { autarkHosted?: unknown; location?: { href: string } };
  const before = { hosted: page.autarkHosted, location: page.location };
  try {
    resetNativePort();
    const port = new FakePort();
    adoptPort(port as unknown as MessagePort);
    pairAgain();
    assert.deepEqual(port.sent, ['{"t":"add"}'], 'no forget first');

    let forgot = 0;
    page.autarkHosted = { v: 1, base: '/app/', socket: () => undefined, frameUrl: () => '', forget: async () => { forgot++; } };
    pairAgain();
    assert.equal(forgot, 1, 'the iPhone web app keeps its own way');
    assert.equal(port.sent.length, 1);

    page.autarkHosted = undefined;
    resetNativePort();
    page.location = { href: '' };
    pairAgain();
    assert.equal(page.location.href, 'autark-app:forget', 'an Android app before its port: the old address');
  } finally {
    page.autarkHosted = before.hosted;
    page.location = before.location;
    resetNativePort();
  }
});

const source = () => ({ turnedAway: signal(0), refused: signal<4401 | 4403 | 4404 | null>(null), outdated: signal<string | null>(null) });

test('a socket sent off (refused 4401/4404, or its PC too old) tells the phone app "refused" once each; removed (4403) does not', () => {
  resetNativePort();
  const s = source();
  const stop = reportRefusals(s);
  try {
    const port = new FakePort();
    adoptPort(port as unknown as MessagePort);
    s.refused.value = 4401; // set while a PC was out of reach: no socket of it was sent off
    assert.deepEqual(port.sent, []);
    s.turnedAway.value += 1; // the PC refused the token
    assert.deepEqual(port.sent, ['{"t":"refused"}']);
    s.turnedAway.value += 1; // the next PC refused as well
    assert.equal(port.sent.length, 2);
    s.refused.value = 4404; // a PC the company's roster has not reached yet: on to the next PC too
    s.turnedAway.value += 1;
    assert.equal(port.sent.length, 3);
    s.refused.value = null;
    s.outdated.value = 'Laptop'; // a PC older than this interface: on to the next PC (owner 27.11.2026)
    s.turnedAway.value += 1;
    assert.equal(port.sent.length, 4);
    s.outdated.value = null;
    s.refused.value = 4403;
    s.turnedAway.value += 1; // removed: that ends at once, no next PC
    assert.equal(port.sent.length, 4);
  } finally { stop(); resetNativePort(); }
});

test('a refusal before the app handed over its port is told once the port arrives', () => {
  resetNativePort();
  const s = source();
  const stop = reportRefusals(s);
  try {
    s.refused.value = 4401;
    s.turnedAway.value += 1;
    const port = new FakePort();
    adoptPort(port as unknown as MessagePort);
    assert.deepEqual(port.sent, ['{"t":"refused"}']);
    const next = new FakePort();
    adoptPort(next as unknown as MessagePort);
    assert.deepEqual(next.sent, [], 'told once');
  } finally { stop(); resetNativePort(); }
});
