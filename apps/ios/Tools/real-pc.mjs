// A real PC for the Swift tests: the REAL meeting server (services/remote-relay) and, as the PC, the REAL desktop code –
// rendezvous/relay-client.ts (the PC's side of the meeting server), remote/requests.ts (the PC's side of the connect request,
// role 'phone'), devices/rendezvous/phone.ts (PhoneBridge: the pinned-key handshake, the encrypted channel and the byte streams)
// – with a tiny HTTP server standing in for the PC's runtime port. Nothing under apps/desktop is changed: everything is imported
// read-only. The phone side is the Swift code (Linux build: URLSession WebSocket, swift-crypto) run by RealPcInteropTests.
// usage: node real-pc.mjs <code-root> ; prints JSON lines on stdout; ends when stdin closes.
import http from 'node:http';
import path from 'node:path';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { createRelay } = await imp('services/remote-relay/src/relay.ts');
const { RelayClient } = await imp('apps/desktop/src/runtime/devices/rendezvous/relay-client.ts');
const { PhoneBridge, relayPhone } = await imp('apps/desktop/src/runtime/devices/rendezvous/phone.ts');
const { TargetRequests } = await imp('apps/desktop/src/runtime/remote/requests.ts');
const keys = await imp('apps/desktop/src/runtime/devices/keys.ts');
const { remoteIdOf } = await imp('apps/desktop/src/runtime/remote/id.ts');

const say = (event, data = {}) => process.stdout.write(JSON.stringify({ event, ...data }) + '\n');
const log = { debug() {}, info(m, d) { say('log', { level: 'info', m, d }); }, warn(m, d) { say('log', { level: 'warn', m, d }); }, error(m, d) { say('log', { level: 'error', m, d }); } };

// ---- the PC's identity
const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const seed = Buffer.alloc(32, 0x42);
const priv = createPrivateKey({ key: Buffer.concat([ED_PKCS8, seed]), format: 'der', type: 'pkcs8' });
const publicKey = keys.rawPublic(createPublicKey(priv));
const fingerprint = keys.fingerprintOf(publicKey);
const identity = { deviceId: 'dev_realpc00000000001', publicKey, sign: (data) => keys.signEd25519(priv, data) };
const TOKEN = 'tok-real-' + Math.random().toString(36).slice(2, 10);
const VERSION = '9.9.9-real';

// ---- the meeting server (real)
const relay = await createRelay({ port: 0, host: '127.0.0.1' });

// ---- the PC's runtime port: what the phone's streams reach
const runtime = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (c) => chunks.push(c));
  request.on('end', () => {
    const body = Buffer.concat(chunks);
    say('http', { method: request.method, url: request.url, bytes: body.length, auth: request.headers.authorization ? 'yes' : 'no', cookie: request.headers.cookie ? 'yes' : 'no' });
    if (request.method === 'POST' && request.url === '/rpc') {
      if (request.headers.authorization !== `Bearer ${TOKEN}`) { response.writeHead(401); response.end('{"error":"token"}'); return; }
      const json = JSON.stringify({ id: 1, result: { version: VERSION } });
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
      response.end(json);
      return;
    }
    if (request.url === '/big') {
      const data = Buffer.alloc(900_000);
      for (let i = 0; i < data.length; i++) data[i] = i % 251;
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length });
      response.end(data);
      return;
    }
    if (request.method === 'POST') {
      const text = `real PC got ${body.length} bytes`;
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(text) });
      response.end(text);
      return;
    }
    const html = '<html><body>Autark phone UI served by the real PC code path</body></html>';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
    response.end(html);
  });
});
await new Promise((resolve) => runtime.listen(0, '127.0.0.1', resolve));
const runtimePort = runtime.address().port;

// ---- phones the PC accepted (what devices/repo.ts would hold)
const phones = new Map(); // fingerprint → DeviceRecord
const phoneBridge = new PhoneBridge({ identity, log, port: () => runtimePort, phone: (fp) => phones.get(fp) });
phoneBridge.onChange(() => say('channels', { counts: phoneBridge.counts() }));

const client = new RelayClient({
  identity, log,
  events: {
    changed() {},
    presence(fp, online) { say('presence', { fp, online }); },
    incoming(tunnel) {
      const record = phones.get(tunnel.peer);
      if (!relayPhone(record)) { say('tunnel-refused', { peer: tunnel.peer }); tunnel.close(); return; }
      say('tunnel', { peer: tunnel.peer });
      void phoneBridge.accept(tunnel, record).catch((error) => { say('tunnel-failed', { error: String(error?.message ?? error) }); tunnel.close(); });
    },
    async pair(from, body, source) {
      const message = body;
      if (message?.op !== 'pair' || typeof message.body !== 'object') return { ok: false, error: { code: 'bad_request', message: 'Not a connect request.' } };
      return requests.handle(message.body, { address: source });
    },
  },
});

const syncPeers = () => client.setPeers([...phones.values()].map((r) => ({ fp: r.fingerprint, pub: r.publicKey })), true, undefined, undefined);

const timers = { set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clear: (h) => clearTimeout(h) };
const requests = new TargetRequests({
  now: () => Date.now(), timers, roles: ['phone'],
  findable: () => true,
  self: () => ({ id: identity.deviceId, name: 'Real Desktop PC', role: 'home', pub: keys.b64url(publicKey), addresses: [] }),
  signer: identity,
  link: (info) => {
    const phoneFp = keys.fingerprintOf(keys.fromB64url(info.pub));
    phones.set(phoneFp, { id: info.id, name: info.name, kind: 'phone', role: 'client', fingerprint: phoneFp, publicKey: info.pub, addresses: [], caps: {}, status: 'active', self: false });
    syncPeers();
    say('linked', { phone: info.id, name: info.name, fingerprint: phoneFp });
    return { token: TOKEN, deviceId: 'dev_acceptedphone0001' };
  },
  shown: (view) => {
    say('request', { id: view.id, name: view.name, code: view.code, remoteId: view.remoteId });
    setTimeout(() => requests.decide(view.id, process.env.REAL_PC_DECLINE !== '1'), Number(process.env.REAL_PC_ACCEPT_AFTER_MS ?? 400));
  },
  changed() {},
  log,
});

client.configure(`ws://127.0.0.1:${relay.port}/`);
syncPeers();
say('ready', { relay: `ws://127.0.0.1:${relay.port}/`, remoteId: remoteIdOf(fingerprint), fingerprint, token: TOKEN, version: VERSION, runtimePort });

process.stdin.resume();
process.stdin.on('end', () => { void relay.close(); runtime.close(); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
