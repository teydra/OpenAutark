// This installation's device identity: a long-term Ed25519 key pair and the `self` row.
// Owns: creating/loading the key (private key encrypted with the host keychain, stored in kv),
// signing, and keeping the self row (name, caps, addresses) current. Every PC is home of its
// own data (role 'home'); linked PCs are peers – no role can be forced from outside.
// Never: exposes the private key outside this object, or writes it unencrypted anywhere.

import type { KeyObject } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import type { Db } from '../db/database.ts';
import type { Host } from '../host.ts';
import type { Clock, Logger } from '../contracts.ts';
import { KvRepo } from '../store/kv.ts';
import { newId } from '../../shared/ids.ts';
import type { DeviceCaps } from '../../shared/model/devices.ts';
import { DevicesRepo, type DeviceRecord } from './repo.ts';
import { b64url, exportPrivate, fingerprintOf, generateEd25519, importPrivate, rawPublic, signEd25519 } from './keys.ts';

const NS = 'device';

export class DeviceKeyUnavailable extends Error {
  readonly wrongHost: boolean;
  constructor(wrongHost = false) {
    super(wrongHost
      ? 'The desktop app and the headless runtime use different secure storage. Open this profile with the runtime that created it; use a separate data folder for the other one.'
      : 'The device identity key is not available in system secure storage.');
    this.wrongHost = wrongHost;
  }
}

/** The name of a PC nobody renamed: on a Mac the one its person set (System Settings › Sharing, `scutil --get ComputerName`),
 *  else – and when scutil fails or hangs – the host name; a Mac's ends in ".local" there, which people never say. */
export function defaultPcName(deps: { platform?: string; hostname?: () => string; scutil?: () => string } = {}): string {
  const platform = deps.platform ?? process.platform;
  const hostname = (deps.hostname ?? os.hostname)();
  if (platform !== 'darwin') return hostname;
  try {
    const run = deps.scutil ?? (() => execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }));
    const name = String(run()).trim();
    if (name) return name.slice(0, 80);
  } catch { /* fall back */ }
  return hostname.replace(/\.local$/i, '') || hostname;
}

interface StoredIdentity {
  deviceId: string;
  publicKey: string; // base64url raw
  privateCipher: string; // base64 of host.encrypt(pkcs8 base64)
  keyHost?: Host['kind']; // absent on old profiles; set only after a key has been read or created here
}

export class DeviceIdentity {
  readonly deviceId: string;
  readonly publicKey: Buffer; // raw 32 bytes
  readonly fingerprint: string;
  private readonly privateKey: KeyObject;

  private constructor(deviceId: string, publicKey: Buffer, privateKey: KeyObject) {
    this.deviceId = deviceId;
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.fingerprint = fingerprintOf(publicKey);
  }

  /** Loads the identity from kv or creates it on first start; ensures the self row exists. */
  static async load(input: { db: Db; host: Host; clock: Clock; log?: Logger; name?: string; caps?: DeviceCaps }): Promise<DeviceIdentity> {
    const kv = new KvRepo(input.db);
    const repo = new DevicesRepo(input.db);
    const stored = kv.get<StoredIdentity>(NS, 'identity');
    let identity: DeviceIdentity | undefined;
    if (stored?.keyHost && stored.keyHost !== input.host.kind) throw new DeviceKeyUnavailable(true);
    if (stored) {
      try {
        const pkcs8 = await input.host.decrypt(Buffer.from(stored.privateCipher, 'base64'));
        identity = new DeviceIdentity(stored.deviceId, Buffer.from(stored.publicKey, 'base64url'), importPrivate(pkcs8));
      } catch {
        // Legacy headless profiles predate the keyHost marker. Their file key is not an OS key.
        if (input.host.kind === 'electron' && input.host.app.dataDir &&
            existsSync(path.join(input.host.app.dataDir, 'runtime.key'))) throw new DeviceKeyUnavailable(true);
        // A linked profile must keep the identity its peers trust (see the guard below).
      }
    }
    let replacement: StoredIdentity | undefined;
    if (!identity) {
      // Include revoked rows: they prove this identity was used outside this installation.
      // A portable import deliberately has no identity and no self row, even if it still lists peers.
      if ((stored || repo.self()) && repo.list({ includeRevoked: true }).some((device) => !device.self)) throw new DeviceKeyUnavailable();
      const pair = generateEd25519();
      const deviceId = stored?.deviceId ?? repo.self()?.id ?? newId('dev', input.clock.now());
      const plain = exportPrivate(pair.privateKey);
      let cipher: Uint8Array;
      try {
        cipher = await input.host.encrypt(plain);
        // Never overwrite the old bytes if the replacement cannot be read by this host either.
        if (stored && await input.host.decrypt(cipher) !== plain) throw new DeviceKeyUnavailable();
      } catch { throw new DeviceKeyUnavailable(); }
      replacement = { deviceId, publicKey: b64url(rawPublic(pair.publicKey)), privateCipher: Buffer.from(cipher).toString('base64'), keyHost: input.host.kind };
      identity = new DeviceIdentity(deviceId, rawPublic(pair.publicKey), pair.privateKey);
    }
    const existing = repo.get(identity.deviceId);
    const record: DeviceRecord = {
      id: identity.deviceId,
      name: existing?.name ?? input.name ?? defaultPcName(),
      kind: 'pc',
      role: 'home',
      fingerprint: identity.fingerprint,
      publicKey: b64url(identity.publicKey),
      addresses: existing?.addresses ?? [],
      caps: { os: process.platform, ...(existing?.caps ?? {}), ...(input.caps ?? {}) },
      status: 'online',
      self: true,
      pairedAt: existing?.pairedAt,
      lastSeenAt: input.clock.now(),
    };
    input.db.tx(() => {
      if (replacement) {
        if (stored) {
          const previous = kv.get<StoredIdentity[]>(NS, 'identity-before-recovery') ?? [];
          kv.set(NS, 'identity-before-recovery', [...previous, stored], input.clock.now());
        }
        kv.set(NS, 'identity', replacement, input.clock.now());
      } else if (stored && !stored.keyHost) {
        kv.set(NS, 'identity', { ...stored, keyHost: input.host.kind }, input.clock.now());
      }
      repo.upsert(record);
    });
    if (stored && replacement) input.log?.warn('unpaired device identity key replaced; device ID kept');
    return identity;
  }

  sign(data: Uint8Array): Buffer {
    return signEd25519(this.privateKey, data);
  }
}
