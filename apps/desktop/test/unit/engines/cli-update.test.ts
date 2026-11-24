// Claude Code and Codex keep themselves current (engines/cli-update.ts, Fest 22.11.2026 – before: Claude Code only). Claude by
// `claude update`; Codex by `codex update` (standalone, brew, bun, pnpm) or, in npm's global folder, by
// `npm install -g @openai/codex@latest`; a copy inside an app (the Codex desktop app) not at all. Only while none of that CLI's
// processes of the runtime runs, only for a profile with an account of that CLI in use on this PC, never in a test profile or
// the demo; "updated" means the CLI names another version afterwards, and only then the catalog lists again.
// Owns: these assertions only. Never runs a real CLI or installer (scripted supervisor and finder).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliBusy, keepClisCurrent, updateCli, type CliUpdateDeps, type UpdatedCli } from '../../../src/runtime/engines/cli-update.ts';
import type { Executable, ExecutableFinder } from '../../../src/runtime/accounts/executables.ts';
import { fakeSpawn, testSupervisor, type SpawnCall } from './fakes.ts';

const LOCAL = 'C:\\Users\\p\\AppData\\Local';
const STANDALONE = `${LOCAL}\\Programs\\OpenAI\\Codex\\bin\\codex.exe`;
const DESKTOP_COPY = `${LOCAL}\\OpenAI\\Codex\\bin\\f71a721e0e6193a9\\codex.exe`; // measured on the owner's PC 22.11.2026
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const NPM = 'C:\\Program Files\\nodejs\\npm.cmd';
const NPM_CODEX: Executable = { command: NODE, prefixArgs: ['C:\\Users\\p\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'], path: 'C:\\Users\\p\\AppData\\Roaming\\npm\\codex.cmd' };
const CLAUDE = 'C:\\Users\\p\\.local\\bin\\claude.exe';

type Acc = { provider: string; enabled: boolean; deviceId?: string };
const exe = (file: string): Executable => ({ command: file, prefixArgs: [], path: file });

/** A process the test starts as the runtime's own work: a Codex app-server or a Claude turn (print mode). */
const work = (call: SpawnCall) => call.args.includes('app-server') || call.args.includes('-p');

/**
 * updateCli over a scripted PC: `--version` names the installed version, the runtime's own work runs until it is stopped,
 * any other command "installs" `next` and exits with `code` (or hangs).
 */
function rig(found: Record<string, Executable | null>, options: { version?: string; next?: string; code?: number | 'hang'; accounts?: Acc[]; env?: NodeJS.ProcessEnv } = {}) {
  let version = options.version ?? '0.167.0';
  const { spawn, calls } = fakeSpawn((call: SpawnCall) => {
    if (work(call)) return;
    setImmediate(() => {
      if (call.args.at(-1) === '--version') { call.child.stdout.write(`codex-cli ${version}\n`); call.child.exit(0); return; }
      if (options.code === 'hang') return;
      if ((options.code ?? 0) === 0) version = options.next ?? version;
      call.child.exit(options.code ?? 0);
    });
  });
  const supervisor = testSupervisor(spawn);
  const log = { infos: [] as Array<[string, unknown]>, warns: [] as string[], info(msg: string, data?: unknown) { this.infos.push([msg, data]); }, warn(msg: string) { this.warns.push(msg); } };
  const updated: UpdatedCli[] = [];
  let clears = 0;
  const finder = { find: async (id: string) => found[id] ?? null, clear: () => { clears++; } } as unknown as ExecutableFinder;
  const accounts = options.accounts ?? [{ provider: 'codex', enabled: true }, { provider: 'claude', enabled: true }];
  const deps: CliUpdateDeps = {
    supervisor, finder, log, onUpdated: (cli) => { updated.push(cli); }, accounts: () => accounts as ReturnType<CliUpdateDeps['accounts']>,
    env: options.env ?? { PATH: 'C:\\Windows' }, testProfile: false, platform: 'win32', cwd: 'C:\\temp',
  };
  const lines = () => calls.filter((call) => !work(call)).map((call) => [call.command, ...call.args].join(' '));
  return { deps, calls, lines, log, supervisor, updated, accounts, clears: () => clears };
}

test('an update to a Codex not on the verified list warns in the runtime log; a listed one does not (task_76a7vybn)', async () => {
  const listed = rig({ codex: exe(STANDALONE) }, { next: '0.172.0' });
  assert.equal(await updateCli('codex', listed.deps), 'updated');
  assert.deepEqual(listed.log.warns, []);
  const unchecked = rig({ codex: exe(STANDALONE) }, { next: '0.173.0' });
  assert.equal(await updateCli('codex', unchecked.deps), 'updated', 'the update itself stands');
  assert.deepEqual(unchecked.log.warns, ['Codex 0.173.0 is not on the verified list: sessions start anew after a restart until Autark lists it']);
  assert.deepEqual(unchecked.updated, ['codex'], 'the catalog lists again as for any update');
});

test('a standalone Codex updates with its own `codex update`; a new version lists the Codex accounts again', async () => {
  const r = rig({ codex: exe(STANDALONE) }, { next: '0.171.0' });
  assert.equal(await updateCli('codex', r.deps), 'updated');
  assert.deepEqual(r.lines(), [`${STANDALONE} --version`, `${STANDALONE} update`, `${STANDALONE} --version`]);
  assert.deepEqual(r.updated, ['codex']);
  assert.deepEqual(r.log.infos, [['Codex updated', { from: '0.167.0', to: '0.171.0' }]]);
  assert.equal(r.clears(), 1, 'the finder looks again');
  assert.equal(r.calls[1].options.cwd, 'C:\\temp');
});

test('a Codex in npm\'s global folder updates by npm itself – its own updater would run npm from inside the locked codex.exe', async () => {
  const r = rig({ codex: NPM_CODEX, npm: exe(NPM) }, { next: '0.171.0' });
  assert.equal(await updateCli('codex', r.deps), 'updated');
  assert.deepEqual(r.lines(), [
    `${NODE} ${NPM_CODEX.prefixArgs[0]} --version`, 'cmd.exe /d /s /c npm install -g @openai/codex@latest', `${NODE} ${NPM_CODEX.prefixArgs[0]} --version`,
  ]);
  assert.deepEqual(r.updated, ['codex']);

  const pnpm: Executable = { command: NODE, prefixArgs: [`${LOCAL}\\pnpm\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js`], path: `${LOCAL}\\pnpm\\codex.cmd` };
  const other = rig({ codex: pnpm, npm: exe(NPM) }, { next: '0.171.0' });
  assert.equal(await updateCli('codex', other.deps), 'updated');
  assert.equal(other.lines()[1], `${NODE} ${pnpm.prefixArgs[0]} update`, 'pnpm keeps its own place: Codex\'s own updater knows it');
});

test('the Codex desktop app\'s own copy is left to the app: nothing runs', async () => {
  for (const file of [DESKTOP_COPY, 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1117.4957.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe', '/Applications/Codex.app/Contents/Resources/codex']) {
    const r = rig({ codex: exe(file) }, { next: '0.171.0' });
    assert.equal(await updateCli('codex', r.deps), 'app', file);
    assert.equal(r.calls.length, 0, file);
    assert.deepEqual([r.updated.length, r.log.warns.length, r.log.infos.length], [0, 0, 0]);
  }
});

test('the same version afterwards is current: no relist, no log line', async () => {
  const r = rig({ codex: exe(STANDALONE) }, { next: '0.167.0' });
  assert.equal(await updateCli('codex', r.deps), 'current');
  assert.equal(r.lines().length, 3);
  assert.deepEqual([r.updated.length, r.log.infos.length, r.log.warns.length, r.clears()], [0, 0, 0, 0]);
});

test('a failed or stopped update is failed – one warning without output, nothing relisted', async () => {
  const r = rig({ codex: exe(STANDALONE) }, { code: 1, next: '0.171.0' });
  assert.equal(await updateCli('codex', r.deps), 'failed');
  assert.deepEqual(r.log.warns, ['Codex update failed']);
  assert.equal(r.lines().length, 2, 'no version read after a failure');
  const hung = rig({ claude: exe(CLAUDE) }, { code: 'hang' });
  assert.equal(await updateCli('claude', { ...hung.deps, timeoutMs: 20 }), 'failed');
  assert.deepEqual(hung.log.warns, ['Claude Code update failed']);
  assert.equal(hung.updated.length + r.updated.length, 0);
});

test('no update while a Codex app-server of the runtime runs; once it ended, the update runs and the next one starts from the new binary', async () => {
  const r = rig({ codex: exe(STANDALONE) }, { next: '0.171.0' });
  const server = r.supervisor.spawn({ command: STANDALONE, args: ['app-server', '--listen', 'stdio://'], owner: 'codex:acc_1', kind: 'heavy' });
  assert.ok(cliBusy(r.supervisor, 'codex'));
  assert.equal(cliBusy(r.supervisor, 'claude'), false, 'a Codex process does not hold Claude Code');
  assert.equal(await updateCli('codex', r.deps), 'busy');
  assert.equal(r.lines().length, 0);
  await server.release();
  assert.equal(await updateCli('codex', r.deps), 'updated');
  assert.deepEqual(r.updated, ['codex']);
});

test('Claude Code keeps its own `claude update`, read from the version before and after (live 2.1.303 → 2.1.321)', async () => {
  const r = rig({ claude: exe(CLAUDE) }, { version: '2.1.303', next: '2.1.321' });
  assert.equal(await updateCli('claude', r.deps), 'updated');
  assert.deepEqual(r.lines(), [`${CLAUDE} --version`, `${CLAUDE} update`, `${CLAUDE} --version`]);
  assert.deepEqual(r.log.infos, [['Claude Code updated', { from: '2.1.303', to: '2.1.321' }]]);
  assert.deepEqual(r.updated, ['claude']);
  const busy = rig({ claude: exe(CLAUDE) });
  const turn = busy.supervisor.spawn({ command: CLAUDE, args: ['-p'], owner: 'claude:run_1', kind: 'heavy' });
  assert.equal(await updateCli('claude', busy.deps), 'busy');
  assert.equal(busy.lines().length, 0);
  await turn.release();
});

test('an updater never gets a provider key; the rest of the env stays', async () => {
  const r = rig({ codex: exe(STANDALONE) }, { next: '0.171.0', env: { PATH: 'C:\\Windows', OPENAI_API_KEY: 'sk-secret', ANTHROPIC_API_KEY: 'sk-ant' } });
  await updateCli('codex', r.deps);
  for (const call of r.calls) {
    assert.equal(call.options.env?.OPENAI_API_KEY, undefined);
    assert.equal(call.options.env?.ANTHROPIC_API_KEY, undefined);
    assert.equal(call.options.env?.PATH, 'C:\\Windows');
  }
});

test('a PC\'s CLI is updated only for a profile with an account of it in use here – never a test profile, the demo or a missing CLI (FIXES-4 G3)', async () => {
  const runs = async (cli: UpdatedCli, accounts: Acc[], patch: Partial<CliUpdateDeps> = {}, found: Record<string, Executable | null> = { codex: exe(STANDALONE), claude: exe(CLAUDE) }) => {
    const r = rig(found, { accounts, next: '9.9.9' });
    return { outcome: await updateCli(cli, { ...r.deps, ...patch }), calls: r.calls.length };
  };
  assert.deepEqual(await runs('codex', [{ provider: 'codex', enabled: true }]), { outcome: 'updated', calls: 3 });
  assert.deepEqual(await runs('codex', [{ provider: 'claude', enabled: true }]), { outcome: 'unused', calls: 0 }, 'no Codex account');
  assert.deepEqual(await runs('codex', [{ provider: 'codex', enabled: false }]), { outcome: 'unused', calls: 0 }, 'every Codex account off');
  assert.deepEqual(await runs('codex', [{ provider: 'codex', enabled: true, deviceId: 'dev_other' }]), { outcome: 'unused', calls: 0 }, 'a Codex account of another PC');
  assert.deepEqual(await runs('codex', [{ provider: 'codex', enabled: true }], { testProfile: true }), { outcome: 'unused', calls: 0 }, 'a test profile');
  assert.deepEqual(await runs('codex', [{ provider: 'codex', enabled: true }], { demo: true }), { outcome: 'missing', calls: 0 }, 'the demo');
  assert.deepEqual(await runs('codex', [{ provider: 'codex', enabled: true }], {}, { codex: null }), { outcome: 'missing', calls: 0 }, 'no Codex on this PC: nothing is installed');
  assert.deepEqual(await runs('claude', [{ provider: 'codex', enabled: true }]), { outcome: 'unused', calls: 0 }, 'a Codex account does not update Claude Code');
});

test('the test profile is read from the runtime\'s own env, not from the env the update process gets (review R2)', async () => {
  const before = process.env.WORKFORCE_TEST_DATA;
  process.env.WORKFORCE_TEST_DATA = 'C:\\profile';
  try {
    const r = rig({ codex: exe(STANDALONE) }, { next: '0.171.0' });
    const { testProfile: _, ...deps } = r.deps;
    assert.equal(await updateCli('codex', { ...deps, env: { PATH: '/bin' } }), 'unused');
    assert.equal(r.calls.length, 0);
  } finally {
    if (before === undefined) delete process.env.WORKFORCE_TEST_DATA; else process.env.WORKFORCE_TEST_DATA = before;
  }
});

test('one cycle per CLI: an account that arrives after the first attempt gets its update at the next short retry (review R1)', async () => {
  const r = rig({ codex: exe(STANDALONE), claude: exe(CLAUDE) }, { accounts: [], next: '0.171.0' });
  const stop = keepClisCurrent({ ...r.deps, firstAfterMs: 1, retryMs: 30, everyMs: 60 * 60_000 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(r.calls.length, 0, 'no account at the first attempt');
    r.accounts.push({ provider: 'codex', enabled: true });
    for (let waited = 0; r.updated.length === 0 && waited < 3_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(r.lines(),[`${STANDALONE} --version`, `${STANDALONE} update`, `${STANDALONE} --version`], 'Codex only: Claude Code has no account');
    assert.deepEqual(r.updated, ['codex']);
  } finally { stop(); }
  const calls = r.calls.length;
  r.accounts.push({ provider: 'claude', enabled: true });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(r.calls.length, calls, 'stopped: no further attempt');
});
