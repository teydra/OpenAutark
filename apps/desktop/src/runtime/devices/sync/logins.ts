// Plan logins between the CEO's own PCs (mesh method 'sync.login': sign in on one PC, the plan works on all of his): the files that hold a CLI plan's login (accounts/cli-homes.ts loginFiles – Codex auth.json,
// Claude Code .credentials.json, Gemini CLI oauth_creds.json and google_accounts.json) are read at send time and
// travel only inside the encrypted, key-pinned mesh channel, like secret values (secrets.ts). One unit per account:
// its files and the login's own time (Codex last_refresh, Claude Code's and Gemini CLI's token expiry, else the
// file's mtime); the newer login wins, an older or equal one never replaces the one here, and a file without a token
// to refresh with (an emptied login) never travels. The receiver writes the files whole (temp beside them, mode 0600,
// file-io.ts) into the account's home here – its own <accounts>/<provider>/<id> (Paths.accounts), or a CLI's default home
// (~/.claude, ~/.gemini) for a login this PC found there, but never over a file whose identity (accounts/login-file.ts) differs – and asks for the account check when the account is not signed in yet.
// A login of another PC's account that this PC has itself (tables.ts: the same provider and e-mail) lands in that
// account. A plan the person signed out of here (accounts/cli-homes.ts signedOut) takes no login from another PC
// until one is made here again. A login whose refresh token another plan's home on the same PC already holds is one login
// in two accounts (a Claude Code login file names no account; the next refresh signed both plans out) – it is neither taken
// nor sent; neither is a refresh token a list carries for two accounts at once, also when it comes alone later, and one
// login is checked and written at a time. The CLIs refresh their tokens and rewrite these files: a watch on each home's
// folder and every account change (a cheap compare) send a changed login within a second, so a second PC acts
// like a second process on the same PC, which reads the file again before it refreshes. Each PC gets a login when it
// differs from the one that PC last took from here (or sent here): a link that comes up takes every login again, a
// catch-up in rhythm (service.ts) brings only what a PC lacks – one a send missed –, so a repeat sends nothing new. Rows and logins travel
// in calls of their own, so a plan shared just now can bring its login before its row – that login waits here for the row
// (the newest per account) instead of being lost until the next refresh or link-up. Claude Code on macOS keeps
// its login in the Keychain: nothing is sent or written there.
// 16.11.2026: a plan's home is this PC's one home of that login, shared by every company here (accounts/cli-homes.ts):
// each company's LoginSync reads and writes the same file (whole, the newer login wins, so two writers are harmless),
// and a refresh token is held elsewhere when any other home on this PC holds it – this company's plans' homes and every
// home in the PC's logins folder. A sign-out mark is the home's (every company's LoginSync keeps out a linked PC's login).
// 22.11.2026 (owner: plans "für alle in der Firma aktiviert … auf jedem PC verwendet werden können … Token müssen wirklich
// schnell da sein"): a plan on all PCs of this company goes to every PC that shares it (plan-peers.ts) – the CEO's own PCs
// and every employee's PC; an employee's PC sends a login it refreshed back to the company it came from, never one of the
// person's own plans, and from a PC that is no 'ceo' link only the login of that very account is taken. A plan whose login
// is rejected here (it turns 'needs_login') asks the PCs that share it for theirs at once (`want`, at most every ASK_MS
// per plan, answered at most that often per PC); each sends it when it differs from what that PC last took.
// 24.11.2026 (ORENDA find): a PC that answers 'forbidden' gets no more logins until something relevant changes (login-refusals.ts).
// Konrad 26.11.2026 (company move, point 2): an agent of this company that moves to an employee's PC is such a change – that
// PC gets every plan it shares at once, as at a new connection (loginsTo), before the agent's first turn there.
// Owns: reading, sending and writing these files. Never: logs, journals or returns their content, shows them to
// an agent, a tool or the UI, or sends them to a PC that does not share the plan.

import { createHash, randomUUID } from 'node:crypto';
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeServices } from '../../contracts.ts';
import type { Account } from '../../../shared/model/providers.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { defaultHome, homeKey, loginFiles, ownHomes, sharedLogins, signedOut } from '../../accounts/cli-homes.ts';
import { MAX_LOGIN_FILE, identity, loginTime, parseLogin, refreshToken, signedIn, type Json } from '../../accounts/login-file.ts';
import { LoginRefusals } from './login-refusals.ts';
import { replaceWith } from './file-io.ts';
import { linkOf } from './home.ts';
import { DevicesRepo } from '../repo.ts';
import { planLink, planPeers } from './plan-peers.ts';

interface LoginFile { name: string; data: string }
/** One account's login as it travels (`data`: the file's bytes, base64). */
export interface Login { account: string; provider: string; email?: string; at: number; files: LoginFile[] }
/** A login with the digest of its files (what a PC took is remembered by it). */
interface Read { login: Login; digest: string }

export interface LoginDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** The user's home folder (the CLIs' default homes lie below it). */
  homeDir?: string;
  watch?: (dir: string, listener: (event: string, name: string | Buffer | null) => void) => FSWatcher;
}

/** How long a change gathers before the login is read (a CLI writes in steps). */
const SETTLE_MS = 500;
const SETTLED: ReadonlySet<string> = new Set(['ok', 'cooling', 'disabled']);
/** A plan asks the PCs that share it at most this often, and each answers one PC's ask for a plan at most this often. */
const ASK_MS = 30_000;

const code = (error: unknown) => (error instanceof WorkforceError ? error.code : String((error as NodeJS.ErrnoException)?.code ?? 'failed')); // never a message: it could quote content

const digestOf = (files: readonly LoginFile[]) => createHash('sha256').update(JSON.stringify(files)).digest('hex');
const asRead = (login: Login): Read => ({ login, digest: digestOf(login.files) });

/** A login's refresh token as a hash (a CLI with homes of its own), to compare without keeping the token. */
function tokenKey(login: Login): string | undefined {
  if (!ownHomes(login.provider as Account['provider'])) return undefined;
  const first = parseLogin(Buffer.from(login.files[0].data, 'base64'));
  const token = first && refreshToken(login.provider, first);
  return token ? createHash('sha256').update(`${login.provider}\n${token}`).digest('hex') : undefined;
}

/** The token keys one list carries for two accounts or more. */
function twinKeys(logins: readonly Login[]): string[] {
  const owners = new Map<string, Set<string>>();
  for (const login of logins) {
    const key = tokenKey(login);
    if (key) owners.set(key, (owners.get(key) ?? new Set<string>()).add(login.account));
  }
  return [...owners].filter(([, accounts]) => accounts.size > 1).map(([key]) => key);
}

const valid = (item: unknown): item is Login => {
  const login = item as Login;
  return Boolean(login) && typeof login.account === 'string' && login.account.length <= 200 && typeof login.provider === 'string'
    && typeof login.at === 'number' && Array.isArray(login.files) && login.files.length > 0 && login.files.length <= 4
    && login.files.every((file) => typeof file?.name === 'string' && typeof file.data === 'string' && file.data.length <= MAX_LOGIN_FILE * 2)
    && new Set(login.files.map((file) => file.name)).size === login.files.length;
};

/** The login sync of each runtime, by its database (loginsTo finds it there). */
const running = new WeakMap<object, LoginSync>();

/** An agent of this company moved to `peer`, an employee's PC: the plans it shares go there now (a refusal gets one more try). Never throws. */
export async function loginsTo(s: RuntimeServices, peer: string): Promise<void> {
  const sync = running.get(s.db);
  if (!sync || linkOf(new DevicesRepo(s.db).get(peer))?.kind !== 'employee' || !s.devices.online(peer)) return;
  await sync.catchUp(peer).catch(() => undefined);
}

export class LoginSync {
  private readonly s: RuntimeServices;
  private readonly deps: LoginDeps;
  /** Per `peer/account`: the login that PC last took from here or sent here (one it has is not sent again). */
  private readonly took = new Map<string, string>();
  private readonly watchers = new Map<string, { account: string; watcher: FSWatcher }>();
  private readonly pending = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  /** The login being checked and written (two calls at once would both find no twin here). */
  private applying: Promise<unknown> = Promise.resolve();
  /** Token keys a linked PC sent for two plans at once: that login is no plan's, also when it comes alone later. */
  private readonly twins = new Set<string>();
  /** 21.11.2026: a login that came before its account's row (rows and logins travel in calls of their own) – taken when the row is here. */
  private readonly waiting = new Map<string, { login: Login; from: string }>();
  /** Per plan: when it last asked the PCs that share it for their login; per `peer/account`: when that PC's ask was answered. */
  private readonly asked = new Map<string, number>();
  private readonly answered = new Map<string, number>();
  /** Per plan: its last state here (an ask goes once when the login turns rejected, not on every change of the row). */
  private readonly states = new Map<string, string>();
  /** The PCs that answered 'forbidden' (post: nothing goes there until something relevant changes). */
  private readonly refusals: LoginRefusals;

  constructor(s: RuntimeServices, deps: LoginDeps = {}) {
    this.s = s;
    this.deps = deps;
    this.refusals = new LoginRefusals(s);
    running.set(s.db, this);
  }

  private get platform(): NodeJS.Platform { return this.deps.platform ?? process.platform; }

  /** The CLI plans whose login is a file this PC knows. */
  private plans(): Account[] {
    // 17.11.2026: a login the person kept on this PC (`thisPcOnly`) is neither sent nor watched for sending
    return this.s.accounts.list().filter((account) => account.auth === 'cli' && !account.thisPcOnly && loginFiles(account.provider, this.platform).length > 0);
  }

  private homeOf(account: Account): string | undefined {
    return account.home ?? defaultHome(account.provider, this.deps.env ?? process.env, this.deps.homeDir ?? os.homedir());
  }

  /** Whether `peer` shares the plan of `login` – a login that names no plan here (one taken into this PC's own account) goes only to my own PCs. */
  private shares(peer: string, login: Login): boolean {
    const account = this.s.accounts.get(login.account);
    if (account) return Boolean(planLink(this.s.db, peer, account));
    return linkOf(new DevicesRepo(this.s.db).get(peer))?.kind === 'ceo';
  }

  /** The login here of a plan that was rejected here: asks every PC that shares it (they send theirs when it differs). */
  private ask(account: Account): void {
    const now = Date.now();
    if (account.thisPcOnly || account.auth !== 'cli' || now - (this.asked.get(account.id) ?? 0) < ASK_MS) return;
    this.asked.set(account.id, now);
    for (const peer of planPeers(this.s.db)) {
      if (!this.s.devices.online(peer) || !planLink(this.s.db, peer, account) || this.refusals.held(peer)) continue; // a PC that refuses logins is not asked either
      void this.s.devices.call(peer, 'sync.login', { logins: [], want: [account.id] })
        .catch((error: unknown) => this.s.log.info('login not asked for', { peer, error: code(error) }));
    }
  }

  /** `want` from a PC that shares those plans: their logins go there again (each only when it differs from what that PC has). */
  private async answer(peer: string, ids: readonly string[]): Promise<void> {
    const reads: Read[] = [];
    for (const id of ids) {
      const account = this.s.accounts.get(id);
      const key = `${peer}/${id}`, now = Date.now();
      if (!account || !planLink(this.s.db, peer, account) || !this.plans().some((plan) => plan.id === id) || now - (this.answered.get(key) ?? 0) < ASK_MS) continue;
      this.answered.set(key, now);
      this.took.delete(key); // what that PC took from here is rejected there now
      const read = await this.local(account);
      if (read) reads.push(read);
    }
    if (reads.length) await this.post(peer, reads);
  }

  // ---------------------------------------------------------------- sending

  /** Watches the plans' homes and hears account changes; returns the off switch. */
  attach(): () => void {
    const offs = [
      this.s.bus.on('account.upserted', (account) => {
        this.watchHomes(); this.soon(account.id); this.arrived(account.id);
        // the login was rejected just now (not a network error: a login cannot help there) – a newer one may be on another PC
        const was = this.states.get(account.id);
        this.states.set(account.id, account.state);
        if (account.enabled && account.state === 'needs_login' && was !== undefined && was !== 'needs_login') this.ask(account);
      }),
      this.s.bus.on('account.removed', ({ id }) => { signedOut.clear(this.s.db, { id }); this.watchHomes(); }), // a home's mark stays: it is the login's
      this.s.bus.on('device.removed', ({ id }) => this.refusals.forget(id)),
    ];
    this.watchHomes();
    try { for (const account of this.s.accounts.list()) this.states.set(account.id, account.state); } catch { /* the next change tells */ }
    return () => {
      for (const off of offs) off();
      for (const { watcher } of this.watchers.values()) watcher.close();
      this.watchers.clear();
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
    };
  }

  private watchHomes(): void {
    const want = new Map<string, Account>();
    try { for (const account of this.plans()) { const home = this.homeOf(account); if (home) want.set(home, account); } } catch { return; }
    for (const [dir, { account, watcher }] of this.watchers) if (want.get(dir)?.id !== account) { watcher.close(); this.watchers.delete(dir); }
    for (const [dir, account] of want) {
      if (this.watchers.has(dir)) continue;
      const names = loginFiles(account.provider, this.platform);
      try {
        const watcher = (this.deps.watch ?? fsWatch)(dir, (_event, name) => { if (!name || names.some((file) => String(name).startsWith(file))) this.soon(account.id); });
        watcher.on('error', () => { watcher.close(); this.watchers.delete(dir); });
        this.watchers.set(dir, { account: account.id, watcher });
      } catch { /* no folder yet: the next account change looks again */ }
    }
  }

  private soon(id: string): void {
    this.pending.add(id);
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, SETTLE_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async flush(): Promise<void> {
    const ids = [...this.pending];
    this.pending.clear();
    const reads: Read[] = [];
    for (const id of ids) {
      const account = this.s.accounts.get(id);
      const read = account ? await this.local(account) : undefined;
      if (read) reads.push(read);
    }
    for (const peer of planPeers(this.s.db)) if (this.s.devices.online(peer)) await this.post(peer, reads);
  }

  /** The login of `account` as it would travel; undefined when there is none (no file, emptied, half written, kept in the Keychain). */
  private async read(account: Account): Promise<Read | undefined> {
    const home = this.homeOf(account);
    const names = account.auth === 'cli' ? loginFiles(account.provider, this.platform) : [];
    if (!home || !names.length) return undefined;
    const files: LoginFile[] = [];
    let at = 0;
    for (const [index, name] of names.entries()) {
      const file = path.join(home, name);
      const info = await lstat(file).catch(() => undefined);
      if (!info?.isFile() || info.size > MAX_LOGIN_FILE) { if (index === 0) return undefined; continue; }
      const bytes = await readFile(file);
      const json = parseLogin(bytes);
      if (!json || (index === 0 && !signedIn(account.provider, json))) return undefined;
      if (index === 0 && await this.heldElsewhere(account, json)) return undefined; // whose it is stays unclear: it stays here
      if (index === 0) at = loginTime(account.provider, json, info.mtimeMs);
      files.push({ name, data: bytes.toString('base64') });
    }
    return { login: { account: account.id, provider: account.provider, ...(account.email ? { email: account.email } : {}), at, files }, digest: digestOf(files) };
  }

  /** The login here as it would travel; one that is here ends a sign-out mark (the person signed in here again). */
  private async local(account: Account): Promise<Read | undefined> {
    const read = await this.read(account).catch(() => undefined);
    if (read) signedOut.clear(this.s.db, account);
    return read;
  }

  /** Sends `peer` each of `reads` it has not taken yet; false when the call failed (they go at the next catch-up). */
  private async post(peer: string, reads: readonly Read[]): Promise<boolean> {
    const refused = this.refusals.held(peer); // ORENDA 24.11.2026: a PC that refuses logins gets none until something relevant changes (login-refusals.ts)
    const fresh = reads.filter(({ login, digest }) => this.took.get(`${peer}/${login.account}`) !== digest && !refused?.has(login.account) && this.shares(peer, login));
    if (!fresh.length) return true;
    try {
      await this.s.devices.call(peer, 'sync.login', { logins: fresh.map(({ login }) => login) });
      for (const { login, digest } of fresh) this.took.set(`${peer}/${login.account}`, digest);
      this.refusals.accepted(peer);
      return true;
    } catch (error) {
      if (code(error) === 'forbidden') { this.refusals.refuse(peer, fresh.map(({ login }) => login.account)); return true; } // not a miss a later round could make good
      this.s.log.info('logins not sent', { peer, count: fresh.length, error: code(error) });
      return false;
    }
  }

  /** What a catch-up owes a linked PC: every shared plan's login it has not taken – at a link-up (`again` false) every one (the other PC keeps what is newer there). */
  async catchUp(peer: string, again = false): Promise<boolean> {
    if (!linkOf(new DevicesRepo(this.s.db).get(peer))) return true;
    if (!again) { // a new connection: what that PC took is open again, and so is a refusal (one try)
      for (const key of [...this.took.keys()]) if (key.startsWith(`${peer}/`)) this.took.delete(key);
      this.refusals.reopen(peer);
    }
    const reads: Read[] = [];
    for (const account of this.plans()) {
      const read = await this.local(account);
      if (read) reads.push(read);
    }
    return this.post(peer, reads);
  }

  // ---------------------------------------------------------------- receiving

  /** 'sync.login' from a PC that shares the plans: each newer login is written here and passed on to the others that share it; `want`: that PC asks for these plans' logins. */
  async receive(params: unknown, from: string): Promise<{ ok: true; applied: number }> {
    if (!linkOf(new DevicesRepo(this.s.db).get(from))) throw new WorkforceError('forbidden', 'Logins come only from this company\'s PCs.');
    const want = (params as { want?: unknown } | null)?.want;
    if (Array.isArray(want)) void this.answer(from, want.filter((id): id is string => typeof id === 'string' && id.length <= 200).slice(0, 20)).catch(() => undefined);
    const list = (params as { logins?: unknown } | null)?.logins;
    const logins = (Array.isArray(list) ? list : []).filter(valid);
    for (const key of twinKeys(logins)) this.twins.add(key);
    const applied: Login[] = [];
    for (const login of logins) {
      const key = tokenKey(login);
      if (key && this.twins.has(key)) { this.s.log.warn('one login for two plans not taken', { account: login.account }); continue; }
      if (!this.targetOf(login, from)) { this.hold(login, from); continue; }
      try { if (await this.inTurn(login, from)) applied.push(login); } catch (error) { this.s.log.warn('synced login not stored', { account: login.account, error: code(error) }); }
    }
    for (const peer of planPeers(this.s.db, from)) if (this.s.devices.online(peer)) await this.post(peer, applied.map(asRead));
    return { ok: true, applied: applied.length };
  }

  /** Keeps the newest login of an account whose row is not here yet. */
  private hold(login: Login, from: string): void {
    const held = this.waiting.get(login.account);
    if (!held || held.login.at < login.at) this.waiting.set(login.account, { login, from });
  }

  /** The account's row is here: the login that waited for it is taken now (and passed on like one that came with its row). */
  private arrived(id: string): void {
    const held = this.waiting.get(id);
    if (!held || !this.targetOf(held.login, held.from)) return;
    this.waiting.delete(id);
    void this.inTurn(held.login, held.from).then(async (taken) => {
      if (taken) for (const peer of planPeers(this.s.db, held.from)) if (this.s.devices.online(peer)) await this.post(peer, [asRead(held.login)]);
    }).catch((error: unknown) => this.s.log.warn('synced login not stored', { account: id, error: code(error) }));
  }

  /**
   * The plan here a login from `from` belongs to: the same account, else the same login (provider and e-mail; any, for a
   * CLI with one sign-in per PC). From a PC that is no 'ceo' link only that very account, and only when it shares it.
   */
  private targetOf(login: Login, from: string): Account | undefined {
    const plans = this.s.accounts.list().filter((account) => account.auth === 'cli' && account.provider === login.provider);
    const same = plans.find((account) => account.id === login.account);
    if (linkOf(new DevicesRepo(this.s.db).get(from))?.kind !== 'ceo') return same && planLink(this.s.db, from, same) ? same : undefined;
    return same ?? plans.find((account) => !ownHomes(account.provider) || (Boolean(login.email) && account.email === login.email));
  }

  private inTurn(login: Login, from: string): Promise<boolean> {
    const run = this.applying.then(() => this.apply(login, from));
    this.applying = run.catch(() => undefined);
    return run;
  }

  /** Writes `login` from `from` here when it is newer; what is here then is what `from` has (no echo back). */
  private async apply(login: Login, from: string): Promise<boolean> {
    const target = this.targetOf(login, from);
    const home = target && this.homeOf(target);
    const names = target ? loginFiles(target.provider, this.platform) : [];
    if (!target || !home || login.files[0].name !== names[0]) return false; // not here, or kept in the Keychain here
    if (signedOut.has(this.s.db, target)) {
      this.s.log.info('login of a plan signed out here not taken', { account: target.id });
      return false;
    }
    const files = login.files.filter((file) => names.includes(file.name)).map((file) => ({ name: file.name, bytes: Buffer.from(file.data, 'base64') }));
    const first = parseLogin(files[0].bytes);
    if (!first || !signedIn(target.provider, first) || files.some((file) => !parseLogin(file.bytes))) return false;
    const here = await this.loginHere(target, path.join(home, names[0]));
    if (here && here.at >= login.at) return false; // never an older login over this one
    const mine = here && identity(target.provider, here.json);
    const theirs = identity(target.provider, first);
    if (mine && theirs && mine !== theirs) {
      this.s.log.info('login of another account kept', { account: target.id });
      return false;
    }
    const twin = await this.heldElsewhere(target, first);
    if (twin) {
      this.s.log.warn('login of another plan here not taken', { account: target.id, holder: twin.id });
      return false;
    }
    await mkdir(home, { recursive: true });
    for (const file of files) await this.writeWhole(path.join(home, file.name), file.bytes);
    const read = await this.read(target).catch(() => undefined);
    if (read) this.took.set(`${from}/${target.id}`, read.digest);
    this.s.log.info('login taken from a linked PC', { account: target.id });
    if (!SETTLED.has(target.state)) void this.s.accounts.checkNow?.(target.id);
    return true;
  }

  /**
   * Another home of the provider here that holds the refresh token of `file` (never the same home): a plan's of this
   * company, or any home in this PC's logins folder (another company's); its id names it in the log.
   */
  private async heldElsewhere(account: Account, file: Json): Promise<{ id: string } | undefined> {
    const token = refreshToken(account.provider, file);
    const home = this.homeOf(account);
    if (!token || !home) return undefined;
    const homes = new Map<string, { id: string; home: string }>();
    for (const other of this.plans()) {
      const there = other.provider === account.provider ? this.homeOf(other) : undefined;
      if (there) homes.set(homeKey(there), { id: other.id, home: there });
    }
    const root = this.s.paths?.accounts;
    for (const shared of root ? sharedLogins(root, this.platform) : []) {
      if (shared.provider === account.provider && !homes.has(homeKey(shared.home))) homes.set(homeKey(shared.home), { id: shared.id, home: shared.home });
    }
    homes.delete(homeKey(home));
    for (const other of homes.values()) {
      const bytes = await readFile(path.join(other.home, loginFiles(account.provider, this.platform)[0])).catch(() => undefined);
      const json = bytes && parseLogin(bytes);
      if (json && refreshToken(account.provider, json) === token) return other;
    }
    return undefined;
  }

  /** The login file in the home here with its time (0: no login in it, e.g. emptied). */
  private async loginHere(account: Account, file: string): Promise<{ json: Json; at: number } | undefined> {
    const info = await lstat(file).catch(() => undefined);
    if (!info?.isFile()) return undefined;
    const json = parseLogin(await readFile(file)) ?? {};
    return { json, at: signedIn(account.provider, json) ? loginTime(account.provider, json, info.mtimeMs) : 0 };
  }

  private async writeWhole(file: string, bytes: Buffer): Promise<void> {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, bytes, { mode: 0o600 });
      await chmod(temp, 0o600);
      await replaceWith(temp, file);
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }
}
