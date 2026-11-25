// F25 P3 end to end (18.11.2026): the iPhone web app's own pairing and Connection (src/ui/hosted, bundled with esbuild
// into a page served with the app's CSP – plus ws: for the local meeting server) in real Chromium, against the real
// meeting server (services/remote-relay) and a PC with its real Meeting, RemoteWithPhones, PwaService and PhoneBridge
// with the WebRTC way (rendezvous/rtc.ts, werift) on this PC's own addresses, no STUN. Proven here:
// - the direct way stands: the page's streams take B (Connection.via 'rtc'), the PC UI's kind of WebSocket reopens on
//   it, a 4 MB download runs over rtc while the tunnel carries only signalling bytes (bridge.counts per path);
// - B lost (the peer connection closed) → the page is back on A at once and the next download runs through the tunnel;
// - the fallbacks stay silently on the tunnel: the PC says no (devices.rtc off), the PC proves another key on B (the
//   phone refuses it: DTLS is no trust), the PC refuses the phone's key on B (no new try in that session, even after a
//   resume), ICE blocked (no candidate reaches the other side: ICE fails at once, or the 15 s pass);
// - no console line of the page names an address or SDP.
// WebKit runs the same when Playwright has it installed; on this PC it has not (the test says so and skips).
// Not proven: mDNS discovery (Chromium uses numeric host ICE candidates here), a real iPhone (Safari across a WLAN,
// iOS background kills), mobile networks, STUN in the field. Run: node --test test/native/hosted-rtc.test.mjs
// Owns: these assertions. Never: the user's data, the real meeting server, or the website build.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';
import { WebSocketServer } from 'ws';
import { acceptSecure } from '../../src/runtime/devices/channel.ts';
import { DeviceIdentity } from '../../src/runtime/devices/identity.ts';
import { DeviceMesh } from '../../src/runtime/devices/mesh.ts';
import { DevicesRepo } from '../../src/runtime/devices/repo.ts';
import { RemoteWithPhones } from '../../src/runtime/devices/rendezvous/phone-pair.ts';
import { PhoneBridge } from '../../src/runtime/devices/rendezvous/phone.ts';
import { Meeting } from '../../src/runtime/devices/rendezvous/service.ts';
import { PwaService } from '../../src/runtime/pwa/service.ts';
import { remoteIdOf } from '../../src/runtime/remote/id.ts';
import { systemClock } from '../../src/runtime/system/clock.ts';
import { fakeHost, memoryDb, recordingBus, silentLog } from '../unit/devices/fakes.ts';
import { startRelay } from '../unit/rendezvous/rig.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIG = 4 * 1024 * 1024;
const realTimers = { set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clear: (handle) => clearTimeout(handle) };

async function until(read, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Playwright's browser, or the newest headless shell installed here when the pinned one is missing. */
function executable(type) {
  try { if (existsSync(type.executablePath())) return undefined; } catch { /* none pinned */ }
  if (process.env.CI === 'true') throw new Error('Pinned Playwright browser missing in CI');
  if (type !== chromium) return null;
  const store = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.cache'), 'ms-playwright');
  const shell = existsSync(store) ? readdirSync(store).filter((name) => name.startsWith('chromium_headless_shell-')).sort().at(-1) : undefined;
  const file = shell && path.join(store, shell, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
  return file && existsSync(file) ? file : null;
}

/** The app's CSP from the website build (apps/website/build.mjs), with ws: for the local meeting server. */
async function appCsp() {
  const text = await readFile(path.join(root, '..', 'website', 'build.mjs'), 'utf8');
  const list = /const APP_CSP = \[([\s\S]*?)\]\.join/.exec(text)[1];
  return [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]).join('; ').replace("connect-src 'self' wss:", "connect-src 'self' wss: ws:");
}

/** The PC's UI port: '/' with the hosted marker, /big (4 MB), /ws answering. */
async function pcUi(t) {
  const big = Buffer.alloc(BIG, 0x5a);
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><meta name="autark-hosted" content="1"><script type="module" src="main.js"></script>'); return; }
    if (req.url === '/big') { res.setHeader('content-length', String(big.length)); res.end(big); return; }
    res.statusCode = 404; res.end();
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => ws.on('message', (data) => ws.send(data.toString())));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { wss.close(); server.closeAllConnections(); server.close(); });
  return server.address().port;
}

/** The PC: real Meeting, pairing and PhoneBridge with the WebRTC way; `pc.mode` steers what it does on B. */
async function desk(relayUrl, uiPort) {
  const db = memoryDb();
  const { bus } = recordingBus();
  const identity = await DeviceIdentity.load({ db, host: fakeHost(), clock: systemClock, name: 'Desk' });
  const other = await DeviceIdentity.load({ db: memoryDb(), host: fakeHost(), clock: systemClock, name: 'Other' });
  const lines = [];
  const keep = (message, data) => { if (message.startsWith('phone rtc')) lines.push({ message, ...data }); };
  const log = { debug() {}, info: keep, warn: keep, error: keep };
  const state = { mode: 'on' };
  const repo = new DevicesRepo(db);
  const mesh = new DeviceMesh({ db, identity, clock: systemClock, log: silentLog, bus, timers: realTimers, dial: async () => { throw new Error('no direct path'); } });
  const settings = { get: () => ({ pwa: { enabled: false, bind: 'localhost' } }), update: () => undefined };
  const push = { subscribedDevices: () => new Set(), publicKey: async () => 'key', removeDevice: () => undefined };
  const pwa = new PwaService({ db, clock: systemClock, bus, log: silentLog, settings, push, port: () => uiPort, qr: async () => '', serveStatus: async () => undefined, interfaces: () => ({}) });
  const remote = new RemoteWithPhones({
    identity, clock: systemClock, bus, log: silentLog, mesh, timers: realTimers, findable: () => true,
    post: async () => { throw new Error('unused'); }, pair: (phone) => pwa.pairPhone(phone),
  });
  class TestBridge extends PhoneBridge {
    acceptRtc(socket, pub) {
      if (state.mode === 'otherPc') return acceptSecure(socket, other, () => 'dev_x'); // another PC's key on B
      if (state.mode === 'refuseKey') return acceptSecure(socket, identity, () => undefined); // 4003 for the phone's key
      return super.acceptRtc(socket, pub);
    }
  }
  const phones = new TestBridge({ identity, log, port: () => uiPort, phone: (fp) => repo.byFingerprint(fp), rtc: { stun: () => (state.mode === 'off' ? undefined : []) } });
  const meeting = new Meeting({
    db, bus, log: silentLog, clock: systemClock, identity, mesh, timers: realTimers, phones,
    remote: { handle: (body, from) => remote.handle(body, from), wellKnown: () => ({ deviceId: identity.deviceId, name: 'Desk', fingerprint: identity.fingerprint }), kinds: new Set(['remote1', 'remote2', 'remote3', 'remoteCancel']) },
    relayUrl: () => relayUrl, findable: () => true, port: () => undefined,
  });
  meeting.start();
  return { identity, remote, meeting, phones, lines, state, stop: () => { meeting.stop(); phones.closeAll(); mesh.close(); } };
}

/** Wraps the page's RTCPeerConnection: every one kept (window.__peers); with window.__block no candidate gets through. */
const INIT = `(() => {
  const Real = window.RTCPeerConnection;
  if (!Real) return;
  window.__peers = [];
  window.__configs = [];
  window.__block = false;
  class Peer extends Real {
    constructor(config) { super(config); this.__blocked = window.__block; window.__peers.push(this); window.__configs.push(JSON.parse(JSON.stringify(config || {}))); }
    addIceCandidate(candidate) { return this.__blocked ? Promise.resolve() : super.addIceCandidate(candidate); }
    get localDescription() { const d = super.localDescription; return d && this.__blocked ? { type: d.type, sdp: d.sdp.replace(/a=candidate:[^\\r\\n]*\\r\\n/g, '') } : d; }
    get onicecandidate() { return super.onicecandidate; }
    set onicecandidate(handler) { super.onicecandidate = this.__blocked && handler ? (event) => { if (!event.candidate) handler(event); } : handler; }
  }
  window.RTCPeerConnection = Peer;
})();`;

async function pairStats(page) {
  return page.evaluate(async () => {
    const peer = window.__peers.at(-1);
    const stats = [...(await peer.getStats()).values()];
    const pair = stats.find((s) => s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) ?? stats.find((s) => s.type === 'candidate-pair' && s.state === 'succeeded');
    const type = (id) => stats.find((s) => s.id === id)?.candidateType;
    return pair ? { local: type(pair.localCandidateId), remote: type(pair.remoteCandidateId) } : undefined;
  });
}

async function run(t, type, executablePath) {
  const relay = await startRelay();
  t.after(() => relay.close());
  const uiPort = await pcUi(t);
  const pc = await desk(relay.url, uiPort);
  t.after(() => pc.stop());
  await until(() => pc.meeting.state().status === 'connected', 'the PC at the meeting server');

  const bundle = await build({ absWorkingDir: root, entryPoints: ['test/e2e/lib/hosted-rtc-page.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'safari17', logLevel: 'warning' });
  const csp = await appCsp();
  const site = http.createServer((req, res) => {
    if (req.url === '/page.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'content-security-policy': csp }); res.end(bundle.outputFiles[0].text); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp });
    res.end('<!doctype html><meta charset="utf-8"><title>rtc</title><script type="module" src="/page.js"></script>');
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  t.after(() => site.close());

  // This same-host fixture is about the data path and fallback, not whether the
  // runner routes multicast. Otherwise Chromium's .local names can spend 10 s
  // in werift's mDNS lookup and fail before the key-refusal handshake is reached.
  const args = type === chromium ? ['--disable-features=WebRtcHideLocalIpsWithMdns'] : [];
  const browser = await type.launch({ headless: true, args, ...(executablePath ? { executablePath } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const consoleLines = [];
  page.on('console', (message) => consoleLines.push(message.text()));
  page.on('pageerror', (error) => consoleLines.push(`pageerror ${error.message}`));
  await page.addInitScript(INIT);
  const gcryptWebKit = type === webkit && process.platform === 'linux';
  if (gcryptWebKit) {
    // This pinned Linux WebKit can drop a leading zero from freshly generated
    // key material (https://bugs.webkit.org/show_bug.cgi?id=307095). Retry only
    // the native X25519 key generation, not pairing, key validation or any RTC
    // step. Remove when Playwright carries https://commits.webkit.org/323215@main.
    await page.addInitScript(() => {
      const original = SubtleCrypto.prototype.generateKey;
      window.__x25519Retries = 0;
      SubtleCrypto.prototype.generateKey = async function (...args) {
        try {
          return await original.apply(this, args);
        } catch (error) {
          const algorithm = typeof args[0] === 'string' ? args[0] : args[0]?.name;
          if (algorithm !== 'X25519' || error?.name !== 'OperationError') throw error;
          window.__x25519Retries++;
          return original.apply(this, args);
        }
      };
    });
  }
  await page.goto(`http://127.0.0.1:${site.address().port}/`);
  await page.waitForFunction(() => window.rtcTest);

  // ── pairing (the app's own flow; the PC accepts)
  const pairing = page.evaluate(([url, id]) => window.rtcTest.pair(url, id), [relay.url, remoteIdOf(pc.identity.fingerprint)]);
  // Observe a pairing rejection immediately, even if the PC never gets a request.
  const [deviceId] = await Promise.all([pairing, (async () => {
    const request = await until(() => pc.remote.state().incoming[0], 'the request on the PC');
    pc.remote.decide(request.id, true);
  })()]);
  const counts = () => pc.phones.counts().find((row) => row.deviceId === deviceId) ?? { rtc: 0, relay: 0 };
  const state = () => page.evaluate(() => window.rtcTest.state());
  const get = () => page.evaluate(() => window.rtcTest.get('/big'));
  const report = {};

  // ── the direct way: B carries the streams, the socket reopens there, a 4 MB download goes over rtc
  await page.evaluate(() => { window.rtcTest.start(); window.rtcTest.socket(); });
  const ready = await until(async () => { const s = await state(); return s.via === 'rtc' && s; }, 'the page on B', 25_000)
    .catch(async (error) => { throw new Error(`${error.message}: ${JSON.stringify({ page: await state(), pc: pc.lines })}`); });
  assert.ok(ready.statuses.some((line) => / directly\.$/.test(line)), ready.statuses.join(' | '));
  assert.deepEqual(await page.evaluate(() => window.__configs.map((c) => c.iceServers)), [[]], 'iceServers exactly the offer\'s: none');
  await until(async () => (await state()).sockets.includes('open rtc'), 'the WebSocket reopened on B');
  const before = counts();
  const direct = await get();
  const after = counts();
  assert.deepEqual([direct.status, direct.length, direct.via], [200, BIG, 'rtc']);
  report.rtcBytes = after.rtc - before.rtc;
  report.relayBytesDuringDownload = after.relay - before.relay;
  report.directMs = direct.ms;
  report.pair = await pairStats(page);
  assert.ok(report.rtcBytes > BIG, `the download went over rtc (${report.rtcBytes} bytes)`);
  assert.ok(report.relayBytesDuringDownload < 4_096, `the tunnel carried no stream bytes (${report.relayBytesDuringDownload})`);

  // ── B lost: back on A at once; the next download runs through the tunnel
  await page.evaluate(() => window.__peers.at(-1).close());
  const back = await until(async () => { const s = await state(); return s.via === 'relay' && s; }, 'back on A', 10_000);
  assert.equal(back.statuses.at(-1), 'Connected to Desk.', 'the page hears resume');
  assert.equal(back.last, 'lost');
  const relayed = await get();
  assert.deepEqual([relayed.length, relayed.via], [BIG, 'relay']);
  report.relayMs = relayed.ms;
  await until(async () => (await state()).sockets.at(-1) === 'open relay', 'the WebSocket reopened on A');

  // ── the fallbacks: each a fresh session, each stays silently on the tunnel
  const fallback = async (mode, block, outcome, ms) => {
    // Stop the old session before switching fixture behaviour. Wait for its
    // relay channel to close on the PC, not just for the browser to request it.
    await page.evaluate(() => window.rtcTest.stop());
    await until(() => !counts().via, 'the previous phone channel closed at the PC', 10_000);
    pc.state.mode = mode;
    await page.evaluate((b) => { window.__block = b; window.rtcTest.start(); }, block);
    const s = await until(async () => { const now = await state(); return [outcome].flat().includes(now.last) && now; }, `${mode}: ${outcome}`, ms)
      .catch(async (error) => { throw new Error(`${error.message}: ${JSON.stringify({ page: await state(), pc: pc.lines.slice(-3) })}`); });
    const fetched = await get();
    assert.deepEqual([fetched.length, fetched.via], [BIG, 'relay'], `${mode}: the tunnel carries`);
    assert.ok(!s.statuses.some((line) => /directly/.test(line)), `${mode}: never said direct`);
    return s;
  };
  await fallback('off', false, 'off', 10_000);
  await fallback('otherPc', false, 'failed', 20_000);
  await fallback('refuseKey', false, 'refused', 20_000);
  const peersBefore = await page.evaluate(() => window.__peers.length);
  await page.evaluate(() => window.rtcTest.nudge());
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  assert.equal(await page.evaluate(() => window.__peers.length), peersBefore, 'after refused: no new try, even after a resume');
  const blocked = Date.now();
  report.blockedOutcome = (await fallback('on', true, ['failed', 'timeout'], 25_000)).last; // ICE fails at once or the 15 s pass
  report.blockedMs = Date.now() - blocked;
  await page.evaluate(() => window.rtcTest.stop());

  const leaks = consoleLines.filter((line) => /\b\d{1,3}(\.\d{1,3}){3}\b|candidate|a=fingerprint|ice-ufrag|v=0/.test(line));
  assert.deepEqual(leaks, [], 'no address or SDP in the page\'s console');
  report.outcomesAtPc = pc.lines.map((line) => line.outcome);
  if (gcryptWebKit) report.x25519Retries = await page.evaluate(() => window.__x25519Retries);
  report.browser = `${type.name()} ${browser.version()}`;
  t.diagnostic(JSON.stringify(report));
}

test('Chromium: the iPhone web app\'s direct way to the PC, its fallbacks to the tunnel', { timeout: 240_000 }, async (t) => {
  const file = executable(chromium);
  if (file === null) { t.skip('Chromium is not installed for Playwright here'); return; }
  await run(t, chromium, file);
});

test('WebKit: the same', { timeout: 240_000 }, async (t) => {
  const file = executable(webkit);
  if (file === null) { t.skip('WebKit is not installed for Playwright here (npx playwright install webkit)'); return; }
  await run(t, webkit, file);
});
