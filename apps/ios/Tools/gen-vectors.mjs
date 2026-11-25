// Generates apps/ios/Tests/CoreTests/DesktopVectors.swift from the REAL desktop code (read-only import):
// remote/sas.ts, devices/pair-proof.ts, devices/handshake.ts, devices/channel.ts, rendezvous/seal.ts, services/remote-relay protocol.ts.
// usage: node --experimental-strip-types gen-vectors.mjs <code-root> <out.swift>
import { createPrivateKey, createPublicKey, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = process.argv[2];
const out = process.argv[3];
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const sas = await imp('apps/desktop/src/runtime/remote/sas.ts');
const proof = await imp('apps/desktop/src/runtime/devices/pair-proof.ts');
const hs = await imp('apps/desktop/src/runtime/devices/handshake.ts');
const chan = await imp('apps/desktop/src/runtime/devices/channel.ts');
const seal = await imp('apps/desktop/src/runtime/devices/rendezvous/seal.ts');
const keys = await imp('apps/desktop/src/runtime/devices/keys.ts');
const stableMod = await imp('apps/desktop/src/shared/text/stable-json.ts');
const protocol = await imp('services/remote-relay/src/protocol.ts');

const fill = (n, v) => Buffer.alloc(n, v);
const hex = (b) => Buffer.from(b).toString('hex');
const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const X_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const edPrivate = (seed) => createPrivateKey({ key: Buffer.concat([ED_PKCS8, seed]), format: 'der', type: 'pkcs8' });
const xPrivate = (raw) => createPrivateKey({ key: Buffer.concat([X_PKCS8, raw]), format: 'der', type: 'pkcs8' });
const rawPub = (priv) => keys.rawPublic(createPublicKey(priv));

const v = {};

// ---- connect request math (sas.ts / pair-proof.ts), the same inputs as the Android test
const a = { id: 'dev_pc00000000001', name: 'Büro-PC "Nord"\b\f', role: 'home', pub: 'A'.repeat(43), addresses: ['http://192.168.1.2:47812', 'relay:x'] };
const b = { id: 'dev_phone00000001', name: 'Pixel 8 😀', role: 'client', pub: 'B'.repeat(43), addresses: [] };
const ephA = fill(32, 1), ephB = fill(32, 2), na = fill(16, 3), nb = fill(16, 4);
const commit = sas.commitment(ephA, ephB, na);
const t = sas.transcript({ a, b, ephA, ephB, commit, role: 'phone' });
v.sas = {
  stableA: stableMod.stable(a),
  commit,
  transcript: hex(t),
  code: sas.matchCode(t, na, nb),
  macAccept: proof.mac(fill(32, 5), 'remote-accept', a, keys.b64url(t)),
  macWait: proof.mac(fill(32, 5), 'remote-wait', 'sess'),
  signedBPrefix: hex(sas.signedBytes('B', t)).slice(0, 40),
};

// ---- peer handshake and channel frames (handshake.ts, channel.ts) with fixed key material on the phone side
const phoneSeed = fill(32, 0x11), pcSeed = fill(32, 0x22);
const phonePriv = edPrivate(phoneSeed), pcPriv = edPrivate(pcSeed);
const phoneSigner = { deviceId: 'dev_phone00000000000001', publicKey: rawPub(phonePriv), sign: (d) => keys.signEd25519(phonePriv, d) };
const pcSigner = { deviceId: 'dev_pc0000000000000001', publicKey: rawPub(pcPriv), sign: (d) => keys.signEd25519(pcPriv, d) };
const ephPrivRaw = fill(32, 0x33);
const ephPriv = xPrivate(ephPrivRaw);
const ephPub = rawPub(ephPriv);
const nonce = fill(16, 0x44);
const hello = { t: 'hello', v: hs.PEER_PROTOCOL, id: phoneSigner.deviceId, pub: keys.b64url(phoneSigner.publicKey), eph: keys.b64url(ephPub), n: keys.b64url(nonce) };
const server = hs.serverWelcome(pcSigner, hello);
const finished = hs.clientFinish(phoneSigner, { eph: ephPriv, ephPub, nonce }, server.message);
const serverKeys = server.verifyAuth(finished.message);
if (!serverKeys || !serverKeys.send.equals(finished.keys.receive) || !serverKeys.receive.equals(finished.keys.send)) throw new Error('desktop handshake self-check failed');
const frameOf = (keySet, messages) => {
  const sent = [];
  const sock = { send: (d) => sent.push(Buffer.from(d)), close() {}, onMessage() {}, onClose() {} };
  const channel = new chan.SecureChannel(sock, keySet, 'x', Buffer.alloc(32));
  for (const m of messages) channel.send(m);
  return sent.map((s, i) => ({ hex: hex(s), plain: JSON.stringify(messages[i]) }));
};
const fromPc = frameOf(serverKeys, [{ t: 'd', s: 1, b: 'SFRUUC8xLjEgMjAwIE9LDQoNCg==' }, { t: 'e', s: 1 }]);
const fromPhone = frameOf(finished.keys, [{ t: 'o', s: 1 }]);
v.handshake = {
  phoneSeed: hex(phoneSeed), pcSeed: hex(pcSeed),
  phonePublic: hex(phoneSigner.publicKey), pcPublic: hex(pcSigner.publicKey),
  phoneDeviceId: phoneSigner.deviceId,
  ephPrivate: hex(ephPrivRaw), nonce: hex(nonce),
  hello: JSON.stringify(hello), welcome: JSON.stringify(server.message), auth: JSON.stringify(finished.message),
  clientToServerKey: hex(finished.keys.send), serverToClientKey: hex(finished.keys.receive),
  fromPc, fromPhone,
};

// ---- meeting-server sealing (seal.ts) and what the relay has devices sign (protocol.ts)
const boxPrivRaw = fill(32, 0x55), boxPriv = xPrivate(boxPrivRaw);
const box = { privateKey: boxPriv, pub: keys.b64url(rawPub(boxPriv)) };
const openerEphRaw = fill(32, 0x66), openerEphPub = rawPub(xPrivate(openerEphRaw));
const owner = seal.fromSender(box, keys.b64url(openerEphPub), seal.PAIR_INFO);
const opener = new seal.CounterCipher(owner.receiveKey, owner.sendKey); // the phone's view: sends with toOwner, receives toOpener
const request = { op: 'pair', body: { kind: 'remote1', v: 1 } };
const reply = { ok: true, status: 'pending' };
v.seal = {
  boxPrivate: hex(boxPrivRaw), boxPublic: box.pub, openerPrivate: hex(openerEphRaw), openerPublic: keys.b64url(openerEphPub),
  info: seal.PAIR_INFO,
  toOwnerKey: hex(owner.receiveKey), toOpenerKey: hex(owner.sendKey),
  requestPlain: JSON.stringify(request), requestSealed: seal.sealJson(opener, request),
  replyPlain: JSON.stringify(reply), replySealed: seal.sealJson(owner, reply),
  tunnelText: seal.tunnelText(keys.b64url(openerEphPub), box.pub), helloText: seal.helloText('CHALLENGE'), boxText: seal.boxText(box.pub),
};
const tOwner = seal.fromSender(box, keys.b64url(openerEphPub), seal.TUNNEL_INFO);
v.tunnel = {
  info: seal.TUNNEL_INFO, toOwnerKey: hex(tOwner.receiveKey), toOpenerKey: hex(tOwner.sendKey),
  textFromPcPlain: JSON.stringify(server.message),
  textFromPcSealed0: hex(tOwner.seal(Buffer.from(JSON.stringify(server.message), 'utf8'))),
};

// ---- Remote IDs (the relay's copy of remote/id.ts)
v.ids = {
  zero: protocol.remoteIdOf('0'.repeat(64)),
  other: protocol.remoteIdOf('81f39bf2061bf1c90aa791641ecf949f794ec5eae41a1185ab04e58ca2e6e9a5'),
  phone: protocol.remoteIdOf(keys.fingerprintOf(phoneSigner.publicKey)),
  phoneFingerprint: keys.fingerprintOf(phoneSigner.publicKey),
};
const digest = createHash('sha256').update(Buffer.from(JSON.stringify(v))).digest('hex');
const literal = JSON.stringify(v, null, 2).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const source = '// Generated by tools/gen-vectors.mjs from the real desktop code (apps/desktop remote/sas.ts, devices/{pair-proof,handshake,channel,keys}.ts,\n'
  + '// rendezvous/seal.ts, services/remote-relay protocol.ts). Do not edit by hand. sha256 of the data: ' + digest + '\n'
  + 'import Foundation\n\nenum DesktopVectors {\n    static let json = "' + literal + '"\n}\n';
writeFileSync(out, source);
console.log('wrote', out, Object.keys(v).join(','));
