// settings.json section `security` (owner 19.11.2026, shared/model/security-settings.ts): the mode and its switches as
// schema.ts describes every section – what each key does, the allowed values and the default (Trust AI mode's, the
// open system). validate.ts checks the lists (absolute folders, app names). The topic texts are files, not keys
// (runtime/security/topics.ts). Umzug 21.11.2026: the section is this PC's own (it does not travel to the other PCs), and
// `otherPcs` has no default – absent (null in the file) reads as yes, so a section kept before this key existed still
// equals the file's (settings/service.ts keepSecurity) and no upgrade reads as a disk edit.
// Owns: these key definitions. Never: reads files, decides a call (runtime/security/policy.ts).

import { MAX_SCOPE_ITEMS, OTHER_PCS, SECURITY_MODES, securityDefaults, siteOf, type SecuritySettings } from '../../shared/model/security-settings.ts';
import type { KeyDef, SectionDef } from './schema.ts';

/** Longest folder path or app name in a list. */
export const MAX_SCOPE_TEXT = 1024;

const open = securityDefaults('trust');
const ALLOW = ['yes', 'ask'] as const;
const ASKS = 'yes = the team does it on its own, ask = the app asks you before each time (Secure mode';
const pick = (key: keyof SecuritySettings & string, about: string, options: readonly string[]): KeyDef => ({ key, about, type: 'string', options, default: open[key] });
const allow = (key: keyof SecuritySettings & string, what: string, trust = false): KeyDef => pick(key, `${what}: ${ASKS}${trust ? ', and Trust AI mode too' : ''})`, ALLOW);
const list = (key: keyof SecuritySettings & string, about: string, allowed: string): KeyDef => ({
  key, about, type: 'array', allowed: `a list of up to ${MAX_SCOPE_ITEMS} ${allowed}`, default: [],
  schema: { maxItems: MAX_SCOPE_ITEMS, items: { type: 'string', minLength: 1, maxLength: MAX_SCOPE_TEXT } },
});

/** The section as settings.json and settings.schema.json show it. */
export const SECURITY_SECTION: SectionDef = {
  key: 'security',
  title: 'Security – how far the team goes on its own on this PC (Settings › Security)',
  notes: [
    'This section is this PC\'s own: each of your PCs keeps its own mode and switches.',
    'The texts the team reads about each topic are files: security/trust/<topic>.md and security/secure/<topic>.md beside this file.',
    'In Trust AI mode only money, publish, message and otherPcs count below; in Secure mode every key counts and spending money stays closed.',
  ],
  keys: [
    pick('mode', 'trust = Trust AI mode: the team works everywhere and follows the texts in security/trust/; secure = Secure mode: the switches below hold closed what they close, and the app asks you when an agent needs it', SECURITY_MODES),
    pick('read', 'Reading files outside the team\'s own folders: all = everywhere, chosen = in readFolders, elsewhere the app asks you (Secure mode)', ['all', 'chosen']),
    list('readFolders', 'Folders open for reading besides the team\'s own', 'absolute folder paths'),
    pick('write', 'Changing and deleting files outside the team\'s own folders: all = everywhere, chosen = in writeFolders, elsewhere the app asks you (Secure mode)', ['all', 'chosen']),
    list('writeFolders', 'Folders open for changes besides the team\'s own', 'absolute folder paths'),
    allow('commands', 'Running commands in a shell'),
    pick('web', 'Browsing, searching and fetching from the web: yes = every site, chosen = a search and the sites in webDomains, before the first visit to any other site the app asks you, ask = the app asks you each time (Secure mode)', ['yes', 'chosen', 'ask']),
    { ...list('webDomains', 'Sites open when web is chosen (a site\'s subdomains count with it)', 'host names, e.g. "example.com"'), default: undefined, allowed: `a list of up to ${MAX_SCOPE_ITEMS} host names, e.g. "example.com", or null (none)` },
    pick('computer', 'Operating apps on this PC: yes = every app, chosen = the apps in computerApps, ask = the app asks you each time (Secure mode, where Autark\'s own window is never operated)', ['yes', 'chosen', 'ask']),
    list('computerApps', 'Apps open to operate when computer is chosen', 'process names in lower case without .exe, e.g. "excel"'),
    allow('phone', 'Operating your linked phone'),
    allow('message', 'Messages to people outside the company', true),
    allow('publish', 'Posting publicly', true),
    allow('accounts', 'Signing in, creating accounts, using stored passwords'),
    allow('setup', 'Autark\'s own setup: this file, other agents\' instructions, shared skills, modes, prompts, theme'),
    allow('team', 'Hiring, changing and archiving agents'),
    allow('money', 'Spending money (closed in Secure mode whatever this says)', true),
    { key: 'otherPcs', about: 'Calls from agents on other PCs: yes = they run here like this PC\'s own agents\' calls, ask = the app asks you before each one, no = this PC refuses them (both modes)', type: 'string', options: OTHER_PCS, allowed: 'yes | ask | no, or null (yes)' },
  ],
};

/** An absolute folder on Windows (C:\…, \\server\…) or elsewhere (/…). */
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/])/;
const CONTROL = /[\u0000-\u001f]/;
/** A site as webDomains keeps it (siteOf): a host name or an IP address, no scheme, path or port. */
export const SITE = /^(?:[a-z0-9](?:[a-z0-9-]{0,62})(?:\.[a-z0-9](?:[a-z0-9-]{0,62}))*|[0-9a-f:]+)$/;

/** A folder as the list keeps it: trimmed, without a trailing separator (a drive's or the system's root keeps its own). */
export function folderOf(text: string): string {
  const trimmed = text.trim();
  return /^(?:[A-Za-z]:[\\/]|[\\/]{1,2})$/.test(trimmed) ? trimmed : trimmed.replace(/[\\/]+$/, '');
}

/** An app as the list keeps it: its process name in lower case, without .exe. */
export function appOf(text: string): string {
  return text.trim().toLowerCase().replace(/\.exe$/, '').trim();
}

/**
 * Checks the section (validate.ts validateSettings) and puts its lists in their one form: folders trimmed and absolute,
 * app names lower case without .exe, each once. Throws through `bad` like every other check.
 */
export function validateSecurity(value: SecuritySettings, bad: (path: string, expected: string) => never): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) bad('security', 'an object');
  const record = value as unknown as Record<string, unknown>;
  for (const def of SECURITY_SECTION.keys) {
    const path = `security.${def.key}`;
    const item = record[def.key];
    if (def.type === 'string') {
      if (item === undefined && def.default === undefined) continue; // otherPcs: absent = yes
      if (!def.options!.includes(item as string)) bad(path, def.options!.join(' | '));
      continue;
    }
    if (def.key === 'webDomains' && (item === undefined || item === null)) { delete record[def.key]; continue; } // absent = none
    const app = def.key === 'computerApps';
    const site = def.key === 'webDomains';
    const expected = `a list of up to ${MAX_SCOPE_ITEMS} ${app ? 'app names' : site ? 'host names' : 'absolute folder paths'}`;
    if (!Array.isArray(item) || item.length > MAX_SCOPE_ITEMS) bad(path, expected);
    const clean = (item as unknown[]).map((entry) => {
      if (typeof entry !== 'string' || entry.length > MAX_SCOPE_TEXT || CONTROL.test(entry)) bad(path, expected);
      const one = app ? appOf(entry) : site ? siteOf(entry) : folderOf(entry);
      if (!one || (site && !SITE.test(one)) || (!app && !site && !ABSOLUTE.test(one))) bad(path, expected);
      return one;
    });
    record[def.key] = [...new Set(clean)];
  }
}
