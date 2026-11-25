// Which switches an Autark tool call needs (Sicher-Runde 19.11.2026) and its pass through the security gate – called where
// a call runs: tools/registry.ts for this company's agents on this PC (and, for a call into another company of this PC, as
// this company's gate for its own agent), devices/tools.ts for a linked PC's call and tools/builtin/companies.ts for another
// company's call (the caller's agent, this company's settings). By name and arguments first, then by category:
// files.read/list/search → read (the path; a search without one reaches the home folder), files.write → write,
// shell.exec → commands and write for its folder, computer.* → computer (the app the outputs showed), phone.* → phone,
// browser.* / web.* → web (25.11.2026, webNeed: a search, the site of a URL it opens, a step in an open tab, or – eval, a
// stored link – no site), agents.create/archive/update of another agent and spaces.save → team, modes.save, app.install,
// devices.connect, skills.save into the shared library and other system changes → setup, secrets and sign-ins → accounts,
// a connected app's writing tool → message, communicate → message, publish → publish, spend → money. A stored secret
// named by its handle in any argument → accounts, card data → money. Files a call names and the map above does not cover
// – a `file:` URL anywhere in the arguments, devices.send_file's and secrets.import's file, a path argument of any other
// tool – are read (by its category: a changing tool's path is write; secrets.export writes its file). Tools that only
// think, plan, read the company's own data or talk in its chats need none.
// REVIEW-2 (19.11.2026): secrets.export always writes a file – the default one in Downloads too – so it needs `write` for
// the file it will write; devices.connect is closed in Secure mode (a linked PC gets a full copy of the company – the
// person connects it in Settings › Devices); peerGates says whether a linked PC gates forwarded calls itself.
// A need's fingerprint holds what the step does – its path, command and folder, app or URL – never free text such as a
// reason, so the same step tried again after a late "once" is the same step.
// Owns: that mapping, the fingerprints and the receiving side's gate of a forwarded call (gateForwarded). Never: decides
// (policy.ts) or waits (service.ts).

import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { SecuritySwitch } from '../../shared/model/security-settings.ts';
import type { SecretInfo } from '../../shared/model/security.ts';
import type { SkillInfo } from '../../shared/model/knowledge.ts';
import type { ActionCategory, ActionDescription, ToolContext, ToolDef } from '../tools/types.ts';
import type { SecurityService } from './service.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { compareAppVersions } from '../../shared/model/devices.ts';
import { siteOfUrl } from '../../shared/model/security-settings.ts';
import { exportTarget } from '../secrets/export.ts';
import { fingerprintOf, isPayment } from './policy.ts';

/** One switch a call needs, with what it is about (web: its site, or what it is when it reaches none – policy.ts CheckInput). */
export interface Need { capability: SecuritySwitch; path?: string; app?: string; site?: string; web?: 'search' | 'tab' }

/** What needsOf knows of the caller: its agent, the PC it runs on, the skill a skills.save would write over and the data folder. */
export interface NeedContext { agentId: string; deviceId?: string; skill?: (name: string) => SkillInfo | undefined; data?: string }

/** The first app version whose runtime gates a call from a linked PC itself (devices/tools.ts gateForwarded) – the release after 0.3.14, which shipped without it. */
export const GATES_FORWARDED_FROM = '0.3.15';

/** True when a linked PC on `version` gates forwarded calls itself (its pre-releases count); an unknown version is older. */
export function peerGates(version: string | undefined): boolean {
  const core = version?.trim().split('-')[0];
  return Boolean(core) && compareAppVersions(core!, GATES_FORWARDED_FROM) >= 0;
}

const READ_TOOLS: ReadonlySet<string> = new Set(['files.read', 'files.list', 'files.search']);
const ACCOUNT_TOOLS: ReadonlySet<string> = new Set(['secrets.save', 'secrets.generate', 'secrets.import', 'secrets.export', 'secrets.delete', 'browser.save_secret', 'browser.save_totp', 'accounts.sign_in', 'calendar.connect']);
const SETUP_TOOLS: ReadonlySet<string> = new Set(['modes.save', 'app.install', 'devices.connect']);
const TEAM_TOOLS: ReadonlySet<string> = new Set(['agents.create', 'agents.archive', 'spaces.save']);
/** Tools whose file the map knows apart from their category: what they do with it. */
const FILE_TOOLS: ReadonlyMap<string, 'read' | 'write'> = new Map([['devices.send_file', 'read'], ['secrets.import', 'read']]);
/** Arguments that name files on this PC. memory.* and knowledge.* name entries of the company's own stores, not files. */
const PATH_KEYS: readonly string[] = ['path', 'paths', 'cwd', 'folder', 'dir', 'files'];
const STORE_TOOLS = /^(memory|knowledge)\./;
const CHANGING: ReadonlySet<ActionCategory> = new Set(['write_local', 'write_system', 'delete']);
/** Arguments that do not change what a step does (left out of its fingerprint). */
const FREE_TEXT: readonly string[] = ['reason', 'description', 'title', 'note', 'timeoutSeconds', 'timeoutMs', 'motion'];
const HANDLE = /secret:\/\/([A-Za-z0-9_-]{1,128})/g;

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** The switches a call needs (empty: none). `secrets`: the catalog, to tell card data from other secrets. */
export function needsOf(tool: Pick<ToolDef, 'name' | 'category'>, args: Record<string, unknown>, action: ActionDescription, ctx: NeedContext, secrets: () => readonly SecretInfo[] = () => []): Need[] {
  const name = tool.name;
  const needs: Need[] = [];
  if (READ_TOOLS.has(name)) needs.push({ capability: 'read', path: str(args.path) ?? (name === 'files.search' ? os.homedir() : undefined) });
  else if (name === 'files.write') needs.push({ capability: 'write', path: str(args.path) });
  else if (name === 'shell.exec') {
    needs.push({ capability: 'commands' });
    const cwd = str(args.cwd);
    if (cwd) needs.push({ capability: 'write', path: cwd });
  } else if (name.startsWith('computer.')) {
    const app = action.resource && action.resource !== 'this PC' && action.resource !== ctx.deviceId ? action.resource : undefined;
    needs.push({ capability: 'computer', ...(app ? { app } : {}) });
  } else if (name.startsWith('phone.')) needs.push({ capability: 'phone' });
  else if (ACCOUNT_TOOLS.has(name) || tool.category === 'account' || tool.category === 'secret') needs.push({ capability: 'accounts' });
  else if (name.startsWith('browser.') || name.startsWith('web.')) needs.push(webNeed(name, args));
  else if (name === 'agents.update') { if ((str(args.agentId) ?? ctx.agentId) !== ctx.agentId) needs.push({ capability: 'team' }); }
  else if (TEAM_TOOLS.has(name)) needs.push({ capability: 'team' });
  else if (SETUP_TOOLS.has(name)) needs.push({ capability: 'setup' });
  else if (name === 'skills.save') { const shared = sharedSkill(args, ctx); if (shared) needs.push({ capability: 'setup', path: shared }); }
  else if (tool.category === 'spend') needs.push({ capability: 'money' });
  else if (tool.category === 'publish') needs.push({ capability: 'publish' });
  else if (tool.category === 'communicate') needs.push({ capability: 'message' });
  else if (tool.category === 'write_system') needs.push({ capability: action.resource?.startsWith('app://') ? 'message' : 'setup' });
  if (name === 'secrets.export') needs.push({ capability: 'write', path: exportTarget(str(args.path), ctx.data) }); // the default file too
  for (const need of fileNeeds(tool, args)) if (!needs.some((one) => one.path === need.path && one.capability === need.capability)) needs.push(need);
  const ids = handles(args);
  if (ids.length) {
    const catalog = secrets();
    const payment = ids.some((id) => { const info = catalog.find((entry) => entry.id === id); return info ? isPayment({ kind: info.kind, groupKind: info.group?.kind, route: info.route }) : false; });
    if (payment) needs.unshift({ capability: 'money' });
    if (!needs.some((need) => need.capability === 'accounts')) needs.push({ capability: 'accounts' });
  }
  return needs;
}

/** Tools that send the agent to a URL it names: the site of that URL is what the step reaches. */
const OPENING: ReadonlySet<string> = new Set(['web.fetch', 'browser.open', 'browser.show']);
/** Browser tools that work in a tab already open (its site was let through when it was opened; a move to another site is the browser's guard, browser/nav-guard.ts). */
const IN_TAB: ReadonlySet<string> = new Set(['browser.snapshot', 'browser.act', 'browser.batch', 'browser.screenshot', 'browser.extract', 'browser.tabs', 'browser.find', 'browser.console', 'browser.network', 'browser.wait']);

/**
 * The web need of a browser.* / web.* call (25.11.2026, web 'chosen'): a search; an open of a URL with its site; a step in
 * an open tab; anything else – browser.eval (the page's JavaScript reaches any site), a stored link (secret://, its site
 * is unknown here), a tool not named here – without a site, so it asks unless the web is open everywhere.
 */
export function webNeed(name: string, args: Record<string, unknown>): Need {
  if (name === 'web.search') return { capability: 'web', web: 'search' };
  if (IN_TAB.has(name)) return { capability: 'web', web: 'tab' };
  if (OPENING.has(name)) {
    const url = str(args.url);
    if (!url) return name === 'browser.show' ? { capability: 'web', web: 'tab' } : { capability: 'web' }; // show without url: my own browser, live
    if (url === 'about:blank') return { capability: 'web', web: 'tab' };
    const site = /^secret:/i.test(url) ? '' : siteOfUrl(url);
    return site ? { capability: 'web', site } : { capability: 'web' };
  }
  return { capability: 'web' };
}

/** skills.save that writes the shared library (not `main`, over a shared skill that is not read-only): that folder; else undefined (my own copy). */
function sharedSkill(args: Record<string, unknown>, ctx: NeedContext): string | undefined {
  const name = str(args.name);
  if (args.main === true || !name) return undefined;
  let info: SkillInfo | undefined;
  try { info = ctx.skill?.(name); } catch { info = undefined; }
  return info && info.source !== 'agent' && !info.readOnly ? info.path : undefined;
}

/** The files a call names beyond the mapping above: `file:` URLs anywhere, and its path arguments by tool or category. */
function fileNeeds(tool: Pick<ToolDef, 'name' | 'category'>, args: Record<string, unknown>): Need[] {
  const needs: Need[] = fileUrls(args, 0).map((file) => ({ capability: 'read' as const, path: file }));
  if (READ_TOOLS.has(tool.name) || tool.name === 'files.write' || tool.name === 'shell.exec' || tool.name === 'secrets.export' || STORE_TOOLS.test(tool.name)) return needs;
  const capability = FILE_TOOLS.get(tool.name) ?? (CHANGING.has(tool.category) ? 'write' : 'read');
  for (const key of PATH_KEYS) {
    const value = args[key];
    for (const file of Array.isArray(value) ? value : [value]) {
      const named = str(file);
      if (named && !/^[a-z][a-z0-9+.-]*:\/\//i.test(named)) needs.push({ capability, path: named.toLowerCase().startsWith('file:') ? fromFileUrl(named) : named });
    }
  }
  return needs;
}

/** Every `file:` URL among the string values of `value` (a few levels deep), as a path. */
function fileUrls(value: unknown, depth: number): string[] {
  if (typeof value === 'string') return /^file:/i.test(value.trim()) ? [fromFileUrl(value.trim())] : [];
  if (depth > 4 || !value || typeof value !== 'object') return [];
  return (Array.isArray(value) ? value : Object.values(value)).flatMap((item) => fileUrls(item, depth + 1));
}

function fromFileUrl(url: string): string {
  try { return fileURLToPath(url); } catch { return decodeURIComponent(url.replace(/^file:\/*/i, '')); }
}

/** The secret ids named by handle anywhere in the arguments. */
function handles(args: Record<string, unknown>): string[] {
  let text: string;
  try { text = JSON.stringify(args) ?? ''; } catch { return []; }
  return [...new Set([...text.matchAll(HANDLE)].map((match) => match[1]))];
}

/** One need's fingerprint: the tool, the switch and what the step does with it – never free text. */
export function needFingerprint(name: string, need: Need, args: Record<string, unknown>): string {
  let effect: unknown;
  if (name === 'shell.exec') effect = { command: args.command ?? null, cwd: args.cwd ?? null };
  else if (need.path !== undefined) effect = { path: need.path };
  else if (need.capability === 'computer') effect = { app: need.app ?? null };
  else if (str(args.url)) effect = { url: str(args.url) };
  else effect = Object.fromEntries(Object.entries(args).filter(([key]) => !FREE_TEXT.includes(key)));
  return `${fingerprintOf(name, effect)}:${need.capability}`;
}

/**
 * Passes the call through the gate: undefined when it may run, else my text why not (each need in turn). `ctx.agent` is
 * the calling agent (a stand-in for a linked PC's or another company's agent); this runtime's settings decide.
 */
export async function gateToolCall(security: SecurityService | undefined, tool: ToolDef, args: Record<string, unknown>, action: ActionDescription, ctx: ToolContext): Promise<string | undefined> {
  if (!security) return undefined;
  if (tool.name === 'devices.connect' && modeOf(security) !== 'trust') return connectText(personName(ctx));
  const skill = (name: string) => ctx.services.skills?.get(name, ctx.agent.id)?.info;
  let data: string | undefined;
  try { data = ctx.services.paths.data; } catch { data = undefined; }
  const needs = needsOf(tool, args, action, { agentId: ctx.agent.id, deviceId: ctx.deviceId, skill, data }, () => { try { return ctx.services.secrets.list(); } catch { return []; } });
  for (const need of needs) {
    const result = await security.gate({
      agentId: ctx.agent.id, agentName: ctx.agent.name, capability: need.capability, summary: action.summary, fingerprint: needFingerprint(tool.name, need, args),
      ...(need.path ? { path: need.path } : {}), ...(need.app ? { app: need.app } : {}), ...(need.site ? { site: need.site } : {}), ...(need.web ? { web: need.web } : {}),
      ...(ctx.conversationId ? { chatId: ctx.conversationId } : {}), ...(ctx.taskId ? { taskId: ctx.taskId } : {}), runId: ctx.runId, signal: ctx.signal,
    });
    if (!result.ok) return result.text;
  }
  return undefined;
}

/** The company's mode; undefined when it cannot be read (then the stricter rule holds). */
function modeOf(security: SecurityService): string | undefined {
  try { return security.current().mode; } catch { return undefined; }
}

function personName(ctx: ToolContext): string {
  try { return ctx.services.settings.get().profile.name?.trim() || 'the person'; } catch { return 'the person'; }
}

/** devices.connect in Secure mode, in my own words. */
export function connectText(name: string): string {
  return `A linked PC gets a full copy of this company – its secrets, settings and phones included –, so in Secure mode linking one is ${name}'s own step: they connect it in Settings › Devices › Connect a PC. I tell ${name} which PC and what it is for.`;
}

/**
 * The receiving side of a forwarded call (a linked PC's, devices/tools.ts; another company's, builtin/companies.ts): the
 * gate of this runtime for the calling agent before the tool runs. Throws 'forbidden' with my text – it travels back to
 * the caller as the call's refusal (nothing ran). A forwarded call always names an agent, never the person or the system.
 */
export async function gateForwarded(tool: ToolDef, args: Record<string, unknown>, ctx: ToolContext): Promise<void> {
  if (ctx.agent.id === HUMAN_ID || ctx.agent.id === SYSTEM_ID) throw new WorkforceError('forbidden', 'A call from another PC or company runs for one of its agents, so it names that agent.');
  let action: ActionDescription = { summary: tool.name, external: false };
  try { if (tool.describe) action = tool.describe(args, ctx); } catch { /* the tool's name says what it is */ }
  const refused = await gateToolCall(ctx.services.security, tool, args, action, ctx);
  if (refused) throw new WorkforceError('forbidden', refused);
}
