// AccountService: unlimited accounts per provider, each with an isolated CLI home (<accounts>/<provider>/<id>
// for Codex, Claude Code and Kimi Code – cli-homes.ts), an encrypted API key reference or a key from this PC's
// environment (connect.ts, env-keys.ts – read in-process when needed, never stored); detection and
// adoption (adoption.ts; removed detected logins stay dismissed until "Add again", dismissed.ts),
// official-CLI login/logout (sign-in.ts – Copilot CLI and Kimi Code in a terminal window), limits, candidates per
// engine and model, usage and turn-reported states.
// PR8: Gemini CLI and Copilot CLI are ACP plans, one per PC in the CLI's default home (acp-plans.ts);
// Kimi Code (B-044) is an ACP plan with its own homes like Codex (cli-homes.ts, KIMI_CODE_HOME);
// acpLaunch is the ACP engine's resolver, sharing the launches (`--help` read once) with detection.
// B-044: Codex banked resets (resets.ts, accounts.useReset) and the API key form's Test before
// saving (endpoint-test.ts, accounts.test – the typed key only in memory for that call).
// Every CLI the service starts (scan, sign-ins) runs in the empty engine folder, never the process cwd;
// Copilot CLI's sign-in window, an agent itself, in a new folder below temp each time (sign-in.ts).
// Plan readings stay current through its AccountMonitor (monitor.ts), whose serial queue runs every check.
// 01.11.2026: older 'decision' and model data accounts are moved to normal connections at the start (legacy.ts).
// B-051: adding a Codex/Claude Code plan installs its missing CLI first (install.ts; a failed install creates
// nothing); add()/login({ page }) hand back the sign-in page the CLI printed (sign-in.ts, never stored); a plan
// that cannot run agents (Claude Free, cli.ts planBlocked) is 'error' even from a background check.
// B-066: API connections live in settings.json's `providers` section (provider-file.ts): an entry is an account with its
// id, the table keeps its state and limits; add, rename and remove go through the file. Plans stay detected.
// Its input and dependency shapes and the provider labels: service-shape.ts.
// A plan's login files travel between the CEO's own PCs in devices/sync/logins.ts (not here); a sign-out here marks the
// plan (cli-homes.ts signedOut), so no login from a linked PC – nor the default home's (retake) – signs it in again.
// Every Codex account runs in a home of its own: one found in the default home runs on a copy of that login (cli-homes.ts
// found – also, once, for an account from before), and when that copy is signed out while the default home holds a newer
// login of the same person, it takes that one again before it counts as signed out.
// B-091: a check that finds a working Codex/Claude Code plan signed out reports it like a turn would (failure.ts
// reportSignedOut → the sign-in work, relogin.ts); login/add `away` and loginCode let the person finish it on the phone.
// 16.11.2026: a plan's home lives once per PC in its logins folder, shared by every company there (cli-homes.ts): a login
// made in another company is adopted at the next detect (adoption.ts), remove drops only this company's row, a sign-out
// signs the login out for all of them (the mark is the home's, so another company's check does not report it as
// unexpected).
// 21.11.2026: one login, one plan – two rows of the same login merge into one on this PC (twins.ts), at the start and on every
// account change.
// Owns: the accounts table (via AccountRepo) and account.upserted / account.removed / usage.updated.
// Never: reads provider tokens itself (cli-homes.ts and logins.ts copy login files), stores key values (SecretService does),
// deletes a plan's home, or rotates mid-turn.

import os from 'node:os';
import type { AccountService as AccountServiceContract } from '../contracts.ts';
import { DECISION_PROVIDER, MEDIA_ONLY_PROVIDERS, type Account, type AccountLimits, type DetectionReport, type EngineId, type ProviderId, type UsageSummary } from '../../shared/model/providers.ts';
import { AccountRepo } from './repo.ts';
import { detect as scan } from './detect.ts';
import { engineFor, selectCandidates } from './candidates.ts';
import { mergeLimits } from './limits.ts';
import { AccountMonitor } from './monitor.ts';
import { installCli } from './install.ts';
import { SignIns } from './sign-in.ts';
import { planBlocked } from './cli.ts';
import { envKey } from './env-keys.ts';
import { connection, handleId, vaultId } from './connect.ts';
import { DismissedLogins, dismissalKeys, serverKey } from './dismissed.ts';
import { ProviderFile } from './provider-file.ts';
import { Adoption, CLI_PROVIDERS } from './adoption.ts';
import { AcpPlans } from './acp-plans.ts';
import { CliHomes, defaultHome, loginFiles, signedOut, whoseLogin } from './cli-homes.ts';
import { loginIn } from './login-file.ts';
import { twinMerges, type HomeLogin } from './twins.ts';
import { AcpLaunches, acpProvider } from '../engines/acp/providers.ts';
import { Resets } from './resets.ts';
import { testEndpoint, type EndpointTestInput } from './endpoint-test.ts';
import { mediaKeyState } from '../media/providers/key-check.ts'; // B-058 i1
import { reportSignedOut } from './failure.ts';
import { isPlanProvider } from '../../shared/model/plan-roles.ts';
import { PROVIDER_LABELS, type AccountServiceDeps, type AddAccountInput } from './service-shape.ts';
import type { AwaySignIn, ResetOutcome } from '../../shared/api/methods-providers.ts';
import type { AcpLaunch } from '../engines/acp/process.ts';
import { engineCwd } from '../system/paths.ts';
import { newId } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { creditsPossible, extraUsageOf } from '../../shared/model/charge.ts';

export type { SecretPort } from './connect.ts';
export type { AccountServiceDeps, AddAccountInput } from './service-shape.ts';

export class AccountServiceImpl implements AccountServiceContract {
  private readonly deps: AccountServiceDeps;
  private readonly repo: AccountRepo;
  private readonly dismissed: DismissedLogins;
  private readonly adoption: Adoption;
  private readonly signIns: SignIns;
  private readonly acp: AcpPlans;
  private readonly homes: CliHomes;
  private readonly launches: AcpLaunches;
  private readonly resets: Resets;
  /** settings.json's connections (absent without a settings service: tests). */
  private readonly file?: ProviderFile;
  /** Set when the constructor is through: its own sync checks nothing (the engines come later; the monitor reads every account). */
  private checking = false;
  /** Throwaway account id → the typed key while an endpoint test runs (endpoint-test.ts). */
  private readonly testKeys = new Map<string, string>();
  private disposed = false; // set by dispose(): a check that ends during shutdown stores nothing
  /** Accounts the person is signing out of right now (logout()). */
  private readonly signingOut = new Set<string>();
  /** Accounts that took the default home's newer login and wait for the check that reads it: their sign-out reports are stale. */
  private readonly retaking = new Set<string>();
  private merging = false;
  /** Keeps plan readings current (started by the runtime; explicit calls work without it). */
  readonly monitor: AccountMonitor;

  constructor(deps: AccountServiceDeps) {
    this.deps = deps;
    this.repo = new AccountRepo(deps.db);
    this.dismissed = new DismissedLogins(deps.db, () => this.now());
    this.monitor = new AccountMonitor({ accounts: this, bus: deps.bus, clock: deps.clock, log: deps.log });
    const { data, temp } = deps.paths;
    const cwd = data ? engineCwd({ data }) : temp ?? os.tmpdir(); // never the process cwd, where project config could apply
    this.signIns = new SignIns({
      finder: deps.finder, supervisor: deps.supervisor, env: deps.env, now: () => this.now(), terminal: deps.terminal, cwd,
      agentRoot: temp ?? os.tmpdir(), mkdir: deps.mkdir, urlWaitMs: deps.signInUrlMs, // Copilot CLI's window: a new folder each time, never the engine folder
      label: (provider) => PROVIDER_LABELS[provider] ?? provider, check: (id) => this.monitor.checkNow(id), state: (id) => this.repo.get(id)?.state,
    });
    this.launches = new AcpLaunches({ finder: deps.finder, supervisor: deps.supervisor, cwd, env: deps.env, promptDir: deps.enginePrompts }); // B-049 F3
    const store = {
      repo: this.repo, dismissed: this.dismissed, save: (account: Account) => this.save(account), blank: (provider: ProviderId, patch: Partial<Account>) => this.blank(provider, patch),
    };
    this.homes = new CliHomes({ ...store, accounts: deps.paths.accounts, env: deps.env, homeDir: deps.homeDir, login: (id, away) => this.login(id, { page: true, away }), require: (id) => this.require(id), mkdir: deps.mkdir });
    this.adoption = new Adoption({
      ...store, found: (account) => this.homes.found(account), shared: () => this.homes.shared(), checkOnce: (id) => this.monitor.checkOnce(id), env: () => this.env(), now: () => this.now(), demo: deps.demo,
      scan: () => scan({ finder: deps.finder, supervisor: deps.supervisor, env: deps.env, now: () => this.now(), cwd, launches: this.launches, version: deps.version, ...deps.detectDeps }),
    });
    this.acp = new AcpPlans({ ...store, check: (id) => this.monitor.checkNow(id), signIns: this.signIns, engine: () => this.deps.engines().get('acp') });
    this.resets = new Resets({ get: (id) => this.repo.get(id), engine: () => this.deps.engines().get('codex'), check: (id) => this.monitor.checkNow(id) });
    if (deps.settings) {
      this.file = new ProviderFile({
        ...store, db: deps.db, settings: deps.settings, now: () => this.now(), forget: (account) => this.forget(account),
        check: (id) => { if (this.checking) void this.monitor.checkNow(id); },
      });
      this.file.sync();
      deps.bus.on('settings.updated', () => this.file!.sync());
      this.checking = true;
    }
    this.mergeTwins(); // an installation from before may hold them already
    deps.bus.on('account.upserted', (account) => { if (account.auth === 'cli' && account.email) this.mergeTwins(); });
  }

  /** One login, one plan (twins.ts): a twin row goes on this PC only, the kept one runs on the home with the newest login. */
  private mergeTwins(): void {
    if (this.merging) return;
    this.merging = true;
    try {
      for (const { keep, home, drop } of twinMerges(this.repo.list(), (account) => this.held(account))) {
        for (const twin of drop) this.forget(twin, keep.id);
        if (home !== keep.home) this.save({ ...this.require(keep.id), home });
      }
    } catch (error) { this.deps.log?.warn('plan twins not merged', { error: String(error) }); }
    finally { this.merging = false; }
  }

  private held(account: Account): HomeLogin {
    const home = account.home ?? defaultHome(account.provider, this.env(), this.deps.homeDir ?? os.homedir());
    const file = loginFiles(account.provider)[0];
    if (!home || !file) return { at: 0 };
    const who = whoseLogin(account.provider, home);
    return { ...(who ? { who } : {}), at: loginIn(account.provider, home, file)?.at ?? 0 };
  }

  /** The ACP engine's resolver (createEngineRegistry `acp`): the agent an ACP plan account starts; undefined when its CLI is missing. */
  readonly acpLaunch = (account: Account): Promise<AcpLaunch | undefined> => this.launches.resolve(account);

  private now(): number { return this.deps.clock.now(); }
  private env(): NodeJS.ProcessEnv { return this.deps.env ?? process.env; }

  list(): Account[] { return this.repo.list(); }
  get(id: string): Account | undefined { return this.repo.get(id); }

  private require(id: string): Account {
    const account = this.repo.get(id);
    if (!account) throw new WorkforceError('not_found', 'This account does not exist.');
    return account;
  }

  private save(account: Account): Account {
    this.homes.note(account); // the home's note names the login's e-mail: another company adopts it by that
    this.repo.save(account);
    this.deps.bus.emit('account.upserted', account);
    return account;
  }

  /** Also checks terminal sign-ins whose window may still be open (Settings asks when the person comes back). */
  async detect(force = false): Promise<DetectionReport> {
    await this.signIns.recheck();
    return this.adoption.detect(force);
  }

  /** 17.11.2026: "Use" for a plan login on offer (DetectionReport.found) – only now it is an account here, used and shared to this company's PCs. */
  useFound(key: string, options: { thisPcOnly?: boolean } = {}): Promise<Account> { return this.adoption.useFound(key, options.thisPcOnly ?? true); }

  /** "Not here": the offered plan login stays on the PC and unused in this company. */
  declineFound(key: string): Promise<void> { return this.adoption.declineFound(key); }

  /** The last detection's report without a new scan (RT7: readers that follow every rescan), dismissed entries marked; undefined before the first. */
  lastDetection(): DetectionReport | undefined { return this.adoption.cached(); }

  private blank(provider: ProviderId, patch: Partial<Account>): Account {
    const accounts = this.repo.list();
    const samePriority = accounts.filter((a) => a.provider === provider).length;
    return {
      id: newId('acc', this.now()), provider, label: PROVIDER_LABELS[provider] ?? provider, auth: 'none', state: 'unknown',
      priority: samePriority, enabled: true, detected: false, createdAt: this.now(), ...patch,
    };
  }

  /** `signInUrl` (Codex, Claude Code): the sign-in page the CLI printed within a few seconds – handed back, never stored; `away`: see login(). */
  async add(input: AddAccountInput, options: { away?: boolean } = {}): Promise<Account & { signInUrl?: string } & AwaySignIn> {
    const provider = input.provider;
    if (!PROVIDER_LABELS[provider]) throw new WorkforceError('bad_request', 'Choose a supported provider.');
    if (input.detected) return this.adoption.addAgain(provider, PROVIDER_LABELS[provider]!);
    const same = this.repo.list().filter((a) => a.provider === provider);
    const label = input.label?.trim().slice(0, 80) || (same.length ? `${PROVIDER_LABELS[provider]} ${same.length + 1}` : PROVIDER_LABELS[provider]!);
    // Kimi Code has a home variable: each added account gets its own home like Codex (cli-homes.ts).
    if (AcpPlans.handles(provider) && !acpProvider(provider)?.home && input.envVar === undefined) return this.acp.add(provider, label);
    if (CLI_PROVIDERS.has(provider) && input.envVar === undefined) {
      if (provider === 'codex' || provider === 'claude') await this.ensureCli(provider); // B-051 L3: install first, else nothing is created
      return this.homes.add(provider, input.label?.trim() ? label : undefined, label, options.away === true);
    }
    const connected = await connection({ ...input, label }, { env: this.env(), secrets: this.deps.secrets });
    const found = connected.auth === 'env' ? same.find((a) => a.auth === 'env' && a.envVar === connected.envVar) : undefined;
    if (found) return found; // one account per environment variable
    if (connected.auth === 'local' && connected.baseUrl) this.dismissed.delete(serverKey(provider, connected.baseUrl)); // added by hand again
    if (this.file && connected.auth !== 'env' && !input.demoEngine) return this.file.add({ provider, label }, connected);
    const account = this.save(this.blank(provider, { ...connected, label, ...(input.demoEngine ? { detected: true } : {}) }));
    void this.monitor.checkNow(account.id); // in the monitor's serial queue
    return account;
  }

  /** `credits` (B-083): the account holds a plan's monthly API credits – charged and routed like a plan (shared/model/charge.ts). */
  update(id: string, patch: Partial<Pick<Account, 'label' | 'priority' | 'enabled' | 'credits' | 'extraUsage' | 'thisPcOnly'>>): Account {
    const account = this.require(id);
    const next: Account = { ...account };
    if (typeof patch.label === 'string' && patch.label.trim()) {
      next.label = patch.label.trim().slice(0, 80);
      if (this.file?.has(id)) this.file.rename(id, next.label);
    }
    if (typeof patch.priority === 'number' && Number.isFinite(patch.priority)) next.priority = Math.round(patch.priority);
    if (patch.credits === true) {
      // a mark elsewhere would book real pay-per-use spend as "plan, no charge"
      if (!creditsPossible(account)) throw new WorkforceError('bad_request', 'Plan credits come with an Anthropic, OpenAI or OpenAI-compatible key (a subscription such as Qwen Token Plan).');
      next.credits = true;
    } else if (patch.credits === false) delete next.credits;
    // 17.11.2026: a plan may go on past its limit on the provider's extra usage (billed by the provider) – the person's switch, off by default
    if (patch.extraUsage === true) {
      const can = extraUsageOf(account);
      if (!can.ok) throw new WorkforceError('bad_request', can.why);
      next.extraUsage = true;
    } else if (patch.extraUsage === false) delete next.extraUsage;
    // 17.11.2026: a plan login stays on this PC, or goes to all PCs of the company (the other PCs drop it when it comes back here only)
    if (typeof patch.thisPcOnly === 'boolean') {
      if (account.auth !== 'cli') throw new WorkforceError('bad_request', 'Only a plan login can stay on this PC.');
      if (patch.thisPcOnly) next.thisPcOnly = true; else delete next.thisPcOnly;
    }
    if (typeof patch.enabled === 'boolean') { next.enabled = patch.enabled; if (!patch.enabled) next.state = 'disabled'; else if (next.state === 'disabled') next.state = 'unknown'; }
    const saved = this.save(next);
    // switched back on: checked again at once ('unknown' until the check answers – Settings says "Checking…")
    if (account.state === 'disabled' && saved.enabled) void this.monitor.checkNow(id);
    return saved;
  }

  /**
   * Starts the official sign-in under the account's home (Codex/Claude/Gemini CLI open the browser, Copilot CLI/Kimi Code a terminal).
   * `page` (B-051 L4, only for the person's own UI – accounts.login/add): also the sign-in page the CLI printed. Agent tools
   * never ask for it: their output is stored with the run, and the page must stay in memory.
   * B-091 `away`: the person started it on their phone and finishes it there (Codex: `code`, Claude Code: `paste` → loginCode).
   */
  async login(id: string, options: { page?: boolean; away?: boolean } = {}): Promise<{ started: boolean; url?: string } & AwaySignIn> {
    const account = this.require(id);
    const result = AcpPlans.handles(account.provider) ? await this.acp.login(account) : await this.signIns.login(account, options.page === true, options.away === true);
    this.homes.started(account);
    return result;
  }

  /** B-091: the code the Claude sign-in page showed the person, into the running away sign-in; ok = the account works now. */
  async loginCode(id: string, code: string): Promise<{ ok: boolean }> {
    this.require(id);
    return this.signIns.code(id, code);
  }

  /**
   * Signs out through the CLI (Codex, Claude Code); ACP plans have none Workforce could start. A home of its own is the
   * login's on this PC, so this signs it out for every company using it; it stays signed out: no login from a linked PC comes back.
   */
  async logout(id: string): Promise<void> {
    const account = this.require(id);
    if (AcpPlans.handles(account.provider)) this.acp.logout(account);
    this.signingOut.add(id); // a check meanwhile sees the CLI signed out: the person's own, no sign-in work (check)
    try {
      if (await this.signIns.logout(account) === 'window') return;
      signedOut.mark(this.deps.db, account, this.now());
      this.save({ ...this.require(id), state: 'needs_login', limits: undefined, email: undefined, plan: undefined });
    } finally { this.signingOut.delete(id); }
  }

  /** Drops this company's row; a plan's home stays – it is the login's, which other companies on this PC may use (it is dismissed here). */
  async remove(id: string): Promise<void> {
    const account = this.require(id);
    if (this.file?.has(id)) { this.file.remove(id); return; } // the file's sync takes the account out; its key stays in the catalog
    await this.signIns.cancel(id);
    // the account's own typed key goes with it; a catalog entry it only names (a handle) stays the person's
    if (account.secretId && !handleId(account.secretId)) { try { this.deps.secrets.remove(account.secretId); } catch { /* already gone */ } }
    this.forget(account);
  }

  /** `twinOf`: the row that stays for this login (mergeTwins) – no linked PC loses its row. */
  private forget(account: Account, twinOf?: string): void {
    this.resets.forget(account.id);
    this.repo.remove(account.id);
    for (const key of dismissalKeys(account)) this.dismissed.add(key); // detection must not add it back (a twin's login is the kept row's); "Add again" undoes this
    this.deps.bus.emit('account.removed', { id: account.id, ...(twinOf ? { twinOf } : {}) });
  }

  async install(provider: 'claude' | 'codex'): Promise<void> {
    await installCli(provider, { supervisor: this.deps.supervisor, finder: this.deps.finder, env: this.deps.env, demo: this.deps.demo });
    await this.detect(true);
  }

  /** B-051 L3: the plan's CLI before its account – throws the install error (nothing created); a fresh install rescans in the background. */
  private async ensureCli(provider: 'claude' | 'codex'): Promise<void> {
    const installed = await installCli(provider, { supervisor: this.deps.supervisor, finder: this.deps.finder, env: this.deps.env, demo: this.deps.demo });
    if (installed) void this.detect(true).catch(() => undefined);
  }

  useReset(id: string, creditId?: string): Promise<ResetOutcome> { return this.resets.use(id, creditId); }

  test(input: EndpointTestInput): Promise<{ models: string[] }> {
    return testEndpoint(input, { engine: (id) => this.deps.engines().get(id), keys: this.testKeys, secrets: this.deps.secrets, now: () => this.now(), demo: this.deps.demo });
  }

  candidates(engine: EngineId, model?: string): Account[] {
    return selectCandidates(this.repo.list(), engine, this.now(), model);
  }

  markLimited(id: string, until: number, limits?: AccountLimits): void {
    const account = this.repo.get(id);
    if (!account) return;
    this.save({ ...account, state: 'cooling', coolingUntil: until, limits: limits ? mergeLimits(account.limits, limits) : account.limits });
    this.monitor.publish();
  }

  /** A turn found the account signed out ('needs_login') or its CLI missing ('error'); true when that changed its state. */
  markUnavailable(id: string, state: 'needs_login' | 'error'): boolean {
    const account = this.repo.get(id);
    if (!account || !account.enabled || account.state === state) return false;
    // a stopping runtime (quit, update install) records no sign-out: its CLIs fail while the installer replaces files – on
    // 23.11.2026 a quit that hung for minutes marked all four plans signed out and gave the person sign-in to-dos (0.3.19)
    if (this.disposed) return false;
    if (state === 'needs_login' && this.retaking.has(id)) return false; // the newer login is in place; its check decides
    if (state === 'needs_login' && this.retake(account)) { this.retaking.add(id); void this.monitor.checkNow(id); return false; } // the default home's newer login
    this.save({ ...account, state });
    this.monitor.publish();
    return true;
  }

  updateLimits(id: string, limits: AccountLimits): void {
    const account = this.repo.get(id);
    if (!account) return;
    const next: Account = { ...account, limits: mergeLimits(account.limits, limits) };
    if (account.state === 'cooling' && (account.coolingUntil ?? 0) <= this.now()) { next.state = 'ok'; next.coolingUntil = undefined; }
    this.save(next);
    this.monitor.publish();
  }

  /**
   * Runs the engine's official status check and stores state/plan/email/limits; readings the check
   * did not return stay. `background` (the monitor): a check that failed ('error') changes nothing;
   * `details`: Codex reads its banked resets' credit details too (else the count, monitor.ts).
   * An environment key that is not set is 'needs_login'; a set one without an engine (model data) is 'ok'.
   */
  async check(id: string, background = false, details = false): Promise<Account> {
    const account = this.require(id);
    const env = account.auth === 'env' && account.enabled ? envKey(account, this.env()) !== undefined : undefined;
    if (env === false) return this.save({ ...account, state: 'needs_login', checkedAt: this.now() });
    const engine = this.deps.demo && account.provider === 'compatible' ? 'fake' : engineFor(account.provider);
    const mediaKey = account.enabled && account.auth === 'api_key' && Boolean(account.secretId) && MEDIA_ONLY_PROVIDERS.includes(account.provider); // B-058: no engine
    if (mediaKey) { // B-058 i1: one free authenticated GET of the provider (media/providers/key-check.ts); unknown keeps a rejected key rejected, else 'ok'
      const state = await mediaKeyState(account, () => this.deps.secrets.read(vaultId(account.secretId!)), this.deps.detectDeps?.fetch);
      const fresh = this.require(id);
      return this.disposed ? fresh : this.save({ ...fresh, state: fresh.enabled ? state : 'disabled', checkedAt: this.now() });
    }
    // no engine: a set environment key, or a decision connection (accounts.try asks it one question), reads as connected
    if (!engine) return env || (account.provider === DECISION_PROVIDER && account.enabled) ? this.save({ ...account, state: 'ok', checkedAt: this.now() }) : account;
    const result = await this.deps.engines().get(engine).checkAccount(account, { details, background });
    if (this.disposed) return account; // shutdown: a check whose process was stopped stores nothing
    this.retaking.delete(id);
    const fresh = this.require(id);
    if (result.state === 'needs_login' && this.retake(fresh)) { this.retaking.add(id); void this.monitor.checkNow(id); return fresh; } // the default home's newer login, checked next
    if (background && result.state === 'error' && !planBlocked(result)) return fresh; // a plan that cannot run agents is a reading (B-051 L5)
    const cooling = fresh.coolingUntil !== undefined && fresh.coolingUntil > this.now();
    const next: Account = {
      ...fresh, state: !fresh.enabled ? 'disabled' : cooling && result.state === 'ok' ? 'cooling' : result.state,
      plan: result.plan ?? fresh.plan, email: result.email ?? fresh.email,
      limits: result.limits ? mergeLimits(fresh.limits, result.limits) : fresh.limits,
      coolingUntil: cooling ? fresh.coolingUntil : undefined, checkedAt: this.now(),
    };
    const saved = this.save(next);
    if (result.state === 'ok') signedOut.clear(this.deps.db, saved); // a login works here again: the sign-out mark ends
    // B-091: a plan that worked and is signed out now – the sign-in work, like a turn that met the sign-out (failure.ts);
    // not when the person signed it out (here, or in another company using the same home)
    const usable = fresh.state === 'ok' || fresh.state === 'cooling';
    const unexpected = !this.signingOut.has(id) && !signedOut.has(this.deps.db, saved);
    if (usable && saved.state === 'needs_login' && saved.auth === 'cli' && isPlanProvider(saved.provider) && unexpected) reportSignedOut({ accounts: this }, saved);
    return saved;
  }

  /** A found Codex login whose copy is signed out takes the default home's newer one (cli-homes.ts retake) – never after the person signed out here. */
  private retake(account: Account): boolean {
    return !this.signingOut.has(account.id) && !signedOut.has(this.deps.db, account) && this.homes.retake(account);
  }

  /** A check in the monitor's queue whose result shows – a login that arrived from a linked PC (devices/sync/logins.ts). */
  checkNow(id: string): Promise<void> { return this.monitor.checkNow(id); }

  /** Quota summaries; explicit refresh and activity share the automatic provider cadence (a window brought to the front is the person back: the working cadence, also while no turn runs). */
  async usage(refresh = false): Promise<UsageSummary[]> {
    if (refresh) await this.monitor.refreshAll();
    else this.monitor.activity(true);
    return this.monitor.summaries();
  }

  /** In-process only (HTTP engines, model data): the vault's key, or the environment variable's value at this moment. */
  async apiKey(id: string): Promise<string | undefined> {
    const tested = this.testKeys.get(id);
    if (tested !== undefined) return tested;
    const account = this.repo.get(id);
    if (account?.auth === 'env') return envKey(account, this.env());
    if (!account?.secretId) return undefined;
    return this.deps.secrets.read(vaultId(account.secretId));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.acp.dispose();
    await this.signIns.dispose();
  }
}
