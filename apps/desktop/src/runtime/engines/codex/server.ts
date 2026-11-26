// One long-lived `codex app-server --listen stdio://` per account home (CODEX_HOME – an Autark-owned folder per account,
// accounts/cli-homes.ts, so nothing of the person's own Codex set-up reaches an agent). It starts with the computer/browser
// features off (our guarded tools replace them) and isolation.ts's server-wide config, in `cwd`, an empty folder no turn
// works in. Its env is the agents' env (engines/wf-shim.ts) with Codex's own rg and, on Windows, PowerShell 7 for its shells.
// It restarts between turns – never during one – when another codex.exe is to run, when PowerShell 7 arrived after it
// started, or when its home's login file changed (a sign-in, a login from a linked PC or one taken again from the default
// home), so it always runs on the login that is there.
// Owns: the process lease, the initialize handshake (and the Codex version its userAgent names), routing notifications and
// server requests to the thread that owns them, the account-level limits push and the idle shutdown after 10 min without
// turns. Never: reads CODEX_HOME files (only the login file's stamp) – the official CLI owns authentication.

import type { Supervisor, Lease } from '../../system/supervisor.ts';
import type { Executable, ExecutableFinder } from '../../accounts/executables.ts';
import { RpcClient, RpcError } from './rpc.ts';
import type { RpcNote } from '../line-rpc.ts';
import { SERVER_CONFIG, WORKSPACE_FEATURES } from './isolation.ts';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { loginFiles } from '../../accounts/cli-homes.ts';
import { IdleTimer, str } from '../shared.ts';
import { pwshDir, withTools } from '../wf-shim.ts';
import { ENV_KEY_PROVIDERS } from '../../../shared/model/providers.ts';

export interface ThreadHandler {
  onNotification(note: RpcNote): void;
  onServerRequest(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/** Features turned off because they bypass our own guarded tools (human-priority computer/browser control). */
const UNSAFE_FEATURES = ['computer_use', 'browser_use'];

/**
 * Env vars never handed to engine processes (keys stay in-process for HTTP engines only): every
 * provider key variable of the one env → provider table (PR5 ENV_KEY_PROVIDERS), OLLAMA_API_KEY included.
 */
export const STRIPPED_ENV: readonly string[] = Object.keys(ENV_KEY_PROVIDERS);

export function childEnv(base: NodeJS.ProcessEnv, extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of STRIPPED_ENV) delete env[key];
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) env[key] = value;
  return env;
}

export interface CodexServerOptions {
  key: string; // account id (lease owner)
  home?: string; // CODEX_HOME (the account's own; undefined: the env's CODEX_HOME – tests only)
  executable: Executable;
  supervisor: Supervisor;
  cwd: string;
  version: string;
  env?: NodeJS.ProcessEnv;
  idleMs?: number;
  onLimits?: (params: Record<string, unknown>) => void;
  onExit?: () => void;
  /** A warning for the runtime log (the reason a connection closed). */
  log?: (message: string, data: Record<string, unknown>) => void;
  lifecycle?: (message: string, data: Record<string, unknown>) => void;
}

/** A file's stamp ("<mtime>:<size>"), '' when it is missing or unreadable. */
export async function fileStamp(file: string): Promise<string> {
  try {
    const stat = await fsp.stat(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return '';
  }
}

/** This codex.exe lost its helper (an update while it ran): the next process of every account starts from what this PC has now. */
export async function pickAgain(finder: Pick<ExecutableFinder, 'find'>, servers: Iterable<CodexServer>): Promise<void> {
  const executable = await finder.find('codex', { force: true }).catch(() => null);
  if (executable) for (const server of servers) server.useExecutable(executable);
}

export class CodexServer {
  readonly key: string;
  private options: CodexServerOptions;
  private restartDue = false;
  private launchedWithoutPwsh = false; // started on Windows before PowerShell 7 was there
  private lease: Lease | undefined;
  private client: RpcClient | undefined;
  private starting: Promise<RpcClient> | undefined;
  private readonly threads = new Map<string, ThreadHandler>();
  private readonly idle: IdleTimer;
  private loginStamp: string | undefined; // the home's login file when the process started
  /** The Codex version from initialize's userAgent (undefined until a start, or when it names none). */
  cliVersion: string | undefined;

  constructor(options: CodexServerOptions) {
    this.options = options;
    this.key = options.key;
    this.idle = new IdleTimer(options.idleMs, () => void this.dispose(), options.lifecycle
      ? (durationMs, end) => options.lifecycle?.('codex server without a turn hold', { account: this.key, durationMs, end })
      : undefined);
  }

  get running(): boolean { return Boolean(this.client && !this.client.isClosed); }

  /** The open connection, if any – never starts or restarts the process (C4: "Stop all work" reaches only what runs). */
  get current(): RpcClient | undefined { return this.running ? this.client : undefined; }

  async rpc(reason: 'account-check' | 'work' = 'work'): Promise<RpcClient> {
    const running = this.client && !this.client.isClosed ? this.client : undefined;
    // Restart between turns (a running turn is never cut): another codex.exe, PowerShell 7 arrived, or the login file changed.
    if (running && !this.idle.busy && !this.starting && (this.restartDue || this.pwshArrived() || await this.loginChanged()) && this.client === running && !this.idle.busy) {
      this.restartDue = false;
      await this.dispose();
    }
    if (this.client && !this.client.isClosed) return this.client;
    if (!this.starting) this.starting = this.start().then((client) => {
      this.options.lifecycle?.('codex server cold start', { account: this.key, reason });
      return client;
    }).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  /** The executable of the next start; a running process of another one ends between turns. */
  useExecutable(executable: Executable): void {
    if (executable.command === this.options.executable.command) return;
    this.options = { ...this.options, executable };
    this.restartDue = true;
  }

  register(threadId: string, handler: ThreadHandler): () => void {
    this.threads.set(threadId, handler);
    return () => { if (this.threads.get(threadId) === handler) this.threads.delete(threadId); };
  }

  /** Marks a turn as running (prevents idle shutdown). Returns the end function. */
  beginTurn(): () => void {
    return this.idle.hold();
  }

  async dispose(): Promise<void> {
    this.idle.clear();
    const lease = this.lease;
    this.client?.close(new Error('codex server disposed'));
    this.client = undefined;
    this.lease = undefined;
    this.threads.clear();
    await lease?.release();
  }

  /** This server's shells are 5.1 while a PowerShell 7 is there now. */
  private pwshArrived(): boolean {
    return this.launchedWithoutPwsh && Boolean(pwshDir(this.options.env ?? process.env));
  }

  /** The home's login file (none without a home of its own: the env's CODEX_HOME, tests). */
  private loginFile(): string | undefined {
    return this.options.home ? path.join(this.options.home, loginFiles('codex')[0]) : undefined;
  }

  /** The login file changed since the process started. */
  private async loginChanged(): Promise<boolean> {
    const file = this.loginFile();
    return file !== undefined && this.loginStamp !== undefined && await fileStamp(file) !== this.loginStamp;
  }

  private async start(): Promise<RpcClient> {
    const file = this.loginFile();
    this.loginStamp = file ? await fileStamp(file) : undefined;
    return this.launch();
  }

  private async launch(): Promise<RpcClient> {
    const { executable, supervisor, home } = this.options;
    const off = [...UNSAFE_FEATURES, ...WORKSPACE_FEATURES];
    const args = [
      ...executable.prefixArgs, 'app-server', '--listen', 'stdio://',
      ...off.flatMap((name) => ['-c', `features.${name}=false`]), ...SERVER_CONFIG.flatMap((pair) => ['-c', pair]),
    ];
    // An npm-installed Codex runs as node.exe with codex.js – no Codex rg beside that, so only a codex.exe is named.
    const codexExe = /(^|[\\/])codex\.exe$/i.test(executable.command) ? executable.command : undefined;
    const env = withTools(childEnv(this.options.env ?? process.env, { CODEX_HOME: home }), process.platform, codexExe);
    this.launchedWithoutPwsh = process.platform === 'win32' && !pwshDir(env);
    const lease = supervisor.spawn({
      command: executable.command, args, owner: `codex:${this.key}`, kind: 'heavy', cwd: this.options.cwd, env, stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.lease = lease;
    const client = new RpcClient(lease.child);
    client.handler = (method, params) => this.route(method, params);
    client.onNotification((note) => this.dispatch(note));
    client.onClose((closed) => {
      if (this.client === client) { this.idle.clear(); this.client = undefined; this.lease = undefined; }
      // 18.11.2026: the process of a closed connection ends with it. Before, the lease was only forgotten: every closed connection
      // left its app-server running (four at once on the server), the next call started another, and a thread delete found
      // its thread "already has an active writer" in the one left behind.
      void lease.release().catch(() => undefined);
      if (!/disposed/.test(closed.message)) this.options.log?.('codex connection closed', { account: this.key, reason: closed.message });
      for (const handler of this.threads.values()) handler.onNotification({ method: 'workforce/closed', params: {} });
      this.threads.clear();
      this.options.onExit?.();
    });
    try {
      const init = await client.request<{ userAgent?: unknown }>('initialize', {
        clientInfo: { name: 'workforce', title: 'Autark', version: this.options.version },
        capabilities: { experimentalApi: true }, // dynamicTools and inject_items are experimental
      }, 30_000);
      // "<client>/0.165.0-alpha.1.2 (…)" – the Codex version the rebuild probe is kept for.
      this.cliVersion = /\/(\d+\.\d+\.\d+[^\s()]*)/.exec(typeof init?.userAgent === 'string' ? init.userAgent : '')?.[1] ?? this.cliVersion;
      client.notify('initialized', {});
    } catch (error) {
      client.close(error as Error);
      await lease.release();
      if (this.lease === lease) this.lease = undefined;
      throw error;
    }
    this.client = client;
    this.idle.arm();
    return client;
  }

  private threadOf(params: Record<string, unknown>): ThreadHandler | undefined {
    const id = str(params.threadId) ?? str(params.conversationId);
    return id ? this.threads.get(id) : undefined;
  }

  private dispatch(note: RpcNote): void {
    if (note.method === 'account/rateLimits/updated') { this.options.onLimits?.(note.params); }
    this.threadOf(note.params)?.onNotification(note);
  }

  private route(method: string, params: Record<string, unknown>): Promise<unknown> {
    const thread = this.threadOf(params);
    if (!thread) return Promise.reject(new RpcError(-32601, 'No active Autark turn for this request.'));
    return thread.onServerRequest(method, params);
  }
}
