// Claude Code engine: one `claude -p` stream-json process per active turn.
// Owns: command line (session id/resume, model, effort, system prompt, MCP hub config,
// bypassPermissions), limits, the reported context window and the answer (every main-thread text block, parser.answer()).
// turns.ts runs a turn's process: the stream → events mapping, interrupt/steer through stdin (a turn with
// steered lines ends its input at the first result and waits for their answers or the CLI's end). B-080: while the CLI's own
// background work runs (stream.ts state.background) a successful result ends nothing and the input stays open – the turn
// ends at the first result after it, as in Claude Code, or at an error result (a limit, an outage); setModel (control_request set_model; no effort inside a turn –
// FIXES-3 C1: the turn's 'model' event comes when a request runs on the new model, so a run names the model of its requests); a fresh
// --session-id is announced at its system/init ('session'). A session Claude Code cannot find any more is reported as ended
// (details.rebase): the executor renews it (compaction + new session with the full projection).
// Claude Code keeps a session per working folder, so a session this process ran in another folder
// (e.g. before a task worktree) is renewed before the CLI starts, quietly (details.folder, like Codex).
// Models: the CLI's own list from the status probe (`initialize`, cached 5 min per account, see
// models.ts) with the context windows `result.modelUsage` reported in this account's turns; the
// last good list when a probe does not answer (and an error, so the catalog keeps its listing,
// when there is none yet); CLAUDE_MODELS when the CLI is missing or cannot list models. A 1M
// variant's catalog id `<id>-1m` runs as `--model <id>[1m]` (cliModel).
//
// Agent turns run with `--permission-mode bypassPermissions`: Claude Code never asks before its own tools. B-085: an agent turn's env names its agent (AUTARK_AGENT, wf-shim.ts asAgent).
// Sicher-Runde 19.11.2026: in Secure mode (services.security) an agent turn runs `default` with its prompts sent to us and answered by the gate (permissions.ts).
// B-083 (owner 09.11.): Claude Code always thinks, and thinking is never turned off for a temperature – its turns send none (older Claude models take one only without thinking, the newer ones none).
// Login guard 03.11.: a turn's CLI is never hard-killed when the turn ends or is stopped (it may be saving a refreshed
// sign-in): its stdin closes and it ends by itself; its tree is killed only after the grace (CLAUDE_EXIT_GRACE_MS). A
// stopped turn still returns after 3 s at the latest; what the CLI prints after the turn returned is dropped.
//
// Project config: a turn runs with cwd = the workspace (file tools work there as usual) but loads
// only the account's user settings (`--setting-sources user`, USER_SETTINGS_ONLY in status.ts) and
// only our MCP config (`--strict-mcp-config` in both branches); the prompt and MCP files live in temp.
// The CLI's own cron scheduler is off (NO_CLI_CRON: no prompts from `.claude/scheduled_tasks.json`).
// A turn without the hub and without tools (the runtime's helper turns) passes `--no-session-persistence` like the status
// probe (no transcript on disk); promptArgs gives it no built-in tool (`--tools ''`), so Claude Code's own tools – also those that never prompt – are off.
//
// Native rebuild (rebuild.ts, transcript.ts): rebuild() writes the ledger's history as a fresh transcript; the next turn resumes it by
// its path (or by id in the app's own project folder); a first turn refused is reported as ended (details.rebuild 'failed').
// input.trace goes in as real tool_use + tool_result records before the resume (rebuilder.ts injectTrace; when that fails: a
// tool-call-shaped block in the input, result.traceAsText).
// deleteSession() deletes superseded sessions the app created: for a path ref our transcript, for an id ref the CLI's
// transcript of that session id (rebuild.ts, found by listing folder names).
// Agent turns ask for summarized thinking (`--thinking-display summarized`, 2.1.303 on) so reasoning can be shown.
// B-049 F2 (lean.ts): every turn runs with our stable system prompt only (`--system-prompt-file`), no skills/slash commands,
// no hooks, no CLAUDE.md/auto memory/git workflow text; an agent turn keeps the built-in execution core and the hub's tools
// upfront, a helper turn no built-in tool (`--json-schema` keeps its answer tool). The live context is the first block of
// every turn's user message (shared.ts contextText), on a new session as on a resumed one.
// B-057 (fork.ts): fork() reserves a split's forked session; its first turn adds `--resume <parent> --fork-session
// --session-id <new>` (a pending fork is the one piece of session state a restart loses: that turn then renews).
// KI-Runde 17.11.2026 (kept.ts): a helper turn with `keep` – a call's voice – runs in one process kept for the call: the
// call's start (keepOpen) or its first line starts it (no transcript on disk), each later line with its ref is one more
// user message there, a ref whose process is gone answers 'conflict', and unload() at the call's end lets it end by itself.
// 0.3.19 (managed-session.ts): a session resumes natively only while ManagedSessions trusts it – an own turn marks it pending at
// its start and seals its transcript at its end (so do a rebuild and a fork's first turn); else it is renewed (details.rebase).
// Never: reads CLAUDE_CONFIG_DIR files or tokens but the transcript of a session the app created (it writes there only a rebuilt
// transcript in the app's own home and that transcript's trace records, and deletes there only transcripts of sessions the app created); never passes API keys in the env (they would
// silently override the user's subscription login); keeps session state a restart would lose;
// never lets project-level config in the workspace (.claude/settings*.json, .mcp.json, project
// skills/agents/commands) add permissions, hooks, plugins or MCP servers to a turn.

import { ManagedSessions, LEGACY_SESSION, type ManagedPathStore } from '../managed-session.ts'; // 0.3.19: which sessions resume natively (managed-path.ts marks)
import * as path from 'node:path';
import type { Account, Effort, EngineId } from '../../../shared/model/providers.ts';
import type { AccountCheck, Engine, EngineCaps, EngineEvent, EngineForkInput, EngineForkResult, EngineModel, EngineRebuildInput, EngineRebuildResult, EngineTurnInput, EngineTurnResult, KeepOpenInput, RebuildProbe } from '../types.ts';
import { hasTrace } from '../../../shared/model/subconscious.ts';
import { rebuiltTurnFailed } from '../rebuild-text.ts';
import { traceInput } from '../trace-text.ts';
import type { Supervisor } from '../../system/supervisor.ts';
import type { ExecutableFinder } from '../../accounts/executables.ts';
import { CLAUDE_EXIT_GRACE_MS, runCli } from '../../accounts/cli.ts';
import { ClaudeStatus, USER_SETTINGS_ONLY } from './status.ts';
import { HUB_SERVER } from './stream.ts';
import { claudeModels, cliModel, rememberWindows } from './models.ts';
import { ERR, contextText, sameFolder } from '../shared.ts';
import { purgeHistories } from './purge.ts';
import { claudeDown, providerDownMessage } from '../provider-outage.ts'; // B-059 #184
import { ClaudeForks } from './fork.ts'; // B-057
import { ClaudeRebuilder } from './rebuilder.ts';
import { nodeFiles, type FileOps } from './rebuild.ts';
import { AGENT_ENV, CeilingFlag, LEAN_ENV, coreTools, hubConfig, promptArgs } from './lean.ts';
import { asAgent } from '../wf-shim.ts'; // B-085
import { withOwnTemp } from '../temp-env.ts'; // 25.11.2026
import { ClaudeKept, KEPT_GONE } from './kept.ts'; // KI-Runde 17.11.2026: a call voice's kept process
import { ClaudeTurns, type Attempt } from './turns.ts';
import { secureTurn } from './permissions.ts'; // Sicher-Runde 19.11.2026: Secure mode
import { secureService, type SecurityLookup } from '../codex/native-gate.ts';

export { CLAUDE_MODELS } from './models.ts';

/** Claude Code's answer to --resume with an id it no longer has (2.1.303: `errors: ["No conversation found with session ID: …"]`, verified live 23.10.). */
const MISSING_SESSION = /no conversation found|session .*not found/i;
/** Session folders remembered per process (the oldest is dropped beyond this). */
const MAX_FOLDERS = 500;

export interface ClaudeEngineDeps {
  supervisor: Supervisor;
  finder: ExecutableFinder;
  tempDir: string;
  now?: () => number;
  files?: FileOps;
  env?: NodeJS.ProcessEnv;
  uuid?: () => string;
  /** B-048: <data>/engine-transcripts/claude – rebuilt transcripts (default: <tempDir>/engine-transcripts/claude). */
  transcriptsDir?: string;
  /** B-048: where the app's own isolated homes lie (system/paths.ts homeRoots; the only ones the 'project' tier writes into). */
  accountsRoots?: readonly string[];
  /** Login guard 03.11.: how long an ended or stopped CLI may take to exit by itself before its tree is killed (CLAUDE_EXIT_GRACE_MS). */
  graceMs?: number;
  lifecycle?: (message: string, data: Record<string, unknown>) => void;
  /** Sicher-Runde 19.11.2026: services.security – in Secure mode an agent turn's permission prompts go through its gate (permissions.ts). */
  security?: SecurityLookup;
  /** 0.3.19: the persistent managed-shell marks (managed-path.ts); none: process memory only. */
  managed?: ManagedPathStore;
}

export class ClaudeEngine implements Engine {
  readonly id: EngineId = 'claude';
  readonly caps: EngineCaps = { sessions: true, dynamicTools: false, mcp: true, images: true, rebase: true, structured: true, ownTools: true, fork: true, rebuild: true, trace: true };
  private readonly deps: ClaudeEngineDeps;
  private readonly files: FileOps;
  private readonly rebuilds: ClaudeRebuilder; // session refs, CLI version, delete (rebuilder.ts)
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly status: ClaudeStatus;
  private readonly windows = new Map<string, Map<string, number>>(); // account id → model → window from modelUsage
  private readonly noEffort = new Set<string>(); // models the CLI lists without effort support (no --effort)
  private readonly folders = new Map<string, string>(); // session id → the folder its turns ran in (this process)
  /** Wave 2: account id → its running `claude purge`; a turn of that account starts only after it. */
  private readonly purging = new Map<string, Promise<unknown>>();
  private readonly forks = new ClaudeForks({ files: () => this.rebuilds.files, uuid: () => this.uuid() }); // B-057: pending forks (fork.ts)
  private readonly kept: ClaudeKept; // KI-Runde 17.11.2026: the processes kept for calls' voices (kept.ts)
  private readonly turns: ClaudeTurns; // the running turns' processes (turns.ts)
  private readonly ceiling = new CeilingFlag(); // Runde "Halb": whether this CLI takes --autocompact (lean.ts)
  private readonly trust: ManagedSessions; // 0.3.19: which sessions resume natively

  constructor(deps: ClaudeEngineDeps) {
    this.deps = deps;
    this.files = deps.files ?? nodeFiles;
    this.now = deps.now ?? Date.now;
    this.uuid = deps.uuid ?? (() => crypto.randomUUID());
    this.status = new ClaudeStatus({ supervisor: deps.supervisor, tempDir: deps.tempDir, now: this.now, env: deps.env, graceMs: deps.graceMs });
    this.rebuilds = new ClaudeRebuilder({
      supervisor: deps.supervisor, finder: deps.finder, tempDir: deps.tempDir, files: this.files, env: deps.env, envFor: (account) => this.status.envFor(account),
      uuid: this.uuid, now: this.now, transcriptsDir: deps.transcriptsDir, accountsRoots: deps.accountsRoots,
    });
    this.kept = new ClaudeKept({ supervisor: deps.supervisor, graceMs: deps.graceMs ?? CLAUDE_EXIT_GRACE_MS, now: this.now });
    this.trust = new ManagedSessions({ engine: this, store: deps.managed, locate: (account, ref) => this.rebuilds.transcriptOf(account, ref) });
    this.turns = new ClaudeTurns({ supervisor: deps.supervisor, graceMs: deps.graceMs, now: this.now, uuid: this.uuid, noEffort: this.noEffort, purging: this.purging, lifecycle: deps.lifecycle });
  }

  async listModels(account: Account): Promise<EngineModel[]> {
    const exe = account.state === 'needs_login' ? null : await this.deps.finder.find('claude');
    const probe = exe ? await this.status.probe(exe, account) : undefined;
    // No answer and no earlier list: the static list would drop the CLI's own models (1M variants,
    // legacy ids) and add ones the plan may lack – the catalog keeps its previous listing instead.
    if (probe?.failed && !probe.init) throw new Error('Claude Code did not answer the model list.');
    const models = claudeModels(probe?.init, this.windows.get(account.id));
    for (const m of models) {
      if (m.efforts.length) this.noEffort.delete(m.model);
      else this.noEffort.add(m.model);
    }
    return models;
  }

  async checkAccount(account: Account, options: { background?: boolean } = {}): Promise<AccountCheck> {
    const exe = await this.deps.finder.find('claude');
    if (!exe) return { state: 'error', message: 'Claude Code is not installed.' };
    try { return await this.status.check(exe, account, { background: options.background === true }); }
    catch { return { state: 'error', message: 'Claude Code did not answer the account check.' }; }
  }

  /** A line steered into the running turn (turns.ts). */
  steer(runId: string, text: string): Promise<boolean> { return this.turns.steer(runId, text); }

  /** B-080 (model.set now): the running turn takes `model` from its next request (turns.ts). */
  setModel(runId: string, model: string, effort: Effort): Promise<boolean> { return this.turns.setModel(runId, model, effort); }

  async run(input: EngineTurnInput): Promise<EngineTurnResult> {
    const kept = input.keep && !input.mcp && input.tools.length === 0;
    if (!kept && input.session && !(await this.trust.trusted(input.account, input.session.ref))) return { text: '', stop: 'error', error: { code: 'conflict', message: LEGACY_SESSION, details: { rebase: true } } };
    const exe = await this.deps.finder.find('claude');
    if (!exe) return { text: '', stop: 'error', error: ERR.unavailable('Claude Code is not installed.') };
    if (kept) return this.keptTurn(exe, input);
    let resume = input.session?.ref;
    const ranIn = resume ? this.folders.get(resume) : undefined;
    if (ranIn !== undefined && !sameFolder(ranIn, input.cwd)) return { text: '', stop: 'error', error: ERR.folder('Claude Code') };
    let traceRefused: string | undefined;
    if (hasTrace(input.trace)) {
      if (resume && this.forks.target(resume).fork) traceRefused = 'a forked session has no transcript yet';
      else {
        try { resume = await this.rebuilds.injectTrace(input, resume); } catch (error) { traceRefused = error instanceof Error ? error.message.slice(0, 200) : 'refused'; }
      }
    }
    const generation = input.session?.generation ?? 1;
    const sessionId = resume ?? this.uuid();
    // A transcript-path session resumes from its path (or by id in the app's own project folder); B-057: a fork's first turn its parent.
    const target = resume ? this.forks.target(resume) : undefined;
    const { rebuilt, grownFrom } = await this.rebuilds.before(resume);
    const agentTurn = Boolean(input.mcp || input.tools.length);
    await this.files.mkdir(this.deps.tempDir);
    const base = path.join(this.deps.tempDir, `claude-${input.runId}-${this.uuid().slice(0, 8)}`);
    const promptFile = input.system.stable ? `${base}.prompt.md` : undefined; // none: a helper turn on Claude Code's own prompt
    const mcpFile = `${base}.mcp.json`;
    const temp = [promptFile, input.mcp ? mcpFile : undefined].filter((file): file is string => Boolean(file));
    // Sicher-Runde 19.11.2026: an agent turn in Secure mode asks the gate (permissions.ts); Trust mode keeps bypassPermissions.
    const security = input.mcp ? secureService(this.deps.security) : undefined;
    const secure = security ? secureTurn(security, { agentId: input.agentId, runId: input.runId }) : undefined;
    let ran: Attempt;
    try {
      // The stable prompt only: Claude Code replays a session's first system prompt on resume, and all sessions of an agent share it in the cache.
      if (promptFile) await this.files.writeFile(promptFile, input.system.stable);
      const args = [...exe.prefixArgs, '-p', ...USER_SETTINGS_ONLY, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--model', cliModel(input.model), ...(this.noEffort.has(input.model) ? [] : ['--effort', input.effort === 'none' ? 'low' : input.effort]), ...promptArgs(promptFile, agentTurn ? coreTools() : [], secure?.settings),
        ...(agentTurn && this.rebuilds.thinkingDisplay() ? ['--thinking-display', 'summarized'] : []), // B-048: reasoning text to show
        ...(agentTurn ? this.ceiling.args() : [])]; // Runde "Halb": the session compacts near the run ceiling where the CLI can (lean.ts)
      if (input.mcp) {
        // File (0600, deleted after the turn) instead of argv: argv is visible to other processes.
        await this.files.writeFile(mcpFile, hubConfig(input.mcp));
        args.push('--mcp-config', mcpFile, '--strict-mcp-config', ...(secure?.args ?? ['--permission-mode', 'bypassPermissions']));
      } else {
        args.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-prompts', 'none');
        // A runtime helper turn (decision, verifier, compaction) never resumes, so Claude Code keeps no transcript of it (the prompt may hold outside content).
        if (input.tools.length === 0 && !resume) args.push('--no-session-persistence');
      }
      if (input.outputSchema) args.push('--json-schema', JSON.stringify(input.outputSchema));
      args.push(...(target ? ['--resume', target.resume, ...(target.fork ? ['--fork-session', '--session-id', target.fork] : [])] : ['--session-id', sessionId]));
      const content = await this.content(traceRefused ? { ...input, input: [traceInput(input.trace!.calls), ...input.input] } : input);
      const plain = asAgent({ ...this.status.envFor(input.account), ...LEAN_ENV, ...(agentTurn ? AGENT_ENV : {}), ...target?.env }, agentTurn ? input.agentId : undefined); // B-085: its wf writes as the agent; AGENT_ENV: a one-hour cache for an agent's session
      const env = secure ? withOwnTemp(plain, this.deps.tempDir) : plain; // 25.11.2026: Secure mode's own temp folder (temp-env.ts)
      const fresh = !resume && agentTurn ? { ref: sessionId, generation } : undefined; // B-080: announced at the CLI's system/init
      if (fresh || resume) this.trust.opened(input.account, fresh?.ref ?? resume!); // pending until the turn's end seals it
      ran = await this.turns.attempt(exe.command, args, env, input, content, fresh, secure);
    } finally {
      for (const file of temp) await this.files.rm(file).catch(() => {});
    }
    const { parser, broken, interrupted } = ran;
    const s = parser.state;
    this.forks.settle(resume, s.sessionId, s.done && !broken); // B-057: a fork the CLI took is no longer pending
    this.rebuilds.remember(s.version);
    this.ceiling.seen(s.version, () => runCli(this.deps.supervisor, exe, ['--help'], { env: this.deps.env, cwd: this.deps.tempDir, timeoutMs: 30_000, owner: 'claude-help' }).then((help) => help.stdout));
    this.rememberWindows(input.account.id, s.contextWindows);
    const result: EngineTurnResult = {
      text: parser.answer(), stop: 'done', usage: s.usage, contextTokens: s.contextTokens,
      contextWindow: parser.contextWindow(cliModel(ran.model)), session: { ref: await this.rebuilds.nextRef(resume, grownFrom, s.sessionId ?? sessionId, s.done && !s.isError && !broken), generation },
    };
    if (ran.started && (agentTurn || resume) && result.session) void this.trust.sealed(input.account, result.session.ref, s.version);
    if (input.outputSchema && s.structured !== undefined) result.structured = s.structured;
    if (traceRefused) result.traceAsText = traceRefused;
    if (s.compacted) result.compacted = true; // B-049 F6: the next turn sends every volatile section again
    if (input.mcp || input.tools.length || resume) this.ranIn(result.session!.ref, input.cwd); // helper turns keep no session
    if (interrupted || input.signal.aborted) return { ...result, stop: 'interrupted', error: ERR.cancelled() };
    if (parser.limited()) return { ...result, stop: 'limit', error: ERR.limit(s.resetsAt ? Math.max(0, s.resetsAt - this.now()) : undefined) };
    if (parser.signedOut()) return { ...result, stop: 'error', error: ERR.unavailable('Claude Code is not signed in for this account.') };
    if (!ran.started && !broken) return { ...result, stop: 'error', error: ERR.unavailable('Claude Code ended before it began the turn – this Claude Code may be older than Autark needs; updating it fixes that.') };
    if (!s.done || broken) return { ...result, stop: 'error', error: ERR.unavailable('Claude Code stopped unexpectedly.') };
    if (s.isError) {
      if (resume && MISSING_SESSION.test(s.errorText ?? '')) {
        this.folders.delete(resume);
        return { ...result, session: undefined, stop: 'error', error: { code: 'conflict', message: 'Claude Code could not resume this session.', details: { rebase: true, ...(rebuilt ? { rebuild: 'failed' } : {}) } } };
      }
      // 19.11.2026 (Vera, company-2: Sonnet declined her history six turns in a row, each renewal on the same model): the model's
      // safeguards declined – a model outage, never the account's (details.local: no cooling); turn.ts leaves this model out of the turn.
      if (parser.declined()) return { ...result, session: undefined, stop: 'error', error: { ...ERR.unavailable('This model declined the conversation (its safeguards); another model takes it.'), details: { local: true, declined: true } } };
      // B-059 #184: the API overloaded or unreachable is an outage of the account (provider-outage.ts).
      if (claudeDown(s.assistantError, s.errorText)) return { ...result, stop: 'error', error: ERR.unavailable(providerDownMessage('Anthropic')) };
      const failed: EngineTurnResult = { ...result, stop: 'error', error: ERR.failed() };
      return rebuilt ? rebuiltTurnFailed(failed) : failed;
    }
    return result;
  }

  /**
   * KI-Runde 17.11.2026 (kept.ts): one line of a call's voice. A ref whose process still runs takes the line as one more
   * user message; a ref whose process is gone (it idled out, ended or was let go after a stop) answers 'conflict' and starts
   * nothing, so the caller says the line again with the call so far in front. Without a ref a new process starts as a
   * helper turn does (our prompt only, no tools, nothing on disk), and its session id is the ref the next line brings.
   */
  private async keptTurn(exe: NonNullable<Awaited<ReturnType<ExecutableFinder['find']>>>, input: EngineTurnInput): Promise<EngineTurnResult> {
    let ref = input.session?.ref;
    if (ref && !this.kept.has(ref)) return { text: '', stop: 'error', error: KEPT_GONE };
    ref ??= await this.startKept(exe, input);
    const emit = (event: EngineEvent) => { try { input.onEvent(event); } catch { /* isolate */ } };
    const line = await this.kept.say(ref, await this.content(input), emit, input.signal);
    const s = line.parser.state;
    this.rememberWindows(input.account.id, s.contextWindows);
    const result: EngineTurnResult = { text: line.parser.answer(), stop: 'done', usage: s.usage, contextTokens: s.contextTokens, session: { ref, generation: input.session?.generation ?? 1 } };
    if (line.interrupted || input.signal.aborted) return { ...result, stop: 'interrupted', error: ERR.cancelled() };
    if (line.parser.limited()) { this.kept.close(ref); return { ...result, stop: 'limit', error: ERR.limit(s.resetsAt ? Math.max(0, s.resetsAt - this.now()) : undefined) }; }
    if (line.parser.signedOut()) { this.kept.close(ref); return { ...result, stop: 'error', error: ERR.unavailable('Claude Code is not signed in for this account.') }; }
    // A process that ended under a line it had from an earlier one is gone like an idled one; one that never answered could not start.
    if (line.broken) { this.kept.close(ref); return { ...result, stop: 'error', error: input.session ? KEPT_GONE : ERR.unavailable('Claude Code stopped unexpectedly.') }; }
    if (s.isError) return { ...result, stop: 'error', error: claudeDown(s.assistantError, s.errorText) ? ERR.unavailable(providerDownMessage('Anthropic')) : ERR.failed() };
    return result;
  }

  /** KI-Runde 17.11.2026 (decision 7.1): a call started – its voice's process starts before the first line and waits for it. */
  async keepOpen(input: KeepOpenInput): Promise<{ ref: string; generation: number }> {
    const exe = await this.deps.finder.find('claude');
    if (!exe) throw Object.assign(new Error('Claude Code is not installed.'), { code: 'unavailable' });
    return { ref: await this.startKept(exe, input), generation: 1 };
  }

  /** A new kept process (kept.ts) as a helper turn starts (our prompt only, no tools, nothing on disk); its ref is its session id. */
  private async startKept(exe: NonNullable<Awaited<ReturnType<ExecutableFinder['find']>>>, input: KeepOpenInput): Promise<string> {
    for (let purge = this.purging.get(input.account.id); purge; purge = this.purging.get(input.account.id)) await purge.catch(() => undefined);
    const ref = this.uuid();
    await this.files.mkdir(this.deps.tempDir);
    const promptFile = input.system.stable ? path.join(this.deps.tempDir, `claude-kept-${ref.slice(0, 8)}.prompt.md`) : undefined;
    if (promptFile) await this.files.writeFile(promptFile, input.system.stable);
    const args = [...exe.prefixArgs, '-p', ...USER_SETTINGS_ONLY, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', cliModel(input.model), ...(this.noEffort.has(input.model) ? [] : ['--effort', input.effort === 'none' ? 'low' : input.effort]), ...promptArgs(promptFile, []),
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-prompts', 'none', '--no-session-persistence', '--session-id', ref];
    // the CLI has read the prompt file once its first line ended (or it ended)
    const read = promptFile ? () => { void this.files.rm(promptFile).catch(() => {}); } : undefined;
    this.kept.start(ref, input.account.id, { command: exe.command, args, cwd: input.cwd, env: asAgent({ ...this.status.envFor(input.account), ...LEAN_ENV }, undefined) }, read);
    return ref;
  }

  /** KI-Runde 17.11.2026: the call ended – its voice's kept process ends by itself (kept.ts). */
  async unload(_account: Account, ref: string): Promise<void> { this.kept.close(ref); }

  /** The ledger's history as a fresh transcript for the probed tier; the next turn resumes it (rebuilder.ts). */
  async rebuild(input: EngineRebuildInput): Promise<EngineRebuildResult> {
    const result = await this.rebuilds.rebuild(input);
    void this.trust.sealed(input.account, result.ref, await this.rebuilds.cliVersion());
    return result;
  }

  /** The CLI version the rebuild probe is kept for. */
  rebuildVersion(): Promise<string | undefined> { return this.rebuilds.cliVersion(); }

  /** The model-free probe of the rebuild tiers in `cwd`. */
  probeRebuild(account: Account, cwd: string): Promise<RebuildProbe> { return this.rebuilds.probe(account, cwd); }

  /** B-057 (fork.ts): reserves a forked session of the parent; its first turn resumes the parent with --fork-session. */
  async fork(input: EngineForkInput): Promise<EngineForkResult> {
    if (!(await this.trust.trusted(input.account, input.parentRef))) throw new Error(LEGACY_SESSION);
    const result = await this.forks.fork(input, this.folders.get(input.parentRef));
    this.trust.opened(input.account, result.ref); // no transcript before its first turn: pending (a restart renews it, as the pending fork)
    return result;
  }

  /** 0.3.19 (managed-session.ts): whether `ref` may resume natively. */
  managedResume(account: Account, ref: string): Promise<boolean> { return this.trust.trusted(account, ref); }

  /** A superseded session the app created – our transcript (path ref) or the CLI's transcript of its id (id ref). */
  deleteSession(account: Account, ref: string): Promise<'deleted' | 'missing'> {
    this.folders.delete(ref);
    this.trust.forget(account, ref);
    this.forks.drop(ref); // B-057: a split's fork that never ran
    return this.rebuilds.delete(account, ref);
  }

  /** Remembers the folder of a session's turn (at most MAX_FOLDERS sessions, the oldest go first). */
  private ranIn(sessionId: string, cwd: string): void {
    this.folders.delete(sessionId);
    this.folders.set(sessionId, cwd);
    if (this.folders.size > MAX_FOLDERS) this.folders.delete(this.folders.keys().next().value!);
  }

  private rememberWindows(accountId: string, reported: Record<string, number>): void {
    if (!Object.keys(reported).length) return;
    let windows = this.windows.get(accountId);
    if (!windows) this.windows.set(accountId, windows = new Map());
    rememberWindows(windows, reported);
  }

  /** The user message: the live context block first, then the turn's input (text, images, files). */
  private async content(input: EngineTurnInput): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    const context = contextText(input.system.volatile);
    if (context) out.push({ type: 'text', text: context });
    for (const item of input.input) {
      if (item.type === 'text') out.push({ type: 'text', text: item.text });
      else if (item.type === 'image') {
        try {
          const data = Buffer.from(await this.files.readFile(item.path)).toString('base64');
          out.push({ type: 'image', source: { type: 'base64', media_type: item.mime, data } });
        } catch { out.push({ type: 'text', text: `[image unavailable: ${path.basename(item.path)}]` }); }
      } else out.push({ type: 'text', text: `[file: ${item.name} (${item.mime}) at ${item.path}]${item.text ? `\n${item.text}` : ''}` });
    }
    if (!out.length) out.push({ type: 'text', text: '(continue)' });
    return out;
  }

  /**
   * Wave 2 (privacy): every session history of this account's home, through `claude purge --all --yes`
   * (purge.ts). The account is held from this call on (set before the first await): a turn of it waits
   * until the purge ended, so it never resumes or writes a transcript the purge is deleting.
   */
  purgeHistories(account: Account): Promise<{ purged: boolean; message?: string }> {
    if (this.purging.has(account.id)) return Promise.reject(Object.assign(new Error("Claude Code is already deleting this account's histories."), { code: 'conflict' }));
    this.kept.closeAll(account.id); // a call voice of this account ends with its histories; its next line opens a new one after the purge
    const job = (async () => {
      const exe = await this.deps.finder.find('claude');
      if (!exe) throw Object.assign(new Error('Claude Code is not installed.'), { code: 'unavailable' });
      return purgeHistories(this.deps.supervisor, exe, account, this.status.envFor(account), this.deps.tempDir);
    })().finally(() => {
      this.purging.delete(account.id);
      this.folders.clear();
    });
    this.purging.set(account.id, job);
    return job;
  }

  async dispose(): Promise<void> {
    this.kept.closeAll();
    await Promise.all([this.turns.dispose(), this.trust.settled()]);
  }
}
