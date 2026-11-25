// Secure mode for ACP agents (Gemini CLI, Copilot CLI, Kimi Code; Sicher-Runde 19.11.2026): their own tools' permission
// requests (`session/request_permission`) go through services.security's gate (codex/native-gate.ts) instead of being
// allowed at once. ACP has no folder rules, so every own step the agent asks about takes this round trip; a CLI that does
// not ask before a step is not stopped by it (its own approval mode decides, providers.ts passes no auto-approve flag).
// Mapping by the tool call's kind: read/search → read (its files), edit/delete/move → write (its files), execute →
// commands, fetch → web, think → through at once; anything else (switch_mode, other, none) → commands.
// Owns: the kind → switch mapping and the step's line for the person. Never: answers a hub tool's request (turn.ts allows
// those; the registry gates each call) or picks the option (updates.ts permissionOutcome).

import { siteOfUrl, type SecuritySwitch } from '../../../shared/model/security-settings.ts';
import type { SecurityService } from '../../security/service.ts';
import { effectOf, gateNative, nativeFingerprint, type NativeTurn } from '../codex/native-gate.ts';
import { isRecord, str } from '../shared.ts';
import { pathsOf } from './updates.ts';

const KINDS: Readonly<Record<string, SecuritySwitch>> = {
  read: 'read', search: 'read', edit: 'write', delete: 'write', move: 'write', execute: 'commands', fetch: 'web',
};

const clip = (text: string) => (text.length > 200 ? `${text.slice(0, 199)}…` : text);

/** What one own tool call's permission request is about: its switch, its files and one line (undefined: nothing to ask). */
export function acpStep(call: Record<string, unknown>): { capability: SecuritySwitch; paths: string[]; summary: string; tool: string; args: unknown; site?: string } | undefined {
  const kind = str(call.kind) ?? 'other';
  if (kind === 'think') return undefined;
  const raw = isRecord(call.rawInput) ? call.rawInput : {};
  const capability = KINDS[kind] ?? 'commands';
  const paths = capability === 'read' || capability === 'write' ? pathsOf(call, raw) : [];
  const title = str(call.title)?.trim();
  const command = str(raw.command);
  const summary = capability === 'commands' && command ? `Run: ${command}` : title || `${kind} ${paths.join(', ')}`.trim();
  // What it does – its command, files, URL – never the title the CLI words for the person (native-gate.ts effectOf).
  const url = capability === 'web' ? str(raw.url) : undefined;
  const site = url ? siteOfUrl(url) : ''; // 25.11.2026: web 'chosen' asks once per new site
  return { capability, paths, summary: clip(summary), tool: kind, args: effectOf({ ...raw, ...(paths.length ? { paths } : {}) }), ...(site ? { site } : {}) };
}

/** The gate's answer to an own tool call's permission request: true lets it run. */
export async function acpAllowed(security: SecurityService, turn: NativeTurn, call: Record<string, unknown>, signal: AbortSignal): Promise<boolean> {
  const step = acpStep(call);
  if (!step) return true;
  const result = await gateNative(security, { ...turn, capability: step.capability, paths: step.paths, summary: step.summary, ...(step.site ? { site: step.site } : {}), fingerprint: nativeFingerprint('acp', step.tool, step.args), signal });
  return result.ok;
}
