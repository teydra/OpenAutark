// The security decision (owner 19.11.2026, Sicher-Runde): from the company's security settings (effective(), so Trust AI
// mode reads only its three switches) and one request – a switch, maybe a path or an app – whether the step is open, asks
// the person first, or is closed for good. Pure but for the file system resolving real paths (realPath): no settings store, no clock.
// The company's own folders (open in every mode): the workspace, the agent's home <data>/agents/<id>, <data>/memory, the
// temp folders; reading also the shipped resources and the data folder's documented parts (FX1 19.11.2026: never
// runtime.json with the launch token, the database, secrets/, the CLIs' sign-ins, browser profiles or backups). Inside <data> everything else is Autark's own
// setup (switch `setup`), and so is the shared skill library <workspace>/skills; the agent's own home stays open.
// Hard-closed in Secure mode, whatever a switch says and with no request: spending money, <data>/security (the topic texts,
// changed by the person in Settings › Security), and Autark's own window for computer use.
// 25.11.2026 (Andrea Griffiths' VM test of Secure mode, Konrad's decisions): (1) the web in Secure mode starts 'chosen' –
// a search and a step in a tab already open are open, the first visit to any other site asks, "always" adds the site to
// webDomains (subdomains count with it); (2) the only temp folder of the own folders is <data>/tmp – the OS temp folder
// is shared with every other program on the PC, so it is "elsewhere" like any folder (the engines' TMP/TEMP point to the
// own one, engines/temp-env.ts); (3) a workspace inside <data> (a further company's, root/companies.ts) is the team's own
// folder like any other workspace, not Autark's setup – unless it holds <data> itself.
// Owns: decide(), the own folders, the place a request offers, the helper's guard config and the vault's money refusal.
// Never: asks, waits, reads settings or file contents (runtime/security/service.ts does), or maps tool calls (tool-gate.ts).

import type { SecurityMode } from '../../shared/model/security-settings.ts';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { otherPcsOf, SECURITY_DIR, SECURITY_LABELS, siteListed, siteOf, webDomainsOf, type ApprovalPlace, type SecuritySettings, type SecuritySwitch } from '../../shared/model/security-settings.ts';
import { AGENT_CORE_DIR } from '../../shared/model/agent-core.ts';
import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { ROOT_CHATS, ROOT_ENTRIES, ROOT_SECRETS } from '../root/layout.ts';

/** On Windows only explicit Trust may use the privileged route. This is not an action grant. */
export const requiresDefaultWindowsDesktop = (mode: SecurityMode | undefined): boolean => mode !== 'trust';

export const WINDOWS_DESKTOP_REFUSAL = 'Windows is waiting at the lock screen or a Windows prompt, or the active desktop could not be verified. In Secure mode, I cannot operate it; please unlock or confirm directly in Windows.';

export type Verdict = 'open' | 'ask' | 'closed';
/** Why a step is closed for good (the refusal text says it). */
export type ClosedWhy = 'money' | 'security' | 'own-window';

/** Where the company lives on this PC. */
export interface Places {
  data: string;
  workspace: string;
  resources: string;
  /** The company's own temp folder <data>/tmp (tempFolders; never the OS temp folder, which every program shares). */
  temp: readonly string[];
  /** Autark's own process name (lower case, without .exe): its window is never operated in Secure mode. */
  ownApp?: string;
}

export interface CheckInput {
  agentId: string;
  capability: SecuritySwitch;
  path?: string;
  app?: string;
  /** web: the site a step reaches (a host name, siteOf); undefined with `web` for a step that reaches no new site. */
  site?: string;
  /**
   * web without a site: 'search' – a web search (the search provider gets the query); 'tab' – a step in a browser tab
   * already open (reading it, a click, a form), whose site was let through when it was opened. Neither: a step whose
   * destination is unknown (a stored link, the page's own JavaScript), which asks when web is 'chosen'.
   */
  web?: 'search' | 'tab';
}

/** The verdict and the switch that decides it (a write into Autark's setup is `setup`, not `write`). */
export interface Decision {
  verdict: Verdict;
  capability: SecuritySwitch;
  why?: ClosedWhy;
}

/** Lower case on Windows (paths and process names ignore case there). */
const fold = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value);

/**
 * A path as it really is (M2): `\\?\` / `\\.\` taken off, absolute (a relative one counts from `base`), its longest existing
 * part resolved by the file system (8.3 names, junctions and links – `realpathSync.native`) with the rest appended, no
 * trailing separator. The spelling an agent uses never changes a verdict.
 */
export function realPath(target: string, base = process.cwd()): string {
  const plain = target.replace(/^\\\\[?.]\\UNC\\/i, '\\\\').replace(/^\\\\[?.]\\(?=[a-z]:)/i, '');
  const full = path.resolve(base, plain);
  const rest: string[] = [];
  for (let head = full; ;) {
    try {
      return path.join(realpathSync.native(head), ...rest.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return full; // nothing of it exists: as written
      rest.push(path.basename(head));
      head = parent;
    }
  }
}

/** True when `target` is `root` or below it – both compared as real paths (realPath), case-insensitive on Windows. */
export function inside(root: string, target: string): boolean {
  const relative = path.relative(fold(realPath(root)), fold(realPath(target)));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const inAny = (roots: readonly string[], target: string): boolean => roots.some((root) => inside(root, target));

/** The same folder or file, however spelled (realPath, case-insensitive on Windows). */
export const samePath = (a: string, b: string): boolean => fold(realPath(a)) === fold(realPath(b));

/** A process name as the lists keep it: lower case, without ".exe", trimmed. */
export function appName(value: string): string {
  return value.trim().toLowerCase().replace(/\.exe$/, '');
}

/** The agent's own home <data>/agents/<id> (undefined for an id that is no folder name). */
function agentHome(places: Places, agentId: string): string | undefined {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(agentId) && !agentId.includes('..') ? path.join(places.data, AGENT_CORE_DIR, agentId) : undefined;
}

/** The parts of <data> an agent reads as its own: the documented entries but secrets/, the chat folders, stored files, logs, exports. */
const DATA_READS: readonly string[] = [...ROOT_ENTRIES.filter((name) => name !== ROOT_SECRETS), ROOT_CHATS, 'blobs', 'logs', 'exports'];

/** The folders an agent works in freely in every mode: changed (write) and read. */
export function ownFolders(places: Places, agentId: string): { read: string[]; write: string[] } {
  const home = agentHome(places, agentId);
  const write = [places.workspace, ...(home ? [home] : []), path.join(places.data, 'memory'), ...places.temp];
  return { write, read: [...write, ...DATA_READS.map((name) => path.join(places.data, name)), places.resources] };
}

/** The folder of the security topic texts (<data>/security). */
export const securityFolder = (places: Pick<Places, 'data'>): string => path.join(places.data, SECURITY_DIR);

/** Is `target` part of Autark's own setup: <data> outside the agent's own parts, and the shared skill library. */
function isSetup(places: Places, agentId: string, target: string): boolean {
  if (inside(path.join(places.workspace, 'skills'), target)) return true;
  const home = agentHome(places, agentId);
  if (home && inside(home, target)) return false;
  if (inside(path.join(places.data, 'memory'), target) || inAny(places.temp, target)) return false;
  if (inside(places.workspace, target) && !inside(places.workspace, places.data)) return false; // 25.11.2026: a workspace inside <data> is the team's own
  return inside(places.data, target);
}

const allow = (value: 'yes' | 'ask'): Verdict => (value === 'yes' ? 'open' : 'ask');

/**
 * The decision for one request under `settings` – pass effective(securityOf(settings)), so Trust AI mode reads only its
 * switches. A relative path counts from the workspace.
 */
export function decide(settings: SecuritySettings, places: Places, input: CheckInput): Decision {
  const secure = settings.mode === 'secure';
  const target = input.path ? realPath(input.path, places.workspace) : undefined;
  const result = (verdict: Verdict, capability: SecuritySwitch = input.capability, why?: ClosedWhy): Decision => ({ verdict, capability, ...(why ? { why } : {}) });
  if (input.capability === 'money') return secure ? result('closed', 'money', 'money') : result(allow(settings.money));
  if (target && secure && inside(securityFolder(places), target) && input.capability !== 'read') return result('closed', 'setup', 'security');
  switch (input.capability) {
    case 'write': {
      if (!target) return result(settings.write === 'all' ? 'open' : 'ask');
      if (isSetup(places, input.agentId, target)) return result(allow(settings.setup), 'setup');
      if (settings.write === 'all' || inAny(ownFolders(places, input.agentId).write, target) || inAny(settings.writeFolders, target)) return result('open');
      return result('ask');
    }
    case 'read': {
      if (!target || settings.read === 'all') return result('open');
      return result(inAny(ownFolders(places, input.agentId).read, target) || inAny(settings.readFolders, target) ? 'open' : 'ask');
    }
    case 'computer': {
      const app = input.app ? appName(input.app) : undefined;
      if (secure && app && places.ownApp && app === places.ownApp) return result('closed', 'computer', 'own-window');
      if (settings.computer === 'yes') return result('open');
      if (settings.computer === 'ask') return result('ask');
      // 'chosen': a listed app is open; an unknown target is left to the helper's guard, which knows the window at input time
      return result(!app || settings.computerApps.map(appName).includes(app) ? 'open' : 'ask');
    }
    case 'web': {
      if (settings.web === 'yes') return result('open');
      if (settings.web !== 'chosen') return result('ask');
      if (input.web) return result('open'); // a search, or a step in a tab already open
      return result(input.site && siteListed(webDomainsOf(settings), input.site) ? 'open' : 'ask');
    }
    case 'otherPcs': { // Umzug 21.11.2026: 'no' is refused before the gate with its own text (devices/other-pcs.ts)
      const value = otherPcsOf(settings);
      return result(value === 'yes' ? 'open' : value === 'ask' ? 'ask' : 'closed');
    }
    default:
      return result(allow(settings[input.capability]));
  }
}

/** What "always for this place" would add: the file's folder (or the folder itself), the app, or the site. */
export function placeOf(capability: SecuritySwitch, input: { path?: string; app?: string; site?: string; isFolder?: boolean }, workspace: string): ApprovalPlace | undefined {
  if (capability === 'web') { const site = input.site ? siteOf(input.site) : ''; return site ? { kind: 'site', value: site } : undefined; }
  if ((capability === 'read' || capability === 'write') && input.path) {
    const full = realPath(input.path, workspace);
    const folder = input.isFolder ? full : path.dirname(full);
    return folder === path.parse(folder).root ? undefined : { kind: 'folder', value: folder }; // never a whole drive
  }
  if (capability === 'computer' && input.app?.trim()) return { kind: 'app', value: appName(input.app) };
  return undefined;
}

/** The settings after "always": the switch opened ('setting') or the place added to its list ('place'). */
export function opened(settings: SecuritySettings, capability: SecuritySwitch, place?: ApprovalPlace): SecuritySettings {
  const next: SecuritySettings = structuredClone(settings);
  if (!place) {
    if (capability === 'read' || capability === 'write') next[capability] = 'all';
    else if (capability === 'computer') next.computer = 'yes';
    else next[capability] = 'yes';
    return next;
  }
  if (place.kind === 'site') {
    const site = siteOf(place.value);
    const listed = webDomainsOf(next);
    if (site && !listed.includes(site)) next.webDomains = [...listed, site];
    if (next.web === 'ask') next.web = 'chosen'; // "always this site" is the list mode
    return next;
  }
  if (place.kind === 'app') {
    if (!next.computerApps.map(appName).includes(place.value)) next.computerApps = [...next.computerApps, place.value];
    if (next.computer === 'ask') next.computer = 'chosen'; // "always this app" is the list mode
    return next;
  }
  const key = capability === 'read' ? 'readFolders' : 'writeFolders';
  if (!next[key].some((folder) => samePath(folder, place.value))) next[key] = [...next[key], place.value];
  if (capability === 'write' && !next.readFolders.some((folder) => samePath(folder, place.value)) && next.read === 'chosen') next.readFolders = [...next.readFolders, place.value]; // what I may change I may read
  return next;
}

/** One fingerprint per tool (or method) and arguments: keys sorted, so the same call is the same text. */
export function fingerprintOf(name: string, args: unknown): string {
  return createHash('sha256').update(`${name}\u0000${stable(args)}`).digest('hex').slice(0, 32);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** What the Windows helper's Guard holds: Autark's process ids (Secure mode) and, for computer 'chosen', the apps input may reach. */
export interface GuardConfig {
  appPids: number[];
  apps: string[] | null;
}

/** The helper's guard under `settings` (effective); `open`: apps answered "once" a moment ago. */
export function guardConfig(settings: SecuritySettings, pids: readonly number[], open: readonly string[] = []): GuardConfig {
  if (settings.mode !== 'secure') return { appPids: [], apps: null };
  const appPids = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))].sort((a, b) => a - b);
  const apps = settings.computer === 'chosen' ? [...new Set([...settings.computerApps, ...open].map(appName).filter(Boolean))].sort() : null;
  return { appPids, apps };
}

/** A stored secret as the vault knows it at use. */
export interface VaultEntry { kind: string; groupKind?: string; route?: string | null }

/** True for card data: a card, a field of a card, or an entry of the payment route. */
export const isPayment = (entry: VaultEntry): boolean => entry.kind === 'card' || entry.groupKind === 'card' || entry.route === 'payment';

/** The vault's refusal for an agent's use of card data in Secure mode (undefined: it may be used). */
export function vaultRefusal(settings: SecuritySettings, entry: VaultEntry, agentId: string, name = 'the person'): string | undefined {
  if (agentId === HUMAN_ID || agentId === SYSTEM_ID || settings.mode !== 'secure' || !isPayment(entry)) return undefined;
  return closedText('money', name);
}

/** The refusal of a step closed for good, in my own voice. */
export function closedText(why: ClosedWhy, name: string, pc = 'this PC'): string { // pc: by name where the text travels to another PC
  switch (why) {
    case 'money': return `${SECURITY_LABELS.money} is closed on ${pc} (Secure mode): the app refuses stored cards and its spending tools, whatever a chat says, and a payment it cannot see – a shop's saved card behind a Buy button – is just as much not mine to make. Where money is needed, I tell ${name} what it is for and how much, and they pay themselves.`;
    case 'security': return `Autark's security setup – the security settings and the texts in ${SECURITY_DIR}/ – is ${name}'s and stays closed to me in Secure mode on ${pc}; ${name} changes it in Settings › Security.`;
    case 'own-window': return `Autark's own window on ${pc} is not mine to operate in Secure mode; what I need there I do with my own tools or tell ${name}.`;
  }
}

/**
 * The company's own temp folder <data>/tmp – the only one of the own folders (25.11.2026: no longer the OS temp folder,
 * which every program on the PC shares; the engines' TMP/TEMP point to this one).
 */
export function tempFolders(dataTemp: string): string[] {
  return [dataTemp];
}
