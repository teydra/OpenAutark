// The security gate for the CLI engines' own tools (Sicher-Runde 19.11.2026): Claude Code's permission prompts, Codex's
// approval requests and ACP's permission requests each become one GateRequest of services.security (security/service.ts),
// so a native Read, Edit or shell command goes through the same gate as an Autark tool. Only in Secure mode: in Trust mode
// the engines keep today's flags and nothing here runs (no round trip, nothing slower).
// A step that names several files is asked about once – for the first file that is not open (a closed one first). Each
// request carries the turn's run, so a late answer wakes the agent in the chat or task it was working in.
// A step's fingerprint holds only what it does (effectOf: its command, files, URL or query), never free text such as a
// description or title the model writes anew each time – the same step tried again after a late "once" goes through.
// Owns: whether a turn runs secure, the fingerprint of a native step, which of its files the request names, and the gate
// call that never throws. Never: decides (the service does) or speaks a CLI's answer format (each engine does).

import { createHash } from 'node:crypto';
import type { SecuritySwitch } from '../../../shared/model/security-settings.ts';
import type { GateResult, SecurityService } from '../../security/service.ts';
import { isRecord } from '../shared.ts';

/** How an engine reaches the service: built after the engines, so it is looked up at each turn (undefined: Trust mode as today). */
export type SecurityLookup = () => SecurityService | undefined;

/** Whose turn a native step belongs to: the agent and its run (the service finds the run's chat and task). */
export interface NativeTurn { agentId: string; runId?: string }

/** The service when the company runs in Secure mode; undefined in Trust mode or without a service (today's flags). */
export function secureService(lookup: SecurityLookup | undefined): SecurityService | undefined {
  try {
    const security = lookup?.();
    return security?.current().mode === 'secure' ? security : undefined;
  } catch { return undefined; }
}

/** The company's security mode now ('trust' without a service): a Codex thread loaded under another mode is opened anew (engine.ts). */
export function securityMode(lookup: SecurityLookup | undefined): string {
  try { return lookup?.()?.current().mode ?? 'trust'; } catch { return 'trust'; }
}

/** Arguments that say what a step does. */
const EFFECT_KEYS: readonly string[] = ['command', 'cmd', 'cwd', 'file_path', 'notebook_path', 'path', 'paths', 'locations', 'url', 'query', 'pattern', 'glob', 'app'];
/** Free text and knobs that never change what a step does. */
const FREE_TEXT: ReadonlySet<string> = new Set(['description', 'title', 'explanation', 'reason', 'justification', 'summary', 'timeout', 'run_in_background', 'prompt']);

/** What a step does, out of its arguments: the effect keys when it has any, else everything but free text. */
export function effectOf(args: unknown): unknown {
  if (!isRecord(args)) return args ?? null;
  const picked = EFFECT_KEYS.filter((key) => args[key] !== undefined && args[key] !== null).map((key) => [key, args[key]] as const);
  return Object.fromEntries(picked.length ? picked : Object.entries(args).filter(([key]) => !FREE_TEXT.has(key)));
}

/** Same CLI, same tool, same effect → same fingerprint (an answer "once" lets one later identical step through). Keys sorted. */
export function nativeFingerprint(engine: string, tool: string, effect: unknown): string {
  return `${engine}:${tool}:${createHash('sha256').update(stable(effect)).digest('hex').slice(0, 32)}`;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** One native step of an agent's turn. */
export interface NativeStep extends NativeTurn {
  capability: SecuritySwitch;
  /** One line, what the agent would do ("Read C:\…\a.pdf", "Run: npm install"). */
  summary: string;
  /** The files the step names (absolute when the CLI gave them so). */
  paths?: readonly string[];
  fingerprint: string;
  signal?: AbortSignal;
}

/** The text a step gets when the gate itself failed: nothing ran. */
export const GATE_FAILED = 'BLOCKED – not executed. The app could not check this step, so it did not run and is not done; I try it again later and until then never report it as done.';

/**
 * Asks the gate about one native step. With files: all open → through at once; otherwise the request names the first
 * closed file, else the first one that would be asked about. A gate that throws refuses (GATE_FAILED).
 */
export async function gateNative(security: SecurityService, step: NativeStep): Promise<GateResult> {
  try {
    const paths = (step.paths ?? []).filter((file) => typeof file === 'string' && file.trim() !== '');
    let path: string | undefined;
    if (paths.length) {
      const seen = paths.map((file) => ({ file, state: security.check({ agentId: step.agentId, capability: step.capability, path: file, fingerprint: step.fingerprint }) }));
      const named = seen.find((one) => one.state === 'closed') ?? seen.find((one) => one.state === 'ask');
      if (!named) return { ok: true };
      path = named.file;
    }
    return await security.gate({
      agentId: step.agentId, capability: step.capability, summary: step.summary.slice(0, 300), fingerprint: step.fingerprint,
      ...(path ? { path } : {}), ...(step.runId ? { runId: step.runId } : {}), ...(step.signal ? { signal: step.signal } : {}),
    });
  } catch {
    return { ok: false, text: GATE_FAILED };
  }
}
