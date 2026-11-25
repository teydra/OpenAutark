// The connector files in <data>/connectors/ – the whole configuration of connected apps, edited by the AI (skill
// connect-apps) or the person:
//   mcp.json   {"mcpServers": {"<name>": {"url": "https://…", "headers": {…}} | {"command": "npx", "args": […], "env": {…}, "cwd": "…"}}}
//              – the map Claude Code and Cursor use; "disabled": true turns one off.
//   mail.json  {"mailboxes": {"<name>": {"address": "me@x.com", "password": "secret://<id>", "agent": "<agent id or name>",
//              "user"?, "imap"?: {"host", "port", "tls": "implicit"|"starttls"}, "smtp"?: {…}, "disabled"?: true}}}
// Any value may hold secret://<id> handles of the secrets catalog (resolved only when it connects; a plain value works
// too). status.json is written by the runtime: each connector's state, tool count, error and open sign-in page.
// Owns: reading, checking and writing these files, the id a key gets. Never: resolves a handle, logs a value.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { APP_ID_MAX, APP_ID_PATTERN, type ConnectedApp, type MailServer } from '../../shared/model/apps.ts';
import { parseResultProjections } from './result-projection.ts';
import type { Connector } from './types.ts';

export const CONNECTORS_DIR = 'connectors';
export const MCP_FILE = 'mcp.json';
export const MAIL_FILE = 'mail.json';
export const STATUS_FILE = 'status.json';
/** Ids a connector never gets: they would read as the runtime's own tools. */
const RESERVED: ReadonlySet<string> = new Set(['workforce', 'apps', 'app']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const strings = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) return undefined;
  const out = Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  return Object.keys(out).length ? out : undefined;
};

export const connectorsDir = (dataDir: string) => path.join(dataDir, CONNECTORS_DIR);

/** Lower-case [a-z0-9-], starting with a letter, at most APP_ID_MAX characters ('app' when nothing is left). */
export function slug(name: string): string {
  let out = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!out) return 'app';
  if (!/^[a-z]/.test(out)) out = `app-${out}`;
  return out.slice(0, APP_ID_MAX).replace(/-+$/, '');
}

/** JavaScript enumerates array-index object keys before ordinary names, regardless of insertion order. */
function isArrayIndexKey(name: string): boolean {
  const value = Number(name);
  return Number.isInteger(value) && value >= 0 && value < 0xffff_ffff && String(value) === name;
}

/** A free id for `name` (its slug, else with -2, -3 …). */
function freeId(name: string, taken: Set<string>): string {
  const base = slug(name);
  for (let n = 1; n < 1000; n += 1) {
    const suffix = n === 1 ? '' : `-${n}`;
    const id = `${base.slice(0, APP_ID_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!RESERVED.has(id) && !taken.has(id) && APP_ID_PATTERN.test(id)) { taken.add(id); return id; }
  }
  return `app-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
}

type NamedTransport = Pick<Connector, 'name' | 'transport'>;

function idsFor(items: readonly NamedTransport[]): Map<string, string> {
  const taken = new Set<string>();
  return new Map(items.map((item) => [`${item.transport}\0${item.name}`, freeId(item.name, taken)]));
}

/** A structural edit must not silently rebind any existing app/tool id. */
function assertStableExistingIds(before: readonly NamedTransport[], after: readonly NamedTransport[], action: string): void {
  const oldIds = idsFor(before);
  const newIds = idsFor(after);
  for (const [key, oldId] of oldIds) {
    const nextId = newIds.get(key);
    if (nextId !== undefined && nextId !== oldId) throw new Error(`${action} would change another app id; rename the colliding app on the PC first.`);
  }
}

function server(value: unknown): MailServer | undefined {
  if (!isRecord(value) || !text(value.host)) return undefined;
  const port = Number(value.port);
  const tls = value.tls === 'starttls' ? 'starttls' : 'implicit';
  return { host: text(value.host)!, port: Number.isInteger(port) && port > 0 ? port : tls === 'starttls' ? 587 : 993, tls };
}

/** Reads one JSON file of the folder: its object, undefined when it does not exist, or the problem. */
function readJson(file: string): { value?: Record<string, unknown>; source?: string; problem?: string } {
  if (!existsSync(file)) return {};
  try {
    const source = readFileSync(file, 'utf8');
    const value: unknown = JSON.parse(source.replace(/^﻿/, '') || '{}');
    return isRecord(value) ? { value, source } : { source, problem: `${path.basename(file)}: the top level must be an object.` };
  } catch (error) {
    return { problem: `${path.basename(file)}: ${error instanceof Error ? error.message.slice(0, 200) : 'not valid JSON'}` };
  }
}

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/** Every connector the two files name (keys in file order, mcp.json first), and the problems found. */
export function readConnectors(dataDir: string): { connectors: Connector[]; problems: string[] } {
  const dir = connectorsDir(dataDir);
  const problems: string[] = [];
  const connectors: Connector[] = [];
  const taken = new Set<string>();
  const mcp = readJson(path.join(dir, MCP_FILE));
  if (mcp.problem) problems.push(mcp.problem);
  const servers = mcp.value?.mcpServers ?? {};
  if (!isRecord(servers)) problems.push(`${MCP_FILE}: "mcpServers" must be an object.`);
  else {
    for (const [name, raw] of Object.entries(servers)) {
      if (!isRecord(raw)) { problems.push(`${MCP_FILE}: "${name}" must be an object.`); continue; }
      const resultProjection = Object.hasOwn(raw, 'resultProjection') ? parseResultProjections(raw.resultProjection) : undefined;
      if (resultProjection === null) problems.push(`${MCP_FILE}: a connector has invalid resultProjection rules.`);
      const base = { name, enabled: raw.disabled !== true && raw.enabled !== false, fingerprint: fingerprint(raw),
        ...(resultProjection !== undefined ? { resultProjection } : {}) };
      const url = text(raw.url) ?? text(raw.serverUrl);
      const command = text(raw.command);
      if (url) connectors.push({ ...base, id: freeId(name, taken), transport: 'http', url, ...(strings(raw.headers) ? { headers: strings(raw.headers) } : {}) });
      else if (command) {
        const args = Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === 'string') : [];
        connectors.push({ ...base, id: freeId(name, taken), transport: 'stdio', command, args, ...(text(raw.cwd) ? { cwd: text(raw.cwd) } : {}), ...(strings(raw.env) ? { env: strings(raw.env) } : {}) });
      } else problems.push(`${MCP_FILE}: "${name}" needs "url" or "command".`);
    }
  }
  const mail = readJson(path.join(dir, MAIL_FILE));
  if (mail.problem) problems.push(mail.problem);
  const boxes = mail.value?.mailboxes ?? {};
  if (!isRecord(boxes)) problems.push(`${MAIL_FILE}: "mailboxes" must be an object.`);
  else {
    for (const [name, raw] of Object.entries(boxes)) {
      if (!isRecord(raw)) { problems.push(`${MAIL_FILE}: "${name}" must be an object.`); continue; }
      const address = text(raw.address);
      const password = text(raw.password);
      if (!address || !address.includes('@') || !password) { problems.push(`${MAIL_FILE}: "${name}" needs "address" and "password".`); continue; }
      const imap = server(raw.imap);
      const smtp = server(raw.smtp);
      connectors.push({
        id: freeId(name, taken), name, transport: 'mail', enabled: raw.disabled !== true && raw.enabled !== false, fingerprint: fingerprint(raw),
        mail: { address, password, ...(raw.contactStopFile !== undefined ? { contactStopFile: typeof raw.contactStopFile === 'string' ? raw.contactStopFile : '' } : {}), ...(text(raw.user) ? { user: text(raw.user) } : {}), ...(imap ? { imap } : {}), ...(smtp ? { smtp } : {}), ...(text(raw.agent) ? { agent: text(raw.agent) } : {}) },
      });
    }
  }
  return { connectors, problems };
}

/** Writes `content` through a temporary file (an editor never sees half a file). */
function writeFile(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

/**
 * Compare all connector bytes immediately before atomic replacement, catching edits already visible at that point.
 * This is not an OS compare-and-swap: an unrelated external writer in the final compare/rename window is uncoordinated.
 */
function writeMutation(file: string, before: string | undefined, content: string, guards: Array<{ file: string; source: string | undefined }> = []): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
    const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    if (current !== before) throw new Error('Connector file changed; refresh the list and try again.');
    for (const guard of guards) {
      const latest = existsSync(guard.file) ? readFileSync(guard.file, 'utf8') : undefined;
      if (latest !== guard.source) throw new Error('Connector files changed; refresh the list and try again.');
    }
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* already renamed or removed */ }
    throw error;
  }
}

export type ConnectorMutation =
  | { kind: 'add'; entries: Array<{ name: string; entry: Record<string, unknown> }> }
  | { kind: 'setEnabled'; id: string; name: string; transport: 'http' | 'stdio' | 'mail'; enabled: boolean }
  | { kind: 'remove'; id: string; name: string; transport: 'http' | 'stdio' | 'mail'; allowMailRemoval?: true }
  | { kind: 'setToken'; id: string; name: string; transport: 'http'; secretId: string };

/** Mutates only named connector entries and preserves every other raw JSON field. No parser projection is serialized. */
export function mutateConnectors(dataDir: string, mutation: ConnectorMutation, options: { validateOnly?: boolean } = {}): void {
  const file = mutation.kind === 'add' ? MCP_FILE : mutation.kind === 'setToken' || mutation.transport !== 'mail' ? MCP_FILE : MAIL_FILE;
  const section = file === MCP_FILE ? 'mcpServers' : 'mailboxes';
  const pathAt = path.join(connectorsDir(dataDir), file);
  const parsed = readJson(pathAt);
  if (parsed.problem) throw new Error(`${file} is invalid.`);
  const before = parsed.source;
  const otherFile = file === MCP_FILE ? MAIL_FILE : MCP_FILE;
  const otherPath = path.join(connectorsDir(dataDir), otherFile);
  const other = readJson(otherPath);
  if (other.problem) throw new Error(`${otherFile} is invalid.`);
  const current = readConnectors(dataDir);
  if (current.problems.length) throw new Error('Connector files have problems; fix them before changing apps.');
  const root = parsed.value ?? {};
  const rawSection = root[section] ?? {};
  if (!isRecord(rawSection)) throw new Error(`${file} has an invalid ${section} section.`);
  const entries: Record<string, unknown> = Object.assign(Object.create(null) as Record<string, unknown>, rawSection);
  if (mutation.kind === 'add') {
    if (!mutation.entries.length) throw new Error('No connectors to add.');
    if (mutation.entries.length > 40) throw new Error('A maximum of 40 connectors can be added at once.');
    const existingNames = new Set(current.connectors.map((item) => item.name));
    const names = new Set<string>();
    const addedNames: string[] = [];
    for (const { name, entry } of mutation.entries) {
      if (!name.trim() || name.length > 120 || names.has(name) || existingNames.has(name) || Object.hasOwn(entries, name) || !isRecord(entry)) throw new Error('Connector names must be unique and entries valid.');
      if (isArrayIndexKey(name)) throw new Error('Integer connector names change object order; rename them on the PC first.');
      names.add(name);
      addedNames.push(name);
      const allowed = new Set(['url', 'serverUrl', 'command', 'args', 'cwd', 'env', 'headers', 'resultProjection']);
      if (Object.keys(entry).some((key) => !allowed.has(key))) throw new Error('Connector entry has unsupported fields.');
      if (Object.hasOwn(entry, 'resultProjection') && !parseResultProjections(entry.resultProjection)) throw new Error('Invalid connector resultProjection rules.');
      const http = typeof entry.url === 'string' || typeof entry.serverUrl === 'string';
      const stdio = typeof entry.command === 'string';
      if (Object.hasOwn(entry, 'url') && Object.hasOwn(entry, 'serverUrl')) throw new Error('Use either url or serverUrl, not both.');
      if (http === stdio || (http && (Object.hasOwn(entry, 'command') || Object.hasOwn(entry, 'args') || Object.hasOwn(entry, 'cwd') || Object.hasOwn(entry, 'env'))) ||
          (stdio && (Object.hasOwn(entry, 'url') || Object.hasOwn(entry, 'serverUrl') || Object.hasOwn(entry, 'headers')))) {
        throw new Error('Connector entry must describe either one HTTP server or one local command.');
      }
      const urlValue = typeof entry.url === 'string' ? entry.url : entry.serverUrl;
      if (http) {
        let url: URL;
        try { url = new URL(urlValue as string); } catch { throw new Error('Connector URL is invalid.'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw new Error('Connector URL must be HTTP(S) without embedded credentials.');
      } else if (typeof entry.command !== 'string' || !entry.command.trim()) throw new Error('Connector command is required.');
      if (Object.hasOwn(entry, 'args') && (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== 'string'))) throw new Error('Connector arguments must be strings.');
      for (const field of ['headers', 'env'] as const) {
        if (!Object.hasOwn(entry, field)) continue;
        if (!isRecord(entry[field]) || Object.values(entry[field]).some((value) => typeof value !== 'string')) throw new Error(`Connector ${field} must contain text values.`);
      }
      if (Object.hasOwn(entry, 'cwd') && (typeof entry.cwd !== 'string' || !entry.cwd.trim())) throw new Error('Connector working directory must be text.');
      const secretHandle = (value: unknown) => typeof value === 'string' && /^(?:(?:Bearer|Token|Basic)\s+)?secret:\/\/[A-Za-z0-9_-]+$/i.test(value.trim());
      if (isRecord(entry.headers)) for (const [key, value] of Object.entries(entry.headers)) if (/authorization|token|secret|password|api[-_]?key/i.test(key) && !secretHandle(value) && !(typeof value === 'string' && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value))) throw new Error('Sensitive headers must use a Secrets handle.');
      if (isRecord(entry.env)) for (const [key, value] of Object.entries(entry.env)) if (/token|secret|password|api[-_]?key/i.test(key) && !secretHandle(value) && !(typeof value === 'string' && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value))) throw new Error('Sensitive environment values must use a Secrets handle.');
      entries[name] = entry;
    }
    const after = [
      ...current.connectors.filter((item) => item.transport !== 'mail').map((item) => ({ name: item.name, transport: item.transport })),
      ...addedNames.map((name) => ({ name, transport: 'http' as const })),
      ...current.connectors.filter((item) => item.transport === 'mail').map((item) => ({ name: item.name, transport: item.transport })),
    ];
    assertStableExistingIds(current.connectors, after, 'Adding this name');
  } else {
    const raw = entries[mutation.name];
    if (!isRecord(raw)) throw new Error('Connector no longer exists.');
    const actualTransport = section === 'mailboxes' ? 'mail' : typeof raw.url === 'string' || typeof raw.serverUrl === 'string' ? 'http' : typeof raw.command === 'string' ? 'stdio' : undefined;
    const actualId = current.connectors.find((item) => item.name === mutation.name && item.transport === mutation.transport)?.id;
    if (actualId !== mutation.id || actualTransport !== mutation.transport) throw new Error('Connector changed; refresh the list.');
    if (mutation.kind === 'remove') {
      if (actualTransport === 'mail' && mutation.allowMailRemoval !== true) throw new Error('Mobile mailbox removal is not supported.');
      const after = current.connectors.filter((item) => !(item.name === mutation.name && item.transport === mutation.transport));
      assertStableExistingIds(current.connectors, after, 'Removing this app');
      delete entries[mutation.name];
    } else if (mutation.kind === 'setEnabled') {
      if (mutation.enabled) { delete raw.disabled; delete raw.enabled; }
      else { raw.disabled = true; delete raw.enabled; }
    } else {
      if (actualTransport !== 'http' || !/^[A-Za-z0-9_-]{1,120}$/.test(mutation.secretId)) throw new Error('A valid HTTP connector and secret handle are required.');
      const headers = isRecord(raw.headers) ? { ...raw.headers } : {};
      for (const key of Object.keys(headers)) if (key.toLowerCase() === 'authorization') delete headers[key];
      headers.Authorization = `Bearer secret://${mutation.secretId}`;
      raw.headers = headers;
    }
  }
  root[section] = entries;
  if (!options.validateOnly) writeMutation(pathAt, before, `${JSON.stringify(root, null, 2)}\n`, [{ file: otherPath, source: other.source }]);
}

/** Creates the folder and the two files when they are missing (so the AI finds them). */
export function ensureFiles(dataDir: string): void {
  const dir = connectorsDir(dataDir);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(path.join(dir, MCP_FILE))) writeFile(path.join(dir, MCP_FILE), `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
  if (!existsSync(path.join(dir, MAIL_FILE))) writeFile(path.join(dir, MAIL_FILE), `${JSON.stringify({ mailboxes: {} }, null, 2)}\n`);
}

/** status.json: what the AI reads after a change (written by the runtime only). */
export function writeStatus(dataDir: string, apps: readonly ConnectedApp[], problems: readonly string[], now: number): void {
  const connectors = Object.fromEntries(apps.map((app) => [app.name, {
    id: app.id, type: app.transport === 'mail' ? 'mail' : 'mcp', status: app.status, tools: app.tools,
    ...(app.error ? { error: app.error } : {}), ...(app.signInUrl ? { signInUrl: app.signInUrl } : {}),
    ...(app.toolNames.length ? { toolNames: app.toolNames } : {}),
  }]));
  const body = { note: 'Written by the app – edit mcp.json / mail.json instead.', updatedAt: new Date(now).toISOString(), ...(problems.length ? { problems } : {}), connectors };
  try { writeFile(path.join(connectorsDir(dataDir), STATUS_FILE), `${JSON.stringify(body, null, 2)}\n`); } catch { /* the next change writes it again */ }
}
