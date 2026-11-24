// Keeps the engine CLIs current – Claude Code and Codex, one cycle each. A CLI learns a provider's new model only with a new
// version (live 09.11.2026: Claude Code 2.1.303 knew no Fable 5.2, 2.1.321 did; 22.11.2026: a ChatGPT plan lists only what the
// installed Codex's own app-server answers to model/list), and the engines run both in modes that never update themselves – an
// npm install stayed weeks behind. So each CLI is updated shortly after start and every 6 h; when it names another version
// afterwards, the catalog lists again and the provider's new models are there. Fest 22.11.2026: one module for both (it was
// engines/claude/cli-update.ts, Claude only).
// The route per install: the CLI's own updater – `claude update`; `codex update`, which runs the official install.ps1/install.sh
// for the standalone install and brew's, bun's or pnpm's own command for theirs (read in Codex 0.167 and its source); a Codex in
// npm's global folder by npm itself (`npm install -g @openai/codex@latest`, accounts/install.ts), because Codex's own updater would
// run npm from inside the codex.exe npm has to replace, and Windows keeps a running exe locked; a copy inside an app (the Codex
// desktop app's own bin folder, a Store package, an app bundle) not at all – the app brings its own (`codex update` there answers
// "Could not detect the Codex installation method").
// The install is the PC's – other profiles and the person's own terminals share it – so only a profile with an account of that
// CLI in use on this PC updates it; a test profile (WORKFORCE_TEST_DATA, FIXES-4 G3) and the demo never do. No process of that
// CLI of the runtime runs meanwhile (Windows cannot replace a running exe). An update keeps the CLI's path – the standalone's bin
// is a junction to the new release, npm's script stays – so the next process, a Codex app-server too, starts from the new binary.
// Owns: when an update runs, its route per install, its 10-minute limit and the outcome from the version before and after.
// Never: installs a CLI where none is found (accounts/install.ts does on request), hands provider keys to an updater, or logs
// output.

import * as path from 'node:path';
import type { Supervisor } from '../system/supervisor.ts';
import type { Executable, ExecutableFinder } from '../accounts/executables.ts';
import { runCli } from '../accounts/cli.ts';
import { npmInstaller, type InstallRoute } from '../accounts/install.ts';
import { childEnv } from './codex/server.ts';
import { verifiedCli } from './managed-path.ts';
import type { Account } from '../../shared/model/providers.ts';

/** The CLIs that are kept current (each one's CLI id is its provider id). */
export type UpdatedCli = 'claude' | 'codex';
const UPDATED_CLIS: readonly UpdatedCli[] = ['claude', 'codex'];
const NAME: Record<UpdatedCli, string> = { claude: 'Claude Code', codex: 'Codex' };

export interface CliUpdateDeps {
  supervisor: Supervisor;
  finder: ExecutableFinder;
  log: { info(msg: string, data?: Record<string, unknown>): void; warn(msg: string, data?: Record<string, unknown>): void };
  /** After a new version was installed (the catalog lists the accounts again). */
  onUpdated(cli: UpdatedCli): void;
  /** This profile's accounts, read at each attempt. */
  accounts(): readonly Pick<Account, 'provider' | 'enabled' | 'deviceId'>[];
  /** Default: the runtime's own WORKFORCE_TEST_DATA (`env` is only the update process's). */
  testProfile?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  demo?: boolean;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

/** 'app': a copy inside an app, which brings its own updates – nothing runs. */
export type CliUpdateOutcome = 'updated' | 'current' | 'busy' | 'missing' | 'unused' | 'failed' | 'app';

const UPDATE_TIMEOUT_MS = 10 * 60_000;
const VERSION_TIMEOUT_MS = 30_000;
const FIRST_AFTER_MS = 2 * 60_000;
const EVERY_MS = 6 * 60 * 60_000;
const RETRY_MS = 10 * 60_000;
/** A copy inside an app: the Codex desktop app's hashed folder (%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\), a Store package, an app bundle. */
const IN_APP = /[\\/]OpenAI[\\/]Codex[\\/]bin[\\/][^\\/]+[\\/]|[\\/]WindowsApps[\\/]|\.app[\\/]Contents[\\/]/i;
/** "2.1.321 (Claude Code)", "codex-cli 0.171.0-alpha.13". */
const VERSION = /\d+\.\d+\.\d+[^\s()]*/;

/** True while a process of this CLI of the runtime runs (turns, app-servers, checks, probes): their lease owners start with its id. */
export function cliBusy(supervisor: Pick<Supervisor, 'leases'>, cli: UpdatedCli): boolean {
  return supervisor.leases().some((lease) => lease.owner.startsWith(cli));
}

/** True when an account of this CLI is on and runs on this PC, outside a test profile. */
function inUse(deps: Pick<CliUpdateDeps, 'accounts' | 'testProfile'>, cli: UpdatedCli): boolean {
  if (deps.testProfile ?? Boolean(process.env.WORKFORCE_TEST_DATA)) return false;
  return deps.accounts().some((account) => account.provider === cli && account.enabled && !account.deviceId);
}

/** A Codex in npm's global folder: its shim beside `node_modules\@openai\codex` (npm's layout; pnpm, yarn and bun keep theirs elsewhere). */
function npmCodex(exe: Executable): boolean {
  const own = `${path.win32.join(path.win32.dirname(exe.path), 'node_modules', '@openai', 'codex')}\\`.toLowerCase();
  return [exe.command, ...exe.prefixArgs].some((part) => part.toLowerCase().startsWith(own));
}

/** How this install updates (see the header); undefined for a copy inside an app. */
async function updateRoute(cli: UpdatedCli, exe: Executable, deps: Pick<CliUpdateDeps, 'finder' | 'platform'>, env: NodeJS.ProcessEnv): Promise<InstallRoute | undefined> {
  if (IN_APP.test(exe.command) || IN_APP.test(exe.path)) return undefined;
  const npm = cli === 'codex' && npmCodex(exe) ? await deps.finder.find('npm') : null;
  if (npm) return npmInstaller(npm, deps.platform ?? process.platform, env);
  return { command: exe.command, args: [...exe.prefixArgs, 'update'], env };
}

/** The version the CLI names; undefined when it does not answer. */
async function versionOf(cli: UpdatedCli, exe: Executable, deps: CliUpdateDeps, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const result = await runCli(deps.supervisor, exe, ['--version'], { env, cwd: deps.cwd, timeoutMs: VERSION_TIMEOUT_MS, owner: `${cli}-update` }).catch(() => undefined);
  return result?.code === 0 ? VERSION.exec(result.stdout)?.[0] : undefined;
}

/** One update attempt of one CLI. */
export async function updateCli(cli: UpdatedCli, deps: CliUpdateDeps): Promise<CliUpdateOutcome> {
  if (deps.demo) return 'missing';
  if (!inUse(deps, cli)) return 'unused';
  const exe = await deps.finder.find(cli);
  if (!exe) return 'missing';
  const env = childEnv(deps.env ?? process.env, {});
  const route = await updateRoute(cli, exe, deps, env);
  if (!route) return 'app';
  if (cliBusy(deps.supervisor, cli)) return 'busy';
  const before = await versionOf(cli, exe, deps, env);
  const result = await runCli(deps.supervisor, { command: route.command, prefixArgs: [], path: route.command }, route.args, {
    env: route.env ?? env, cwd: deps.cwd, timeoutMs: deps.timeoutMs ?? UPDATE_TIMEOUT_MS, owner: `${cli}-update`, maxBytes: 64 * 1024,
  }).catch(() => undefined);
  if (!result || result.timedOut || result.code !== 0) {
    deps.log.warn(`${NAME[cli]} update failed`, { code: result?.code ?? null, timedOut: result?.timedOut ?? false });
    return 'failed';
  }
  const after = await versionOf(cli, exe, deps, env);
  if (!after || after === before) return 'current';
  deps.finder.clear();
  deps.log.info(`${NAME[cli]} updated`, { from: before ?? null, to: after });
  // Not yet controlled (the version watch in the CI harness checks each new npm latest within a day): its sessions start anew
  // from the filtered history after each restart until Autark lists it – a cost, not a leak.
  if (!verifiedCli(cli, after)) deps.log.warn(`${NAME[cli]} ${after} is not on the verified list: sessions start anew after a restart until Autark lists it`, { version: after });
  deps.onUpdated(cli);
  return 'updated';
}

/**
 * Starts one update cycle per CLI (first shortly after start, then every 6 h); a busy runtime, or a profile whose first
 * account of that CLI is not there yet, tries again in 10 min (that retry only reads the account list). Returns stop.
 */
export function keepClisCurrent(deps: CliUpdateDeps & { firstAfterMs?: number; everyMs?: number; retryMs?: number }): () => void {
  const timers = new Map<UpdatedCli, ReturnType<typeof setTimeout>>();
  let stopped = false;
  const plan = (cli: UpdatedCli, ms: number) => {
    if (stopped) return;
    const timer = setTimeout(() => {
      void updateCli(cli, deps)
        .catch(() => 'failed' as const)
        .then((outcome) => plan(cli, outcome === 'busy' || outcome === 'unused' ? deps.retryMs ?? RETRY_MS : deps.everyMs ?? EVERY_MS));
    }, ms);
    timer.unref?.();
    timers.set(cli, timer);
  };
  for (const cli of UPDATED_CLIS) plan(cli, deps.firstAfterMs ?? FIRST_AFTER_MS);
  return () => { stopped = true; for (const timer of timers.values()) clearTimeout(timer); };
}
