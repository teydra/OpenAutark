// Phone/browser access: the runtime serves the same UI to phones/browsers (HTTP server owned elsewhere).
// Owns: pwa.* behaviour – state, enable, the one-time pairing link with its QR code (the phone's
// camera opens it; scanning the PC's screen is the proof) and its 6-digit code (B-075: an installed iPhone app types
// it, pair-code.ts), exchanging either for a device token, authenticate → scope, revoke, push subscriptions (bound to
// the caller) and pushConfig. B-075: the addresses put `tailscale serve`'s https address first (read at most every
// SERVE_CACHE_MS, urls.ts); a link is refused while no phone can reach this PC (only its loopback), and phone access
// turned on without a choice while only the loopback answers takes the same network (as the QR row's Turn on).
// B-078 (D5): no switch gates phones any more – a phone or browser gets in exactly while its accepted device row and
// token exist (Remove ends both); pwa.enabled stays a settings.json key that this file only ever writes true, pwa.bind says who
// reaches the PC's HTTP port (LAN/Tailscale browsers; the phone app comes through the meeting server to the loopback).
// pairPhone stores a phone paired by Remote ID and code (rendezvous/phone-pair.ts) and issues its token – mine, or with a
// personId an employee's person token (people/tokens.ts).
// B-087: a phone's subscription made at another of my PCs and held here through the roster (devices/sync/held-push.ts)
// counts as on here too – this PC pushes to it – so the iPhone web app, which reaches whichever of my PCs is online, shows
// "on" at each of them and never re-subscribes under this PC's key (that would cut off the PC where it was made).
// Never: starts the HTTP server itself or exposes owner scope (an employee's phone never gets a device token).

import { VapidKeyUnavailable } from './vapid.ts';
import type { Bus } from '../bus.ts';
import type { Clock, Logger, SettingsService } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID, newId } from '../../shared/ids.ts';
import type { Person } from '../../shared/model/people.ts';
import { isPhoneRoute } from '../../shared/api/phone-route.ts';
import type { ClientScope } from '../../shared/api/protocol.ts';
import type { PushConfig, PwaState } from '../../shared/model/devices.ts';
import type { Settings } from '../../shared/model/system.ts';
import { DevicesRepo, publicDevice } from '../devices/repo.ts';
import { fingerprintOf, fromB64url, sha256 } from '../devices/keys.ts';
import { heldSubs } from '../devices/sync/held-push.ts';
import { PERSON_SUBSCRIPTIONS_PER_DEVICE, isPushServiceEndpoint, parseSubscription, type PushMessage, type PushService } from './push.ts';
import { PeopleRepo } from '../people/repo.ts';
import { PersonTokens } from '../people/tokens.ts';
import { PairCodes } from './pair-code.ts';
import { TokenService, hashToken } from './tokens.ts';
import { readServeStatus, reachableUrls, serveUrls, type InterfacesFn } from './urls.ts';

/** How long a read of `tailscale serve status` counts. */
export const SERVE_CACHE_MS = 30_000;
/** link()'s refusal while phones reach only this PC's loopback. */
export const UNREACHABLE = 'Phones can\'t reach this PC yet – choose “The same network” or ask the AI to set up Tailscale.';

/** The address a phone should open: https first, then a LAN/tailnet IP – never this PC's loopback. */
export function phoneUrl(urls: readonly string[]): string | undefined {
  return urls.find((url) => url.startsWith('https://')) ?? urls.find((url) => !/^http:\/\/(localhost|127\.|\[::1\])/i.test(url));
}

/** The device a push subscription belongs to: a paired device's or a person's (never the owner's: no device). */
const callerDevice = (scope: ClientScope | undefined): string | undefined =>
  scope?.kind === 'device' || scope?.kind === 'person' ? scope.deviceId : undefined;

export interface PwaDeps {
  db: Db;
  clock: Clock;
  bus: Bus;
  log: Logger;
  settings: SettingsService;
  push: PushService;
  /** Port the runtime HTTP server listens on (127.0.0.1 or the configured bind). */
  port(): number;
  qr(text: string): Promise<string>;
  interfaces?: InterfacesFn;
  /** `tailscale serve status --json` (default: urls.ts readServeStatus; undefined = none). */
  serveStatus?: () => Promise<string | undefined>;
}

export class PwaService {
  readonly tokens: TokenService;
  private readonly deps: PwaDeps;
  private readonly devices: DevicesRepo;
  private readonly codes: PairCodes;
  private serve: { at: number; json?: string } = { at: -Infinity };
  private reading: Promise<void> | undefined;

  constructor(deps: PwaDeps) {
    this.deps = deps;
    this.tokens = new TokenService(deps.db, deps.clock);
    this.devices = new DevicesRepo(deps.db);
    this.codes = new PairCodes(() => deps.clock.now());
  }

  /**
   * The addresses with the last read of `tailscale serve` (a person's invite asks here without waiting); a read older
   * than SERVE_CACHE_MS starts a new one, so the next call has it. freshUrls waits for that read.
   */
  urls(): string[] {
    void this.readServe();
    const settings = this.deps.settings.get().pwa;
    const port = this.deps.port();
    return reachableUrls({ port, bind: settings.bind, interfaces: this.deps.interfaces, https: serveUrls(this.serve.json, port) });
  }

  async freshUrls(): Promise<string[]> {
    await this.readServe();
    return this.urls();
  }

  /** Reads `tailscale serve status` when the last read is older than SERVE_CACHE_MS (concurrent callers share one read). */
  private readServe(): Promise<void> {
    if (this.deps.clock.now() - this.serve.at < SERVE_CACHE_MS) return Promise.resolve();
    this.reading ??= (this.deps.serveStatus ?? readServeStatus)().catch(() => undefined)
      .then((json) => { this.serve = { at: this.deps.clock.now(), json }; })
      .finally(() => { this.reading = undefined; });
    return this.reading;
  }

  async state(): Promise<PwaState> {
    const urls = await this.freshUrls();
    const secure = urls[0]?.startsWith('https://') ?? false;
    const names = new Map(this.devices.list({ kinds: ['phone', 'browser'] }).map((device) => [device.id, device.name]));
    const subscribed = this.deps.push.subscribedDevices();
    for (const sub of heldSubs(this.deps.db)) if (sub.deviceId) subscribed.add(sub.deviceId); // B-087: held from my other PCs
    const key = await this.vapidKey();
    return {
      enabled: true, // D5: no switch; kept in the shape for 0.3.x readers
      urls,
      secure,
      devices: this.tokens.devices().map((entry) => ({
        id: entry.deviceId, name: names.get(entry.deviceId) ?? entry.name ?? 'Browser', createdAt: entry.createdAt, lastSeenAt: entry.lastUsedAt,
        notifications: subscribed.has(entry.deviceId),
      })),
      pushReady: key.ready,
      vapidPublicKey: key.publicKey,
    };
  }

  /**
   * DEV5A: what the calling phone/browser needs to turn notifications on. `endpoint` (its current
   * PushManager subscription, when it has one) answers "is it stored here?" for exactly that
   * browser; without it a device asks whether the PC holds any subscription of its own. B-087: that endpoint held here
   * from another of my PCs for the same caller is on as well; the key stays this PC's own (a held one signs only there).
   */
  async pushConfig(scope: ClientScope | undefined, endpoint?: string): Promise<PushConfig> {
    const key = await this.vapidKey();
    const deviceId = callerDevice(scope);
    const held = Boolean(endpoint) && heldSubs(this.deps.db).some((sub) => sub.endpoint === endpoint && sub.deviceId === deviceId);
    return { pushReady: key.ready, vapidPublicKey: key.publicKey, subscribed: this.deps.push.isSubscribed(deviceId, endpoint) || held, reason: key.reason };
  }

  /** The VAPID key, or why push cannot work right now (the key unavailable). */
  private async vapidKey(): Promise<{ ready: boolean; publicKey?: string; reason?: string }> {
    try {
      return { ready: true, publicKey: await this.deps.push.publicKey() };
    } catch (error) {
      return { ready: false, reason: error instanceof VapidKeyUnavailable ? error.message : 'The PC could not prepare notifications.' };
    }
  }

  /**
   * pwa.enable (B-078, D5): only the bind moves. Access is the accepted device rows, so `enabled: false` turns nothing
   * off any more – the flag is written true and nothing reads it as a gate. Without a choice while only the loopback answers, the same network (as before).
   */
  async enable(input: { enabled: boolean; bind?: Settings['pwa']['bind'] }): Promise<PwaState> {
    const current = this.deps.settings.get().pwa;
    const unreachable = input.enabled && !input.bind && current.bind === 'localhost' && !phoneUrl(await this.freshUrls());
    this.deps.settings.update({ pwa: { enabled: true, bind: input.bind ?? (unreachable ? 'lan' : current.bind) } });
    return this.emit();
  }

  /**
   * One-time link + QR the phone opens, and its 6-digit code for an installed app (both 10 minutes, one use); the PWA
   * exchanges either via `exchange` (POST /rpc, method pwa.exchange) and then opens `route` (`&to=`). The address is the
   * best one a phone can reach; with only this PC's loopback there is none (UNREACHABLE).
   */
  async link(input: { name?: string; route?: string } = {}): Promise<{ url: string; qrDataUrl: string; expiresAt: number; code: string }> {
    const base = phoneUrl(await this.freshUrls());
    if (!base) throw new WorkforceError('conflict', UNREACHABLE);
    const { secret, expiresAt } = this.tokens.createLink({ name: input.name });
    const code = this.codes.issue(hashToken(secret), expiresAt);
    const to = isPhoneRoute(input.route) ? `&to=${encodeURIComponent(input.route)}` : '';
    const url = `${base}/#pair=${secret}${to}`;
    return { url, qrDataUrl: await this.deps.qr(url), expiresAt, code };
  }

  /** Consumes a pairing secret or its 6-digit code, registers the browser as a client device and returns its token. */
  exchange(secret: string, input: { name?: string; kind?: 'phone' | 'browser'; publicKey?: string } = {}): { token: string; deviceId: string } {
    // A phone app over the meeting server pairs with its own device key (rendezvous/phone.ts): it is pinned by that key.
    const key = input.publicKey === undefined ? undefined : fromB64url(input.publicKey);
    if (key && key.length !== 32) throw new WorkforceError('bad_request', 'Not a device key.');
    const digits = secret.replace(/[\s-]/g, '');
    const typed = /^\d{6}$/.test(digits);
    const hash = typed ? this.codes.redeem(digits) : hashToken(secret);
    if (!hash) throw new WorkforceError('forbidden', 'This code is wrong or has expired.');
    const now = this.deps.clock.now();
    const deviceId = newId('dev', now);
    const issued = this.tokens.exchangeHash(hash, deviceId, input.name?.slice(0, 60));
    if (!issued) throw new WorkforceError('forbidden', typed ? 'This code was already used.' : 'This link has expired or was already used.');
    const record = this.devices.upsert({
      id: deviceId, name: issued.name ?? (input.kind === 'browser' ? 'Browser' : 'Phone'), kind: input.kind ?? 'phone', role: 'client',
      fingerprint: key ? fingerprintOf(key) : sha256(deviceId).toString('hex'), ...(key ? { publicKey: input.publicKey } : {}),
      addresses: [], caps: {}, status: 'online', self: false, pairedAt: now, lastSeenAt: now,
    });
    this.deps.bus.emit('device.upserted', publicDevice(record));
    void this.emit();
    return { token: issued.token, deviceId };
  }

  /**
   * A phone accepted here by Remote ID and code: stored as a phone with its key (pinned at the meeting server), its token.
   * F1: with `personId` (an employee's phone, picked on Accept) it gets that person's token – the one a person's join
   * issues (people/tokens.ts) – under its own device id, and its row carries the person; without one it is my own phone.
   * An earlier pairing of the same key here ends, so one phone never holds two accesses.
   */
  pairPhone(input: { id: string; name: string; publicKey: string; personId?: string }): { token: string; deviceId: string; person?: string } {
    const key = fromB64url(input.publicKey);
    if (key.length !== 32) throw new WorkforceError('bad_request', 'Not a device key.');
    const fingerprint = fingerprintOf(key);
    const person = input.personId ? this.employee(input.personId) : undefined;
    const known = this.devices.get(input.id);
    if (!person && known && !known.revokedAt && known.fingerprint !== fingerprint) throw new WorkforceError('conflict', 'Another device already uses this id.');
    const now = this.deps.clock.now();
    const name = input.name.slice(0, 60) || 'Phone';
    const issued = person ? new PersonTokens(this.deps.db, this.deps.clock).issue(person.id, name) : undefined;
    const id = issued?.deviceId ?? input.id;
    const earlier = this.devices.byFingerprint(fingerprint);
    if (earlier && earlier.kind === 'phone' && earlier.id !== id) void this.revoke(earlier.id);
    const record = this.devices.upsert({
      id, name, kind: 'phone', role: 'client', fingerprint, publicKey: input.publicKey,
      addresses: [], caps: {}, status: 'online', self: false, pairedAt: now, lastSeenAt: now, ...(person ? { personId: person.id } : {}),
    });
    if (person) { // as people/service.ts admit: the person is in now
      const people = new PeopleRepo(this.deps.db);
      people.save({ ...person, status: 'active', joinedAt: person.joinedAt ?? now, updatedAt: now });
      people.audit(person.id, now, HUMAN_ID, 'joined', { deviceId: id, device: name });
    }
    const token = issued?.token ?? this.tokens.issueDevice(id, name);
    this.deps.bus.emit('device.upserted', publicDevice(record));
    void this.emit();
    return { token, deviceId: id, ...(person ? { person: person.name } : {}) };
  }

  /** The employee a phone is accepted for; undefined for me (the owner); refused when that person has no access. */
  private employee(personId: string): Person | undefined {
    if (personId === HUMAN_ID) return undefined;
    const person = new PeopleRepo(this.deps.db).get(personId);
    if (!person || person.status === 'revoked') throw new WorkforceError('forbidden', 'This person no longer has access.');
    return person.owner ? undefined : person;
  }

  /**
   * A removed phone/browser (its token or device revoked) – the transport closes with 4403 instead
   * of 4401, so the phone shows "This phone was removed".
   */
  revoked(token: string): boolean {
    if (this.tokens.isRevoked(token)) return true;
    const scope = this.tokens.authenticate(token);
    if (scope?.kind !== 'device') return false;
    return Boolean(this.devices.get(scope.deviceId)?.revokedAt);
  }

  /** Transport hook: device token → scope (undefined = reject: unknown, revoked or removed); linked PCs use /peer. */
  authenticate(token: string): ClientScope | undefined {
    const scope = this.tokens.authenticate(token);
    if (scope?.kind === 'device') {
      const device = this.devices.get(scope.deviceId);
      if (!device || device.revokedAt) return undefined;
      this.devices.patch(device.id, { lastSeenAt: this.deps.clock.now() });
    }
    return scope;
  }

  async revoke(deviceId: string): Promise<void> {
    this.tokens.revokeDevice(deviceId);
    this.deps.push.removeDevice(deviceId);
    const record = this.devices.patch(deviceId, { status: 'revoked', revokedAt: this.deps.clock.now() });
    if (record) this.deps.bus.emit('device.upserted', publicDevice(record));
    await this.emit();
  }

  pushSubscribe(subscription: unknown, scope?: ClientScope): void {
    if (scope?.kind === 'person') { // a person's device: only a browser vendor's push service, a few per device
      if (!isPushServiceEndpoint(parseSubscription(subscription).endpoint)) throw new WorkforceError('bad_request', 'Notifications need the browser\'s own push service.');
      this.deps.push.subscribeKeeping(subscription, scope.deviceId, PERSON_SUBSCRIPTIONS_PER_DEVICE);
    } else {
      this.deps.push.subscribe(subscription, callerDevice(scope));
    }
    void this.emit(); // the owner sees "Notifications on" for that phone
  }

  /** Removes only the caller's own subscription(s); returns how many were removed. */
  pushUnsubscribe(scope: ClientScope | undefined, endpoint?: string): number {
    const removed = this.deps.push.unsubscribe(callerDevice(scope), endpoint);
    if (removed) void this.emit();
    return removed;
  }

  /** Notification channel for the NotificationService (it filters kinds and quiet hours; `silent`: its Sound off). */
  async pushNotify(message: PushMessage & { silent?: boolean }): Promise<number> {
    return this.deps.push.send(message, { silent: message.silent === true });
  }

  private async emit(): Promise<PwaState> {
    const state = await this.state();
    this.deps.bus.emit('pwa.updated', state);
    return state;
  }
}
