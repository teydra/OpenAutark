// The company's security mode (owner 19.11.2026, Settings › Security): settings.json section `security`.
// 'trust' = Trust AI mode, the open system of today: the team works everywhere; the person explains each topic in a text
// (a file per topic) and a few switches catch the gravest steps. 'secure' = Secure mode: switches per capability, the
// runtime holds closed what a switch closes, and when an agent needs it the app asks the person – once, always for that
// setting, or always for that place. In Secure mode spending money is closed for good and Autark's own window and its
// security setup are never the agents' to operate or change.
// Topic texts: <data>/security/<mode>/<topic>.md (absent = the default in resources/security/<mode>/<topic>.md; `{{name}}`
// stands for the person's name). One file per text field.
// Umzug 21.11.2026 (PCSEC): the section belongs to this PC – each of the person's PCs keeps its own mode and switches
// (devices/sync/settings.ts LOCAL_SECTIONS), and an agent works under the rules of the PC its tool call runs on.
// `otherPcs` (both modes): what a call from an agent on another PC (the person's own or an employer's) gets here – yes as today, ask = the
// app asks the person first, no = refused. Absent = yes (files and the kept copy of a version before it hold none).
// Owns: these shapes, the ids, the defaults per mode and which texts need a double confirm. Never: reads files, decides a
// call (runtime/security/policy.ts) or holds a text.

/** The two modes. */
export type SecurityMode = 'trust' | 'secure';
export const SECURITY_MODES: readonly SecurityMode[] = ['trust', 'secure'];

/** A capability switch: 'yes' = the team does it on its own; 'ask' = the app asks the person before each time. */
export type Allow = 'yes' | 'ask';
/** Files: 'all' = everywhere on this PC; 'chosen' = the company's own folders plus the listed ones, elsewhere ask. */
export type FileScope = 'all' | 'chosen';
/** Computer use: 'yes' every app (never Autark itself in Secure mode), 'chosen' the listed apps, 'ask' each time. */
export type AppScope = 'yes' | 'chosen' | 'ask';
/**
 * The web (25.11.2026, Secure mode after Andrea Griffiths' VM test – data could leave through any URL): 'yes' every site,
 * 'chosen' the sites in webDomains and a search (its receiver is the search provider, not a site of the agent's
 * choosing) – the app asks before the first visit to any other site and an "always" adds it to the list –, 'ask' each time.
 */
export type WebScope = 'yes' | 'chosen' | 'ask';
/** Calls from agents on other PCs (the person's own, and a firm's PC this one joined as an employee): 'yes' run like this PC's own agents' calls, 'ask' each time, 'no' refused. */
export type OtherPcs = 'yes' | 'ask' | 'no';
export const OTHER_PCS: readonly OtherPcs[] = ['yes', 'ask', 'no'];

export interface SecuritySettings {
  mode: SecurityMode;
  /** Reading files outside the company's own folders. */
  read: FileScope;
  readFolders: string[];
  /** Changing, creating and deleting files outside the company's own folders. */
  write: FileScope;
  writeFolders: string[];
  /** Running commands in a shell (PowerShell, Bash, cmd). */
  commands: Allow;
  /** Browsing, searching and fetching from the web. */
  web: WebScope;
  /**
   * Sites open when web is 'chosen' (host names in lower case, without "www."; a site's subdomains count with it). Absent
   * = none (a section kept before this key existed; read it with webDomainsOf).
   */
  webDomains?: string[];
  /** Operating apps on this PC (computer use). */
  computer: AppScope;
  /** Process names, e.g. "excel", "chrome" (lower case, without .exe). */
  computerApps: string[];
  /** Operating a linked phone. */
  phone: Allow;
  /** Messages to people outside the company (e-mail, DMs, comments). */
  message: Allow;
  /** Posting publicly (social media, websites, releases). */
  publish: Allow;
  /** Signing in, creating accounts, using stored passwords and cards' other data. */
  accounts: Allow;
  /** Autark's own setup: settings.json, other agents' instructions, shared skills, modes, prompts, theme. */
  setup: Allow;
  /** Hiring, changing and archiving agents. */
  team: Allow;
  /** Spending money. Trust mode only – in Secure mode it is closed whatever this says. */
  money: Allow;
  /** Calls from agents on other PCs, in both modes (absent = 'yes'; read it with otherPcsOf). */
  otherPcs?: OtherPcs;
}

/** The switches of a mode in the order Settings › Security shows them (each has its topic text). */
export const SECURITY_SWITCHES = ['read', 'write', 'commands', 'web', 'computer', 'phone', 'message', 'publish', 'accounts', 'setup', 'team', 'money'] as const;
/** Every switch the gate knows: a mode's switches and `otherPcs` (both modes, no topic text; the page's head shows it). */
export type SecuritySwitch = typeof SECURITY_SWITCHES[number] | 'otherPcs';

/** What calls from agents on other PCs get here. */
export function otherPcsOf(settings: Pick<SecuritySettings, 'otherPcs'> | undefined): OtherPcs {
  return settings?.otherPcs ?? 'yes';
}

/** The sites open when web is 'chosen' (absent: none). */
export function webDomainsOf(settings: Pick<SecuritySettings, 'webDomains'> | undefined): string[] {
  return settings?.webDomains ?? [];
}

/**
 * A site as the list keeps it and the app asks about it: the host name in lower case, without a trailing dot and a
 * leading "www.", an IPv6 address without its brackets; '' when `host` is none.
 */
export function siteOf(host: string): string {
  return host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.+$/, '').replace(/^www\./, '');
}

/** The WHATWG URL parts siteOfUrl uses (shared has no DOM or Node types; every layer's runtime has the global). */
declare const URL: new (input: string) => { protocol: string; hostname: string };

/** The site of a URL (a bare "example.com/x" counts as https); '' when it names none (data:, about:, an invalid one). */
export function siteOfUrl(url: string): string {
  const raw = url.trim();
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'ws:' || parsed.protocol === 'wss:' || parsed.protocol === 'ftp:' ? siteOf(parsed.hostname) : '';
  } catch { return ''; }
}

/** True when `site` is one of `domains` or lies below one ("docs.example.com" under "example.com"); never for ''. */
export function siteListed(domains: readonly string[], site: string): boolean {
  const host = siteOf(site);
  if (!host) return false;
  return domains.some((domain) => { const listed = siteOf(domain); return Boolean(listed) && (host === listed || host.endsWith(`.${listed}`)); });
}

/** The line an agent reads when Secure mode held back its browser's move to `site` (its own browser and the side pane). */
export function heldMoveText(site: string): string {
  return `Secure mode held back the move to ${site}: that site is not open to me yet. I open it with browser.open, and the app asks the person first.`;
}

/** The switches Trust mode keeps for the gravest steps (Yes / Ask). */
export const TRUST_SWITCHES: readonly SecuritySwitch[] = ['money', 'publish', 'message'];

/** Topic texts, one file each. Every switch has its topic (in Secure mode the optional note under it), plus two more. */
export const SECURITY_TOPICS = ['general', 'captcha', ...SECURITY_SWITCHES] as const;
export type SecurityTopic = typeof SECURITY_TOPICS[number];

/** The topic fields Trust mode shows, in order. */
export const TRUST_TOPICS: readonly SecurityTopic[] = ['general', 'write', 'message', 'publish', 'accounts', 'money', 'captcha', 'computer', 'phone', 'setup'];
/** The topic fields Secure mode shows besides the notes under the switches. */
export const SECURE_EXTRA_TOPICS: readonly SecurityTopic[] = ['general', 'captcha'];

/** Texts whose change needs the double confirm in Settings › Security, every time the field is opened for editing. */
export const CRITICAL_TOPICS: Readonly<Record<SecurityMode, readonly SecurityTopic[]>> = {
  trust: ['money'],
  secure: ['money', 'accounts', 'setup', 'captcha'],
};

/** Words for the UI and the prompt. */
export const SECURITY_LABELS: Readonly<Record<SecurityTopic | SecuritySwitch, string>> = {
  general: 'When to check with you',
  captcha: 'Bot checks ("I\'m not a robot")',
  read: 'Reading files',
  write: 'Changing and deleting files',
  commands: 'Running commands',
  web: 'Web',
  computer: 'Operating apps on this PC',
  phone: 'Operating your phone',
  message: 'Messages to other people',
  publish: 'Publishing',
  accounts: 'Accounts, sign-ins and passwords',
  setup: 'Autark\'s own setup',
  team: 'Hiring and changing agents',
  money: 'Spending money',
  otherPcs: 'Calls from agents on other PCs',
};

/** A topic file's folder and name below <data>. */
export const SECURITY_DIR = 'security';
export function topicPath(mode: SecurityMode, topic: SecurityTopic): string {
  return `${SECURITY_DIR}/${mode}/${topic}.md`;
}

/** Longest topic text (characters). */
export const MAX_TOPIC_TEXT = 4000;
/** Longest folder or app list. */
export const MAX_SCOPE_ITEMS = 50;

const TRUST: Omit<SecuritySettings, 'mode'> = {
  read: 'all', readFolders: [], write: 'all', writeFolders: [], commands: 'yes', web: 'yes', computer: 'yes', computerApps: [],
  phone: 'yes', message: 'yes', publish: 'yes', accounts: 'yes', setup: 'yes', team: 'yes', money: 'yes',
};
const SECURE: Omit<SecuritySettings, 'mode'> = {
  read: 'chosen', readFolders: [], write: 'chosen', writeFolders: [], commands: 'ask', web: 'chosen', computer: 'ask', computerApps: [],
  phone: 'ask', message: 'ask', publish: 'ask', accounts: 'ask', setup: 'ask', team: 'yes', money: 'ask',
};

/** The switches a mode starts with (the first run's choice; switching modes in Settings keeps the person's own values). */
export function securityDefaults(mode: SecurityMode): SecuritySettings {
  return { mode, ...(mode === 'secure' ? SECURE : TRUST), readFolders: [], writeFolders: [], computerApps: [] }; // webDomains: absent = none
}

/**
 * What a switch says in the mode in force: Trust mode reads only TRUST_SWITCHES and otherPcs (everything else
 * 'yes'/'all'); Secure mode reads them all and money is always 'ask'-and-refused (runtime/security/policy.ts refuses it
 * without asking).
 */
export function effective(settings: SecuritySettings): SecuritySettings {
  if (settings.mode === 'secure') return settings;
  const open = securityDefaults('trust');
  for (const key of TRUST_SWITCHES) (open as unknown as Record<string, unknown>)[key] = settings[key];
  if (settings.otherPcs) open.otherPcs = settings.otherPcs;
  return open;
}

/** What "always for this place" adds: a folder (read/write), an app (computer) or a site (web 'chosen', its webDomains). */
export interface ApprovalPlace { kind: 'folder' | 'app' | 'site'; value: string }

/** How a person answers an approval request. */
export type ApprovalAnswer = 'once' | 'setting' | 'place' | 'decline';
