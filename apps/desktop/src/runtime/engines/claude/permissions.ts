// Secure mode for Claude Code agent turns (Sicher-Runde 19.11.2026). Trust mode keeps `--permission-mode bypassPermissions`
// (engine.ts) and nothing here runs. In Secure mode an agent turn starts with `--permission-mode default` and
// `--permission-prompts host` (verified in `claude --help`, 2.1.328; 'default' is the mode the CLI also calls 'manual'):
// what the session's rules do not allow comes to Autark as a stream `control_request` `can_use_tool`, and the answer is
// services.security.gate's (codex/native-gate.ts). So that open steps need no round trip, `--settings` carries allow rules
// for the open folders (`Read(<dir>/**)` – also Glob and Grep –, `Edit(<dir>/**)` – also Write and NotebookEdit –, the bare
// tool when a switch is open everywhere), the hub's tools (`mcp__workforce`: the registry gates them), Bash/PowerShell when
// commands are open and WebSearch when the web is, and a deny `Edit(<dir>/**)` for every closed folder (<data>/security);
// the read-open folders are also `--add-dir` working directories (reads there pass even if a rule spelling were off).
// Rule paths follow Claude Code's form for absolute paths: `//` + the POSIX spelling (Windows `C:\a` → `//c/a`); a folder
// whose name holds a parenthesis gets no rule (its steps take the round trip, the gate answers at once).
// Mapping: Read/Glob/Grep → read (the file or folder), Edit/Write/NotebookEdit → write (the file), Bash/PowerShell →
// commands (what a command touches is not checkable), WebSearch/WebFetch → web, anything else → commands.
// Owns: the Secure-mode start arguments and settings, the can_use_tool → GateRequest mapping and the host's answers
// (control_response; a control_cancel_request stops the wait). Never: answers without the gate, widens a Trust-mode turn,
// or touches helper turns (they keep `--permission-prompts none`).

import * as path from 'node:path';
import type { FileScope, SecurityService } from '../../security/service.ts';
import type { SecuritySwitch } from '../../../shared/model/security-settings.ts';
import { effectOf, GATE_FAILED, gateNative, nativeFingerprint, type NativeTurn } from '../codex/native-gate.ts';
import { isRecord, str } from '../shared.ts';
import { HUB_SERVER } from './stream.ts';

const READS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const WRITES = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const SHELLS = new Set(['Bash', 'PowerShell']);
const WEB = new Set(['WebSearch', 'WebFetch']);

/** A Secure-mode agent turn: its permission flags, its `--settings` text and the answer to one can_use_tool request. */
export interface ClaudeSecure {
  args: string[];
  settings: string;
  answer(request: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>;
}

/** A folder as a Claude Code rule path (`//` + POSIX form); undefined when it cannot be one safely. */
export function rulePath(dir: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!dir || /[()]/.test(dir)) return undefined;
  if (platform === 'win32') {
    const resolved = path.win32.resolve(dir);
    const drive = /^([a-z]):[\\/]*(.*)$/i.exec(resolved);
    if (!drive) return undefined; // a UNC share or something else without a drive letter
    const rest = drive[2]!.replace(/\\/g, '/').replace(/\/+$/, '');
    return `//${drive[1]!.toLowerCase()}${rest ? `/${rest}` : ''}`;
  }
  const resolved = path.posix.resolve(dir).replace(/\/+$/, '');
  return `/${resolved || '/'}`;
}

/** `Tool(<dir>/**)` for each folder that has a rule path. */
function folderRules(tool: string, dirs: readonly string[], platform: NodeJS.Platform): string[] {
  return dirs.flatMap((dir) => { const rule = rulePath(dir, platform); return rule ? [`${tool}(${rule}/**)`] : []; });
}

/** The session settings of a Secure-mode agent turn: no hooks (as every turn) plus the allow and deny rules of `scope`. */
export function secureSettings(scope: FileScope, platform: NodeJS.Platform = process.platform): string {
  const allow = [`mcp__${HUB_SERVER}`];
  allow.push(...(scope.read === 'all' ? ['Read'] : folderRules('Read', scope.read, platform)));
  allow.push(...(scope.write === 'all' ? ['Edit'] : folderRules('Edit', scope.write, platform)));
  if (scope.commands === 'yes') allow.push('Bash', 'PowerShell');
  if (scope.web === 'yes') allow.push('WebSearch');
  const deny = folderRules('Edit', scope.closed, platform);
  // Folders inside open ones whose edits still ask (Autark's setup there, e.g. <workspace>/skills): `ask` beats `allow`.
  // Read when the service's FileScope names them (`guarded`, see build/S3.md); none until then.
  const ask = folderRules('Edit', (scope as FileScope & { guarded?: string[] }).guarded ?? [], platform);
  return JSON.stringify({ disableAllHooks: true, permissions: { allow, deny, ...(ask.length ? { ask } : {}) } });
}

/** The permission flags of a Secure-mode agent turn (in place of `--permission-mode bypassPermissions`). */
export function secureArgs(scope: FileScope): string[] {
  const dirs = scope.read === 'all' ? [] : scope.read;
  return ['--permission-mode', 'default', '--permission-prompts', 'host', ...dirs.flatMap((dir) => ['--add-dir', dir])];
}

const clip = (text: string, max = 200) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** What a can_use_tool request is about: its switch, its files and one line for the person. */
export function nativeStep(tool: string, input: Record<string, unknown>, blocked?: string): { capability: SecuritySwitch; paths: string[]; summary: string } {
  const file = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path) ?? blocked;
  const paths = [file, blocked].filter((one, i, all): one is string => Boolean(one) && all.indexOf(one) === i);
  const where = file ? ` in ${file}` : '';
  if (READS.has(tool)) {
    const summary = tool === 'Read' ? `Read ${file ?? 'a file'}` : `Search ${str(input.pattern) ?? 'files'}${where}`;
    return { capability: 'read', paths, summary: clip(summary) };
  }
  if (WRITES.has(tool)) return { capability: 'write', paths, summary: clip(`${tool === 'Write' ? 'Write' : 'Edit'} ${file ?? 'a file'}`) };
  if (SHELLS.has(tool)) return { capability: 'commands', paths: [], summary: clip(`Run: ${str(input.command) ?? tool}`) };
  if (WEB.has(tool)) return { capability: 'web', paths: [], summary: clip(tool === 'WebFetch' ? `Open ${str(input.url) ?? 'a page'}` : `Search the web: ${str(input.query) ?? ''}`) };
  return { capability: 'commands', paths, summary: clip(`Use ${tool}`) };
}

/** Secure mode's part of an agent turn (its agent and run), from the service's current scope. */
export function secureTurn(security: SecurityService, turn: NativeTurn, platform: NodeJS.Platform = process.platform): ClaudeSecure {
  let scope: FileScope;
  try { scope = security.fileScope(turn.agentId); }
  catch { scope = { mode: 'secure', read: [], write: [], commands: 'ask', web: 'ask', closed: [] }; } // no scope: every step goes to the gate
  return {
    args: secureArgs(scope),
    settings: secureSettings(scope, platform),
    async answer(request, signal) {
      const tool = str(request.tool_name) ?? '';
      const input = isRecord(request.input) ? request.input : {};
      const allow = { behavior: 'allow', updatedInput: input };
      if (tool.startsWith(`mcp__${HUB_SERVER}__`)) return allow; // our tools: the registry gates each call
      const step = nativeStep(tool, input, str(request.blocked_path));
      const result = await gateNative(security, { ...turn, ...step, fingerprint: nativeFingerprint('claude', tool, effectOf(input)), signal });
      return result.ok ? allow : { behavior: 'deny', message: result.text };
    },
  };
}

/**
 * The host side of a turn's control stream: a `can_use_tool` request is answered through `secure` (never twice, never
 * after the stream closed), a `control_cancel_request` ends its wait. Returns whether `message` was one of them.
 */
export function hostRequests(write: (line: string) => boolean, secure: ClaudeSecure, signal: AbortSignal): (message: unknown) => boolean {
  const waiting = new Map<string, AbortController>();
  return (message) => {
    if (!isRecord(message)) return false;
    if (message.type === 'control_cancel_request') {
      const id = String(message.request_id);
      const own = waiting.get(id);
      waiting.delete(id); // the CLI no longer waits: no answer goes out for it
      own?.abort();
      return true;
    }
    const request = isRecord(message.request) ? message.request : undefined;
    if (message.type !== 'control_request' || request?.subtype !== 'can_use_tool') return false;
    const id = String(message.request_id ?? '');
    const own = new AbortController();
    waiting.set(id, own);
    const answer = (response: Record<string, unknown>) => {
      if (waiting.get(id) !== own) return;
      waiting.delete(id);
      write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })}\n`);
    };
    secure.answer(request, AbortSignal.any([signal, own.signal]))
      .then(answer, () => answer({ behavior: 'deny', message: GATE_FAILED }));
    return true;
  };
}
