// After a crash, an update, a quit or a power loss: the work a cut-off run belonged to gets one wake note
// (INTERRUPTED_NOTE: check what the run already did, then continue – tasks/watch.ts recover), and one start
// notice says what happened ("Updated to X · N tasks continued" or "Restarted after an interruption · …", kv 'system',
// read by system.info).
// B-080: an install – an agent's app.install or system.install, or the updater's own (system.prepareRestart {to}) – is
// kept as kv 'system'/'install' {to?, from, installer?, by?, pid?, at} until the next start: the start notice then says
// whether it landed ("Updated to X · …" or "The update to X did not install · still on Y" – marked `failed`, F25), the agent named in `by`
// gets one wake note saying so (installReceipt, through the watcher's recover), and recordStart drops the record. Every
// install ends the app, so a start under the same app process (`pid`, Host.app.pid) followed none: a postponed update
// says nothing there, an agent hears that its install did not start. An install main gives up without a restart (the
// window kept its drafts, a refused pause) arrives as system.prepareRestart {cancel}: dropInstall answers it at once.
// Owns: the note texts, the start notice and the install record. Never: repeats, cancels or judges an action.

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import { KvRepo } from '../store/kv.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { clockText } from '../context/time.ts';

export const INTERRUPTED_NOTE = 'My last run was cut off (restart or stop). I check what it already did, then continue.';
const KV = 'system';
const NOTICE_KEY = 'startNotice';
const VERSION_KEY = 'version';
const INSTALL_KEY = 'install';
/** The relaunch helper's log in <data>/logs (main/updates/install-helper.ts HELPER_LOG). */
export const HELPER_LOG = 'update-helper.log';

/**
 * `failed` (F25, 16.11.2026): an install did not land – the window keeps that line until Dismiss and About shows it;
 * `to`: the version it would have brought (main's updater does not install that one by itself again).
 */
export interface StartNotice { id: string; text: string; at: number; failed?: true; to?: string }

/** Who started an install (app.install's turn). */
export interface InstallBy { agentId: string; conversationId?: string; taskId?: string; runId?: string }
/** B-080: an install not yet confirmed by a start: the version it brings (when known), the one it replaces, the file, who; `pid`: the app's process then. */
export interface InstallRecord { to?: string; from: string; installer?: string; by?: InstallBy; pid?: number; at: number }

/** The start notice for this start (undefined when nothing happened worth saying); `install`: an install this start answers. */
export function startNotice(input: { previous?: string; version: string; interrupted: number; continued: number; at: number; install?: InstallRecord; blocked?: boolean; reinstalled?: boolean }): StartNotice | undefined {
  const tasks = `${input.continued} task${input.continued === 1 ? '' : 's'} continued`;
  const notice = (text: string): StartNotice => ({ id: `start:${input.at}`, text, at: input.at });
  // 28.11.2026: a build of the same version (an app.install of the running version – no latest.yml, so no `to`) that the
  // helper's installer ran without an error is a reinstall, not a failed update (the S9 showed "did not install · still on 0.3.21").
  if (input.install && input.reinstalled && !input.blocked && !input.install.to && input.version === input.install.from) return notice(`Reinstalled ${input.version} · ${tasks}`);
  if (input.install && !landed(input.install, input.version)) {
    const update = `The update${input.install.to ? ` to ${input.install.to}` : ''}`;
    return { ...notice(input.blocked
      ? `${update} did not install: Windows Smart App Control blocked its setup (Autark is not code-signed yet) · still on ${input.version}`
      : `${update} did not install · still on ${input.version}`), failed: true, ...(input.install.to ? { to: input.install.to } : {}) };
  }
  if (input.install || (input.previous && input.previous !== input.version)) return notice(`Updated to ${input.version} · ${tasks}`);
  if (input.interrupted > 0) return notice(`Restarted after an interruption · ${tasks}`);
  return undefined;
}

/** Whether this start runs the version an install brought: its `to`, or – unknown – any other than the one it replaced. */
function landed(record: InstallRecord, version: string): boolean {
  return record.to ? version === record.to : version !== record.from;
}

/** Whether the app ended since the record (another app process now, or one unknown) – only then can its install have run. */
function endedSince(record: InstallRecord, pid: number | undefined): boolean {
  return record.pid === undefined || pid === undefined || record.pid !== pid;
}

/** Stores this start's notice (or clears the last one) and the version it ran; B-080: answers and drops the install record. */
export function recordStart(s: Pick<RuntimeServices, 'db' | 'clock'> & Partial<Pick<RuntimeServices, 'host' | 'paths'>>, input: { version: string; interrupted: number; continued: number }): StartNotice | undefined {
  const kv = new KvRepo(s.db);
  const now = s.clock.now();
  const kept = kv.get<InstallRecord>(KV, INSTALL_KEY) ?? undefined;
  const install = kept && endedSince(kept, s.host?.app.pid) ? kept : undefined; // the same app process: nothing installed
  const blocked = install !== undefined && blockedByWindows(helperLog(s.paths?.logs));
  const reinstalled = install !== undefined && reinstallRan(install, s.paths?.logs);
  const notice = startNotice({ ...input, previous: kv.get<string>(KV, VERSION_KEY), at: now, ...(install ? { install } : {}), ...(blocked ? { blocked } : {}), ...(reinstalled ? { reinstalled } : {}) });
  if (notice) kv.set(KV, NOTICE_KEY, notice, now);
  else kv.delete(KV, NOTICE_KEY);
  kv.set(KV, VERSION_KEY, input.version, now);
  if (kept) kv.delete(KV, INSTALL_KEY);
  return notice;
}

/** The notice of the current start, for system.info. */
export function readStartNotice(s: Pick<RuntimeServices, 'db'>): StartNotice | undefined {
  try { return new KvRepo(s.db).get<StartNotice>(KV, NOTICE_KEY) ?? undefined; } catch { return undefined; }
}

/**
 * B-080: the wake note for the agent that started the install this start answers – landed, not landed, or (the same app
 * process: the app never ended) not started, in its own voice – with where it goes (its chat, its task while open).
 * Undefined without an install record or without `by`. Reads only.
 */
export function installReceipt(s: Pick<RuntimeServices, 'db' | 'clock'> & Partial<Pick<RuntimeServices, 'host' | 'settings' | 'paths' | 'tasks'>>): { by: InstallBy; note: string } | undefined {
  const record = new KvRepo(s.db).get<InstallRecord>(KV, INSTALL_KEY) ?? undefined;
  const version = s.host?.app.version;
  if (!record?.by || !version) return undefined;
  let zone: string | undefined;
  try { zone = s.settings?.get().profile.timezone; } catch { zone = undefined; }
  const now = clockText(s.clock.now(), zone);
  const at = clockText(record.at, zone);
  const note = !endedSince(record, s.host?.app.pid)
    ? `At ${now} Autark still runs ${version} – the install I started at ${at} did not start.`
    : landed(record, version)
      ? `Autark started again at ${now} on ${version} – the install I started at ${at} landed.`
      : reinstallRan(record, s.paths?.logs) && version === record.from && !blockedByWindows(helperLog(s.paths?.logs))
        ? `Autark started again at ${now} on ${version} – the install I started at ${at} was this same version, installed again without an error.`
      : `Autark started again at ${now}, still on ${version} – the install I started at ${at} did not land; update-helper.log ends with: ${helperTail(s.paths?.logs) ?? '(no line)'}.`;
  let open = false;
  try { open = record.by.taskId !== undefined && !['done', 'dropped'].includes(s.tasks?.get(record.by.taskId)?.status ?? 'done'); } catch { open = false; }
  const { taskId, ...rest } = record.by;
  return { by: open ? { ...rest, taskId } : rest, note };
}

/**
 * B-084: the exit code `start /wait` reports when Windows Code Integrity (Smart App Control) refuses to run the setup –
 * seen on the owner's PC 09.11.2026 09:04 with CodeIntegrity event 3077 on the installer in the same second.
 */
export const SMART_APP_CONTROL_EXIT = 1073751882;

/** Whether the helper's last install ended with Windows refusing the setup (its log goes on with "new version started"). */
export function blockedByWindows(log: string | undefined): boolean {
  const ended = log?.split(/\r?\n/).filter((line) => line.includes('installer ended')).pop();
  return Boolean(ended?.includes(`(exit code ${SMART_APP_CONTROL_EXIT})`));
}

/**
 * Whether the helper's installer ran for this install and ended without an error ("installer ended (exit code 0)"): the
 * log must have been written since the install began (its mtime – the lines' times follow the PC's locale), so a line of an
 * earlier install says nothing. Only for an install without a known target version, which cannot say more.
 */
export function reinstallRan(record: InstallRecord, logs: string | undefined): boolean {
  if (record.to || !logs) return false;
  try {
    if (statSync(path.join(logs, HELPER_LOG)).mtimeMs < record.at) return false;
  } catch { return false; }
  const ended = helperLog(logs)?.split(/\r?\n/).filter((line) => line.includes('installer ended')).pop();
  return Boolean(ended?.includes('(exit code 0)'));
}

/** The end of the helper's log (the last 4 KB), for blockedByWindows. */
function helperLog(logs: string | undefined): string | undefined {
  if (!logs) return undefined;
  try { return readFileSync(path.join(logs, HELPER_LOG), 'utf8').slice(-4096); } catch { return undefined; }
}

/** The relaunch helper log's last line (at most 300 characters), when there is one. */
function helperTail(logs: string | undefined): string | undefined {
  if (!logs) return undefined;
  try {
    const text = readFileSync(path.join(logs, HELPER_LOG), 'utf8').slice(-4096);
    return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop()?.slice(0, 300);
  } catch { return undefined; }
}

/** B-080: the updater's own install (system.prepareRestart {to}) – a record of its own (an earlier one was answered at its cancel). */
export function noteUpdate(s: Pick<RuntimeServices, 'db' | 'clock'> & Partial<Pick<RuntimeServices, 'host'>>, to: string): void {
  const now = s.clock.now();
  const pid = s.host?.app.pid;
  new KvRepo(s.db).set(KV, INSTALL_KEY, { to, from: s.host?.app.version ?? '', ...(pid !== undefined ? { pid } : {}), at: now } satisfies InstallRecord, now);
}

/**
 * B-080: an install that did not happen after all (system.prepareRestart {cancel}: a postponed update, an install main gave
 * up without a restart) – its record goes, and the agent named in `by` hears at once that it did not start.
 */
export function dropInstall(s: Pick<RuntimeServices, 'db' | 'clock' | 'wakes'> & Partial<Pick<RuntimeServices, 'host' | 'settings' | 'paths' | 'tasks' | 'org'>>): void {
  const receipt = installReceipt(s);
  new KvRepo(s.db).delete(KV, INSTALL_KEY);
  if (receipt) wakeInstaller(s, receipt);
}

/** B-080: the receipt's one wake for the agent that started the install (its chat, its task while open), unless it is archived. */
export function wakeInstaller(s: Pick<RuntimeServices, 'wakes' | 'clock'> & Partial<Pick<RuntimeServices, 'org'>>, receipt: { by: InstallBy; note: string }): void {
  const { by, note } = receipt;
  const agent = s.org?.get(by.agentId);
  if ((s.org && (!agent || agent.archivedAt !== undefined)) || (!by.conversationId && !by.taskId)) return;
  const now = s.clock.now();
  s.wakes.wake({ agentId: by.agentId, reason: 'retry', conversationId: by.conversationId, taskId: by.taskId, dueAt: now, note, coalesceKey: `install:${by.runId ?? now}` });
}

/**
 * B-080 (app.install, system.install): installs an Autark build on this PC the way an update installs – the file must
 * exist; the record is kept (installReceipt answers it at the next start), then the host is asked (Host.install: main
 * answers first, then drains, runs the installer and starts the new version). A host without it (headless) refuses.
 */
export async function installBuild(s: Pick<RuntimeServices, 'db' | 'clock' | 'host'>, installer: string, by?: InstallBy): Promise<InstallRecord> {
  const install = s.host.install?.bind(s.host);
  if (!install) throw new WorkforceError('unavailable', 'This Autark runs without its app window, so it cannot install a build on this PC.');
  if (process.platform === 'darwin') throw new WorkforceError('unavailable', 'On macOS a build installs from its .dmg, not from here.');
  if (!path.isAbsolute(installer) || !existsSync(installer)) throw new WorkforceError('not_found', `No installer at ${installer}.`);
  const to = buildVersion(installer);
  const pid = s.host.app.pid;
  const record: InstallRecord = { ...(to ? { to } : {}), from: s.host.app.version, installer, ...(by ? { by } : {}), ...(pid !== undefined ? { pid } : {}), at: s.clock.now() };
  const kv = new KvRepo(s.db);
  kv.set(KV, INSTALL_KEY, record, record.at);
  try { await install(installer); } catch (error) { kv.delete(KV, INSTALL_KEY); throw error; }
  return record;
}

/** The version of a build beside its latest.yml (electron-builder writes `version:` and `path: <file>` there), when it names this file. */
export function buildVersion(installer: string): string | undefined {
  for (const name of ['latest.yml', 'latest-linux.yml']) {
    let text: string;
    try { text = readFileSync(path.join(path.dirname(installer), name), 'utf8'); } catch { continue; }
    const file = /^path:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m.exec(text)?.[1];
    const version = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text)?.[1];
    if (version && file === path.basename(installer)) return version;
  }
  return undefined;
}
