// "## My environment": true facts about where the agent runs and what it can reach, built from the real tool offer of
// the agent's own mode. Two parts:
// KI-Runde 17.11.2026: every tool is in reach from every mode through tools.call, so no line here sends screen or web
// work to another mode or another agent; a line names what this turn's offer really holds.
// - stable (environmentSection): this PC (OS, name, the app's language), how the shells on Windows handle text
//   (windowsShellLine), profile.notes, the workspace, the person's own files, the data folder and memory (constant paths), how
//   the agent searches the web (its engine's own search first), its screen tools and the one line on instruction files.
//   The same agent, mode, engine and PC give the same text – nothing here moves by itself.
// - live (environmentNow, prompt-volatile.ts): free disk space below 2 GB, the engines connected in the Autark system
//   (owner 15.11.2026: "Codex CLI und Claude Code, wenn beide verknüpft sind" – the one this turn runs in stands in
//   "## Now", engineName), the companies on this PC and the linked PCs, the linked phones with their phone use (KI-Runde
//   17.11.2026: a linked phone stood nowhere in the prompt, so agents asked the person for codes it shows), accounts that
//   need a sign-in (labels only) and the connected apps – only what moves on its own. Never a memory list.
// Owner 15.11.2026: the agent lives in the Autark system ("im Autark-System drin … und nicht einfach nur in der App"), so
// these lines say so; texts for people keep "app".
// The lines speak as the agent, in the first person.
// Owns: these lines, their wording and caps. Never: times or counts in the stable part, a tool the mode does not
// offer, e-mails, CLI homes, tokens or secret ids.

import { statfsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { ModeInfo } from '../../shared/model/knowledge.ts';
import type { EngineId, ProviderId, RouteDecision } from '../../shared/model/providers.ts';
import { ROOT_README } from '../root/layout.ts';
import { MEMORY_ENTRY } from '../knowledge/memory-tree.ts';
import { whereHint } from '../browser/place.ts'; // B-080: the person's own Chrome only beside computer.*
import { cleanLabel, linkedPcs } from './setup-facts.ts';
import { CALL_TOOL, FIND_TOOL, nativeWebSearchName } from '../tools/core-sets.ts';
import { listCompanies } from '../root/companies.ts'; // B-075
import { linkedPhones, type LinkedPhone } from '../phone/linked.ts';
import '../contracts/apps.ts'; // B-052: RuntimeServices.apps (the connected-apps line)
import { pwshDir } from '../engines/wf-shim.ts'; // B-080 wave 3: the engines' PowerShell 7
import { PROVIDER_LABELS } from '../accounts/service-shape.ts';
import { engineFor } from '../accounts/candidates.ts';
import { isUsableState } from '../../shared/model/plan-roles.ts';
import { MEDIA_ONLY_PROVIDERS } from '../../shared/model/providers.ts';

export const ENVIRONMENT_HEADER = '## My environment';
/** Accounts named in the sign-in line (beyond: "+N more"). */
const MAX_SIGN_IN = 3;
/** Apps named in the connected-apps line (beyond: "+N more"). */
const MAX_APPS = 6;

/** The OS facts the section names (tests pass their own). */
export interface SystemFacts { platform: NodeJS.Platform; version: string; release: string; hostname: string }

export function systemFacts(): SystemFacts {
  let version = '';
  try { version = os.version(); } catch { /* older runtimes */ }
  return { platform: process.platform, version, release: os.release(), hostname: os.hostname() };
}

function safe<T>(read: () => T, fallback: T): T {
  try { return read(); } catch { return fallback; }
}

/** The tool names this mode offers the agent (the turn's own rule, so the prompt never names a missing tool). */
export function offeredTools(services: RuntimeServices, agent: Agent, mode: ModeInfo): ReadonlySet<string> {
  return safe(() => new Set(services.tools.specsFor(agent, mode).map((spec) => spec.name)), new Set<string>());
}

const any = (offered: ReadonlySet<string>, prefix: string): boolean => [...offered].some((name) => name.startsWith(prefix));

/** "Windows 11 Pro (10.0.26300)", "macOS (Darwin 24.1.0)", "Linux 6.8.0". */
export function osName(system: SystemFacts): string {
  if (system.platform === 'win32') return `${system.version.trim() || 'Windows'} (${system.release})`;
  if (system.platform === 'darwin') return `macOS (Darwin ${system.release})`;
  if (system.platform === 'linux') return `Linux ${system.release}`;
  return `${system.version.trim() || system.platform} ${system.release}`.trim();
}

/** Whether the turn's engine reads, searches and browses with tools of its own (caps.ownTools: Claude Code, Codex, ACP agents). */
export function ownFileTools(services: RuntimeServices, engine?: EngineId): boolean {
  if (!engine) return false;
  try { return services.engines.get(engine).caps.ownTools === true; } catch { return false; }
}

/**
 * How the agent searches the web: native search on Codex and Claude Code, otherwise web.search
 * (`own`: an engine with its own file and shell tools reaches web.search through tools.call).
 */
function webLine(offered: ReadonlySet<string>, engine?: string, own = false): string {
  const fetch = offered.has('web.fetch');
  const search = nativeWebSearchName(engine);
  if (search) return `Web: ${search} (my engine's own search) finds current pages${fetch ? ', web.fetch reads one' : ''}.`;
  if (own && offered.has('web.search')) return `Web: web.search through tools.call finds pages${fetch ? ', web.fetch reads one' : ''}.`;
  if (offered.has('web.search')) return `Web: web.search finds pages (title, link, snippet)${fetch ? ', web.fetch reads one' : ''}.`;
  if (fetch) return 'Web: web.fetch reads a page whose address I know.';
  return '';
}

function screenLine(offered: ReadonlySet<string>): string {
  const browser = [...offered].some((name) => name.startsWith('browser.') && name !== 'browser.show');
  const computer = any(offered, 'computer.');
  // B-080: where: 'chrome' is the person's own Chrome (browser/tools.ts browser.open), computer.* works in its window.
  if (browser && computer) return 'Screen: browser.* browses websites (the person can watch and take over; where: \'chrome\' is the person\'s own Chrome with their logins), computer.* operates this PC\'s screen, mouse and keyboard.';
  // B-072 (live 03.11.2026: a browser-only agent asked the person to sign in while their own Chrome had the session).
  if (browser) return 'Screen: browser.* browses websites in my own profile (the person can watch and take over); the person\'s own browsers on this screen keep their logins and autofill.';
  if (computer) return 'Screen: computer.* operates this PC\'s screen, mouse and keyboard.';
  return '';
}

/** The workspace line ('' without a workspace). */
export function workspaceLine(workspace: string): string {
  return workspace ? `Workspace: ${workspace} – the team's working folder (projects and the files I make).` : '';
}

/** Codex and Claude Code run in an Autark-owned home without the person's instruction files; a folder's own ones are files. */
export const INSTRUCTION_FILES_LINE = 'My instructions are all in this prompt; an AGENTS.md or CLAUDE.md in a folder is a file I read when its content helps.';

/**
 * B-080 (live 05.–08.11.2026: 32 cp1252 failures, tzdata missing under `python -I`, Get-Content | Set-Content turning
 * "…" into "â€¦", "Öffnungszeiten" piped into python arriving as "?ffnungszeiten"): what the shells on Windows do with
 * text – '' elsewhere. B-080 wave 3: where the engines' PowerShell 7 is found (engines/wf-shim.ts pwshDir: PATH,
 * %ProgramFiles%, the per-user install) the line says so – Codex, Claude Code and shell.exec (named where `shell` says
 * the turn offers it) run in it, UTF-8 throughout. Where none is found the Windows PowerShell 5.1 sentences stay: piped
 * text keeps its letters where $OutputEncoding is UTF-8 – shell.exec sets it (files.ts windowsShell), an engine's own
 * PowerShell 5.1 leaves it at ASCII – and (live 09.11.: python -c "…" lost its inner quotes) 5.1 drops a program's inner
 * double quotes.
 */
export function windowsShellLine(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env, shell = false): string {
  if (platform !== 'win32') return '';
  const python = 'Shells here: Python runs in UTF-8 (PYTHONUTF8=1) and finds the person\'s packages (tzdata …); `python -I` leaves both out, so my own scripts run as plain python and with -I I add -X utf8.';
  if (pwshDir(env)) return `${python} My shell${shell ? ' and shell.exec are' : ' is'} PowerShell 7: text piped into programs and written by Set-Content stays UTF-8.`;
  return `${python} PowerShell is Windows PowerShell 5.1: Get-Content and Set-Content read and write ANSI unless I pass -Encoding utf8, and text piped into a program arrives as ASCII (ä becomes ?) unless $OutputEncoding is UTF-8 – ${shell ? 'shell.exec sets it; ' : ''}in my engine's own PowerShell a command that pipes such text starts with $OutputEncoding=[Text.UTF8Encoding]::new($false). Windows PowerShell 5.1 hands a program its arguments without their inner double quotes, so code with quotes reaches python or node whole from a file.`;
}

/** English name of a language code ("de" → "German"); the code itself when unknown. */
export function languageName(code: string | undefined): string {
  const value = code?.trim();
  if (!value) return 'English';
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(value);
    return name && name !== value ? name : value;
  } catch {
    return value;
  }
}

/** Notes in the stable prompt (settings allow 600). */
const NOTES_CAP = 600;

/** "How the person wants to be spoken to (profile.notes): …" – '' without notes. */
export function notesLine(notes: string | undefined): string {
  const text = notes?.replace(/\s+/g, ' ').trim();
  return text ? `How the person wants to be spoken to (profile.notes, kept by us agents): ${text.slice(0, NOTES_CAP)}` : '';
}

/** The stable "## My environment" (deterministic for the same agent, mode, engine and PC). `offered`: the mode's tool names. */
export function environmentSection(services: RuntimeServices, input: { agent: Agent; mode: ModeInfo; route: RouteDecision }, offered?: ReadonlySet<string>, system: SystemFacts = systemFacts()): string {
  const tools = offered ?? offeredTools(services, input.agent, input.mode);
  const workspace = safe(() => services.paths.workspace, '');
  const profile = safe(() => services.settings.get().profile, undefined);
  const language = languageName(profile?.language); // a fact, no rule: the app's setting, which starts as this PC's language
  const own = ownFileTools(services, input.route?.engine);
  const lines = [
    ENVIRONMENT_HEADER,
    `This PC: ${osName(system)}, named "${system.hostname}" – I run inside the Autark system on it, whose language is set to ${language}.`,
    windowsShellLine(system.platform, process.env, tools.has('shell.exec')), // B-080: what the shells on Windows do with text
    notesLine(profile?.notes),
    workspaceLine(workspace),
    homeLine(tools, os.homedir(), own),
    dataLine(services, tools, own),
    memoryLine(services, tools),
    webLine(tools, input.route?.engine, own), // E1: the engine's own search first
    screenLine(tools),
    [...tools].some((name) => name.startsWith('browser.') && name !== 'browser.show') ? `Browser, where: ${whereHint(any(tools, 'computer.'))}` : '',
    INSTRUCTION_FILES_LINE,
  ];
  return lines.filter(Boolean).join('\n');
}

function fileTools(offered: ReadonlySet<string>): string {
  const names = ['files.read', 'files.list', 'files.search'].filter((name) => offered.has(name));
  if (!names.length) return '';
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * E1 live (01.11.2026): the workspace is empty at the start; Codex agents searched only it and hired, briefed or asked on
 * that basis while the person's material lay in their home folder. The line names where the person's own files are and
 * (F2/G1) that files.search without a path covers the workspace and then that folder – a fact, only where a file tool is
 * offered.
 */
export function homeLine(offered: ReadonlySet<string>, home: string = os.homedir(), own = false): string {
  if (!home || !(own || fileTools(offered))) return '';
  const search = !own && offered.has('files.search') ? ' – files.search without a path searches the workspace, then this folder' : '';
  return `The person's own files: ${home} and its folders${search}.`;
}

/** G1 (01.11.2026): the data folder as a fact, no instruction – where a file tool is offered or the engine has its own. */
function dataLine(services: RuntimeServices, offered: ReadonlySet<string>, own: boolean): string {
  const data = safe(() => services.paths.data, '');
  if (!data || !(own || fileTools(offered))) return '';
  return `Data folder: ${data} – the Autark system's own files (settings.json, theme.css, agents' SYSTEM.md, skills, prompts); ${path.join(data, ROOT_README)} maps them.`;
}

/**
 * Lane find 14.11.2026 (E4b live A/B: every Autark arm, Sol too, missed the rules stored in memory – "prices only in NOK",
 * "no calls before 10:00" – while plain Codex found them through one AGENTS.md line saying what its notes hold and where):
 * where memory is and what it holds, as a fact – never a list of it.
 */
export function memoryLine(services: RuntimeServices, offered: ReadonlySet<string>): string {
  const data = safe(() => services.paths.data, '');
  if (!data) return '';
  const find = offered.has('knowledge.find') ? ' knowledge.find finds a note by the names and words of a job.' : '';
  return `Memory: ${path.join(data, MEMORY_ENTRY)} – what we have learned and saved: people, partners, places, their rules and wishes, and how work is done here; one Markdown note per subject, in folders.${find}`;
}

/** Names in the companies line (beyond: "+N more"). */
const MAX_PLACES = 6;

const named = (names: string[]): string => `${names.slice(0, MAX_PLACES).join(', ')}${names.length > MAX_PLACES ? ` +${names.length - MAX_PLACES} more` : ''}`;

/**
 * B-075 (owner 04.11.2026: an agent knew neither the person's other company nor the linked PC it was asked about):
 * "Companies on this PC: Teydra lab (this one), company-2 · Linked PCs: laptop (online)" – only where there is
 * more than one company or a linked PC; with several companies, where tools.call is offered, how to act in another one.
 */
export function companiesLine(services: RuntimeServices, offered: ReadonlySet<string>, agent?: Pick<Agent, 'homes'>): string {
  const companies = safe(() => listCompanies(services.host.app), []);
  const pcs = safe(() => linkedPcs(services), []);
  if (companies.length < 2 && !pcs.length) return '';
  const parts: string[] = [];
  if (companies.length) {
    const how = companies.length > 1 && offered.has(CALL_TOOL) ? ' – tools.call with company: "<name>" runs a tool in another one' : '';
    parts.push(`Companies on this PC: ${named(companies.map((company) => `${cleanLabel(company.label)}${company.current ? ' (this one)' : ''}`))}${how}`);
  }
  // Umzug 21.11.2026: one clause on where I run – my record goes with me, and what happens while my PC is off (part 2:
  // I wait for it unless I am at home on several PCs – agents.update homes – and one of them holds my complete record).
  const moves = !agent ? '' : ` – my record goes with me to the PC I work on; while mine is off ${agent.homes?.length
    ? 'a PC I am at home on goes on with me from my complete record'
    : 'I wait for it – agents.update homes names the PCs that go on with me'}`;
  if (pcs.length) parts.push(`Linked PCs: ${named(pcs.map((pc) => `${cleanLabel(pc.name)} (${pc.online ? 'online' : 'offline'})`))}${moves}`);
  return `${parts.join(' · ')}.`;
}

/** An app phone's phone use in a few words. */
const PHONE_USE: Readonly<Record<NonNullable<LinkedPhone['use']>, string>> = {
  on: 'phone use on', off: 'phone use off – the app shows the person how to turn it on', away: 'not connected right now',
};

/** Phones named in the phones line (beyond: "+N more"). */
const MAX_PHONES = 3;

/**
 * "Linked phones: samsung SM-S918B (the person's, Autark app, phone use on) – phone.* works on a phone whose phone use is
 * on (an ADB phone always); phone.say with ask: true asks the person for a moment of theirs." – '' without a linked phone
 * or where phone.* is not offered. A phone attached to another PC of mine names that PC: phone.* reaches it with `device`.
 */
export function phonesLine(services: RuntimeServices, offered: ReadonlySet<string>): string {
  const phones = offered.has('phone.ui_tree') ? safe(() => linkedPhones(services), []) : [];
  if (!phones.length) return '';
  const names = phones.slice(0, MAX_PHONES).map((phone) => {
    const where = phone.pc ? `, on ${cleanLabel(phone.pc)}` : '';
    if (phone.via === 'adb') return `${cleanLabel(phone.name)} (over ADB${where || ' on this PC'})`;
    return `${cleanLabel(phone.name)} (the person's, Autark app${where || `, ${PHONE_USE[phone.use ?? 'away']}`})`;
  });
  const more = phones.length > MAX_PHONES ? ` +${phones.length - MAX_PHONES} more` : '';
  const ask = phones.some((phone) => phone.via === 'app') ? '; phone.say with ask: true asks the person for a moment of theirs' : '';
  const elsewhere = phones.some((phone) => phone.pc) ? '; one on another PC with device: that PC' : '';
  return `Linked phones: ${names.join(', ')}${more} – phone.* works on a phone whose phone use is on (an ADB phone always)${elsewhere}${ask}.`;
}

/** The name an engine goes by for the person: its account's provider ("Claude Code", "Codex", "OpenAI API"), else the engine's. */
export function engineName(services: RuntimeServices, route: Pick<RouteDecision, 'engine' | 'accountId'>): string {
  const account = safe(() => services.accounts.list(), []).find((entry) => entry.id === route.accountId);
  return (account && PROVIDER_LABELS[account.provider]) || PROVIDER_LABELS[route.engine as ProviderId] || route.engine; // codex, claude … name a provider too
}

/**
 * "Engines connected in this Autark system: Claude Code (2 accounts), Codex." – the signed-in accounts that run turns,
 * by provider in the order they were added ('' when none). A sign-in that lapses moves the account to signInLine.
 */
export function enginesLine(services: RuntimeServices): string {
  const counts = new Map<string, number>();
  for (const account of safe(() => services.accounts.list(), [])) {
    if (!isUsableState(account) || !engineFor(account.provider) || MEDIA_ONLY_PROVIDERS.includes(account.provider)) continue;
    const name = PROVIDER_LABELS[account.provider] ?? account.provider;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (!counts.size) return '';
  return `Engines connected in this Autark system: ${[...counts].map(([name, count]) => (count > 1 ? `${name} (${count} accounts)` : name)).join(', ')}.`;
}

/** "Accounts needing sign-in: …" (labels only; '' when none). */
export function signInLine(services: RuntimeServices, offered: ReadonlySet<string>): string {
  const waiting = safe(() => services.accounts.list(), []).filter((account) => account.enabled !== false && account.state === 'needs_login');
  if (!waiting.length) return '';
  const tool = offered.has('accounts.sign_in'); // then each account's id too: the tool's accountId
  const names = waiting.slice(0, MAX_SIGN_IN).map((account) => `${cleanLabel(account.label, account.email)} (${account.provider}${tool ? `, ${account.id}` : ''})`);
  const more = waiting.length > MAX_SIGN_IN ? ` +${waiting.length - MAX_SIGN_IN} more` : '';
  const how = tool ? ' – accounts.sign_in starts the official sign-in' : '';
  return `Accounts needing sign-in: ${names.join(', ')}${more}${how}.`;
}

/** B-052 M6: "Connected apps: Notion (app.notion.*), … – tools.find finds their tools; another service: skill connect-apps."
 *  – apps the agent may use now (AppsService.usableBy: ids) whose tools this turn offers; with none, where the apps
 *  service runs, the plain fact (G1: the hint to connect a service read as a setup step at the first request). Connector
 *  tools are app.<id>.<tool> (three parts; app.status is the app's own tool). */
export function appsLine(services: RuntimeServices, agent: Agent, offered: ReadonlySet<string>): string {
  const ids = new Set([...offered].map((name) => name.split('.')).filter((parts) => parts[0] === 'app' && parts.length >= 3).map((parts) => parts[1]));
  const usable = new Set(ids.size ? safe(() => services.apps?.usableBy(agent.id) ?? [], [] as string[]) : []);
  const apps = usable.size ? safe(() => services.apps?.list() ?? [], []).filter((app) => ids.has(app.id) && usable.has(app.id)) : [];
  if (!apps.length) return '';
  const names = apps.slice(0, MAX_APPS).map((app) => `${cleanLabel(app.name)} (app.${app.id}.*)`);
  const more = apps.length > MAX_APPS ? ` +${apps.length - MAX_APPS} more` : '';
  const find = offered.has(FIND_TOOL) ? ' – tools.find finds their tools' : '';
  return `Connected apps: ${names.join(', ')}${more}${find}${find ? ';' : ' –'} another service: skill connect-apps.`;
}

const GB = 1024 ** 3;
const DISK_TELL_BYTES = 2 * GB;

/** Free space is context for the agent, independent of whether a turn starts. */
function freeBytes(dir: string): number | undefined {
  try { const stats = statfsSync(dir); return Number(stats.bavail) * Number(stats.bsize); } catch { return undefined; }
}

/**
 * B-080 (live 08.11.2026: the team stood still for hours on a nearly full disk until a person made room): below
 * DISK_TELL_BYTES the free space of the data folder's disk as a fact, in my own voice – rounded down to 0.1 GB, so the
 * volatile delta changes only in those steps. '' when it is more or cannot be read. One statfs per turn, no timer.
 */
export function diskLine(services: RuntimeServices, read: (dir: string) => number | undefined = freeBytes): string {
  const dir = safe<string | undefined>(() => services.paths?.data, undefined);
  const free = dir ? read(dir) : undefined;
  if (free === undefined || free >= DISK_TELL_BYTES) return '';
  const gb = (Math.floor((free / GB) * 10) / 10).toFixed(1);
  return `This PC's disk has only ${gb} GB free. I make room before it is full – temp files, caches and build output that rebuilds itself – and keep everyone's work and data.`;
}

/**
 * The live part (prompt-volatile.ts): the free disk space when low (B-080), the companies and linked PCs, the linked phones, accounts
 * needing sign-in and connected apps. `mode`: the agent's own mode (its tool offer); `disk`: the free-space probe (tests
 * pass their own).
 */
export function environmentNow(services: RuntimeServices, input: { agent: Agent; mode?: ModeInfo }, disk: (dir: string) => number | undefined = freeBytes): string {
  const offered = input.mode ? offeredTools(services, input.agent, input.mode) : new Set<string>();
  const lines = [
    diskLine(services, disk), // B-080: the agent can make room while it keeps working
    enginesLine(services), // owner 15.11.2026: which engines the system has (the turn's own: "## Now")
    companiesLine(services, offered, input.agent), // B-075
    phonesLine(services, offered), // KI-Runde 17.11.2026
    signInLine(services, offered),
    appsLine(services, input.agent, offered), // B-052 M6
  ].filter(Boolean);
  return lines.length ? [`${ENVIRONMENT_HEADER} now`, ...lines].join('\n') : '';
}
