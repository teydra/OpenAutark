// The running turns of the Claude Code engine (engine.ts run): one `claude -p` stream-json process per turn – the user message
// goes into its stdin, its stream is read until the result or its end. A steered line goes into the same stdin (the turn ends
// once each was answered or the CLI ended); B-080: set_model switches the model of its next request (ranOn: once one ran on it);
// a Stop is an interrupt request and the turn returns after 3 s at the latest. Split from engine.ts, which builds the command.
// Sicher-Runde 19.11.2026: in Secure mode the CLI's can_use_tool requests are answered on the same stdin (permissions.ts hostRequests).
// Owns: the running turns (lease, steered lines, live state), their stdin and stdout. Never: starts while the account's
// histories are purged, hard-kills a CLI (the supervisor's grace kills its tree only after), or keeps the lines a CLI prints after its turn returned.

import type { Effort } from '../../../shared/model/providers.ts';
import type { EngineEvent, EngineTurnInput } from '../types.ts';
import type { Supervisor, Lease } from '../../system/supervisor.ts';
import { CLAUDE_EXIT_GRACE_MS } from '../../accounts/cli.ts';
import { ClaudeStreamParser, type ClaudeTurnState } from './stream.ts';
import { cliModel } from './models.ts';
import { isRecord, readJsonLines } from '../shared.ts';
import { hostRequests, type ClaudeSecure } from './permissions.ts';

/** One CLI process of a turn; `model`: the one it ended on (B-080 setModel). */
export interface Attempt { parser: ClaudeStreamParser; broken: boolean; interrupted: boolean; model: string; started: boolean }

/**
 * B-080: a running turn's events, the model its requests run on, its effort and its stream's state; FIXES-3 C1: `asked` – the
 * set_model request no request has run on yet, with the turn's request count when it was asked.
 */
interface LiveTurn { emit(event: EngineEvent): void; model: string; effort: Effort; state: ClaudeTurnState; asked?: { id: string; model: string; calls: number } }

/** What the turns share with the engine: its supervisor, grace, clock and ids, its models without effort and its purges. */
export interface ClaudeTurnsDeps {
  supervisor: Supervisor;
  graceMs?: number;
  lifecycle?: (message: string, data: Record<string, unknown>) => void;
  now: () => number;
  uuid: () => string;
  noEffort: ReadonlySet<string>;
  purging: ReadonlyMap<string, Promise<unknown>>;
}

export class ClaudeTurns {
  private readonly deps: ClaudeTurnsDeps;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly noEffort: ReadonlySet<string>;
  private readonly purging: ReadonlyMap<string, Promise<unknown>>;
  private readonly running = new Map<string, Lease>();
  /** runId → user lines steered into the running turn (17:09): the turn ends only once each was answered or the CLI ended. */
  private readonly steered = new Map<string, number>();
  private readonly live = new Map<string, LiveTurn>(); // B-080: runId → the running turn (setModel)

  constructor(deps: ClaudeTurnsDeps) {
    this.deps = deps;
    this.now = deps.now;
    this.uuid = deps.uuid;
    this.noEffort = deps.noEffort;
    this.purging = deps.purging;
  }

  async steer(runId: string, text: string): Promise<boolean> {
    const stdin = this.running.get(runId)?.child.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) return false; // the turn already answered: the next turn reads it
    stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`);
    this.steered.set(runId, (this.steered.get(runId) ?? 0) + 1);
    return true;
  }

  /**
   * B-080 (model.set now): the running CLI takes `model` from its next request (set_model); it sets no effort inside a turn,
   * so another effort is false. FIXES-3 C1 (real run 18.11.: the CLI switched 1.7 s after the tool's result, while the turn's
   * last request already ran): the turn is on `model` once a request runs on it (ranOn).
   */
  async setModel(runId: string, model: string, effort: Effort): Promise<boolean> {
    const turn = this.live.get(runId);
    const stdin = this.running.get(runId)?.child.stdin;
    if (!turn || !stdin || stdin.destroyed || stdin.writableEnded || (effort !== turn.effort && !this.noEffort.has(model))) return false;
    const id = `set_model_${this.uuid().slice(0, 8)}`;
    stdin.write(`${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'set_model', model: cliModel(model) } })}\n`);
    turn.asked = { id, model, calls: turn.state.modelCalls };
    return true;
  }

  /** B-080: the CLI's answer to a set_model request – an error leaves the turn where it is. */
  private answered(runId: string, message: Record<string, unknown>): void {
    const response = isRecord(message.response) ? message.response : {};
    const turn = this.live.get(runId);
    if (turn?.asked?.id === String(response.request_id) && response.subtype === 'error') turn.asked = undefined;
  }

  /**
   * FIXES-3 C1: a request that started after the ask runs on the model set_model asked for (`requestModel`, the API's id – a 1M
   * variant's without "[1m]", so a switch to the 1M variant of the model I am on counts from the next request) – the turn is on it.
   */
  private ranOn(turn: LiveTurn): void {
    const asked = turn.asked;
    const { requestModel, modelCalls } = turn.state;
    if (!asked || modelCalls <= asked.calls || requestModel !== cliModel(asked.model).replace(/\[1m\]$/, '')) return;
    turn.asked = undefined;
    turn.model = asked.model;
    turn.emit({ type: 'model', model: asked.model, effort: turn.effort });
  }

  /** One CLI process of a turn: the user message, then its stream until the result or its end; `fresh`: the new session it announces (B-080). */
  async attempt(command: string, args: string[], env: NodeJS.ProcessEnv, input: EngineTurnInput, content: Array<Record<string, unknown>>, fresh?: { ref: string; generation: number }, secure?: ClaudeSecure): Promise<Attempt> {
    // Wave 2: never while this account's histories are being purged (nothing awaits between here and the spawn).
    for (let purge = this.purging.get(input.account.id); purge; purge = this.purging.get(input.account.id)) await purge.catch(() => undefined);
    // Stopped while the turn was being prepared (a look before it, a purge): no CLI and no model call after the Stop, as on Codex (codex/turn.ts).
    if (input.signal.aborted) return { parser: new ClaudeStreamParser(() => {}, this.now), broken: false, interrupted: true, model: input.model, started: false };
    const lease = this.deps.supervisor.spawn({ command, args, owner: `claude:${input.runId}`, kind: 'heavy', cwd: input.cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
    this.running.set(input.runId, lease);
    const emit = (event: EngineEvent) => { try { input.onEvent(event); } catch { /* isolate */ } };
    const parser = new ClaudeStreamParser(emit, this.now);
    const turn: LiveTurn = { emit, model: input.model, effort: input.effort, state: parser.state };
    this.live.set(input.runId, turn);
    // Sicher-Runde 19.11.2026: Secure mode – the CLI's permission prompts are answered here through the gate (permissions.ts).
    const stdin = lease.child.stdin;
    const host = secure && stdin ? hostRequests((line) => !stdin.destroyed && !stdin.writableEnded && stdin.write(line), secure, input.signal) : undefined;
    let broken = false;
    let lines = 0;
    let open = true; // the turn has not returned yet; afterwards the lines of a CLI ending by itself are not part of it
    let stopWaiting = () => {};
    let backgroundSince: number | undefined;
    let backgroundWaitMs = 0, backgroundWaits = 0;
    const stopBackgroundWait = () => {
      if (backgroundSince === undefined) return;
      backgroundWaitMs += Math.max(0, this.now() - backgroundSince);
      backgroundSince = undefined;
    };
    const finished = new Promise<void>((resolve) => {
      stopWaiting = () => resolve();
      if (!lease.child.stdout) { broken = true; resolve(); return; }
      let results = 0;
      readJsonLines(lease.child.stdout, (message) => {
        if (!open) return;
        lines++;
        lease.touch();
        if (isRecord(message) && message.type === 'control_response') this.answered(input.runId, message); // B-080: set_model
        if (host?.(message)) return;
        parser.push(message);
        this.ranOn(turn); // FIXES-3 C1
        if (fresh && parser.state.sessionId) { emit({ type: 'session', ref: parser.state.sessionId, generation: fresh.generation }); fresh = undefined; } // B-080: bound at once
        if (parser.state.background.size === 0 || parser.state.isError) stopBackgroundWait();
        if (!parser.state.done) return;
        const result = isRecord(message) && message.type === 'result';
        if (result) results++;
        // B-080: native background work stays part of the turn; measure only the hold after a result.
        if (parser.state.background.size > 0 && !parser.state.isError) {
          if (result && backgroundSince === undefined) { backgroundSince = this.now(); backgroundWaits++; }
          return;
        }
        // Steered lines (17:09) are taken into this turn or answered as their own: no more input, then each
        // answer (one result per line) or the CLI's end – a steered line is never left unanswered.
        if (results > (this.steered.get(input.runId) ?? 0)) { if (result) resolve(); }
        else if (lease.child.stdin && !lease.child.stdin.writableEnded) { try { lease.child.stdin.end(); } catch { /* gone */ } }
      }, () => { broken = true; resolve(); });
      lease.exited.then(() => resolve());
    });
    let interrupted = false;
    const onAbort = () => {
      interrupted = true;
      try { lease.child.stdin?.write(`${JSON.stringify({ type: 'control_request', request_id: 'interrupt', request: { subtype: 'interrupt' } })}\n`); } catch { /* gone */ }
      setTimeout(() => stopWaiting(), 3000).unref?.(); // login guard 03.11.: no kill at once – it may be refreshing the sign-in (finally)
    };
    input.signal.addEventListener('abort', onAbort, { once: true });
    try {
      lease.child.stdin?.on('error', () => {});
      lease.child.stdin?.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);
      if (input.signal.aborted) onAbort();
      await finished;
    } finally {
      input.signal.removeEventListener('abort', onAbort);
      this.running.delete(input.runId);
      this.steered.delete(input.runId);
      this.live.delete(input.runId);
      try { lease.child.stdin?.end(); } catch { /* gone */ }
      void lease.releaseAfter(this.deps.graceMs ?? CLAUDE_EXIT_GRACE_MS); // it ends by itself; its tree is killed only after the grace
      stopBackgroundWait();
      if (backgroundWaits > 0) this.deps.lifecycle?.('claude background wait after result', {
        durationMs: backgroundWaitMs, waits: backgroundWaits, interrupted, streamEnded: broken,
      });
    }
    // `exited` may come before the last stdout data: a start without a line counts only once stdout ended (at most 2 s).
    const stdout = lease.child.stdout;
    if (!lines && stdout && !stdout.readableEnded) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 2000);
        function done() { clearTimeout(timer); resolve(); }
        stdout.once('end', done); stdout.once('close', done);
      });
    }
    open = false;
    return { parser, broken, interrupted, model: turn.model, started: lines > 0 };
  }

  /** Every running turn's CLI let go (engine.ts dispose). */
  async dispose(): Promise<void> {
    await Promise.all([...this.running.values()].map((lease) => lease.release()));
    this.running.clear();
  }
}
