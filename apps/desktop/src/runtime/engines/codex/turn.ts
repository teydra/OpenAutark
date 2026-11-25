// One Codex turn on a persistent thread: notifications → EngineEvents, server requests → our tools / approvals, completion → EngineTurnResult.
// Owns: the per-turn state machine (deltas, reasoning summaries per item with section breaks and the completed item's
// text, own tool items (a web search journaled on completion, with its query; B-048: the full output of commands, file
// changes and MCP calls as tool_end.output, bounded 64k), usage incl. the reported context window and the cached input, limits, interrupt),
// generated images as EngineTurnResult.files (base64 result, or the saved path when Codex sent no bytes) and the
// turn/start input (with the volatile context block and the turn's own sandbox, approval policy and approval reviewer
// from isolation.ts); B-049 F6: whether Codex compacted the thread in this turn (EngineTurnResult.compacted) – KI-Runde
// 17.11.2026: each compaction is also a 'compacted' event (the context before it, how long it took). B-049 F9:
// this turn's raw Responses items give its code-mode exec/wait calls as native tool events, and a call made inside a
// script ("exec-" id) is marked nested on its tool_start (code-mode.ts). B-058: recordings as `localAudio` for a model
// that hears audio (G7, reads.ts); a nested call's images steered into the running turn (G10, nestedImageSteer).
// A turn stopped before turn/start makes no model call (e.g. the emergency stop during a cold start).
// A helper turn (engine.ts) whose model sends nothing for HELPER_SILENT_MS after turn/start answered is cut: a timeout, the call's own failure.
// B-080: setTurnModel switches a started turn's model and effort (turn/settings/update, experimental: only 'applied' counts).
// B-080: the final text holds the agent messages Codex completed – text of a sampling Codex dropped for a steered line or a
// stream retry never completes and stays out. turn/start waits for Codex's answer (it queues behind the thread's running turn)
// until the turn's signal ends the wait; a turn Codex starts after that is interrupted at once, so none runs unobserved. The
// connection closing during that wait is our own engine process (details.local), never an account's failure.
// Never: starts processes or threads (engine.ts does).

import type { EngineEvent, EngineFile, EngineTurnInput, EngineTurnResult } from '../types.ts';
import type { RpcClient } from './rpc.ts';
import type { RpcNote } from '../line-rpc.ts';
import { RpcError } from './rpc.ts';
import type { CodexServer } from './server.ts';
import { APPROVAL_METHODS, approvalResponse, declineUserInput, refusalSteer, type CodexSecure } from './approvals.ts';
import { turnPermissions, type TurnAccess } from './isolation.ts';
import { ERR, ToolNames, contextText, isRecord, nearestEffort, num, outputImages, outputText, safeCall, str, tryJson } from '../shared.ts';
import type { Effort } from '../../../shared/model/providers.ts';
import { normalizeCodexLimits } from '../../accounts/limits.ts';
import { boundOutput } from '../output.ts';
import { CodeCalls, hostMissingText, nestedImageSteer } from '../code-mode.ts'; // B-049 F9; B-058 G10 nested images
import { codexHearsAudioNow } from './reads.ts'; // B-058 G7: recordings as localAudio for a model that hears them
import { codexDown, providerDownMessage } from '../provider-outage.ts'; // B-059 #184
import { orStopped } from './helper-thread.ts'; // B-080: turn/start waits on the turn's signal
import { verifiedCli } from '../managed-path.ts'; // 0.3.19: the row mark only under a verified CLI

const OWN_ITEMS: Record<string, (item: Record<string, unknown>) => { name: string; args: unknown }> = {
  commandExecution: (item) => ({ name: 'shell', args: { command: item.command, cwd: item.cwd } }),
  fileChange: (item) => ({ name: 'apply_patch', args: { files: Array.isArray(item.changes) ? item.changes.map((c) => (isRecord(c) ? c.path : undefined)) : [] } }),
  mcpToolCall: (item) => ({ name: `${str(item.server) ?? 'mcp'}.${str(item.tool) ?? 'tool'}`, args: item.arguments }),
  webSearch: (item) => ({ name: 'web_search', args: { query: webQuery(item) } }),
  imageGeneration: () => ({ name: 'image_generation', args: {} }),
};

/**
 * B-048 E1/E2: a completed native item's full output for the ledger (tool_end.output, bounded): a command's
 * aggregated output, a file change's diffs, an MCP call's result text. None when Codex sent nothing.
 */
export function nativeOutput(type: string, item: Record<string, unknown>): { output?: string } {
  let text = '';
  if (type === 'commandExecution') text = str(item.aggregatedOutput) ?? '';
  else if (type === 'fileChange' && Array.isArray(item.changes)) {
    text = item.changes.filter(isRecord).map((change) => {
      const kind = isRecord(change.kind) ? str(change.kind.type) : str(change.kind);
      return `${kind ?? 'change'} ${str(change.path) ?? ''}${str(change.diff) ? `\n${change.diff as string}` : ''}`;
    }).join('\n');
  } else if (type === 'mcpToolCall') {
    const result = isRecord(item.result) ? item.result : undefined;
    const content = Array.isArray(result?.content) ? result.content : [];
    text = content.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).filter(Boolean).join('\n')
      || (isRecord(item.error) ? str(item.error.message) ?? '' : '');
  }
  return text ? { output: boundOutput(text) } : {};
}

/** A web search item's query (or the page it opens); Codex fills it only when the item completes. */
function webQuery(item: Record<string, unknown>): string {
  const action = isRecord(item.action) ? item.action : {};
  return str(item.query) || str(action.query) || str(action.url) || '';
}

/** Input items as Codex UserInput; B-058 G7: a recording as `localAudio` (+ its text) when `hears` (reads.ts codexHearsAudio), else a text line. */
export const codexInput = (input: EngineTurnInput['input'], hears = false): Array<Record<string, unknown>> => input.flatMap((item): Array<Record<string, unknown>> => {
  if (item.type === 'text') return [{ type: 'text', text: item.text, text_elements: [] }];
  if (item.type === 'image') return [{ type: 'localImage', path: item.path }];
  if (item.type === 'audio' && hears) return [{ type: 'localAudio', path: item.path }, ...(item.text ? [{ type: 'text', text: item.text, text_elements: [] }] : [])];
  return [{ type: 'text', text: `[file: ${item.name} (${item.mime}) at ${item.path}]${item.text ? `\n${item.text}` : ''}`, text_elements: [] }];
});

/** A running turn's handles for steer and (B-080) setTurnModel: its thread, its turn once started, its events; B-080: its signal (engine.ts tell). */
export interface TurnControl { threadId: string; turnId?: string; rpc: RpcClient; emit?: (event: EngineEvent) => void; signal?: AbortSignal }

/**
 * B-080 (model.set now): Codex's experimental turn/settings/update – the running turn goes on with `model` and `effort`
 * (the nearest one the model lists) from its next request. True only when Codex answers 'applied' (then the turn's events
 * say so); 'targetUnavailable', a refusal or a turn not started yet is false, and the caller continues in a new turn.
 */
export async function setTurnModel(control: TurnControl | undefined, model: string, effort: Effort, supported: string[] = []): Promise<boolean> {
  if (!control?.turnId) return false;
  const wire = supported.length ? nearestEffort(effort, supported) : effort === 'max' ? 'xhigh' : effort;
  let status: string | undefined;
  try {
    const answer = await control.rpc.request<{ status?: string }>('turn/settings/update', { threadId: control.threadId, turnId: control.turnId, model, effort: wire }, 10_000);
    status = str(answer?.status);
  } catch { return false; } // an older Codex without the method, or a refused field
  if (status !== 'applied') return false;
  control.emit?.({ type: 'model', model, effort });
  return true;
}

/**
 * A helper turn (structured answer, no tools) is one model request. Live 01.11.2026: a model that keeps reaching for tools it does not have
 * goes on request after request, unseen in the items (55 requests and 503,459 input tokens in the one minute the call may take): it is cut here.
 */
export const HELPER_REQUESTS = 8;

/** Live n2/qf: the first model item came after a median 1.7 s, 3 of 1,324 after 58–62 s and then answered, 2 hangs sent nothing for 179 s – 60 s would have cut answers 2 s early. */
export const HELPER_SILENT_MS = 90_000;

/** Items the turn's own input makes (the app-server's echo of it), not the model. */
const INPUT_ITEMS: ReadonlySet<string> = new Set(['userMessage', 'hookPrompt']);

/** A sign that the model answers: one of its items or a delta of one, or a request's token usage. */
const modelSign = (note: RpcNote): boolean => note.method === 'thread/tokenUsage/updated'
  || (note.method.startsWith('item/') && !(isRecord(note.params.item) && INPUT_ITEMS.has(str(note.params.item.type) ?? '')));

/**
 * The thread's running token total (tokenUsage.total.totalTokens) as last counted, per app-server process and thread. Codex
 * sends the thread's usage again unchanged when a turn is interrupted: measured 18.11.2026 on two cut turns (a model.set
 * with now, a fold cut by the person's line), each run stored the turn before's last request (27,718 in + 14 out = the
 * context before it; 141,459 + 49 = 141,508) as its own. A usage update whose total did not move is that repeat – no request.
 * A process that has not counted the thread yet (the app started anew) knows the repeat by its size: a turn's first update
 * whose request holds exactly the session's count before the turn – a real request of the turn holds its new input too.
 */
const countedTotals = new WeakMap<CodexServer, Map<string, number>>();

/** Whether a usage update reports a new request of the turn (see countedTotals); `before`: the session's count before a turn's first update. */
function newRequest(server: CodexServer, threadId: string, usage: Record<string, unknown>, before: number | undefined): boolean {
  const total = isRecord(usage.total) ? num(usage.total.totalTokens) : undefined;
  let threads = countedTotals.get(server);
  if (!threads) countedTotals.set(server, (threads = new Map()));
  const counted = threads.get(threadId);
  if (total !== undefined) threads.set(threadId, total);
  if (total !== undefined && counted !== undefined) return counted !== total;
  return before === undefined || !isRecord(usage.last) || num(usage.last.totalTokens) !== before;
}

/** A completed imageGeneration item as an engine file (undefined when it carries no image). */
export function generatedImage(item: Record<string, unknown>, n: number): EngineFile | undefined {
  if (item.status === 'failed' || isRecord(item.failure)) return undefined;
  const name = `generated-image-${n}.png`;
  const data = str(item.result);
  if (data) return { name, mime: /^data:([^;,]+)/.exec(data)?.[1] ?? 'image/png', dataBase64: data };
  const saved = str(item.savedPath);
  return saved ? { name, path: saved } : undefined;
}

/** The live context as the turn input's first item (shared.ts contextText; runtime context, not a chat message). */
export function contextBlock(volatile: string | undefined): Array<Record<string, unknown>> {
  const text = contextText(volatile);
  return text ? [{ type: 'text', text, text_elements: [] }] : [];
}

/** The engine id of a reasoning block (Codex item id), when Codex sent one. */
function reasoningId(value: unknown): { id?: string } {
  const id = str(value);
  return id ? { id } : {};
}

/** A completed reasoning item's summary parts as one authoritative text (sections apart), when it has any. */
export function reasoningText(summary: unknown): { text?: string } {
  const parts = Array.isArray(summary) ? summary.filter((part): part is string => typeof part === 'string' && part.trim() !== '') : [];
  return parts.length ? { text: parts.join('\n\n') } : {};
}

/**
 * Runs a turn on an already started/resumed thread. `control` is filled for steer(); `context`
 * (the live context) is sent in front of the input on every turn; `access` (default
 * 'full') is the turn's sandbox (isolation.ts turnAccess); `summary`
 * (D5) asks for reasoning summaries ('auto' for agent turns, 'none' for helper turns); `helper` (engine.ts) arms the cut of a structured turn the model never answers.
 */
export async function runCodexTurn(args: {
  server: CodexServer; rpc: RpcClient; threadId: string; input: EngineTurnInput; effort?: string; names: ToolNames;
  control: TurnControl; now: () => number; context?: string; access?: TurnAccess; summary?: 'auto' | 'none'; helper?: boolean;
  secure?: CodexSecure; // Sicher-Runde 19.11.2026: Secure mode's sandbox and gate (approvals.ts)
}): Promise<EngineTurnResult> {
  const { server, rpc, threadId, input, names, control } = args;
  const emit = (event: EngineEvent) => { try { input.onEvent(event); } catch { /* UI listener errors never break a turn */ } };
  control.emit = emit; // B-080: setTurnModel reports the switch into this turn
  const texts = new Map<string, string>(); // agentMessage itemId → text (deltas, replaced by completed text)
  const done = new Set<string>(); // B-080: agentMessage items Codex completed – a sampling it dropped for a steered line or a stream retry never completes
  const commentary = new Set<string>();
  const images = new Map<string, EngineFile>(); // imageGeneration itemId → generated image
  const usage: NonNullable<EngineTurnResult['usage']> = { inputTokens: 0, outputTokens: 0 }; // cachedInputTokens once Codex reports it
  let contextTokens: number | undefined;
  let contextWindow: number | undefined;
  let requests = 0;
  let usageSeen = false; // the turn's first usage update is weighed against the session's count before it (newRequest)
  let lastError: { message: string; info: unknown } | undefined;
  let compacted = false; // B-049 F6: Codex compacted the thread's history in this turn (contextCompaction / thread/compacted)
  let compacting: { at: number; before?: number } | undefined; // KI-Runde 17.11.2026: a compaction that began – when, and the context then
  // The compaction as an event, once per compaction: the context before it and how long it took, as far as this turn saw them.
  const tellCompacted = () => {
    if (compacted && !compacting) return; // its deprecated second form
    compacted = true;
    emit({ type: 'compacted', ...(compacting?.before !== undefined ? { before: compacting.before } : contextTokens !== undefined ? { before: contextTokens } : {}), ...(compacting ? { ms: Math.max(0, args.now() - compacting.at) } : {}) });
    compacting = undefined;
  };
  let turnId: string | undefined;
  let ended = false; // this Codex cannot run tools: the turn was stopped
  let quiet: ReturnType<typeof setTimeout> | undefined; // a helper turn's cut, until the model's first sign
  let silent = false; // the cut ended the turn
  const early: RpcNote[] = []; // notifications that arrive before turn/start answers
  // B-049 F9: exec/wait calls and nested marking. 0.3.19: an agent thread's script calls carry the row mark only under a CLI
  // version checked against the shell switches (verifiedCli) – under any other one Codex's own shell may still have run, so its
  // rows stay legacy and are withheld from a rebuild, like the session mark that same version would not get trusted.
  const code = new CodeCalls(emit, (wire) => names.ours(wire) !== undefined, !args.helper && verifiedCli('codex', server.cliVersion));

  let finish!: (status: string, error: unknown) => void;
  const completed = new Promise<{ status: string; error: unknown }>((resolve) => { finish = (status, error) => resolve({ status, error }); });

  const handle = (note: RpcNote) => {
    const p = note.params;
    if (note.method === 'workforce/closed') { finish('closed', undefined); return; }
    if (!turnId) { early.push(note); return; }
    if (str(p.turnId) && p.turnId !== turnId && note.method !== 'turn/completed') return;
    if (quiet && modelSign(note)) { clearTimeout(quiet); quiet = undefined; }
    switch (note.method) {
      case 'item/agentMessage/delta': {
        const id = str(p.itemId) ?? '';
        const delta = str(p.delta) ?? '';
        texts.set(id, (texts.get(id) ?? '') + delta);
        if (delta && !commentary.has(id)) emit({ type: 'text', delta });
        break;
      }
      // D5: reasoning summaries per item (schema: ReasoningSummaryTextDelta/PartAdded {itemId, summaryIndex});
      // a new summary part is a section break; the completed reasoning item's summary[] is authoritative.
      case 'item/reasoning/summaryTextDelta':
        if (str(p.delta)) emit({ type: 'reasoning', delta: p.delta as string, ...reasoningId(p.itemId) });
        break;
      case 'item/reasoning/summaryPartAdded':
        if ((num(p.summaryIndex) ?? 0) > 0) emit({ type: 'reasoning', delta: '\n\n', ...reasoningId(p.itemId) });
        break;
      case 'turn/plan/updated':
        if (Array.isArray(p.plan)) emit({ type: 'plan', steps: p.plan.filter(isRecord).map((s) => ({ text: String(s.step ?? ''), status: s.status === 'completed' ? 'done' : s.status === 'inProgress' ? 'active' : 'pending' })) });
        break;
      case 'item/started':
      case 'item/completed': {
        const item = isRecord(p.item) ? p.item : undefined;
        if (!item) break;
        const type = str(item.type) ?? '';
        if (note.method === 'item/started') args.secure?.gate.seen(item); // a file change's files, for its approval request
        if (type === 'contextCompaction') {
          if (note.method === 'item/started') compacting = { at: args.now(), ...(contextTokens !== undefined ? { before: contextTokens } : {}) };
          else tellCompacted();
        }
        if (type === 'agentMessage') {
          const id = str(item.id) ?? '';
          if (item.phase === 'commentary') commentary.add(id);
          if (note.method === 'item/completed' && typeof item.text === 'string') {
            texts.set(id, item.text);
            done.add(id);
            if (commentary.has(id) && item.text.trim()) emit({ type: 'commentary', text: item.text });
          }
        }
        if (type === 'reasoning' && note.method === 'item/completed') emit({ type: 'reasoning_end', ...reasoningId(item.id), ...reasoningText(item.summary) });
        if (type === 'imageGeneration' && note.method === 'item/completed') {
          const image = generatedImage(item, images.size + 1);
          if (image) images.set(str(item.id) ?? String(images.size), image);
        }
        const own = OWN_ITEMS[type];
        if (own) {
          const callId = str(item.id) ?? '';
          // A web search names its query only on completion: its step is journaled then (a start already sent is ignored there).
          const later = type === 'webSearch' && note.method === 'item/started' && !webQuery(item);
          if (later) emit({ type: 'status', note: 'Searching the web' });
          else if (note.method === 'item/started') { const d = own(item); emit({ type: 'tool_start', callId, name: d.name, args: d.args, own: true, ...code.nested(callId) }); }
          else {
            if (type === 'webSearch') { const d = own(item); emit({ type: 'tool_start', callId, name: d.name, args: d.args, own: true, ...code.nested(callId) }); }
            const ok = item.status === 'completed' || (type === 'webSearch' && item.status === undefined);
            const summary = type === 'commandExecution' ? `exit ${num(item.exitCode) ?? '?'}` : String(item.status ?? '');
            emit({ type: 'tool_end', callId, ok, summary, ...nativeOutput(type, item) });
          }
        }
        if (type === 'commandExecution' && note.method === 'item/started' && typeof item.command === 'string') emit({ type: 'status', note: `running ${item.command.slice(0, 60)}` });
        break;
      }
      case 'thread/tokenUsage/updated': {
        const tu = isRecord(p.tokenUsage) ? p.tokenUsage : {};
        const first = !usageSeen;
        usageSeen = true;
        if (!newRequest(server, threadId, tu, first ? input.session?.contextTokens : undefined)) break; // the thread's usage sent again (an interrupt): no request of this turn
        const last = isRecord(tu.last) ? tu.last : {};
        const inTok = num(last.inputTokens) ?? 0, outTok = num(last.outputTokens) ?? 0;
        const cached = num(last.cachedInputTokens); // a part of inputTokens, which stays the total
        usage.inputTokens += inTok;
        usage.outputTokens += outTok;
        if (cached !== undefined) usage.cachedInputTokens = (usage.cachedInputTokens ?? 0) + cached;
        contextTokens = num(last.totalTokens) ?? contextTokens;
        contextWindow = num(tu.modelContextWindow) ?? contextWindow;
        emit({ type: 'usage', inputTokens: inTok, outputTokens: outTok, ...(cached !== undefined ? { cachedInputTokens: cached } : {}), contextTokens });
        if (input.outputSchema && ++requests === HELPER_REQUESTS) onAbort();
        break;
      }
      case 'thread/compacted': // deprecated form of the contextCompaction item (app-server schema v2)
        tellCompacted();
        break;
      case 'rawResponseItem/completed': // B-049 F9: only this turn's (an injection's items carry an 'auto-compact-<n>' turn id)
        if (p.turnId === turnId && isRecord(p.item)) {
          code.raw(p.item);
          if (code.hostMissing !== undefined && !ended) { ended = true; onAbort(); } // no tool can run: the model would only try again and pay for it
        }
        break;
      case 'error':
        if (p.willRetry !== true && isRecord(p.error)) lastError = { message: String(p.error.message ?? ''), info: p.error.codexErrorInfo };
        break;
      case 'turn/completed': {
        const turn = isRecord(p.turn) ? p.turn : {};
        if (str(turn.id) && turn.id !== turnId) break;
        finish(str(turn.status) ?? 'failed', turn.error);
        break;
      }
    }
  };

  const serve = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === 'item/tool/call') {
      const wire = str(params.tool) ?? '';
      const ns = str(params.namespace);
      const name = names.ours(ns ? `${ns}__${wire}` : wire) ?? names.ours(wire);
      const callId = str(params.callId) ?? '';
      if (!name) return { success: false, contentItems: [{ type: 'inputText', text: `Unknown tool: ${wire}` }] };
      emit({ type: 'tool_start', callId, name, args: params.arguments, own: false, ...code.nested(callId) });
      const output = await safeCall(input.callTool, name, params.arguments ?? {}, callId);
      const shown = nestedImageSteer(name, callId, output); // B-058 G10: a nested call's images reach the model
      if (shown && turnId) await rpc.request('turn/steer', { threadId, expectedTurnId: turnId, input: shown }, 10_000).catch(() => undefined);
      emit({ type: 'tool_end', callId, ok: !output.isError, summary: outputText(output, 120) });
      return {
        success: !output.isError,
        contentItems: [
          { type: 'inputText', text: outputText(output) || (output.isError ? 'failed' : 'ok') },
          ...outputImages(output).map((img) => ({ type: 'inputImage', imageUrl: `data:${img.mime};base64,${img.dataBase64}` })),
        ],
      };
    }
    if (APPROVAL_METHODS.has(method)) {
      if (!args.secure) return approvalResponse(method, params, args.access !== 'read');
      // 25.11.2026: a refused step's reason reaches the model as a steered line – Codex's decline carries none of ours.
      const { response, refused } = await args.secure.gate.decide(method, params);
      if (refused && turnId) await rpc.request('turn/steer', { threadId, expectedTurnId: turnId, input: refusalSteer(refused) }, 10_000).catch(() => undefined);
      return response;
    }
    if (method === 'item/tool/requestUserInput') return declineUserInput();
    if (method === 'mcpServer/elicitation/request') return { action: 'decline' };
    throw new RpcError(-32601, 'This action is not available.');
  };

  const unregister = server.register(threadId, { onNotification: handle, onServerRequest: serve });
  const endTurn = server.beginTurn();
  const onAbort = () => {
    if (turnId) void rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {});
    // If Codex never confirms, do not hang the executor.
    setTimeout(() => finish('interrupted', undefined), 10_000).unref?.();
  };
  input.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const hears = input.input.some((item) => item.type === 'audio') && await codexHearsAudioNow(rpc, input.model);
    const params: Record<string, unknown> = { threadId, input: [...contextBlock(args.context), ...codexInput(input.input, hears)], model: input.model, ...turnPermissions(args.access, args.secure?.sandbox) };
    if (args.effort) params.effort = args.effort;
    if (args.summary) params.summary = args.summary; // D5: TurnStartParams.summary (ReasoningSummary)
    if (input.outputSchema) params.outputSchema = input.outputSchema;
    const session = input.session ? { ...input.session, ref: threadId } : { ref: threadId, generation: 1 };
    // Stopped while the server or the thread opened (e.g. "Stop all work" during a cold start): no model call after the Stop.
    if (input.signal.aborted) return { text: '', stop: 'interrupted', error: ERR.cancelled(), usage, session };
    // B-080: no timer – Codex answers once the thread's running turn lets it (live: an abort took up to 9.5 min); the turn's
    // signal (a Stop, the stall watch, a helper call's limit) ends the wait, and a turn Codex starts after that is interrupted.
    const starting = rpc.request<{ turn?: { id?: string } }>('turn/start', params, 0);
    try {
      turnId = str((await orStopped(starting, input.signal))?.turn?.id);
    } catch (error) {
      if (!input.signal.aborted) return { text: '', stop: 'error', error: startError(error) };
      void starting.then((late) => { const id = str(late?.turn?.id); return id ? rpc.request('turn/interrupt', { threadId, turnId: id }) : undefined; }).catch(() => undefined);
      return { text: '', stop: 'interrupted', error: ERR.cancelled(), usage, session };
    }
    if (!turnId) return { text: '', stop: 'error', error: ERR.failed() };
    control.turnId = turnId;
    if (args.helper && input.outputSchema) {
      quiet = setTimeout(() => { quiet = undefined; silent = true; onAbort(); }, HELPER_SILENT_MS);
      quiet.unref?.();
    }
    for (const note of early.splice(0)) handle(note);
    if (input.signal.aborted) onAbort();
    const { status, error } = await completed;
    code.flush(); // B-049 F9: a script call still open ends with what it printed
    // B-080: the completed answers (as Codex keeps them in its thread); the streamed deltas only when none completed
    // A helper turn has no tools, so a model that wrote its whole answer as a commentary message (18.11.2026, a call's voice:
    // the line went unanswered and nothing was passed on) answered with it.
    const final = [...texts.entries()].filter(([id]) => !commentary.has(id));
    const answers = args.helper && !final.some(([, part]) => part.trim()) ? [...texts.entries()] : final;
    const kept = answers.some(([id]) => done.has(id)) ? answers.filter(([id]) => done.has(id)) : answers;
    const text = kept.map(([, part]) => part).filter(Boolean).join('\n\n');
    const result: EngineTurnResult = { text, stop: 'done', usage, contextTokens, contextWindow, session };
    if (images.size) result.files = [...images.values()];
    if (compacted) result.compacted = true;
    if (code.hostMissing !== undefined) return { ...result, stop: 'error', error: { ...ERR.unavailable(hostMissingText(code.hostMissing)), details: { codeHost: true } } };
    if (status === 'completed') {
      if (input.outputSchema) result.structured = tryJson(text.trim());
      return result;
    }
    if (silent) return { ...result, stop: 'error', error: { ...ERR.timeout(), message: `The model sent nothing for ${HELPER_SILENT_MS / 1000} s.` } };
    if (status === 'interrupted' || input.signal.aborted) return { ...result, stop: 'interrupted', error: ERR.cancelled() };
    if (status === 'closed') return { ...result, stop: 'error', error: ERR.unavailable('The Codex connection closed.') };
    const info = isRecord(error) ? error.codexErrorInfo : lastError?.info;
    if (info === 'usageLimitExceeded' || info === 'rateLimitExceeded') return { ...result, stop: 'limit', error: ERR.limit(undefined, { reason: info }) };
    if (info === 'unauthorized') return { ...result, stop: 'error', error: ERR.unavailable('Codex is not signed in for this account.') };
    if (info === 'contextWindowExceeded') return { ...result, stop: 'error', error: { code: 'conflict', message: 'The conversation is too long for this session.', details: { rebase: true } } };
    if (codexDown(info)) return { ...result, stop: 'error', error: ERR.unavailable(providerDownMessage('OpenAI')) }; // B-059 #184: an outage, not a model failure
    return { ...result, stop: 'error', error: ERR.failed() };
  } finally {
    clearTimeout(quiet);
    input.signal.removeEventListener('abort', onAbort);
    unregister();
    endTurn();
  }
}

/**
 * An RpcError is Codex's own answer (a refusal); B-080: anything else is the connection to the app-server on this PC
 * closing while turn/start waited (it has no timer) – our own engine process, `local`: no account cools (accounts/failure.ts).
 */
function startError(error: unknown) {
  if (!(error instanceof RpcError)) return { ...ERR.unavailable('The Codex connection on this PC closed before the turn started.'), details: { local: true } };
  return /limit/i.test(error.message) ? ERR.limit() : ERR.unavailable('Codex could not start this turn.');
}

/** Applies a limits push to retry timing: earliest reset of a window at 100 %. */
export function retryAfterFrom(limitsParams: unknown, now: number): number | undefined {
  const limits = normalizeCodexLimits(isRecord(limitsParams) && 'rateLimits' in limitsParams ? limitsParams : { rateLimits: limitsParams }, now);
  const full = limits?.windows.filter((w) => w.usedPercent >= 100 && w.resetsAt).map((w) => w.resetsAt! - now) ?? [];
  return full.length ? Math.max(0, Math.min(...full)) : undefined;
}
