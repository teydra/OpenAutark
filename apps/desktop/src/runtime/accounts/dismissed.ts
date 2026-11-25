// Dismissed detected logins (PR5): removing an account that detection would adopt again – a login
// in the default CLI home, a plan login in this PC's logins folder another company may still use (16.11.2026,
// accounts/cli-homes.ts) or a local model server – remembers it in kv (ns 'accounts', key 'dismissed'), so detection
// stops adding it back and the detection row offers "Add again" (a default-home login).
// Keys: '<provider>:default' for a default-home login, '<provider>:<home folder>' for a home of its own,
// '<provider>:<baseUrl>' for a local server.
// Owns: the dismissal keys and marking them in a DetectionReport. Never: touches accounts or homes.

import path from 'node:path';
import type { Db } from '../db/database.ts';
import { foundHere, type Account, type DetectionReport, type ProviderId } from '../../shared/model/providers.ts';
import { KvRepo } from '../store/kv.ts';
import type { SettingsService } from '../contracts.ts';
import { DECLINED_LOGINS_MAX } from '../settings/schema.ts';

const NS = 'accounts';
const KEY = 'dismissed';
const LOCAL_MAX = 100;

export const loginKey = (provider: ProviderId | DetectionReport['clis'][number]['provider']): string => `${provider}:default`;
export const serverKey = (provider: ProviderId, baseUrl: string): string => `${provider}:${baseUrl}`;
/** A home of its own by its folder (<accounts>/<provider>/<folder>). */
export const homeLoginKey = (provider: ProviderId, home: string): string => `${provider}:${path.basename(home)}`;

/** The keys detection would adopt this account by: its default-home login and its own home; none for accounts detection never adds. */
export function dismissalKeys(account: Pick<Account, 'provider' | 'auth' | 'home' | 'detected' | 'baseUrl'>): string[] {
  if (account.auth === 'cli') return [...(foundHere(account) ? [loginKey(account.provider)] : []), ...(account.home ? [homeLoginKey(account.provider, account.home)] : [])];
  return account.auth === 'local' && account.baseUrl ? [serverKey(account.provider, account.baseUrl)] : [];
}

/** The part of the settings service the company-wide "Not here" list needs (settings.preferences.declinedLogins). */
export type DeclinedStore = Pick<SettingsService, 'get' | 'update'>;

const strings = (value: unknown, max: number): string[] => (Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string').slice(-max) : []);

export class DismissedLogins {
  private readonly kv: KvRepo;
  private readonly now: () => number;
  private readonly settings?: DeclinedStore;

  /**
   * 25.11.2026 (Stanislaus 24.11., 0.3.20): "Not here" is the person's word for the whole company, not for one PC – it lives
   * in settings.preferences.declinedLogins, which the settings sync (devices/sync/settings.ts) already carries between the
   * person's PCs (no PC first, the last change wins), so the offer stays away on every PC and after a restart. Without a
   * settings service (tests) it stays in kv as before. What detection dismisses by itself (a removed account, a local server)
   * is this PC's own and stays in kv.
   */
  constructor(db: Db, now: () => number, settings?: DeclinedStore) {
    this.kv = new KvRepo(db);
    this.now = now;
    this.settings = settings;
  }

  /** What the company declined (settings, every PC's) – the keys the person said "Not here" to. */
  declined(): string[] {
    return strings(this.settings?.get().preferences.declinedLogins, DECLINED_LOGINS_MAX);
  }

  private local(): string[] { return strings(this.kv.get<unknown>(NS, KEY), LOCAL_MAX); }

  list(): string[] {
    return [...new Set([...this.local(), ...this.declined()])];
  }

  /** `everywhere`: the person's "Not here" – every PC of the company hears it (a settings unit); else this PC's own kv list. */
  add(key: string, everywhere = false): void {
    if (everywhere && this.settings) {
      this.settings.update({ preferences: { declinedLogins: [...this.declined().filter((entry) => entry !== key), key].slice(-DECLINED_LOGINS_MAX) } });
      return;
    }
    this.kv.set(NS, KEY, [...this.local().filter((entry) => entry !== key), key].slice(-LOCAL_MAX), this.now());
  }

  /** True when the key was dismissed (and is not any more) – on this PC and, for a "Not here", on every PC of the company. */
  delete(key: string): boolean {
    const local = this.local();
    const shared = this.declined();
    if (!local.includes(key) && !shared.includes(key)) return false;
    if (local.includes(key)) this.kv.set(NS, KEY, local.filter((entry) => entry !== key), this.now());
    if (shared.includes(key)) this.settings?.update({ preferences: { declinedLogins: shared.filter((entry) => entry !== key) } });
    return true;
  }

  /** The report with every dismissed login and server marked `dismissed`. */
  mark(report: DetectionReport): DetectionReport {
    const keys = new Set(this.list());
    if (!keys.size) return report;
    return {
      ...report,
      clis: report.clis.map((cli) => (keys.has(loginKey(cli.provider)) ? { ...cli, dismissed: true } : cli)),
      localServers: report.localServers.map((server) => (keys.has(serverKey(server.provider, server.baseUrl)) ? { ...server, dismissed: true } : server)),
    };
  }
}
