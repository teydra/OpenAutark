// VAPID (RFC 8292) application server keys and the signed JWT for push requests.
// Owns: generating/loading this PC's P-256 key pair (private key encrypted with the host keychain, stored in kv) and
// building `Authorization: vapid t=…, k=…` under any key pair (this PC's, or one held from my other PCs –
// devices/sync/held-push.ts). Never: sends anything.

import { createECDH, createPrivateKey, sign } from 'node:crypto';
import type { Clock, Logger } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import type { Host } from '../host.ts';
import { KvRepo } from '../store/kv.ts';

/** Contact for push services (RFC 8292 `sub`); the public project page, not personal data. */
export const VAPID_SUBJECT = 'https://github.com/teydra/OpenAutark';

/** A VAPID key pair: `pub` the 65-byte uncompressed point, `priv` the raw P-256 scalar, both base64url. */
export interface KeyPair { pub: string; priv: string }

interface StoredVapid {
  publicKey: string; // base64url, 65-byte uncompressed point
  privateCipher: string; // base64 of host.encrypt(raw private scalar base64url)
}

export class VapidKeyUnavailable extends Error {
  constructor() { super('This PC cannot open the web-push key. Open Autark under the original OS account with its secure storage unlocked.'); }
}

const b64 = (data: Uint8Array | string) => Buffer.from(data).toString('base64url');

/** `Authorization: vapid …` for one endpoint under one key pair (JWT ES256, valid 12 h). */
export function vapidHeader(endpoint: string, now: number, pair: KeyPair): string {
  const point = Buffer.from(pair.pub, 'base64url');
  const key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: pair.priv, x: b64(point.subarray(1, 33)), y: b64(point.subarray(33, 65)) }, format: 'jwk' });
  const header = b64(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: VAPID_SUBJECT }));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64(signature)}, k=${pair.pub}`;
}

export class VapidKeys {
  readonly publicKey: string; // base64url (what PushManager.subscribe needs as applicationServerKey)
  private readonly pair: KeyPair;

  private constructor(pair: KeyPair) {
    this.publicKey = pair.pub;
    this.pair = pair;
  }

  static async load(input: { db: Db; host: Host; clock: Clock; log?: Logger }): Promise<VapidKeys> {
    const kv = new KvRepo(input.db);
    const stored = kv.get<StoredVapid>('pwa', 'vapid');
    if (stored) {
      try { return new VapidKeys({ pub: stored.publicKey, priv: await input.host.decrypt(Buffer.from(stored.privateCipher, 'base64')) }); }
      catch {
        // Existing subscriptions depend on this public key, including those synchronized to a linked PC.
        if (input.db.get('SELECT 1 FROM push_subscriptions LIMIT 1') ||
            input.db.get("SELECT 1 FROM devices WHERE self = 0 AND kind = 'pc' LIMIT 1")) throw new VapidKeyUnavailable();
      }
    }
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const pair = { pub: b64(ecdh.getPublicKey()), priv: b64(ecdh.getPrivateKey()) };
    let cipher: Uint8Array;
    try {
      cipher = await input.host.encrypt(pair.priv);
      if (stored && await input.host.decrypt(cipher) !== pair.priv) throw new VapidKeyUnavailable();
    } catch { throw new VapidKeyUnavailable(); }
    input.db.tx(() => {
      if (stored) {
        const previous = kv.get<StoredVapid[]>('pwa', 'vapid-before-recovery') ?? [];
        kv.set('pwa', 'vapid-before-recovery', [...previous, stored], input.clock.now());
      }
      kv.set('pwa', 'vapid', { publicKey: pair.pub, privateCipher: Buffer.from(cipher).toString('base64') } satisfies StoredVapid, input.clock.now());
    });
    if (stored) input.log?.warn('web-push key replaced; no existing subscriptions or linked PCs');
    return new VapidKeys(pair);
  }

  /** `Authorization` header value for a push endpoint (JWT ES256, valid 12 h). */
  authorization(endpoint: string, nowMs: number): string {
    return vapidHeader(endpoint, nowMs, this.pair);
  }
}
