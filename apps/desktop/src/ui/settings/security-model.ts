// Settings › Security and the first run's mode choice, the pure part (owner 19.11.2026: "Trust AI Mode" and "Secure
// Mode"; tested in test/unit/ui/security-model.test.ts): the words of both modes, the choices each switch offers, which
// fields need the double confirm ("muss doppelt auf den Bestätigungsbutton klicken … jedes Mal"), what a mode switch
// writes, the answers a waiting request offers, how a folder or app typed by the person is cleaned, and the Changes
// group's line for any field the change log holds (fields it does not know are shown by their name).
// Owns: these words and rules. Never: reads signals, calls the runtime or renders.

import {
  CRITICAL_TOPICS, MAX_SCOPE_ITEMS, SECURE_EXTRA_TOPICS, SECURITY_LABELS, SECURITY_SWITCHES, TRUST_SWITCHES, securityDefaults, siteOfUrl,
  type ApprovalAnswer, type SecurityMode, type SecuritySettings, type SecuritySwitch, type SecurityTopic,
} from '../../shared/model/security-settings.ts';
import type { ApprovalRequest } from '../../shared/api/methods-security-mode.ts';
import type { SecurityActor } from '../../shared/model/security-log.ts';

/** The two modes, as the About card and the Security page name them, with the About card's sentence. */
export const MODE_ROWS: ReadonlyArray<{ id: SecurityMode; title: string; text: string }> = [
  { id: 'trust', title: 'Trust AI', text: 'Your team works everywhere on its own and follows the agreements you can read and change in Settings › Security.' },
  { id: 'secure', title: 'Secure', text: 'Your team works freely in its own folders, and the app asks you before anything else – files elsewhere, commands, apps, your phone, messages, posts. Spending money stays closed.' },
];

export const modeTitle = (mode: SecurityMode): string => MODE_ROWS.find((row) => row.id === mode)?.title ?? mode;

/** The Security page's two-line explanation of the mode in force (the row's reserved hint). */
export const MODE_TEXT: Readonly<Record<SecurityMode, string>> = {
  trust: 'The team works everywhere and decides itself, guided by the agreements below. A switch set to Ask waits for you.',
  secure: 'The team works freely in its own folders. For everything set to Ask, the app asks you first.',
};

/** One line under each switch: what it covers. */
export const SWITCH_HINT: Readonly<Record<SecuritySwitch, string>> = {
  read: 'Files outside the team\'s own folders',
  write: 'Changing, creating and deleting files outside its own folders',
  commands: 'PowerShell, Bash and other shells',
  web: 'Browsing, searching and downloading',
  computer: 'Mouse and keyboard in other apps – never Autark\'s own window',
  phone: 'Your linked phone',
  message: 'E-mail, chats and comments to people outside the company',
  publish: 'Social media, websites, releases',
  accounts: 'Signing in, new accounts, stored passwords',
  setup: 'Settings, other agents\' instructions, shared skills, themes',
  team: 'Hiring, changing and archiving agents',
  money: 'Payments, subscriptions and stored cards',
  otherPcs: 'Tools and files that agents on other PCs use on this PC',
};

/**
 * Konrad 25.11.2026: commands set to Yes in Secure mode is a deliberate opening – a shell reads past the folder rules
 * (Codex and Claude Code alike) – so the row says so while it is open.
 */
export const COMMANDS_OPEN_HINT = 'Open: commands run without asking and can read any file this user can, including keys';

/** The line under a switch in this mode with this value. */
export function switchHint(mode: SecurityMode, key: SecuritySwitch, value: string): string {
  return mode === 'secure' && key === 'commands' && value === 'yes' ? COMMANDS_OPEN_HINT : SWITCH_HINT[key];
}

/** Spending money in Secure mode: one fixed note instead of a choice. */
export const MONEY_CLOSED = 'Closed in Secure mode';
export const MONEY_CLOSED_HINT = 'No payment and no stored card, whatever a chat says';

export interface Choice { value: string; label: string }

const YES_ASK: readonly Choice[] = [{ value: 'yes', label: 'Yes' }, { value: 'ask', label: 'Ask' }];
const YES_ASK_NO: readonly Choice[] = [...YES_ASK, { value: 'no', label: 'No' }];

/** The choices a switch offers in Secure mode (files: everywhere or chosen folders; apps: all, chosen or ask). */
export function switchChoices(key: SecuritySwitch): readonly Choice[] {
  if (key === 'read' || key === 'write') return [{ value: 'all', label: 'Everywhere' }, { value: 'chosen', label: 'Chosen folders' }];
  if (key === 'computer') return [{ value: 'yes', label: 'All apps' }, { value: 'chosen', label: 'Chosen apps' }, { value: 'ask', label: 'Ask' }];
  // 25.11.2026: searching stays open; a new site asks once and joins the list
  if (key === 'web') return [{ value: 'yes', label: 'All sites' }, { value: 'chosen', label: 'Chosen sites' }, { value: 'ask', label: 'Ask' }];
  return key === 'otherPcs' ? YES_ASK_NO : YES_ASK;
}

/** The value's word ("Ask", "Chosen folders"), for a read-only row and the Changes group. */
export function choiceLabel(key: SecuritySwitch, value: string): string {
  return switchChoices(key).find((choice) => choice.value === value)?.label ?? value;
}

/** The list a switch keeps (folders, apps or sites), if any. */
export function listKey(key: SecuritySwitch): 'readFolders' | 'writeFolders' | 'computerApps' | 'webDomains' | undefined {
  return key === 'read' ? 'readFolders' : key === 'write' ? 'writeFolders' : key === 'computer' ? 'computerApps' : key === 'web' ? 'webDomains' : undefined;
}

/** The switch's list counts: Chosen folders / Chosen apps is the value. */
export function listInForce(settings: SecuritySettings, key: SecuritySwitch): boolean {
  return settings[key] === 'chosen';
}

/** The field (a topic text or the mode itself) needs the double confirm in this mode, every time it is opened. */
export function needsDoubleConfirm(mode: SecurityMode, field: SecurityTopic | 'mode'): boolean {
  return field === 'mode' || CRITICAL_TOPICS[mode].includes(field);
}

/**
 * A Secure-mode note under a switch whose default is "" (resources/security/secure/ holds files only for the critical
 * topics and the extra fields): it has no head line and no "Reset to default" – emptying it is the way back.
 */
export function plainNote(mode: SecurityMode, topic: SecurityTopic): boolean {
  return mode === 'secure' && !SECURE_EXTRA_TOPICS.includes(topic) && !CRITICAL_TOPICS.secure.includes(topic);
}

/** A field's lock: 'locked' (read-only, Edit), 'confirm' (Yes, change it), 'open' (editable, Done). */
export type LockState = 'locked' | 'confirm' | 'open';
/** The lock button's word in each state (one fixed width for the three). */
export const LOCK_WORD: Readonly<Record<LockState, string>> = { locked: 'Edit', confirm: 'Yes, change it', open: 'Done' };
/** Where a field rests: locked when it needs the double confirm, else open. */
export const lockedState = (needed: boolean): LockState => (needed ? 'locked' : 'open');
/** The lock button's click: Edit → confirm, Yes, change it → open. */
export const nextLock = (now: LockState): LockState => (now === 'locked' ? 'confirm' : 'open');

/** What leaving a text field saves: the cleaned text, `null` for an emptied field whose default is "", or nothing (unchanged). */
export function topicWrite(loaded: { text: string }, draft: string, defaultEmpty: boolean): string | null | undefined {
  const next = draft.replace(/\r\n?/g, '\n').trim();
  if (next === loaded.text.trim()) return undefined;
  return next === '' && defaultEmpty ? null : next;
}

/** The reserved line while the field waits for "Yes, change it". */
export function confirmText(mode: SecurityMode, field: SecurityTopic | 'mode'): string {
  if (field === 'mode') return mode === 'secure' ? 'Trust AI opens everything to the team. Change the mode?' : 'Secure closes what you set to Ask until you answer. Change the mode?';
  if (field === 'money') return mode === 'secure' ? 'This text goes with money staying closed. Change it?' : 'This text decides how the team spends money. Change it?';
  return CONFIRM_TOPIC[field] ?? 'This is one of the key agreements. Change it?';
}

const CONFIRM_TOPIC: Partial<Record<SecurityTopic, string>> = {
  accounts: 'This text guards sign-ins, accounts and passwords. Change it?',
  setup: 'This text guards Autark\'s own setup. Change it?',
  captcha: 'This text decides what the team does at a bot check. Change it?',
};

/**
 * What a mode switch on the Security page writes: the person's own values stay (Trust mode reads only its three
 * switches, so Secure mode's values wait there for the way back). A company that has only ever been in Trust AI mode
 * holds Trust's open values everywhere; switching it to Secure starts from Secure's defaults instead, so "Secure"
 * never arrives with everything open.
 */
export function switchMode(current: SecuritySettings, to: SecurityMode): SecuritySettings {
  if (to === 'trust') return { ...current, mode: 'trust' };
  const open = securityDefaults('trust');
  const untouched = SECURITY_SWITCHES.every((key) => TRUST_SWITCHES.includes(key) || current[key] === open[key])
    && !current.readFolders.length && !current.writeFolders.length && !current.computerApps.length && !current.webDomains?.length;
  return untouched ? { ...securityDefaults('secure'), ...(current.otherPcs ? { otherPcs: current.otherPcs } : {}) } : { ...current, mode: 'secure' }; // otherPcs: both modes
}

/** The first run's write: that mode's defaults, unless the company already is in that mode (Set up again keeps it). */
export function firstRunSecurity(current: SecuritySettings | undefined, choice: SecurityMode): SecuritySettings | undefined {
  return current?.mode === choice ? undefined : securityDefaults(choice);
}

// ------------------------------------------------------------------ folder and app lists

/** A folder typed or picked: trimmed, without a trailing slash (a drive root keeps its), absolute – else null. */
export function cleanFolder(raw: string): string | null {
  let folder = raw.trim().replace(/^"(.*)"$/, '$1').trim();
  if (!folder || folder.includes('\0')) return null;
  if (!/^[a-zA-Z]:[\\/]/.test(folder) && !folder.startsWith('/') && !folder.startsWith('\\\\')) return null;
  while (folder.length > 3 && /[\\/]$/.test(folder) && !/^[a-zA-Z]:[\\/]$/.test(folder) && folder !== '/') folder = folder.slice(0, -1);
  return folder;
}

/** An app typed or picked: the process name in lower case, without ".exe" and without a folder – else null. */
export function cleanApp(raw: string): string | null {
  const name = (raw.trim().split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '').trim().toLowerCase();
  return name && name.length <= 80 && !/[\0"<>|]/.test(name) ? name : null;
}

/** A site typed or pasted ("https://www.example.com/page", "Example.com"): its host as the list keeps it – else null. */
export function cleanSite(raw: string): string | null {
  const text = raw.trim();
  if (!text || /\s/.test(text)) return null;
  const site = siteOfUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  return site && site.length <= 253 && /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|[0-9a-f:]+)$/.test(site) ? site : null;
}

/** The list with one more entry (same entry once, case-insensitive for folders on Windows), or null when it is full or there. */
export function addTo(list: readonly string[], entry: string): string[] | null {
  if (list.length >= MAX_SCOPE_ITEMS || list.some((item) => item.toLowerCase() === entry.toLowerCase())) return null;
  return [...list, entry];
}

// ------------------------------------------------------------------ waiting requests

export interface AnswerOption { answer: ApprovalAnswer; label: string; title?: string }

/** The answers a waiting request offers, in the to-do's order and words. */
export function answerOptions(request: Pick<ApprovalRequest, 'capability' | 'place'>): AnswerOption[] {
  const options: AnswerOption[] = [
    { answer: 'once', label: 'Allow once' },
    { answer: 'setting', label: `Always: ${SECURITY_LABELS[request.capability]}` },
  ];
  if (request.place) options.push({ answer: 'place', label: `Always: ${placeName(request.place)}`, title: request.place.value });
  options.push({ answer: 'decline', label: 'Decline' });
  return options;
}

/** A place for a button: an app by its name, a folder by its last part ("Docs" for C:\Users\Ada\Docs). */
export function placeName(place: NonNullable<ApprovalRequest['place']>): string {
  if (place.kind === 'app' || place.kind === 'site') return place.value;
  return place.value.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || place.value;
}

// ------------------------------------------------------------------ the change log

const FIELD_NAMES: Readonly<Record<string, string>> = {
  securityMode: 'Mode', mode: 'Mode', pcAccess: 'Access to this PC', forEveryAgent: 'For every agent',
  libraryPublish: 'Share in the public library', readFolders: 'Chosen folders for reading', writeFolders: 'Chosen folders for changes',
  computerApps: 'Chosen apps', webDomains: 'Chosen sites',
};
const VALUE_WORDS: Readonly<Record<string, string>> = {
  trust: 'Trust AI', secure: 'Secure', yes: 'Yes', ask: 'Ask', all: 'Everywhere', chosen: 'Chosen', on: 'On', off: 'Off',
  whole: 'Full access', careful: 'Careful',
};

/** The name of a logged field: the switch's or topic's label (with or without a "security." / "topic." prefix), else the field. */
export function fieldName(field: string): string {
  const topicFile = /^security\/(trust|secure)\/([a-z]+)\.md$/.exec(field);
  if (topicFile && Object.hasOwn(SECURITY_LABELS, topicFile[2])) {
    const label = SECURITY_LABELS[topicFile[2] as SecurityTopic];
    return `${label} – text (${modeTitle(topicFile[1] as SecurityMode)})`;
  }
  const bare = field.replace(/^(security|topic|trust|secure)[.:/]/, '').replace(/^(trust|secure)[.:/]/, '');
  if (Object.hasOwn(FIELD_NAMES, field)) return FIELD_NAMES[field];
  if (Object.hasOwn(FIELD_NAMES, bare)) return FIELD_NAMES[bare];
  if (Object.hasOwn(SECURITY_LABELS, bare)) return SECURITY_LABELS[bare as SecurityTopic];
  return bare.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (first) => first.toUpperCase());
}

/** A short logged value reads as a word ("Ask", "Secure"); anything else is a text. */
export function isWord(value: string): boolean {
  return Object.hasOwn(VALUE_WORDS, value);
}

const shown = (value: string): string => isWord(value) ? VALUE_WORDS[value] : `"${value.replace(/\s+/g, ' ').trim()}"`;

/** Change preview; the setting's name is shown separately as the row title. */
export function changeValues(change: { from: string; to: string }): string {
  return `${shown(change.from)} → ${shown(change.to)}`;
}

const ACTOR_ROLES = {
  person: 'Person',
  phone: 'Phone',
  agent: 'Agent',
  colleague: 'Colleague',
} as const satisfies Record<Exclude<SecurityActor['kind'], 'other'>, string>;

type ChangeOrigin =
  | { kind: 'actor'; role: (typeof ACTOR_ROLES)[keyof typeof ACTOR_ROLES]; name: string; href?: string }
  | { kind: 'source'; name: string };

/** Use the recorded role, never infer it from a name. A source need not identify the actor. */
export function changeOrigin(by: SecurityActor): ChangeOrigin {
  if (by.kind !== 'other') {
    const origin: ChangeOrigin = { kind: 'actor', role: ACTOR_ROLES[by.kind], name: by.name };
    if (by.kind === 'agent' && by.id?.startsWith('ag_')) origin.href = `#/team/${encodeURIComponent(by.id)}`;
    return origin;
  }
  switch (by.name) {
    case 'settings.json or a linked PC': return { kind: 'source', name: 'Direct file edit or a linked PC' };
    case 'An edit of the file (an agent, an editor or a script)': return { kind: 'source', name: 'Direct file edit' };
    case 'A command on this PC (wf or a script, no agent named)': return { kind: 'source', name: 'Command on this PC (no agent named)' };
    // The runtime detected a change at startup. Being offline says nothing about who or what made it.
    case 'While Autark was not running': return { kind: 'source', name: 'Unknown' };
    default: return { kind: 'source', name: by.name.trim() || 'Unknown' };
  }
}

/** A change whose values are texts opens to both full texts. */
export function opensToTexts(change: { from: string; to: string }): boolean {
  return !(isWord(change.from) || change.from === '') || !(isWord(change.to) || change.to === '');
}
