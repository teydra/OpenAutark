// Detection → accounts (split from service.ts): the cached DetectionReport (one scan at a time;
// dismissed entries marked; one that could not tell an installed CLI's login is scanned again on the
// next detect), what a scan found – running local servers become 'detected' accounts unless the person removed them
// (dismissed.ts) –, the checks a scan triggers, and the consent for a plan login.
// 17.11.2026 (Konrad task_bgykyzcx, after the owner's own Codex login on this PC was adopted at once and shared to every PC of
// the company): a plan login – one in a CLI's default home on this PC, or one another company on this PC made (its home in the
// PC's logins folder, cli-homes.ts sharedLogins) – is only OFFERED (DetectionReport.found); no account row exists, so nothing
// uses it and nothing syncs it, until the person says "Use" (useFound – the Codex login then runs on a copy in a home of its
// own, cli-homes.ts found, as before) or "Not here" (declineFound = the dismissal "Add again" undoes). Accounts that exist stay.
// Owns: the report cache, the offers and the consent steps. Never: scans itself (detect.ts), signs in or deletes, reads a token.

import { foundHere, type Account, type DetectionReport, type FoundLogin, type ProviderId } from '../../shared/model/providers.ts';
import { isPlanProvider } from '../../shared/model/plan-roles.ts';
import { WorkforceError } from '../../shared/errors.ts';
import path from 'node:path';
import type { AccountRepo } from './repo.ts';
import { homeLoginKey, loginKey, serverKey, type DismissedLogins } from './dismissed.ts';
import { envKey } from './env-keys.ts';
import { loginUnknown } from './detect.ts';
import { homeKey, sameEmail, type SharedLogin } from './cli-homes.ts';
import { PROVIDER_LABELS } from './service-shape.ts';

/** Providers whose logins live in a CLI home (default or <accounts>/<provider>/<id>; Gemini CLI and Copilot CLI only the default, PR8). */
export const CLI_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(['codex', 'claude', 'gemini-cli', 'copilot', 'kimi-cli']);

export interface AdoptionDeps {
  repo: AccountRepo;
  dismissed: DismissedLogins;
  /** Stores and announces an account (AccountService). */
  save(account: Account): Account;
  /** A new account row with the service's defaults (label, priority, id). */
  blank(provider: ProviderId, patch: Partial<Account>): Account;
  /** A found login as its account (cli-homes.ts CliHomes.found: Codex in a home of its own with a copy of the login). */
  found(account: Account): Account;
  /** This PC's plan logins in its logins folder, whichever company made them (cli-homes.ts sharedLogins). */
  shared(): SharedLogin[];
  /** One check in the account monitor's serial queue. */
  checkOnce(id: string): void;
  scan(): Promise<DetectionReport>;
  env(): NodeJS.ProcessEnv;
  now(): number;
  /** Demo/test mode: an empty report – real logins are never detected. */
  demo?: boolean;
}

export class Adoption {
  private readonly deps: AdoptionDeps;
  private report: DetectionReport | undefined;
  private detecting: Promise<DetectionReport> | undefined;

  constructor(deps: AdoptionDeps) { this.deps = deps; }

  /** The last scan's report (no scan), dismissed logins and servers marked like detect(); undefined before the first. */
  cached(): DetectionReport | undefined { return this.report && this.view(this.report); }

  /** The report as readers get it: dismissed entries marked and the plan logins on offer now (computed per read: a click changes them). */
  private view(report: DetectionReport): DetectionReport { return { ...this.deps.dismissed.mark(report), found: this.offers(report) }; }

  /**
   * The cached report (a new scan when forced, none yet, or the last one could not tell an installed
   * CLI's login – detect.ts loginUnknown, e.g. a status command that timed out), dismissed logins and servers marked.
   */
  async detect(force: boolean): Promise<DetectionReport> {
    if (this.report && !force && !loginUnknown(this.report)) return this.view(this.report);
    if (this.deps.demo) return (this.report = { clis: [], localServers: [], envKeys: [], found: [], checkedAt: this.deps.now() });
    if (!this.detecting) {
      this.detecting = this.deps.scan()
        .then((report) => { this.report = report; this.adopt(report); return report; })
        .finally(() => { this.detecting = undefined; });
    }
    return this.view(await this.detecting);
  }

  /**
   * Creates 'detected' accounts for running local servers (idempotent), except dismissed ones – a plan login is only offered
   * (`offers`), the person's word makes it an account. One check each (the monitor's queue): a detected login whose
   * sign-in changed outside Workforce (signed out → needs_login), an 'error' account whose CLI is
   * installed again and an environment key that is set again; a key that is gone is 'needs_login'.
   */
  adopt(report: DetectionReport): void {
    const { repo, dismissed } = this.deps;
    const existing = repo.list();
    const gone = new Set(dismissed.list());
    for (const cli of report.clis) {
      if (!CLI_PROVIDERS.has(cli.provider as ProviderId)) continue;
      const provider = cli.provider as ProviderId;
      const own = existing.find((a) => a.provider === provider && foundHere(a));
      const signInChanged = own?.enabled && cli.loggedIn !== undefined && cli.loggedIn === (own.state === 'needs_login');
      if (own && signInChanged) this.deps.checkOnce(own.id);
    }
    for (const server of report.localServers) {
      if (gone.has(serverKey(server.provider, server.baseUrl)) || existing.some((a) => a.provider === server.provider && a.baseUrl === server.baseUrl)) continue;
      this.deps.save(this.deps.blank(server.provider, { auth: 'local', baseUrl: server.baseUrl, state: 'ok', detected: true }));
    }
    const installed = new Set<string>(report.clis.filter((cli) => cli.path).map((cli) => cli.provider)); // a CLI missing at a failed turn may be back
    for (const account of existing.filter((a) => a.state === 'error' && a.enabled && installed.has(a.provider))) this.deps.checkOnce(account.id);
    for (const account of existing.filter((a) => a.auth === 'env' && a.enabled)) { // the variable may be gone or back since the last start
      const set = envKey(account, this.deps.env()) !== undefined;
      if (!set && account.state !== 'needs_login') this.deps.save({ ...account, state: 'needs_login' });
      else if (set && account.state === 'needs_login') this.deps.checkOnce(account.id);
    }
  }

  /** The plan logins on offer: those in a CLI's default home that are no account here, and those another company made (declined ones marked). */
  private offers(report: DetectionReport): FoundLogin[] {
    const rows = this.deps.repo.list();
    const gone = new Set(this.deps.dismissed.list());
    const out: FoundLogin[] = [];
    for (const cli of report.clis) {
      const provider = cli.provider as ProviderId;
      // a dismissed default-home login stays in `clis` with "Add again" (the person said no); a signed-out one is no login to use
      if (!CLI_PROVIDERS.has(provider) || !cli.loggedIn || gone.has(loginKey(provider)) || rows.some((a) => a.provider === provider && foundHere(a))) continue;
      out.push({ key: loginKey(provider), provider, where: 'this-pc' });
    }
    for (const login of this.deps.shared()) {
      if (login.signedIn === false || this.isMine(rows, login)) continue;
      const key = homeLoginKey(login.provider, login.home);
      out.push({ key, provider: login.provider, where: 'other-company', ...(login.email ? { email: login.email } : {}), ...(gone.has(key) ? { declined: true as const } : {}) });
    }
    return out;
  }

  /** A row here already uses that home or the same person's login (provider and e-mail), or has that id. */
  private isMine(rows: readonly Account[], login: SharedLogin): boolean {
    return rows.some((a) => (a.home && homeKey(a.home) === homeKey(login.home)) || (a.provider === login.provider && sameEmail(a.email, login.email)) || a.id === login.id);
  }

  /**
   * "Use": the offered login becomes an account here – a default-home one switched on and checked (a Codex login on a copy in a
   * home of its own), another company's one on its home, switched on and checked – one login, one home, every company.
   * A declined offer works too (the person changed their mind). Idempotent: a second click returns the account.
   * `thisPcOnly` (the person's choice; since 0.3.20 – Konrad #830, 24.11.2026: they are the person's own PCs – the default is
   * "On all my PCs", so false): true: the account and its login stay on this PC; false: they go to all PCs of the company.
   * Only a newly taken account gets this default; the ones that exist keep the choice they have.
   */
  async useFound(key: string, thisPcOnly = false): Promise<Account> {
    const offer = (await this.detect(false)).found?.find((entry) => entry.key === key);
    if (!offer) {
      const existing = this.deps.repo.list().find((a) => a.provider === key.split(':')[0] && (key.endsWith(':default') ? foundHere(a) : a.home !== undefined && path.basename(a.home) === key.slice(key.indexOf(':') + 1)));
      if (existing) return existing; // the same click came twice
      throw new WorkforceError('not_found', 'That sign-in is not offered any more.');
    }
    this.deps.dismissed.delete(key);
    if (offer.where === 'this-pc') return this.takeDefault(offer.provider, thisPcOnly);
    const login = this.deps.shared().find((entry) => homeLoginKey(entry.provider, entry.home) === key);
    if (!login) throw new WorkforceError('not_found', 'That sign-in is not on this PC any more.');
    return this.takeShared(login, thisPcOnly);
  }

  /** "Not here": the offered login is dismissed in this company, on all its PCs (it stays on the PC; "Add again" or a later "Use" brings it back). */
  async declineFound(key: string): Promise<void> {
    const offer = (await this.detect(false)).found?.find((entry) => entry.key === key);
    if (!offer) throw new WorkforceError('not_found', 'That sign-in is not offered any more.');
    this.deps.dismissed.add(key, true); // the person's word for the company: every PC hears it (settings.preferences.declinedLogins)
  }

  /** The default-home login as an account (the Codex one on a copy in a home of its own); the one that exists when there is one. */
  private takeDefault(provider: ProviderId, thisPcOnly = false): Account {
    const own = this.deps.repo.list().find((a) => a.provider === provider && foundHere(a));
    if (own) return own;
    const adopted = this.deps.save(this.deps.found(this.deps.blank(provider, { auth: 'cli', state: 'ok', detected: true, ...(thisPcOnly ? { thisPcOnly: true } : {}) })));
    if (isPlanProvider(provider)) this.deps.checkOnce(adopted.id);
    return adopted;
  }

  /** Another company's plan login on this PC as an account here (its id the home's folder name), switched on, then checked. */
  private takeShared(login: SharedLogin, thisPcOnly = false): Account {
    const rows = this.deps.repo.list();
    const existing = rows.find((a) => a.id === login.id || (a.home && homeKey(a.home) === homeKey(login.home)));
    if (existing) return existing;
    const same = rows.filter((a) => a.provider === login.provider).length;
    const label = PROVIDER_LABELS[login.provider]!;
    const adopted = this.deps.save({ ...this.deps.blank(login.provider, { auth: 'cli', state: 'unknown', home: login.home, label: same ? `${label} ${same + 1}` : label, ...(login.email ? { email: login.email } : {}), ...(thisPcOnly ? { thisPcOnly: true } : {}) }), id: login.id });
    this.deps.checkOnce(adopted.id);
    return adopted;
  }

  /** "Add again": the dismissed default-home login becomes an account again if this PC still has it (the person's click). */
  async addAgain(provider: ProviderId, label: string): Promise<Account> {
    if (!CLI_PROVIDERS.has(provider)) throw new WorkforceError('bad_request', 'Only a sign-in found on this PC can be added again.');
    this.deps.dismissed.delete(loginKey(provider));
    const signedIn = (report: DetectionReport | undefined) => report?.clis.some((cli) => cli.provider === provider && cli.loggedIn) === true;
    const report = signedIn(this.report) ? this.report! : await this.detect(true);
    if (!signedIn(report)) throw new WorkforceError('not_found', `No ${label} sign-in was found on this PC.`);
    return this.takeDefault(provider);
  }
}
