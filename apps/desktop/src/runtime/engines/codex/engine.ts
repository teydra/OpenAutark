// Codex engine: persistent threads on one app-server per account home (every account has a home of its own, accounts/cli-homes.ts).
// Each thread opens lean (helper-thread.ts), read-only and with the workspace untrusted (isolation.ts); each turn sets its own
// sandbox and approvals. A helper turn (no tools, no hub, no session) runs on an ephemeral thread without environment,
// unloaded after the turn; an agent turn asks for reasoning summaries, a helper turn for none. Every turn gets the live
// context in front of its input (never in the instructions); a thread the server refuses to resume, or a loaded one whose turn
// now runs in another folder, is reported as ended (details.rebase / details.folder) so the executor renews the session.
// fork() copies a parent thread into a split's new thread (fork.ts); rebuild()/revert put the ledger's history into a thread
// (rebuild.ts); the subconscious's calls go in as real call/output pairs before the turn (injectTrace). An agent turn's open
// has no timer – it waits until the turn's signal; a connection that closes meanwhile is our own process (details.local).
// The emergency stop ends every loaded thread's background commands; a thread nobody resumes leaves with its own (terminals.ts).
// warm()/prewarm() keep a helper call from paying the server start; realtime() lends the server to a dictation.
// Owns: the server pool per account (one setup at a time), thread open/resume/fork, steer and model change, model list, account
// check and limits (reads.ts, limits-read.ts), the reset redemption, which threads resume natively (0.3.19 ManagedSessions: an own
// turn, fork, revert or rebuild marks a thread; rollout.ts finds its file). Never: reads token files, migrates a running turn between
// accounts, keeps session state a restart would lose, writes helper turns into the account's Codex history, or decides approvals.

import { ManagedSessions, LEGACY_SESSION, type ManagedPathStore } from '../managed-session.ts'; // 0.3.19: which threads resume natively (managed-path.ts marks)
import { codexRollout } from './rollout.ts';
import { promises as fsp } from 'node:fs';
import type { Account, AccountLimits, Effort, EngineId } from '../../../shared/model/providers.ts';
import type { AccountCheck, Engine, EngineCaps, EngineForkInput, EngineForkResult, EngineModel, EngineRebuildInput, EngineRebuildResult, EngineTurnInput, EngineTurnResult, KeepOpenInput, RealtimeLink, RebuildProbe } from '../types.ts';
import { injectTrace, probeCodexRebuild, responseItems, revertThread, startRebuiltThread } from './rebuild.ts';
import { rebuiltTurnFailed } from '../rebuild-text.ts';
import { traceInput } from '../trace-text.ts';
import { hasTrace, type TraceCall } from '../../../shared/model/subconscious.ts';
import { forkParams, forkThread } from './fork.ts'; // B-057
import type { Supervisor } from '../../system/supervisor.ts';
import type { ExecutableFinder } from '../../accounts/executables.ts';
import { CodexServer, pickAgain } from './server.ts';
import { RPC_TIMEOUT, RpcError, threadGone, type RpcClient } from './rpc.ts';
import { runCodexTurn, retryAfterFrom, setTurnModel, type TurnControl } from './turn.ts';
import { dropThread } from './terminals.ts'; // L3 / C4: a thread nobody resumes leaves with its background commands
import { threadIsolation, trustKeys, turnAccess } from './isolation.ts';
import { codexSecure } from './approvals.ts';
import { securityMode, type SecurityLookup } from './native-gate.ts';
import { secureShellEnv } from '../temp-env.ts';
import { imageThread, openAgentThread, startHelperThread, untilStopped } from './helper-thread.ts';
import { ERR, ToolNames, nearestEffort, sameFolder, str } from '../shared.ts';
import { normalizeCodexLimits } from '../../accounts/limits.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { consumeResetCredit } from './reset-credit.ts';
import { listCodexModels, readCodexAccount } from './reads.ts';

export { threadGone } from './rpc.ts'; // Wave 2 (it lives with RpcError's codes)

/** Our tools as Codex dynamic tools (wire names, as at thread/start). */
function dynamicTools(tools: EngineTurnInput['tools'], names: ToolNames): Array<Record<string, unknown>> {
  return tools.map((tool) => ({ type: 'function', name: names.wire(tool.name), description: tool.description, inputSchema: tool.inputSchema }));
}

export interface CodexEngineDeps {
  supervisor: Supervisor;
  finder: ExecutableFinder;
  cwd: string; // the server process's own empty folder (system/paths.ts engineCwd); threads get their own cwd, never this one
  version: string;
  now?: () => number;
  idleMs?: number;
  /** Account-level limit pushes (also outside turns) → AccountService.updateLimits. */
  onLimits?: (accountId: string, limits: AccountLimits) => void;
  env?: NodeJS.ProcessEnv;
  /** A warning for the runtime log (CodexServer: why a connection closed). */
  log?: (message: string, data: Record<string, unknown>) => void;
  /** The real path of a thread's cwd (one more spelling to mark untrusted); default fs.realpath. */
  realpath?: (dir: string) => Promise<string>;
  /** Variables every agent shell gets (I02: gitSafeEnv; applied after Codex's KEY/SECRET/TOKEN excludes). */
  shellEnv?: Record<string, string>;
  /** Sicher-Runde 19.11.2026: services.security – Secure mode's sandbox and approval gate for agent turns (approvals.ts codexSecure). */
  security?: SecurityLookup;
  tempDir?: string; // 25.11.2026: <data>/tmp – TMP/TEMP/TMPDIR of a Secure-mode thread's shells (temp-env.ts secureShellEnv)
  managed?: ManagedPathStore; // 0.3.19: the persistent managed-shell marks (managed-path.ts); none: process memory only
}

export class CodexEngine implements Engine {
  readonly id: EngineId = 'codex';
  readonly caps: EngineCaps = { sessions: true, dynamicTools: true, mcp: true, images: true, rebase: true, structured: true, ownTools: true, fork: true, rebuild: true, revert: true, trace: true };
  private readonly deps: CodexEngineDeps;
  private readonly now: () => number;
  private readonly servers = new Map<string, CodexServer>();
  private readonly loaded = new Map<string, Map<string, string>>(); // account → thread id → its cwd, for threads loaded in its current process
  private readonly efforts = new Map<string, string[]>(); // model → supported efforts (from model/list)
  private readonly running = new Map<string, TurnControl>(); // runId → control (steer)
  private readonly watchers = new Map<string, Set<(limits: AccountLimits, raw: unknown) => void>>();
  private readonly lastLimits = new Map<string, unknown>();
  private readonly warming = new Map<string, Promise<void>>(); // account → its running prewarm
  private readonly creating = new Map<string, Promise<CodexServer>>(); // B-057: account → its server being set up (concurrent first turns share it)
  private readonly fresh = new Set<string>(); // rebuilt threads before their first turn
  private readonly modes = new Map<string, string>(); // thread id → the security mode its last turn ran under (Sicher-Runde)
  private readonly cut = new Set<string>(); // threads that lost their tail in a failed revert: they cannot continue
  private readonly trust: ManagedSessions;
  constructor(deps: CodexEngineDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.trust = new ManagedSessions({ engine: this, store: deps.managed, locate: (account, ref, known) => codexRollout(account.home ?? (deps.env ?? process.env).CODEX_HOME, ref, known) });
  }

  /** The account's server; B-057: concurrent first calls share one setup, so a cold account never gets two app-servers. */
  private server(account: Account): Promise<CodexServer> {
    const known = this.servers.get(account.id);
    if (known) return Promise.resolve(known);
    const pending = this.creating.get(account.id);
    if (pending) return pending;
    const work = this.createServer(account).finally(() => this.creating.delete(account.id));
    this.creating.set(account.id, work);
    return work;
  }

  private async createServer(account: Account): Promise<CodexServer> {
    let server = this.servers.get(account.id);
    if (!server) {
      const executable = await this.deps.finder.find('codex');
      if (!executable) throw Object.assign(new Error('Codex is not installed.'), { code: 'unavailable' });
      server = new CodexServer({
        key: account.id, home: account.home, executable, supervisor: this.deps.supervisor, cwd: this.deps.cwd,
        version: this.deps.version, idleMs: this.deps.idleMs, env: this.deps.env,
        onLimits: (params) => this.limitsPushed(account.id, params),
        onExit: () => { this.loaded.delete(account.id); },
        log: this.deps.log,
      });
      this.servers.set(account.id, server);
    }
    return server;
  }

  private limitsPushed(accountId: string, params: Record<string, unknown>): void {
    this.lastLimits.set(accountId, params.rateLimits);
    const limits = normalizeCodexLimits(params, this.now());
    if (!limits) return;
    this.deps.onLimits?.(accountId, limits);
    for (const watcher of this.watchers.get(accountId) ?? []) watcher(limits, params.rateLimits);
  }

  async listModels(account: Account): Promise<EngineModel[]> {
    const rpc = await (await this.server(account)).rpc();
    return listCodexModels(rpc, this.efforts);
  }

  async checkAccount(account: Account, options: { details?: boolean } = {}): Promise<AccountCheck> {
    let rpc;
    try { rpc = await (await this.server(account)).rpc(); }
    catch { return { state: 'error', message: 'Codex is not installed or could not start.' }; }
    return readCodexAccount(rpc, { details: options.details === true, now: this.now, seen: (raw) => this.lastLimits.set(account.id, raw) });
  }

  /** B-044: redeems one banked reset (reset-credit.ts – key per attempt, outcome as sent); a Codex that cannot start refuses with 'unavailable'. */
  async consumeReset(account: Account, idempotencyKey: string, creditId?: string): Promise<unknown> {
    let rpc;
    try { rpc = await (await this.server(account)).rpc(); }
    catch { throw new WorkforceError('unavailable', 'Codex is not installed or could not start.'); } // nothing was sent
    return consumeResetCredit(rpc, idempotencyKey, creditId);
  }

  /** False before the turn started (no turn id yet: the dispatcher tries again); B-080: a refusal of Codex throws, so the caller logs why (it was silent). */
  async steer(runId: string, text: string): Promise<boolean> {
    const control = this.running.get(runId);
    if (!control?.turnId) return false;
    await control.rpc.request('turn/steer', { threadId: control.threadId, expectedTurnId: control.turnId, input: [{ type: 'text', text, text_elements: [] }] });
    return true;
  }

  /** B-080 (model.set now): the running turn goes on with another model and effort (turn.ts setTurnModel: true only when Codex applied it). */
  setModel(runId: string, model: string, effort: Effort): Promise<boolean> { return setTurnModel(this.running.get(runId), model, effort, this.efforts.get(model)); }

  async tell(runId: string, call: TraceCall): Promise<boolean> { const control = this.running.get(runId); return control?.turnId ? (await injectTrace(control.rpc, control.threadId, [call], `${runId}_${Date.now()}`, control.signal)) === undefined : false; }

  async run(input: EngineTurnInput): Promise<EngineTurnResult> {
    if (input.session && !(input.keep && !input.mcp && !input.tools.length) && !(await this.trust.trusted(input.account, input.session.ref))) return { text: '', stop: 'error', error: { code: 'conflict', message: LEGACY_SESSION, details: { rebase: true } } };
    let server: CodexServer;
    let rpc;
    try {
      server = await this.server(input.account);
      rpc = await server.rpc();
    } catch {
      return { text: '', stop: 'error', error: ERR.unavailable('Codex is not installed or could not start.') };
    }
    const names = new ToolNames(input.tools);
    const supported = this.efforts.get(input.model) ?? [];
    const effort = supported.length ? nearestEffort(input.effort, supported) : input.effort === 'max' ? 'xhigh' : input.effort;
    const loaded = this.loaded.get(input.account.id) ?? new Map<string, string>();
    this.loaded.set(input.account.id, loaded);
    const threadSettings = await this.settings(input);
    let threadId: string;
    const generation = input.session?.generation ?? 1;
    const ref = input.session?.ref;
    // A runtime helper turn (decision, verifier, compaction … – no tools, no hub, never resumed) runs on an ephemeral thread: nothing lands in
    // the account's Codex history (like Claude Code's --no-session-persistence), and the thread is unloaded after the turn (thread/unsubscribe).
    // LEAN: that thread has no environment and none of Codex's own tools or context blocks (helper-thread.ts).
    // KI-Runde 17.11.2026: `keep` (a call's voice) stays on its lean helper thread for every line of the call.
    const helper = (!ref || input.keep === true) && !input.mcp && input.tools.length === 0;
    const open = untilStopped(rpc, input.signal, () => server.beginTurn()); // B-075: the turn's signal also ends the open; B-080: the server stays up meanwhile
    const mode = securityMode(this.deps.security);
    try {
      if (ref) {
        threadId = ref;
        if (this.cut.delete(threadId)) return { text: '', stop: 'error', error: { code: 'conflict', message: 'Codex could not continue this session.', details: { rebase: true } } };
        // Sicher-Runde: loaded under another security mode – it leaves memory and is resumed (history kept), so no "for the session" approval of that mode carries over.
        if (loaded.has(threadId) && (this.modes.get(threadId) ?? mode) !== mode) { await rpc.request('thread/unsubscribe', { threadId }).catch(() => undefined); loaded.delete(threadId); }
        if (!loaded.has(threadId)) {
          // After a process restart the thread must be resumed (dynamic tools persist with it: live 23.10., codex 0.163 – e2e/runtime-real-restart).
          try {
            await openAgentThread(open, 'thread/resume', { threadId, ...threadSettings }, 0); // until the turn's signal
          } catch (error) {
            // The server answered with an error (not a timeout): this thread cannot continue.
            if (error instanceof RpcError && error.rpcCode !== RPC_TIMEOUT) return { text: '', stop: 'error', error: { code: 'conflict', message: 'Codex could not resume this session.', details: { rebase: true } } };
            throw error;
          }
          loaded.set(threadId, input.cwd);
        } else if (!sameFolder(loaded.get(threadId)!, input.cwd)) {
          // A loaded thread keeps the cwd it was opened with (e.g. a task worktree that is gone now):
          // renew the session – `folder` makes it the executor's quiet folder renewal (agents/turn.ts).
          return { text: '', stop: 'error', error: ERR.folder('Codex') };
        }
      } else {
        const opened = { ...threadSettings, dynamicTools: dynamicTools(input.tools, names) };
        const start = input.nativeTools === 'image' ? imageThread(opened) : opened; // B-058 i1: the plan-image thread (helper-thread.ts)
        const started = helper
          ? await startHelperThread(open, start)
          : await openAgentThread<{ thread?: { id?: string } }>(open, 'thread/start', start, 0); // until the turn's signal
        const id = str(started?.thread?.id);
        if (!id) return { text: '', stop: 'error', error: ERR.failed('Codex did not start a session.') };
        threadId = id;
        if (!helper || input.keep) loaded.set(threadId, input.cwd); // a kept helper thread is live in this server: the next line needs no resume
        if (!helper) { try { input.onEvent({ type: 'session', ref: threadId, generation }); } catch { /* isolate */ } } // bound at once
      }
    } catch (error) {
      if (input.signal.aborted) return { text: '', stop: 'interrupted', error: ERR.cancelled() }; // as a turn stopped while it opened (turn.ts)
      if (error instanceof RpcError && error.rpcCode === RPC_TIMEOUT) return { text: '', stop: 'error', error: { ...ERR.timeout(), message: 'Codex did not open the session in time.' } };
      return { text: '', stop: 'error', error: { ...ERR.unavailable('Codex could not open the session.'), ...(error instanceof RpcError ? {} : { details: { local: true } }) } }; // B-080: a closed connection is ours
    }
    if (loaded.has(threadId)) this.modes.set(threadId, mode); // a helper thread leaves after its turn
    if (!helper) this.trust.opened(input.account, threadId); // 0.3.19: pending until the turn's end seals it (finally below)
    const control: TurnControl = { threadId, rpc, signal: input.signal };
    this.running.set(input.runId, control);
    const watcher = (limits: AccountLimits) => { try { input.onEvent({ type: 'limits', limits }); } catch { /* isolate */ } };
    const set = this.watchers.get(input.account.id) ?? new Set();
    set.add(watcher);
    this.watchers.set(input.account.id, set);
    try {
      const refused = hasTrace(input.trace) ? await injectTrace(open, threadId, input.trace.calls, input.runId) : undefined; // B-080: until the turn's signal, the server held
      // The thread's instructions are the stable prompt only: the live context (time, task …) is the first block of every turn's input.
      const rebuilt = ref ? this.fresh.delete(threadId) : false;
      const access = turnAccess(input, this.deps.cwd);
      let result: EngineTurnResult = await runCodexTurn({
        server, rpc, threadId, input: refused ? { ...input, input: [traceInput(input.trace!.calls), ...input.input] } : input,
        effort, names, control, now: this.now, context: input.system.volatile,
        access, secure: codexSecure(this.deps.security, { agentId: input.agentId, runId: input.runId }, access, input.signal), // Sicher-Runde 19.11.2026: Secure mode
        summary: helper ? 'none' : 'auto', // D5: an agent turn shows its reasoning summaries; a helper turn pays for none
        helper, // a silent helper turn is cut (turn.ts HELPER_SILENT_MS)
      });
      if (result.error?.details?.codeHost) await pickAgain(this.deps.finder, this.servers.values());
      if (!helper || input.keep) result.session = { ref: threadId, generation, ...(control.turnId ? { turn: control.turnId } : {}) }; // B-049 F7: the turn id per run
      else delete result.session;
      if (refused) result.traceAsText = refused;
      if (rebuilt && !control.turnId && result.stop === 'interrupted') this.fresh.add(threadId); // stopped before its first turn: still un-run
      else if (rebuilt) result = rebuiltTurnFailed(result);
      if (result.stop === 'limit' && result.error && result.error.retryAfterMs === undefined) {
        result.error.retryAfterMs = retryAfterFrom(this.lastLimits.get(input.account.id), this.now());
      }
      return result;
    } finally {
      set.delete(watcher);
      this.running.delete(input.runId);
      if (!helper) void this.trust.sealed(input.account, threadId, server.cliVersion);
      if (helper && !input.keep) void dropThread(rpc, threadId); // nobody resumes a helper thread – nothing of it keeps running (a call's voice says the next line on it)
    }
  }

  /** A thread's settings: model, cwd, the stable prompt as its base instructions; read-only and untrusted on open (runCodexTurn gives each turn its own sandbox); B-085: its agent's id in its shells. */
  private async settings(input: { model?: string; cwd: string; system?: { stable: string; volatile: string }; agentId?: string }): Promise<{ config?: Record<string, unknown>; developerInstructions?: string } & Record<string, unknown>> {
    const real = await (this.deps.realpath ?? fsp.realpath)(input.cwd).catch(() => undefined);
    return {
      ...(input.model ? { model: input.model } : {}), cwd: input.cwd,
      ...(input.system ? { baseInstructions: input.system.stable } : {}),
      approvalPolicy: 'never', ...threadIsolation(trustKeys(input.cwd, real), secureShellEnv(this.deps.shellEnv, this.deps.tempDir, securityMode(this.deps.security) === 'secure'), input.agentId),
    };
  }

  /** A new thread with the coming turn's settings and dynamic tools, holding the ledger's history (rebuild.ts); deleted again when the injection fails. */
  async rebuild(input: EngineRebuildInput): Promise<EngineRebuildResult> {
    if (input.revert && !(await this.trust.trusted(input.account, input.revert.ref))) throw new Error(LEGACY_SESSION);
    const rpc = await (await this.server(input.account)).rpc();
    const items = responseItems(input.items, { offered: new Set(input.tools.map((tool) => tool.name)), accountId: input.account.id, model: input.model, custom: input.probe?.custom === true });
    if (!items.length) throw new Error('nothing to rebuild');
    if (input.revert) return this.revert(rpc, input, input.revert, items);
    const start = { ...await this.settings(input), dynamicTools: dynamicTools(input.tools, new ToolNames(input.tools)) };
    const open = (params: Record<string, unknown>) => openAgentThread<{ thread?: { id?: string } }>(rpc, 'thread/start', params);
    const threadId = await startRebuiltThread(rpc, start, items, input.probe?.verify, open);
    const loaded = this.loaded.get(input.account.id) ?? new Map<string, string>();
    this.loaded.set(input.account.id, loaded);
    loaded.set(threadId, input.cwd);
    this.fresh.add(threadId);
    void this.trust.sealed(input.account, threadId, this.servers.get(input.account.id)?.cliVersion);
    return { ref: threadId, generation: input.generation, items: items.length };
  }

  /**
   * Keeps the bound thread – resumed when this process has not loaded it, never one open in another folder – cut before the
   * recorded turn, with the tail injected (rebuild.ts revertThread). Not fresh: it keeps the instructions it opened with.
   * A thread whose tail could not be injected ends at its next turn, should the fallback not replace it.
   */
  private async revert(rpc: RpcClient, input: EngineRebuildInput, revert: { ref: string; beforeTurn: string }, items: Array<Record<string, unknown>>): Promise<EngineRebuildResult> {
    const loaded = this.loaded.get(input.account.id) ?? new Map<string, string>();
    this.loaded.set(input.account.id, loaded);
    const open = loaded.get(revert.ref);
    if (open !== undefined && !sameFolder(open, input.cwd)) throw new Error('the session runs in another folder');
    if (open === undefined) {
      await openAgentThread(rpc, 'thread/resume', { threadId: revert.ref, ...await this.settings(input) });
      loaded.set(revert.ref, input.cwd);
    }
    this.trust.opened(input.account, revert.ref);
    try { await revertThread(rpc, revert.ref, revert.beforeTurn, items, input.probe?.verify); } catch (error) {
      if ((error as { cut?: boolean }).cut) this.cut.add(revert.ref);
      throw error;
    } finally { void this.trust.sealed(input.account, revert.ref, this.servers.get(input.account.id)?.cliVersion); }
    return { ref: revert.ref, generation: input.generation, items: items.length };
  }

  /** The running Codex's version (initialize's userAgent; the server starts if needed). */
  async rebuildVersion(account: Account): Promise<string | undefined> {
    const server = await this.server(account);
    await server.rpc();
    return server.cliVersion;
  }

  /** The model-free probe (rebuild.ts probeCodexRebuild) in `cwd`, read-only like every opened thread. */
  async probeRebuild(account: Account, cwd: string): Promise<RebuildProbe> {
    const version = (await this.rebuildVersion(account).catch(() => undefined)) ?? 'unknown';
    const rpc = await (await this.server(account)).rpc();
    return probeCodexRebuild(rpc, await this.settings({ cwd }), version, this.now());
  }

  /** B-057 (fork.ts): the parent thread copied into a new one (thread/fork, lean), loaded with the split's folder – not fresh. */
  async fork(input: EngineForkInput): Promise<EngineForkResult> {
    if (!(await this.trust.trusted(input.account, input.parentRef))) throw new Error(LEGACY_SESSION);
    const rpc = await (await this.server(input.account)).rpc();
    const loaded = this.loaded.get(input.account.id) ?? new Map<string, string>();
    this.loaded.set(input.account.id, loaded);
    const cwd = input.cwd ?? loaded.get(input.parentRef);
    if (!cwd) throw new Error('the folder of the forked session is unknown');
    const params = forkParams(input, await this.settings({ model: input.model, cwd, agentId: input.agentId }));
    const ref = await forkThread(params, (fork) => openAgentThread<{ thread?: { id?: string } }>(rpc, 'thread/fork', fork));
    loaded.set(ref, cwd);
    void this.trust.sealed(input.account, ref, this.servers.get(input.account.id)?.cliVersion);
    return { ref, generation: 1 };
  }

  /**
   * Wave 2 (privacy): deletes a thread this app started, with the app-server's own `thread/delete`
   * (official protocol schema of the installed Codex; not marked experimental). Only an answer about
   * the thread itself ("thread … not found", "no such thread", B-080: "no rollout found") counts as gone; a Codex without the
   * method (-32601, "method not found", "unknown variant …"), a timeout or another refusal throws, so
   * the row ends 'failed' and stays named as a remaining copy instead of being reported deleted.
   */
  managedResume(account: Account, ref: string): Promise<boolean> { return this.trust.trusted(account, ref); } // 0.3.19 (managed-session.ts)

  async deleteSession(account: Account, ref: string): Promise<'deleted' | 'missing'> {
    this.trust.forget(account, ref);
    const rpc = await (await this.server(account)).rpc();
    // C4: a deleted thread still loaded here leaves nothing running in the background (a refusal is ignored).
    if (this.loaded.get(account.id)?.has(ref)) await rpc.request('thread/backgroundTerminals/clean', { threadId: ref }, 5_000).catch(() => undefined);
    try {
      await rpc.request('thread/delete', { threadId: ref }, 30_000);
    } catch (error) {
      if (error instanceof RpcError && threadGone(error)) return 'missing';
      throw error;
    }
    this.loaded.get(account.id)?.delete(ref);
    this.fresh.delete(ref);
    return 'deleted';
  }

  /** B-057 (splits/release.ts): a released split thread leaves the running app-server's memory (thread/unsubscribe, like a helper thread); its rollout stays for the session sweep's thread/delete. */
  /**
   * KI-Runde 17.11.2026 (decision 7.1, fix B9; real run 18.11.: without it the first line paid the thread's start, 2.9 s to its
   * first words against about 1 s on the later lines): a call started – its voice's lean helper thread opens now with the
   * stable part as its instructions and no turn, and stays loaded; each line runs on it (run with `keep` and this ref).
   */
  async keepOpen(input: KeepOpenInput): Promise<{ ref: string; generation: number }> {
    const rpc = await (await this.server(input.account)).rpc();
    const started = await startHelperThread(rpc, { ...await this.settings(input), dynamicTools: [] });
    const id = str(started?.thread?.id);
    if (!id) throw new WorkforceError('unavailable', 'Codex did not start a session.');
    const loaded = this.loaded.get(input.account.id) ?? new Map<string, string>();
    this.loaded.set(input.account.id, loaded);
    loaded.set(id, input.cwd);
    return { ref: id, generation: 1 };
  }

  async unload(account: Account, ref: string): Promise<void> {
    if (!this.loaded.get(account.id)?.delete(ref)) return; // not loaded here: nothing in memory
    const rpc = this.servers.get(account.id)?.current; // C4: the open connection only – never a (re)start for this
    if (!rpc) return;
    // Live test L3: its background terminals (code mode's exec_command with a yield) outlive a stopped turn and the
    // unsubscribe – nobody resumes a released split, so what it started ends with it (terminals.ts dropThread).
    await dropThread(rpc, ref);
  }

  /**
   * Live test C4: the person's "Stop all work" (agents/work-stop.ts) – every background command a loaded thread left running
   * ends (`thread/backgroundTerminals/clean` per thread, also those of finished turns: an emergency brake keeps nothing
   * running). Only running servers; never starts or restarts one. Resolves to the threads Codex cleaned; refusals are ignored.
   */
  async stopBackground(): Promise<number> {
    const cleaned = await Promise.all([...this.loaded].flatMap(([accountId, threads]) => {
      const rpc = this.servers.get(accountId)?.current;
      return rpc ? [...threads.keys()].map((ref) => rpc.request('thread/backgroundTerminals/clean', { threadId: ref }, 5_000).then(() => true, () => false)) : [];
    }));
    return cleaned.filter(Boolean).length;
  }

  /** LEAN: this account's app-server is up – a helper thread starts in well under a second instead of after a process start. */
  warm(account: Account): boolean {
    return this.servers.get(account.id)?.running === true;
  }

  /**
   * LEAN: starts this account's app-server ahead of a likely helper call: spawn, initialize and one lean
   * ephemeral thread without a turn (a fresh server's first thread pays Codex's own start work – no
   * model call, nothing in the history), unloaded right away. A running server is left as it is; the
   * started one idles out like any other (10 min without turns). Concurrent calls share one start.
   */
  prewarm(account: Account): Promise<void> {
    const pending = this.warming.get(account.id);
    if (pending) return pending;
    if (this.warm(account)) return Promise.resolve();
    const work = (async () => {
      const rpc = await (await this.server(account)).rpc();
      const cwd = this.deps.cwd;
      const real = await (this.deps.realpath ?? fsp.realpath)(cwd).catch(() => undefined);
      const started = await startHelperThread(rpc, {
        cwd, approvalPolicy: 'never', ...threadIsolation(trustKeys(cwd, real), this.deps.shellEnv),
      });
      const id = str(started?.thread?.id);
      if (id) await rpc.request('thread/unsubscribe', { threadId: id }).catch(() => undefined);
    })().finally(() => this.warming.delete(account.id));
    this.warming.set(account.id, work);
    return work;
  }

  async realtime(account: Account): Promise<RealtimeLink> { const server = await this.server(account); const rpc = await server.rpc(); return { request: (method, params, ms) => rpc.request(method, params, ms), hold: () => server.beginTurn() }; } // owner 07.11.2026: the account's server for a request of the plan's dictation (Engine.realtime)
  async dispose(): Promise<void> {
    await Promise.all([this.trust.settled(), ...[...this.servers.values()].map((server) => server.dispose())]);
    this.servers.clear();
    this.loaded.clear();
  }
}
