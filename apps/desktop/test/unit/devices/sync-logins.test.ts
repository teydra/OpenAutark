// Plan logins between the CEO's PCs (devices/sync/logins.ts): two temporary PCs on a fake mesh. A login reaches the
// other PC's own home for that account whole (no temp file left, mode 0600) and the account is checked; the newer
// login wins by its own time, an older one never replaces it; a change the CLI writes (the home's watch) goes on its
// own; a login found in a CLI's default home travels and comes back into that home only when the file there is the
// same account; a PC that has the same login itself (provider and e-mail) takes it into its own account; never over
// a file of another account (in any home), nor a refresh token another plan here holds or one list carries for two plans
// (one login in two plans), and two calls at once take one login once; a plan
// signed out here takes none until one is made here again; nothing
// goes to an employee's PC but the company's shared plans and only their refresh comes back (22.11.2026), an emptied login never travels, Claude Code on a Mac has none to send or take;
// a catch-up in rhythm sends a PC only the logins it has not taken.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { FSWatcher } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Account } from '../../../src/shared/model/providers.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { DevicesRepo, type DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { LoginSync } from '../../../src/runtime/devices/sync/logins.ts';
import { clearLoginsRefused, loginsRefused, withLoginsRefused } from '../../../src/runtime/devices/logins-refused.ts';
import { signedOut } from '../../../src/runtime/accounts/cli-homes.ts';
import { markOrigin } from '../../../src/runtime/devices/sync/employee.ts';
import { memoryDb, recordingBus, silentLog } from './fakes.ts';

const record = (id: string, extra: Partial<DeviceRecord> = {}): DeviceRecord => ({
  id, name: id, kind: 'pc', role: 'home', fingerprint: `fp_${id}`, addresses: [], caps: {}, status: 'online', self: false, ...extra,
});

const plan = (id: string, provider: Account['provider'], extra: Partial<Account> = {}): Account => ({
  id, provider, label: provider, auth: 'cli', state: 'ok', priority: 0, enabled: true, detected: false, createdAt: 0, ...extra,
});

const codexLogin = (refresh: string, at: string, accountId = 'org-1') =>
  JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: 'id', access_token: `access-${refresh}`, refresh_token: refresh, account_id: accountId }, last_refresh: at });

type Pc = Awaited<ReturnType<typeof makePc>>;

async function makePc(pcs: Map<string, { logins: LoginSync }>, id: string, platform: NodeJS.Platform = 'win32') {
  const root = await mkdtemp(path.join(os.tmpdir(), `logins-${id}-`));
  const db = memoryDb();
  const { bus } = recordingBus();
  const repo = new DevicesRepo(db);
  repo.upsert(record(id, { self: true }));
  const accounts: Account[] = [];
  const checked: string[] = [];
  const calls: string[] = [];
  const watchers = new Map<string, (event: string, name: string | null) => void>();
  const s = {
    db, bus, log: silentLog, paths: { accounts: path.join(root, 'data', 'accounts') },
    accounts: {
      list: () => accounts, get: (accountId: string) => accounts.find((account) => account.id === accountId),
      checkNow: async (accountId: string) => { checked.push(accountId); },
    },
    devices: {
      online: (peer: string) => pcs.has(peer),
      call: async (peer: string, method: string, params: unknown) => {
        const target = pcs.get(peer);
        if (!target) throw new WorkforceError('unavailable', 'offline');
        calls.push(`${id}->${peer}`);
        return target.logins.receive(JSON.parse(JSON.stringify(params)), id);
      },
    },
  } as unknown as RuntimeServices;
  const home = path.join(root, 'user');
  const logins = new LoginSync(s, {
    platform, env: {}, homeDir: home,
    watch: (dir, listener) => { watchers.set(dir, listener); return Object.assign(new EventEmitter(), { close: () => watchers.delete(dir) }) as unknown as FSWatcher; },
  });
  /** An account's own home here. */
  const own = (account: string, provider = 'codex') => path.join(root, 'data', 'accounts', provider, account);
  const pc = { id, root, home, repo, accounts, checked, calls, watchers, logins, own, s };
  pcs.set(id, pc);
  return pc;
}

const put = async (file: string, text: string) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); };
const read = (file: string) => readFile(file, 'utf8').catch(() => undefined);
const temps = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.tmp'));
const settle = (ms = 700) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits until `check` holds (a send gathers 500 ms first; a busy machine adds more), at most 10 s. */
async function until(check: () => Promise<boolean>): Promise<void> {
  for (const end = Date.now() + 10_000; !(await check()) && Date.now() < end;) await settle(50);
}

/** `b` joined `a` as one of the CEO's PCs. */
function link(a: Pc, b: Pc): void {
  a.repo.upsert(record(b.id));
  b.repo.upsert(record(a.id, { joinedAs: 'ceo' }));
}

test('a plan\'s login reaches the other PC\'s own home whole and the account is checked; the newer login wins, a refresh there comes back', async (t) => {
  const pcs = new Map<string, Pc>();
  const a = await makePc(pcs, 'dev_a');
  const b = await makePc(pcs, 'dev_b');
  t.after(async () => { for (const pc of [a, b]) await rm(pc.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  link(a, b);
  a.accounts.push(plan('acc_cx', 'codex', { home: a.own('acc_cx'), email: 'lena@example.com' }));
  b.accounts.push(plan('acc_cx', 'codex', { home: b.own('acc_cx'), email: 'lena@example.com', state: 'needs_login' })); // its row came with the rows
  await put(path.join(a.own('acc_cx'), 'auth.json'), codexLogin('r1', '2026-11-04T10:00:00Z'));

  assert.equal(await a.logins.catchUp('dev_b'), true);
  const there = path.join(b.own('acc_cx'), 'auth.json');
  assert.equal(await read(there), codexLogin('r1', '2026-11-04T10:00:00Z'), 'the same login, byte for byte');
  assert.deepEqual(await temps(b.own('acc_cx')), [], 'written whole: no temp file stays');
  if (process.platform !== 'win32') assert.equal((await stat(there)).mode & 0o777, 0o600);
  assert.deepEqual(b.checked, ['acc_cx'], 'the account there is checked (it was not signed in)');

  await put(path.join(a.own('acc_cx'), 'auth.json'), codexLogin('r0', '2026-11-04T09:00:00Z'));
  await a.logins.catchUp('dev_b');
  assert.equal(await read(there), codexLogin('r1', '2026-11-04T10:00:00Z'), 'an older login never replaces the newer one');

  const offs = [a.logins.attach(), b.logins.attach()];
  assert.ok(b.watchers.has(b.own('acc_cx')), 'B watches the account\'s home');
  await put(there, codexLogin('r2', '2026-11-04T11:00:00Z')); // Codex refreshed on B
  b.watchers.get(b.own('acc_cx'))!('rename', 'auth.json');
  b.watchers.get(b.own('acc_cx'))!('change', 'history.jsonl'); // not a login file: nothing
  await until(async () => await read(path.join(a.own('acc_cx'), 'auth.json')) === codexLogin('r2', '2026-11-04T11:00:00Z'));
  assert.equal(await read(path.join(a.own('acc_cx'), 'auth.json')), codexLogin('r2', '2026-11-04T11:00:00Z'), 'the refresh came back at once');
  const sent = b.calls.length;
  a.watchers.get(a.own('acc_cx'))!('rename', 'auth.json'); // A's own write of what came: no echo
  await settle();
  assert.equal(a.calls.filter((call) => call === 'dev_a->dev_b').length, 2, 'A sent only its two link-ups');
  assert.equal(b.calls.length, sent);
  for (const off of offs) off();
});

test('22.11.2026: a catch-up in rhythm sends a PC only the logins it has not taken – none when nothing changed, one a failed send missed', async (t) => {
  const pcs = new Map<string, Pc>();
  const a = await makePc(pcs, 'dev_a');
  const b = await makePc(pcs, 'dev_b');
  t.after(async () => { for (const pc of [a, b]) await rm(pc.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  link(a, b);
  a.accounts.push(plan('acc_cx', 'codex', { home: a.own('acc_cx'), email: 'lena@example.com' }));
  b.accounts.push(plan('acc_cx', 'codex', { home: b.own('acc_cx'), email: 'lena@example.com', state: 'needs_login' }));
  const mine = path.join(a.own('acc_cx'), 'auth.json');
  const there = path.join(b.own('acc_cx'), 'auth.json');
  const sent = () => a.calls.filter((call) => call === 'dev_a->dev_b').length;
  await put(mine, codexLogin('r1', '2026-11-04T10:00:00Z'));
  assert.equal(await a.logins.catchUp('dev_b'), true);
  assert.equal(await a.logins.catchUp('dev_b', true), true);
  assert.equal(sent(), 1, 'nothing new: no call');

  await put(mine, codexLogin('r2', '2026-11-04T11:00:00Z')); // refreshed while the link was cut
  pcs.delete('dev_b');
  assert.equal(await a.logins.catchUp('dev_b', true), false, 'the send did not reach B');
  pcs.set('dev_b', b);
  assert.equal(await a.logins.catchUp('dev_b', true), true);
  assert.equal(await read(there), codexLogin('r2', '2026-11-04T11:00:00Z'), 'the next round brought it');
  assert.equal(sent(), 2);
  await a.logins.catchUp('dev_b');
  assert.equal(sent(), 3, 'a link-up sends every login again');
});

test('a login found in a CLI\'s default home travels and comes back there – never over a file of another account', async (t) => {
  const pcs = new Map<string, Pc>();
  const a = await makePc(pcs, 'dev_a');
  const b = await makePc(pcs, 'dev_b');
  t.after(async () => { for (const pc of [a, b]) await rm(pc.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  link(a, b);
  a.accounts.push(plan('acc_found', 'codex', { detected: true, email: 'lena@example.com' })); // in ~/.codex
  b.accounts.push(plan('acc_found', 'codex', { home: b.own('acc_found'), email: 'lena@example.com', state: 'unknown' }));
  const defaultHome = path.join(a.home, '.codex', 'auth.json');
  await put(defaultHome, codexLogin('r1', '2026-11-04T10:00:00Z'));

  await a.logins.catchUp('dev_b');
  assert.equal(await read(path.join(b.own('acc_found'), 'auth.json')), codexLogin('r1', '2026-11-04T10:00:00Z'), 'B keeps it in its own home for the account');

  await put(path.join(b.own('acc_found'), 'auth.json'), codexLogin('r2', '2026-11-04T11:00:00Z'));
  await b.logins.catchUp('dev_a');
  assert.equal(await read(defaultHome), codexLogin('r2', '2026-11-04T11:00:00Z'), 'the newer login went into ~/.codex: the same account');
  assert.deepEqual(a.checked, [], 'A\'s account was signed in already: no extra check');

  await put(defaultHome, codexLogin('x1', '2026-11-04T08:00:00Z', 'org-2')); // someone signed in another account in ~/.codex
  await put(path.join(b.own('acc_found'), 'auth.json'), codexLogin('r3', '2026-11-04T12:00:00Z'));
  await b.logins.catchUp('dev_a');
  assert.equal(await read(defaultHome), codexLogin('x1', '2026-11-04T08:00:00Z', 'org-2'), 'never over a file whose account differs');
});

test('a PC with the same login itself takes it into its own account (provider and e-mail); Gemini CLI keeps one per PC', async (t) => {
  const pcs = new Map<string, Pc>();
  const a = await makePc(pcs, 'dev_a');
  const b = await makePc(pcs, 'dev_b');
  t.after(async () => { for (const pc of [a, b]) await rm(pc.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  link(a, b);
  a.accounts.push(plan('acc_a', 'codex', { home: a.own('acc_a'), email: 'lena@example.com' }), plan('acc_ga', 'gemini-cli', { detected: true }));
  b.accounts.push(plan('acc_b', 'codex', { detected: true, email: 'lena@example.com', state: 'needs_login' }), plan('acc_gb', 'gemini-cli', { detected: true }));
  await put(path.join(a.own('acc_a'), 'auth.json'), codexLogin('r1', '2026-11-04T10:00:00Z'));
  const geminiCreds = JSON.stringify({ access_token: 'g', refresh_token: 'gr', expiry_date: 1_793_800_000_000 });
  await put(path.join(a.home, '.gemini', 'oauth_creds.json'), geminiCreds);
  await put(path.join(a.home, '.gemini', 'google_accounts.json'), JSON.stringify({ active: 'lena@example.com', old: [] }));

  await a.logins.catchUp('dev_b');
  assert.equal(await read(path.join(b.home, '.codex', 'auth.json')), codexLogin('r1', '2026-11-04T10:00:00Z'), 'into B\'s own Codex login');
  assert.deepEqual(b.checked, ['acc_b']);
  assert.equal(await read(path.join(b.home, '.gemini', 'oauth_creds.json')), geminiCreds);
  assert.equal(await read(path.join(b.home, '.gemini', 'google_accounts.json')), JSON.stringify({ active: 'lena@example.com', old: [] }), 'both of its files');
});

test('22.11.2026: a shared plan goes to an employee\'s PC and its refresh comes back; the person\'s own plan stays, no other PC sends any', async (t) => {
  const pcs = new Map<string, Pc>();
  const a = await makePc(pcs, 'dev_a');
  const b = await makePc(pcs, 'dev_b');
  const mac = await makePc(pcs, 'dev_mac', 'darwin');
  t.after(async () => { for (const pc of [a, b, mac]) await rm(pc.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  a.repo.upsert(record('dev_b', { personId: 'per_lena000001' }));
  b.repo.upsert(record('dev_a', { joinedAs: 'employee' }));
  link(a, mac);
  a.accounts.push(plan('acc_cl', 'claude', { home: a.own('acc_cl', 'claude') }), plan('acc_lena', 'claude', { home: a.own('acc_lena', 'claude'), state: 'needs_login' }));
  b.accounts.push(plan('acc_cl', 'claude', { home: b.own('acc_cl', 'claude'), state: 'needs_login' }), plan('acc_lena', 'claude', { home: b.own('acc_lena', 'claude') }));
  mac.accounts.push(plan('acc_cl', 'claude', { home: mac.own('acc_cl', 'claude'), state: 'needs_login' }));
  markOrigin(b.s.db, { t: 'accounts', id: 'acc_cl', row: {} }, 'dev_a', 0); // the company's plan came with its row
  const login = (refresh: string, expiresAt: number) => JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: refresh, expiresAt, scopes: [], subscriptionType: 'max' } });
  const claude = login('r', 1_793_800_000_000);
  await put(path.join(a.own('acc_cl', 'claude'), '.credentials.json'), claude);
  await put(path.join(b.own('acc_lena', 'claude'), '.credentials.json'), login('lena', 1_793_800_000_000));

  assert.equal(await a.logins.catchUp('dev_b'), true);
  assert.equal(await read(path.join(b.own('acc_cl', 'claude'), '.credentials.json')), claude, 'the company\'s plan reaches the employee\'s PC');
  assert.deepEqual(b.checked, ['acc_cl']);
  await put(path.join(b.own('acc_cl', 'claude'), '.credentials.json'), login('r2', 1_793_850_000_000)); // Claude Code refreshed there
  assert.equal(await b.logins.catchUp('dev_a'), true);
  assert.equal(await read(path.join(a.own('acc_cl', 'claude'), '.credentials.json')), login('r2', 1_793_850_000_000), 'its refresh comes back to the company');
  assert.equal(await read(path.join(a.own('acc_lena', 'claude'), '.credentials.json')), undefined, 'the person\'s own plan stays on their PC');
  await assert.rejects(a.logins.receive({ logins: [] }, 'dev_x'), (error: unknown) => error instanceof WorkforceError && error.code === 'forbidden', 'nothing from a PC that is no link');
  await put(path.join(a.own('acc_cl', 'claude'), '.credentials.json'), claude);

  await a.logins.catchUp('dev_mac');
  assert.equal(await read(path.join(mac.own('acc_cl', 'claude'), '.credentials.json')), undefined, 'a Mac keeps it in the Keychain: nothing written');
  assert.deepEqual(mac.checked, []);
  await put(path.join(mac.own('acc_cl', 'claude'), '.credentials.json'), claude);
  const before = mac.calls.length;
  assert.equal(await mac.logins.catchUp('dev_a'), true);
  assert.equal(mac.calls.length, before, 'nor read there');

  const emptied = JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 1_793_900_000_000 } });
  await put(path.join(a.own('acc_cl', 'claude'), '.credentials.json'), emptied);
  const sent = a.calls.length;
  await a.logins.catchUp('dev_mac');
  assert.equal(a.calls.length, sent, 'an emptied login never travels');
});

test('never over a login of another account – also in the plan\'s own home here (signed in with another account, or the same e-mail)', async (t) => {
  const pcs = new Map<string, Pc>();
  const a = await makePc(pcs, 'dev_a');
  const b = await makePc(pcs, 'dev_b');
  t.after(async () => { for (const pc of [a, b]) await rm(pc.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  link(a, b);
  a.accounts.push(plan('acc_cx', 'codex', { home: a.own('acc_cx'), email: 'lena@example.com' }), plan('acc_work', 'codex', { home: a.own('acc_work'), email: 'team@example.com' }));
  b.accounts.push(plan('acc_cx', 'codex', { home: b.own('acc_cx'), email: 'lena@example.com' }), plan('acc_team', 'codex', { home: b.own('acc_team'), email: 'team@example.com' }));
  await put(path.join(a.own('acc_cx'), 'auth.json'), codexLogin('r1', '2026-11-04T10:00:00Z'));
  await put(path.join(a.own('acc_work'), 'auth.json'), codexLogin('w1', '2026-11-04T10:00:00Z', 'org-3'));
  await put(path.join(b.own('acc_cx'), 'auth.json'), codexLogin('y1', '2026-11-04T09:00:00Z', 'org-2')); // B signed this plan in with another account
  await put(path.join(b.own('acc_team'), 'auth.json'), codexLogin('t1', '2026-11-04T09:00:00Z', 'org-4')); // the same e-mail, another workspace

  await a.logins.catchUp('dev_b');
  assert.equal(await read(path.join(b.own('acc_cx'), 'auth.json')), codexLogin('y1', '2026-11-04T09:00:00Z', 'org-2'), 'the newer login of another account stays out');
  assert.equal(await read(path.join(b.own('acc_team'), 'auth.json')), codexLogin('t1', '2026-11-04T09:00:00Z', 'org-4'), 'also in the plan with the same e-mail');
  assert.deepEqual(b.checked, []);
});

test('a plan signed out here takes no login from a linked PC until one is made here again', async (t) => {
  const pcs = new Map<string, Pc>();
  const a = await makePc(pcs, 'dev_a');
  const b = await makePc(pcs, 'dev_b');
  t.after(async () => { for (const pc of [a, b]) await rm(pc.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  link(a, b);
  a.accounts.push(plan('acc_cx', 'codex', { home: a.own('acc_cx'), email: 'lena@example.com', state: 'needs_login' }));
  b.accounts.push(plan('acc_cx', 'codex', { home: b.own('acc_cx'), email: 'lena@example.com' }));
  const mine = path.join(a.own('acc_cx'), 'auth.json');
  const theirs = path.join(b.own('acc_cx'), 'auth.json');
  await put(theirs, codexLogin('r2', '2026-11-04T11:00:00Z'));
  await mkdir(a.own('acc_cx'), { recursive: true });
  signedOut.mark(a.s.db, a.accounts[0], 1); // the person signed out on A (accounts.logout: the CLI removed the file; the mark is the home's)

  await b.logins.catchUp('dev_a');
  assert.equal(await read(mine), undefined, 'A stays signed out');
  assert.deepEqual(a.checked, []);

  await put(mine, codexLogin('r3', '2026-11-04T12:00:00Z')); // the person signed in on A again
  await a.logins.catchUp('dev_b');
  assert.equal(signedOut.has(a.s.db, a.accounts[0]), false, 'a login here ends the mark');
  assert.equal(await read(theirs), codexLogin('r3', '2026-11-04T12:00:00Z'), 'and goes to B');
  await put(theirs, codexLogin('r4', '2026-11-04T13:00:00Z'));
  await b.logins.catchUp('dev_a');
  assert.equal(await read(mine), codexLogin('r4', '2026-11-04T13:00:00Z'), 'B\'s refresh reaches A again');
});

test('B-080 (live 09.11.2026): one login in two plans – a refresh token another plan here holds is neither sent nor taken', async (t) => {
  const pcs = new Map<string, Pc>();
  const a = await makePc(pcs, 'dev_a');
  const b = await makePc(pcs, 'dev_b');
  t.after(async () => { for (const pc of [a, b]) await rm(pc.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  link(a, b);
  const cred = (refresh: string, expiresAt: number) => JSON.stringify({ claudeAiOauth: { accessToken: `a-${refresh}`, refreshToken: refresh, expiresAt, scopes: [], subscriptionType: 'max' } });
  const file = (pc: Pc, account: string) => path.join(pc.own(account, 'claude'), '.credentials.json');
  for (const pc of [a, b]) pc.accounts.push(plan('acc_c2', 'claude', { home: pc.own('acc_c2', 'claude') }), plan('acc_c3', 'claude', { home: pc.own('acc_c3', 'claude') }));
  // On A, Claude Code 2's home holds Claude Code 3's login: whose it is stays unclear, so A sends neither.
  await put(file(a, 'acc_c2'), cred('r3', 1_793_900_000_000));
  await put(file(a, 'acc_c3'), cred('r3', 1_793_900_000_000));
  await put(file(b, 'acc_c2'), cred('r2', 1_793_800_000_000));
  await put(file(b, 'acc_c3'), cred('r3', 1_793_800_000_000));
  assert.equal(await a.logins.catchUp('dev_b'), true);
  assert.deepEqual(a.calls, [], 'nothing sent');

  // A PC on an older version sends it anyway: B keeps Claude Code 2's own login (Claude Code 3 here holds that token).
  const login = (refresh: string, at: number) => ({ account: 'acc_c2', provider: 'claude', at, files: [{ name: '.credentials.json', data: Buffer.from(cred(refresh, at)).toString('base64') }] });
  assert.deepEqual(await b.logins.receive({ logins: [login('r3', 1_793_900_000_000)] }, 'dev_a'), { ok: true, applied: 0 });
  assert.equal(await read(file(b, 'acc_c2')), cred('r2', 1_793_800_000_000));
  // Its own newer login (a token no other plan here holds) still comes.
  assert.deepEqual(await b.logins.receive({ logins: [login('r2b', 1_793_950_000_000)] }, 'dev_a'), { ok: true, applied: 1 });
  assert.equal(await read(file(b, 'acc_c2')), cred('r2b', 1_793_950_000_000));
});

test('B-087: a list from an older PC that carries one login for two plans gives it to neither, also alone later; two calls at once take it once', async (t) => {
  const pcs = new Map<string, Pc>();
  const a = await makePc(pcs, 'dev_a');
  const b = await makePc(pcs, 'dev_b');
  t.after(async () => { for (const pc of [a, b]) await rm(pc.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  link(a, b);
  const cred = (refresh: string, expiresAt: number) => JSON.stringify({ claudeAiOauth: { accessToken: `a-${refresh}`, refreshToken: refresh, expiresAt, scopes: [], subscriptionType: 'max' } });
  const file = (account: string) => path.join(b.own(account, 'claude'), '.credentials.json');
  // Not signed in yet: a login taken here would also ask for the account check.
  b.accounts.push(plan('acc_c2', 'claude', { home: b.own('acc_c2', 'claude'), state: 'needs_login' }), plan('acc_c3', 'claude', { home: b.own('acc_c3', 'claude'), state: 'needs_login' }));
  const file1 = (refresh: string, at: number) => ({ name: '.credentials.json', data: Buffer.from(cred(refresh, at)).toString('base64') });
  const login = (account: string, refresh: string, at: number) => ({ account, provider: 'claude', at, files: [file1(refresh, at)] });
  await put(file('acc_c2'), cred('r2', 1_793_800_000_000));
  await put(file('acc_c3'), cred('r3old', 1_793_800_000_000));

  // The live shape of 09.11.: the catch-up list of a PC whose Claude Code 2 home holds Claude Code 3's login, plan 2 first.
  assert.deepEqual(await b.logins.receive({ logins: [login('acc_c2', 'T', 1_793_960_000_000), login('acc_c3', 'T', 1_793_960_000_000)] }, 'dev_a'), { ok: true, applied: 0 });
  // Later that PC sends one copy alone (a change in one home): still no plan's login.
  assert.deepEqual(await b.logins.receive({ logins: [login('acc_c2', 'T', 1_793_965_000_000)] }, 'dev_a'), { ok: true, applied: 0 });
  // A login that names its file twice (the first checked, the last written) is no login.
  assert.deepEqual(await b.logins.receive({ logins: [{ ...login('acc_c3', 'fresh', 1_793_965_000_000), files: [file1('fresh', 1_793_965_000_000), file1('T', 1_793_965_000_000)] }] }, 'dev_a'), { ok: true, applied: 0 });
  assert.equal(await read(file('acc_c2')), cred('r2', 1_793_800_000_000), 'plan 2 keeps its own login');
  assert.equal(await read(file('acc_c3')), cred('r3old', 1_793_800_000_000), 'plan 3 too');
  assert.deepEqual(b.checked, []);

  // Two calls at once, each with one plan's copy of one new token: one plan takes it, the other finds it held.
  const [one, two] = await Promise.all([
    b.logins.receive({ logins: [login('acc_c2', 'X', 1_793_970_000_000)] }, 'dev_a'),
    b.logins.receive({ logins: [login('acc_c3', 'X', 1_793_970_000_000)] }, 'dev_a'),
  ]);
  assert.equal(one.applied + two.applied, 1, 'one login in one plan');
  const holders = [await read(file('acc_c2')), await read(file('acc_c3'))].filter((text) => text === cred('X', 1_793_970_000_000));
  assert.equal(holders.length, 1);
  assert.equal(b.checked.length, 1, 'and only that plan is checked');
});

test('16.11.2026: two companies on one PC share one home – both LoginSyncs write it whole, the newer login wins, a refresh there reaches the linked PC once', async (t) => {
  const pcs = new Map<string, Pc>();
  const a = await makePc(pcs, 'dev_a');
  const b = await makePc(pcs, 'dev_b'); // company 1 on PC B
  const b2 = await makePc(pcs, 'dev_b2'); // company 2 on PC B: its row points at the same home
  t.after(async () => { for (const pc of [a, b, b2]) await rm(pc.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  link(a, b);
  link(a, b2);
  const shared = b.own('acc_cx');
  a.accounts.push(plan('acc_cx', 'codex', { home: a.own('acc_cx'), email: 'lena@example.com' }));
  b.accounts.push(plan('acc_cx', 'codex', { home: shared, email: 'lena@example.com' }));
  b2.accounts.push(plan('acc_c2', 'codex', { home: shared, email: 'lena@example.com' })); // its own row, the same login
  await put(path.join(shared, 'auth.json'), codexLogin('r1', '2026-11-04T10:00:00Z'));
  await put(path.join(a.own('acc_cx'), 'auth.json'), codexLogin('r2', '2026-11-04T11:00:00Z'));

  await Promise.all([a.logins.catchUp('dev_b'), a.logins.catchUp('dev_b2')]); // both companies take it at once
  assert.equal(await read(path.join(shared, 'auth.json')), codexLogin('r2', '2026-11-04T11:00:00Z'), 'the newer login, whole');
  assert.deepEqual(await temps(shared), [], 'no temp file stays');
  assert.deepEqual((await readdir(path.join(b2.root, 'data', 'accounts')).catch(() => [])), [], 'no second home for that login');

  await put(path.join(a.own('acc_cx'), 'auth.json'), codexLogin('r0', '2026-11-04T09:00:00Z'));
  await Promise.all([a.logins.catchUp('dev_b'), a.logins.catchUp('dev_b2')]);
  assert.equal(await read(path.join(shared, 'auth.json')), codexLogin('r2', '2026-11-04T11:00:00Z'), 'an older login never replaces it');

  const offs = [a.logins.attach(), b.logins.attach(), b2.logins.attach()];
  assert.ok(b.watchers.has(shared) && b2.watchers.has(shared), 'both companies watch the one home');
  await put(path.join(shared, 'auth.json'), codexLogin('r3', '2026-11-04T12:00:00Z')); // a turn of company 2 refreshed it
  b.watchers.get(shared)!('rename', 'auth.json');
  b2.watchers.get(shared)!('rename', 'auth.json');
  await until(async () => await read(path.join(a.own('acc_cx'), 'auth.json')) === codexLogin('r3', '2026-11-04T12:00:00Z'));
  assert.equal(await read(path.join(a.own('acc_cx'), 'auth.json')), codexLogin('r3', '2026-11-04T12:00:00Z'), 'the refresh reached the linked PC');
  assert.equal(await read(path.join(shared, 'auth.json')), codexLogin('r3', '2026-11-04T12:00:00Z'), 'and nothing older came back');
  for (const off of offs) off();
});

test('a login kept "Only on this PC" (17.11.2026, Account.thisPcOnly) is not sent – not at a link-up, not on a change of its file – until it is shared', async (t) => {
  const pcs = new Map<string, Pc>();
  const a = await makePc(pcs, 'dev_a');
  const b = await makePc(pcs, 'dev_b');
  t.after(async () => { for (const pc of [a, b]) await rm(pc.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  link(a, b);
  const kept = plan('acc_cx', 'codex', { home: a.own('acc_cx'), email: 'lena@example.com', thisPcOnly: true });
  a.accounts.push(kept);
  b.accounts.push(plan('acc_cx', 'codex', { home: b.own('acc_cx'), email: 'lena@example.com', state: 'needs_login' }));
  await put(path.join(a.own('acc_cx'), 'auth.json'), codexLogin('r1', '2026-11-04T10:00:00Z'));
  await a.logins.catchUp('dev_b');
  assert.equal(await read(path.join(b.own('acc_cx'), 'auth.json')), undefined, 'kept on this PC: the login does not go');
  assert.deepEqual(a.calls, [], 'no call at all');

  delete kept.thisPcOnly; // "On all PCs of this company"
  assert.equal(await a.logins.catchUp('dev_b'), true);
  assert.equal(await read(path.join(b.own('acc_cx'), 'auth.json')), codexLogin('r1', '2026-11-04T10:00:00Z'), 'shared: it goes');
});

test('21.11.2026: a login that comes before its account\'s row waits for the row and is taken when it arrives', async (t) => {
  const pcs = new Map<string, Pc>();
  const a = await makePc(pcs, 'dev_a');
  const b = await makePc(pcs, 'dev_b');
  t.after(async () => { for (const pc of [a, b]) await rm(pc.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  link(a, b);
  const off = b.logins.attach();
  t.after(off);
  a.accounts.push(plan('acc_cx', 'codex', { home: a.own('acc_cx'), email: 'lena@example.com' }));
  await put(path.join(a.own('acc_cx'), 'auth.json'), codexLogin('r0', '2026-11-04T09:00:00Z'));
  await a.logins.catchUp('dev_b');
  await put(path.join(a.own('acc_cx'), 'auth.json'), codexLogin('r1', '2026-11-04T10:00:00Z'));
  await a.logins.catchUp('dev_b');
  const there = path.join(b.own('acc_cx'), 'auth.json');
  assert.equal(await read(there), undefined, 'no account here yet: nothing written');

  const row = plan('acc_cx', 'codex', { home: b.own('acc_cx'), email: 'lena@example.com', state: 'needs_login' });
  b.accounts.push(row);
  b.s.bus.emit('account.upserted', row); // the row came (tables.ts emit)
  await until(async () => await read(there) !== undefined);
  assert.equal(await read(there), codexLogin('r1', '2026-11-04T10:00:00Z'), 'the newest login that waited is taken');
  assert.deepEqual(b.checked, ['acc_cx'], 'and the account is checked');
});

test('24.11.2026 (ORENDA): a PC that answers "forbidden" gets no more logins – not in rhythm, not on a change of a login – until a new connection, its role or version there, or a plan it was not tried with; the log says it once, its row says it', async (t) => {
  clearLoginsRefused('dev_b');
  const pcs = new Map<string, Pc>();
  const a = await makePc(pcs, 'dev_a');
  const b = await makePc(pcs, 'dev_b');
  t.after(async () => { clearLoginsRefused('dev_b'); for (const pc of [a, b]) await rm(pc.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const logged: string[] = [];
  (a.s as { log: unknown }).log = { debug() {}, warn() {}, error() {}, info: (message: string) => { logged.push(message); } };
  const rows: Array<{ loginsRefused?: unknown }> = [];
  (a.s.devices as unknown as { list: () => unknown[] }).list = () => [withLoginsRefused({ id: 'dev_b', name: 'dev_b' })];
  a.s.bus.on('device.upserted', (device) => { rows.push(device); });
  a.repo.upsert(record('dev_b')); // B does not know A as a link: it answers 'forbidden' (the old version's way with an employee's PC)
  a.accounts.push(plan('acc_cx', 'codex', { home: a.own('acc_cx'), email: 'lena@example.com' }));
  await put(path.join(a.own('acc_cx'), 'auth.json'), codexLogin('r1', '2026-11-04T10:00:00Z'));
  const sent = () => a.calls.filter((call) => call === 'dev_a->dev_b').length;
  const told = () => logged.filter((message) => message.startsWith('logins not sent')).length;

  assert.equal(await a.logins.catchUp('dev_b'), true);
  assert.equal(sent(), 1, 'one try');
  assert.ok(loginsRefused('dev_b'), 'the row of that PC says it refuses');
  assert.equal(rows.length, 1, 'and the windows hear of it once');
  assert.equal(told(), 1);
  for (let round = 0; round < 3; round++) assert.equal(await a.logins.catchUp('dev_b', true), true); // the rhythm
  assert.equal(sent(), 1, 'no more tries in rhythm');

  const off = a.logins.attach();
  t.after(off);
  await put(path.join(a.own('acc_cx'), 'auth.json'), codexLogin('r2', '2026-11-04T11:00:00Z')); // the CLI refreshed the login
  a.watchers.get(a.own('acc_cx'))!('rename', 'auth.json');
  await settle();
  assert.equal(sent(), 1, 'a refreshed login of the same plan is no reason either');

  assert.equal(await a.logins.catchUp('dev_b'), true); // a new connection
  assert.equal(sent(), 2, 'a new connection tries once');
  assert.equal(await a.logins.catchUp('dev_b', true), true);
  assert.equal(sent(), 2);
  assert.equal(told(), 1, 'the log says it once for this PC and this reason');

  a.repo.patch('dev_b', { caps: { version: '0.3.20' } }); // that PC updated
  await a.logins.catchUp('dev_b', true);
  assert.equal(sent(), 3, 'another version there: one new try');
  await a.logins.catchUp('dev_b', true);
  assert.equal(sent(), 3);
  assert.equal(told(), 2, 'a changed state is news again');

  a.accounts.push(plan('acc_cy', 'codex', { home: a.own('acc_cy'), email: 'team@example.com' }));
  await put(path.join(a.own('acc_cy'), 'auth.json'), codexLogin('t1', '2026-11-04T10:00:00Z', 'org-2'));
  await a.logins.catchUp('dev_b', true);
  assert.equal(sent(), 4, 'a plan it was not tried with is tried');
  await a.logins.catchUp('dev_b', true);
  assert.equal(sent(), 4);

  b.repo.upsert(record('dev_a', { joinedAs: 'ceo' })); // B takes A as its CEO PC now
  b.accounts.push(plan('acc_cx', 'codex', { home: b.own('acc_cx'), email: 'lena@example.com', state: 'needs_login' }));
  assert.equal(await a.logins.catchUp('dev_b'), true);
  assert.equal(await read(path.join(b.own('acc_cx'), 'auth.json')), codexLogin('r2', '2026-11-04T11:00:00Z'), 'taken at the next connection');
  assert.equal(loginsRefused('dev_b'), undefined, 'and the row says nothing any more');
});

test('22.11.2026: a plan whose login is rejected here asks the PCs that share it at once, and gets the newer login', async (t) => {
  const pcs = new Map<string, Pc>();
  const a = await makePc(pcs, 'dev_a');
  const b = await makePc(pcs, 'dev_b');
  t.after(async () => { for (const pc of [a, b]) await rm(pc.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  link(a, b);
  a.accounts.push(plan('acc_cx', 'codex', { home: a.own('acc_cx'), email: 'lena@example.com' }));
  b.accounts.push(plan('acc_cx', 'codex', { home: b.own('acc_cx'), email: 'lena@example.com' }));
  await put(path.join(a.own('acc_cx'), 'auth.json'), codexLogin('r1', '2026-11-04T10:00:00Z'));
  await a.logins.catchUp('dev_b');
  await put(path.join(a.own('acc_cx'), 'auth.json'), codexLogin('r2', '2026-11-04T12:00:00Z')); // A refreshed while the link was down: B has the rotated one
  const off = b.logins.attach();
  t.after(off);
  b.accounts[0] = { ...b.accounts[0], state: 'needs_login' };
  b.s.bus.emit('account.upserted', b.accounts[0]);
  await until(async () => await read(path.join(b.own('acc_cx'), 'auth.json')) === codexLogin('r2', '2026-11-04T12:00:00Z'));
  assert.equal(await read(path.join(b.own('acc_cx'), 'auth.json')), codexLogin('r2', '2026-11-04T12:00:00Z'), 'the rejected plan got the newer login at once');
  const asked = b.calls.length;
  assert.ok(asked >= 1, 'it asked A');
  b.s.bus.emit('account.upserted', b.accounts[0]);
  await settle();
  assert.equal(b.calls.length, asked, 'it asks at most every 30 s');
});
