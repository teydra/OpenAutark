// RPC handlers: system info/resources/restart, event subscriptions, settings, UI state
// (drafts of all chats with their files – B-082 – + the last open chat; both are chat content, so a device without 'chat'
// – a To-do link – gets an empty state). A device with
// 'settings' changes preferences and notifications. On a secure transport (the owner's paired phone, not a colleague's
// session) it also changes routing, voice, devices, profile, day and calendar, and the PC's own preferences – window close,
// login item, automatic update download (owner 12.11.2026; main applies them on change). Plain LAN keeps the PC ones.
// system.root (B-044; 16.11.2026 for the owner and the phone's pane, PATH_RULE; B-081 `device`: that linked CEO PC's, without notices): where <data> and its generated
// map README.md are (the map written when missing),
// plus the settings file's quiet notice. B-080: system.install (owner) installs a build the way an update does;
// system.prepareRestart carries the update's version (`to`), so the next start can say whether it landed; since 16.11.2026
// it answers main's own link only (security.ts fromMain) – every other caller hears that system.install is its way.
// Owns: param checks and scope rules for these methods. Never: business logic – it delegates
// to extras.system, the settings service and the chat service.

import { WorkforceError } from '../../../shared/errors.ts';
import type { Topic } from '../../../shared/api/protocol.ts';
import type { Attachment } from '../../../shared/model/chat.ts';
import path from 'node:path';
import type { RootInfo, SettingsPatch } from '../../../shared/model/system.ts';
import { ROOT_README } from '../../root/layout.ts';
import '../../contracts/open-fs.ts';
import type { RuntimeServices } from '../../contracts.ts';
import { KvRepo } from '../../store/kv.ts';
import { json } from '../../db/database.ts';
import { attachedSecrets } from '../../secrets/chat-capture.ts';
import { restartRuntime, restoreStatus } from '../../portability/service.ts';
import { installBuild } from '../../tasks/recover-notes.ts'; // B-080
import { updateOn } from '../../devices/sync/update.ts'; // 19.11.2026
import { bad, id, input, isIdLike, optBool, optText, text } from '../params.ts';
import { onDevice, PATH_RULE } from './files-path.ts'; // B-081: system.root of a linked CEO PC
import { fromMain } from './security.ts'; // 16.11.2026: system.prepareRestart answers main's own link only
import { actingAs, actorOf, readSecurityChanges } from '../../settings/security-log.ts'; // 16.11.2026: Settings › Security's change log
import { isTopic, maySubscribe } from '../scopes.ts';
import { scopeHas } from '../table.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';

const TODO = { capability: 'todo' } as const;
const CHAT = { capability: 'chat' } as const;
const SETTINGS = { capability: 'settings' } as const;
/** 16.11.2026: Settings › About's backup rows from the owner's own phone (secure transport only). */
const SECURE_SETTINGS = { capability: 'settings', secure: true } as const;
/** Settings sections a phone/browser with the 'settings' capability may change. */
const DEVICE_SETTINGS: ReadonlySet<string> = new Set(['preferences', 'notifications']);
/** B-084: the sections a 'settings' device on a secure transport (my phone app's tunnel) changes as well; 16.11.2026
 * 'calendar' (Settings › Calendar › Use your own Google app on the phone). */
const SECURE_DEVICE_SETTINGS: ReadonlySet<string> = new Set(['routing', 'voice', 'devices', 'profile', 'day', 'calendar']);
/** Preferences that change the PC itself (login item, updates). Owner 12.11.2026: my own securely paired
 * phone reaches all my settings, so a secure 'settings' device changes them too (main applies them on change); a plain-LAN
 * device or a colleague does not. */
const PC_PREFERENCES: ReadonlySet<string> = new Set(['openAtLogin', 'autoDownloadUpdates', 'keepPcAwake']);
const MAX_TOPICS = 256;
const MAX_DRAFT = 100_000;
/** The answer to every caller of system.prepareRestart but main's own link – read by the agent whose script called it. */
export const PREPARE_RESTART_MAIN_ONLY = "system.prepareRestart is the desktop updater's own step right before it stops the app. "
  + 'To install a build I call system.install: it pauses the work, installs and restarts the app the way an update does, and the next start tells me whether it landed.';
const UI_KV = { ns: 'ui', key: 'lastConversationId' };

/**
 * Remembers the chat the human used last (ui.state → reopen it after a restart; the phone's bubble sends its line there,
 * task_cxs4s3pt 26.11.2026). Only the person moves it – their window (owner scope with `person`) or their phone or
 * browser; an agent's own wf and a plain launch token (any shell on this PC) read chats without moving it.
 */
export function rememberConversation(ctx: Pick<HandlerContext, 'services' | 'scope'>, conversationId: string): void {
  const { services, scope } = ctx;
  if (scope.kind !== 'device' && !(scope.kind === 'owner' && scope.person === true && !scope.agentId)) return;
  try {
    const kv = new KvRepo(services.db);
    if (kv.get<string>(UI_KV.ns, UI_KV.key) !== conversationId) kv.set(UI_KV.ns, UI_KV.key, conversationId, services.clock.now());
  } catch (error) {
    services.log.warn('could not store the last conversation', { error: String(error) });
  }
}

function topicsOf(params: unknown): Topic[] {
  const o = input(params);
  const value = o.topics;
  if (!Array.isArray(value) || value.length > 64) bad('topics', 'a list of at most 64 topics');
  for (const topic of value) if (!isTopic(topic)) bad('topics', "topics like 'chats', 'tasks', 'org', 'providers', 'system', 'chat:<id>' or 'runs:<agentId>'");
  return value as Topic[];
}

function subscribe(params: unknown, ctx: HandlerContext): { ok: true } {
  const wanted = topicsOf(params).filter((topic) => maySubscribe(ctx.scope, topic)); // others can never deliver
  const fresh = wanted.filter((topic) => !ctx.topics.has(topic));
  if (ctx.topics.size + fresh.length > MAX_TOPICS) throw new WorkforceError('conflict', 'Too many subscriptions on this connection.');
  for (const topic of fresh) ctx.topics.add(topic);
  return { ok: true };
}

function updateSettings(params: unknown, ctx: HandlerContext) {
  const patch = input(params) as SettingsPatch;
  if (ctx.scope.kind === 'device') {
    const secure = ctx.scope.secure === true && ctx.scope.capabilities.includes('settings');
    for (const section of Object.keys(patch)) {
      if (!DEVICE_SETTINGS.has(section) && !(secure && SECURE_DEVICE_SETTINGS.has(section))) throw new WorkforceError('forbidden', 'This device may only change appearance and notification settings.', { details: { section } });
    }
    const prefs = patch.preferences;
    for (const key of prefs && typeof prefs === 'object' ? Object.keys(prefs) : []) {
      if (!secure && PC_PREFERENCES.has(key)) throw new WorkforceError('forbidden', 'This setting changes the PC; change it on the PC or from the paired phone app over a secure connection.', { details: { section: 'preferences', key } });
    }
  }
  // 16.11.2026: the Security tab's two settings are logged with the caller (settings/security-log.ts)
  const { services } = ctx;
  const by = actorOf(ctx.scope, { person: () => services.settings.get().profile.name || 'The owner', agent: (agentId) => services.org.get(agentId)?.name });
  return actingAs(by, patch, () => services.settings.update(patch));
}

/** B-044 system.root: <data>, the workspace, the map (written now when it is missing) and the settings file's quiet notice. */
function rootInfo(services: RuntimeServices): RootInfo {
  services.rootMaps?.writeRoot();
  const notice = services.settings.notice?.();
  return { path: services.paths.data, workspace: services.paths.workspace, readme: path.join(services.paths.data, ROOT_README), ...(notice ? { notices: [notice] } : {}) };
}

type UiState = { drafts: Record<string, string>; secretDrafts?: Record<string, string[]>; draftFiles?: Record<string, Attachment[]>; lastConversationId?: string };

function uiState(ctx: HandlerContext): UiState {
  if (!scopeHas(ctx.scope, 'chat')) return { drafts: {} };
  const { db } = ctx.services;
  const drafts: Record<string, string> = {};
  const rows = db.all<{ conversation_id: string; text: string; secret_ids: string; attachments: string }>(
    `SELECT d.conversation_id, d.text, d.secret_ids, d.attachments FROM drafts d JOIN conversations c ON c.id = d.conversation_id
     WHERE c.archived_at IS NULL AND (d.text != '' OR d.secret_ids != '[]' OR d.attachments != '[]') ORDER BY d.updated_at DESC LIMIT 500`,
  );
  for (const row of rows) if (row.text) drafts[row.conversation_id] = row.text;
  const secretDrafts: Record<string, string[]> = {};
  const draftFiles: Record<string, Attachment[]> = {}; // B-082: a kept take in a draft comes back after a reload
  for (const row of rows) {
    const refs = json<string[]>(row.secret_ids, []);
    if (refs.length) secretDrafts[row.conversation_id] = refs;
    const files = draftAttachments(json<unknown>(row.attachments, []));
    if (files.length) draftFiles[row.conversation_id] = files;
  }
  const last = new KvRepo(db).get<string>(UI_KV.ns, UI_KV.key);
  const result: UiState = { drafts };
  if (Object.keys(secretDrafts).length) result.secretDrafts = secretDrafts;
  if (Object.keys(draftFiles).length) result.draftFiles = draftFiles;
  if (typeof last === 'string' && ctx.services.chats.get(last) && !ctx.services.chats.get(last)!.archivedAt) result.lastConversationId = last;
  return result;
}

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);

/** Draft attachments are a UI convenience: malformed entries are dropped, not rejected. */
function draftAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return [];
  const out: Attachment[] = [];
  for (const entry of value.slice(0, 20)) {
    const a = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    if (!isIdLike(a.fileId) || typeof a.name !== 'string' || typeof a.mime !== 'string') continue;
    const attachment: Attachment = { fileId: a.fileId, name: a.name.slice(0, 200), mime: a.mime.slice(0, 120), size: num(a.size) ?? 0 };
    for (const key of ['width', 'height', 'durationMs'] as const) {
      const value = num(a[key]);
      if (value !== undefined) attachment[key] = value;
    }
    out.push(attachment);
  }
  return out;
}

export function register(table: HandlerTable): void {
  table.add('system.info', (_params, ctx) => ctx.extras.system.info(), TODO);
  table.add('system.resources', (_params, ctx) => ctx.extras.system.resources());
  table.add('system.restartReadiness', (_params, ctx) => ctx.extras.system.restartReadiness());
  table.add('system.prepareRestart', async (params, ctx) => {
    // 16.11.2026: an agent's update script paused its own company here and the pause cut off the agent's turn with it.
    if (!fromMain(ctx.scope)) throw new WorkforceError('forbidden', PREPARE_RESTART_MAIN_ONLY);
    const o = input(params);
    await ctx.extras.system.prepareRestart(optBool(o, 'cancel'), optText(o, 'to', { max: 64 })); // B-080: the update's version
    return { ok: true };
  });
  // B-080: a build installed the way an update installs (tasks/recover-notes.ts installBuild; owner only: this PC's program).
  table.add('system.install', async (params, ctx) => {
    const record = await installBuild(ctx.services, text(input(params), 'installer', { max: 1024 }));
    return { ok: true, from: record.from, ...(record.to ? { to: record.to } : {}) };
  });

  // Feedback 1b136d01 (19.11.2026): this PC's Update button, or with `device` a linked own PC's – the official update only.
  table.add('system.update', (params, ctx) => {
    const o = input(params);
    const device = o.device === undefined ? undefined : id(o, 'device');
    return updateOn(ctx.services, device);
  }, SECURE_SETTINGS);

  table.add('events.subscribe', (params, ctx) => subscribe(params, ctx), TODO);
  table.add('events.unsubscribe', (params, ctx) => {
    for (const topic of topicsOf(params)) ctx.topics.delete(topic);
    return { ok: true };
  }, TODO);

  table.add('todos.speechLanguage', (_params, ctx) => {
    const value = ctx.services.settings.get().profile.language;
    const raw = typeof value === 'string' && value.length <= 64 ? value.trim().replaceAll('_', '-') : '';
    if (!raw || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(raw)) return { language: null };
    try {
      // baseName excludes locale extensions/private-use parameters not needed for recognition.
      const locale = new Intl.Locale(raw);
      return { language: (!locale.language || locale.language === 'und') ? null : locale.baseName };
    } catch {
      return { language: null };
    }
  }, TODO);
  table.add('settings.get', (_params, ctx) => ctx.services.settings.get(), TODO);
  table.add('settings.update', (params, ctx) => updateSettings(params, ctx), SETTINGS);
  table.add('settings.securityLog', (_params, ctx) => readSecurityChanges(new KvRepo(ctx.services.db)), SETTINGS);

  table.add('ui.state', (_params, ctx) => uiState(ctx), TODO);
  table.add('ui.saveDraft', (params, ctx) => {
    const o = input(params);
    const conversationId = id(o, 'conversationId');
    const draft = text(o, 'text', { max: MAX_DRAFT, allowEmpty: true, multiline: true });
    ctx.services.chats.saveDraft(conversationId, draft, draftAttachments(o.attachments), attachedSecrets(ctx.services, conversationId, o.secrets));
    rememberConversation(ctx, conversationId);
    return { ok: true };
  }, CHAT);

  // MM7: Settings › About › Backup – the restore's state and the in-app restart (paths and the runtime of this PC; 16.11.2026
  // the owner's own phone on a secure transport too, like system.backup).
  table.add('system.restoreStatus', (_params, ctx) => restoreStatus(ctx.services), SECURE_SETTINGS);
  table.add('system.restartRuntime', (_params, ctx) => restartRuntime(ctx.services), SECURE_SETTINGS);
  // B-044: where <data> and its generated README.md map are (paths of this PC – 16.11.2026 for whoever reads its paths:
  // the owner and the phone's pane, PATH_RULE). B-081: with `device` that
  // linked CEO PC's (files.path 'root', devices/sync/paths.ts) – the new-tab page's Files cell of that PC.
  table.add('system.root', (params, ctx) => onDevice(ctx, params, 'root', async () => rootInfo(ctx.services)), PATH_RULE);
}
