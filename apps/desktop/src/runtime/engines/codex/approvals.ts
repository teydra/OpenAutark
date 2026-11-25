// Answers to Codex app-server approval server-requests. B-080: Codex's command guard sends them in every agent turn
// (approvalPolicy 'on-request', isolation.ts); in Trust mode the app accepts them: an agent turn accepts them for the
// session at once, a read-only turn (helpers, approvalPolicy 'never') declines them.
// Sicher-Runde 19.11.2026 – Secure mode (codexSecure): an agent turn runs in Codex's write sandbox (isolation.ts
// turnPermissions) and every approval request asks services.security's gate (native-gate.ts); the answer holds for this
// one step ('accept' / 'approved', never for the session – an "always" lives in the security settings, not in Codex):
// a command → `commands` when commands ask, else (Codex wants to run it outside the sandbox) → `write` with the folders it
// asks for; a file change → `write` with its files (taken from the fileChange item Codex started before it asked); more
// permissions → `write` (files) or `web` (network only); a network approval → `web`.
// Owns: the exact decision values per method (verified against the app-server's generated JSON schema, codex-cli
// 0.167.0-alpha.3.2) and the Secure-mode mapping of a request to a gate step. Never: decides (the gate does) or answers
// a Secure-mode request for the session.

import type { Allow } from '../../../shared/model/security-settings.ts';
import type { SecurityService } from '../../security/service.ts';
import { isRecord, str } from '../shared.ts';
import type { TurnAccess } from './isolation.ts';
import { gateNative, nativeFingerprint, secureService, type NativeStep, type NativeTurn, type SecurityLookup } from './native-gate.ts';

export const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval',
  'execCommandApproval', 'applyPatchApproval',
]);

/** The JSON-RPC result for an approval request: accepted for the session (`once`: for this step only), or declined (the turn goes on). */
export function approvalResponse(method: string, params: Record<string, unknown>, allow: boolean, once = false): Record<string, unknown> {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: allow ? (once ? 'accept' : 'acceptForSession') : 'decline' };
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: allow ? (once ? 'approved' : 'approved_for_session') : 'denied' };
    case 'item/permissions/requestApproval':
      return allow ? { permissions: isRecord(params.permissions) ? params.permissions : {}, scope: once ? 'turn' : 'session' } : { permissions: {}, scope: 'turn' };
    default:
      return {};
  }
}

/** `item/tool/requestUserInput`: we never answer for the human; empty answers decline politely. */
export function declineUserInput(): Record<string, unknown> {
  return { answers: {} };
}

/** What a Secure-mode turn's sandbox is built from (isolation.ts turnPermissions). */
export interface SecureSandbox { write: 'all' | string[]; commands: Allow }

/** A Secure-mode agent turn: its sandbox and the gate its approval requests go through. */
export interface CodexSecure { sandbox: SecureSandbox; gate: CodexGate }

/** Secure mode's part of an agent turn (`access` 'full'); undefined in Trust mode or for a read turn (today's answers). */
export function codexSecure(lookup: SecurityLookup | undefined, turn: NativeTurn, access: TurnAccess, signal: AbortSignal): CodexSecure | undefined {
  if (access !== 'full') return undefined;
  const security = secureService(lookup);
  if (!security) return undefined;
  let sandbox: SecureSandbox;
  try { const scope = security.fileScope(turn.agentId); sandbox = { write: scope.write, commands: scope.commands }; }
  catch { sandbox = { write: [], commands: 'ask' }; } // no scope: writes stay in the turn's folder, every command asks
  return { sandbox, gate: new CodexGate(security, turn, sandbox.commands, signal) };
}

const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string' && one !== '') : []);

/** The folders a permission profile wants to write (its legacy `write` list and its `write` entries with a path). */
function writePaths(profile: unknown): string[] {
  const fs = isRecord(profile) && isRecord(profile.fileSystem) ? profile.fileSystem : {};
  const entries = Array.isArray(fs.entries) ? fs.entries.filter(isRecord) : [];
  const fromEntries = entries.filter((entry) => entry.access === 'write' && isRecord(entry.path)).map((entry) => str((entry.path as Record<string, unknown>).path) ?? '');
  return [...list(fs.write), ...fromEntries].filter(Boolean);
}

const clip = (text: string) => (text.length > 200 ? `${text.slice(0, 199)}…` : text);

/** A request this mapping does not know is declined; the model reads why. */
const UNKNOWN_STEP = 'BLOCKED – not executed. The app does not know this kind of approval request, so it declined it; this step did not run, and I never report it as done.';

/**
 * The line steered into a Codex turn after a refused approval request: the gate's text, marked as the app's own – a steered
 * line reads like a user message, and this one is not the person's.
 */
export function refusalSteer(text: string): Array<Record<string, unknown>> {
  return [{ type: 'text', text: `[Autark app – security gate, not a message from the person] The step you just asked approval for: ${text}`, text_elements: [] }];
}

/** One Secure-mode turn's approval requests through the gate. */
export class CodexGate {
  private readonly security: SecurityService;
  private readonly turn: NativeTurn;
  private readonly commands: Allow;
  private readonly signal: AbortSignal;
  private readonly files = new Map<string, string[]>(); // fileChange item id → its files (from item/started)

  constructor(security: SecurityService, turn: NativeTurn, commands: Allow, signal: AbortSignal) {
    this.security = security;
    this.turn = turn;
    this.commands = commands;
    this.signal = signal;
  }

  /** A started item: a file change's files, for the approval request that names only its item id. */
  seen(item: Record<string, unknown>): void {
    if (item.type !== 'fileChange' || !Array.isArray(item.changes)) return;
    this.files.set(str(item.id) ?? '', item.changes.flatMap((change) => (isRecord(change) && str(change.path) ? [change.path as string] : [])));
  }

  /** The answer to one approval request: the gate's, for this step only. */
  async answer(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return (await this.decide(method, params)).response;
  }

  /**
   * The answer and, when the step was refused, the gate's text for the model (25.11.2026): Codex's decline carries no
   * words of ours – the model only reads Codex's own "rejected" – so the turn steers this text in (turn.ts).
   */
  async decide(method: string, params: Record<string, unknown>): Promise<{ response: Record<string, unknown>; refused?: string }> {
    const step = this.step(method, params);
    const result = step ? await gateNative(this.security, { ...step, ...this.turn, signal: this.signal }) : { ok: false as const, text: UNKNOWN_STEP };
    return { response: approvalResponse(method, params, result.ok, true), ...(result.ok ? {} : { refused: result.text }) };
  }

  private step(method: string, params: Record<string, unknown>): Omit<NativeStep, keyof NativeTurn | 'signal'> | undefined {
    if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
      const command = Array.isArray(params.command) ? list(params.command).join(' ') : str(params.command) ?? '';
      const network = isRecord(params.networkApprovalContext) ? str(params.networkApprovalContext.host) : undefined;
      const fingerprint = nativeFingerprint('codex', 'command', { command, cwd: params.cwd, kind: params.kind, more: params.additionalPermissions ?? null, network: network ?? null });
      if (network) return { capability: 'web', summary: clip(`Reach ${network}${command ? ` for: ${command}` : ''}`), fingerprint };
      if (this.commands === 'ask' || params.kind === 'humanCommand' || params.kind === 'writeStdin') return { capability: 'commands', summary: clip(`Run: ${command || 'a command'}`), fingerprint };
      return { capability: 'write', paths: writePaths(params.additionalPermissions), summary: clip(`Run outside the sandbox: ${command || 'a command'}`), fingerprint };
    }
    if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
      const known = method === 'applyPatchApproval' && isRecord(params.fileChanges) ? Object.keys(params.fileChanges) : this.files.get(str(params.itemId) ?? '') ?? [];
      const paths = known.length ? known : list([params.grantRoot]);
      return { capability: 'write', paths, summary: clip(`Edit ${paths.join(', ') || 'files'}`), fingerprint: nativeFingerprint('codex', 'fileChange', { paths, grantRoot: params.grantRoot ?? null }) };
    }
    if (method === 'item/permissions/requestApproval') {
      const paths = writePaths(params.permissions);
      const fingerprint = nativeFingerprint('codex', 'permissions', params.permissions ?? null);
      if (!paths.length && isRecord(params.permissions) && isRecord(params.permissions.network)) return { capability: 'web', summary: 'Reach the network', fingerprint };
      return { capability: 'write', paths, summary: clip(`Write in ${paths.join(', ') || 'more folders'}`), fingerprint };
    }
    return undefined;
  }
}
