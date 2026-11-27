// Client state as signals: snapshots loaded once per connection (loadAll – the model catalog with them), then kept fresh
// by event deltas (store-events.ts). Every view reads from here; nothing keeps a second copy. A view that loads data of
// its own reloads it on the same reconnect (lib/use-load.ts). Each chat's lines live in one list (messagesFor): the open
// chat's from its events, every other chat of the list catches up its newest lines when its summary says there are
// new ones (catchUp), and a load fills in behind what is shown (takeNewest) – so a chat opens with the line its preview
// already shows (owner 27.11.2026).
// Owns: the data signals, loaders and small upsert helpers.
// Never: renders, or polls – freshness comes from events and reconnect reloads only.

import { batch, computed, signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { Agent } from '../../shared/model/org.ts';
import type { Attachment, ConversationSummary, Message } from '../../shared/model/chat.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import type { Account, ModelInfo, UsageSummary } from '../../shared/model/providers.ts';
import type { AgentActivity } from '../../shared/model/runs.ts';
import type { Preferences, Settings, SettingsPatch, SystemInfo, UpdateState } from '../../shared/model/system.ts';
import { rpc, RpcError } from './rpc.ts';
import { route } from './router.ts';
import { isMobile } from './platform.ts';
import { loadSnapshots } from './load.ts';
import { can, loadSession, session } from './session.ts';
import { countNow } from '../../shared/model/todo-later.ts';
import { loadPeople, personName } from './people.ts';
import { loadDay } from './day-store.ts';
import { selfIdentity } from './self-identity.ts';
import { SYSTEM_ID } from '../../shared/ids.ts';
import { chatSection } from '../../shared/text/chat-sections.ts';

export { route, isMobile };

export const conversations = signal<ConversationSummary[]>([]);
export const activeConversationId = computed<string | null>(() => (route.value.view === 'chat' ? route.value.id : null));
/** Per-conversation message lists (loaded on demand, newest last). */
export const messages = new Map<string, Signal<Message[]>>();
/** Conversations whose oldest message is loaded (no more "load older"). */
export const historyComplete = new Set<string>();
/**
 * Per chat: the oldest seq a loaded page held (C6). The loaded pages run without a gap from there
 * to the newest message, so a row at or above it never moves the paging cursor (list[0].seq) past
 * unloaded rows – the tombstone of a deleted oldest loaded message takes that message's place.
 */
const pageFloor = new Map<string, number>();
export const agents = signal<Agent[]>([]);
/** Archived agents, kept only so their old chats (the default 1:1 above all) show a name and a picture – never as someone to work with. */
export const archivedAgents = signal<Agent[]>([]);
export const tasks = signal<TaskView[]>([]);
export const todos = signal<TaskView[]>([]);
export const settings = signal<Settings | null>(null);
export const accounts = signal<Account[]>([]);
export const usage = signal<UsageSummary[]>([]);
export const activity = signal<AgentActivity[]>([]);
export const models = signal<ModelInfo[]>([]);
export const updateState = signal<UpdateState | null>(null);
export const systemInfo = signal<SystemInfo | null>(null);
export const drafts = signal<Record<string, string>>({});
export const secretDrafts = signal<Record<string, string[]>>({});
/** B-082: the saved files of each chat's draft (ui.state draftFiles) – a kept take comes back after a reload. */
export const draftFiles = signal<Record<string, Attachment[]>>({});
/** True once data is shown: a live load, or this device's saved copy (pwa/offline-cache.ts) before it. */
export const loaded = signal(false);
export const loadError = signal<string | null>(null);
/** When the shown data was saved, while it is this device's copy (pwa/offline-cache.ts); null once the PC answered. */
export const cachedAt = signal<number | null>(null);

export const agentMap = computed(() => new Map(agents.value.map((agent) => [agent.id, agent])));
/** agentMap plus the archived agents: for the name and picture of a member in a chat (not for choosing whom to work with). */
export const knownAgentMap = computed(() => new Map([...archivedAgents.value, ...agents.value].map((agent) => [agent.id, agent])));
export const conversationMap = computed(() => new Map(conversations.value.map((chat) => [chat.id, chat])));
/**
 * The For-you clock (F04): the time the Tasks page's "Later" split and "since …" words are read at. Moved by
 * store-events.ts when the to-dos change and at the next moment a row reads differently by time
 * alone (tasks/todo-time.ts nextListChange) – one timeout to that moment, never polling.
 */
export const todoClock = signal(Date.now());
/**
 * For-you badge (rail and phone tabs: Tasks): what needs the person now (shared/model/todo-later.ts needsYou), never "Later".
 */
export const forYouCount = computed(() => countNow(todos.value, todoClock.value));

// ------------------------------------------------------------------ helpers

export function upsertById<T extends { id: string }>(list: Signal<T[]>, item: T): void {
  const index = list.value.findIndex((entry) => entry.id === item.id);
  if (index === -1) list.value = [...list.value, item];
  else {
    const next = list.value.slice();
    next[index] = item;
    list.value = next;
  }
}

export function removeById<T extends { id: string }>(list: Signal<T[]>, id: string): void {
  if (list.value.some((entry) => entry.id === id)) list.value = list.value.filter((entry) => entry.id !== id);
}

export function messagesFor(conversationId: string): Signal<Message[]> {
  let list = messages.get(conversationId);
  if (!list) {
    list = signal<Message[]>([]);
    messages.set(conversationId, list);
  }
  return list;
}

/**
 * Inserts or replaces a message keeping seq order. D4/D5: a known message may come back with a new
 * seq (a run's answer moves to the end of the chat when it is finished): it is re-sorted, not kept in its old place.
 */
export function putMessage(message: Message): void {
  const list = messages.get(message.conversationId);
  if (!list) return; // not loaded – the chat loads a fresh page when opened
  const current = list.value;
  const index = current.findIndex((entry) => entry.id === message.id);
  if (index !== -1) {
    const next = current.slice();
    const moved = current[index].seq !== message.seq;
    next[index] = message;
    if (moved) next.sort((a, b) => a.seq - b.seq);
    list.value = next;
    return;
  }
  // C6: an unknown row below the loaded pages' floor (a tombstone or an edit of an unloaded message) waits for loadOlder – inserted now it would move the paging cursor (list[0].seq) past the rows between.
  const floor = pageFloor.get(message.conversationId) ?? current[0]?.seq;
  if (floor !== undefined && message.seq < floor && !historyComplete.has(message.conversationId)) return;
  const next = [...current, message];
  if (current.length && current[current.length - 1].seq > message.seq) next.sort((a, b) => a.seq - b.seq);
  list.value = next;
}

export function agentName(id: string): string {
  if (id === 'human') return selfIdentity(settings.value?.profile).name; // the caller, as the profile button names it
  if (id === SYSTEM_ID) return 'Autark'; // the app's own to-dos (a sign-out, B-047 D10) – not "Former member" (Stanislaus 23.11.2026)
  return knownAgentMap.value.get(id)?.name ?? personName(id) ?? 'Former member'; // F-52: people of the organisation (lib/people.ts)
}

// ------------------------------------------------------------------ loaders

const PAGE = 60;
/** How long a failed loadAll waits before it asks again on the same open socket (no Try now: the page asks by itself). */
const LOAD_RETRY_MS = 5_000;
let retryLoad: ReturnType<typeof setTimeout> | undefined;

const fetching = new Map<string, Promise<ConversationSummary | undefined>>();

/**
 * A chat by id – also one chats.list leaves out (agent-only rooms, the To-do chat). Unknown
 * ids are fetched once (chats.get, deduplicated) and kept in `conversations`, where events
 * keep them fresh like any other chat. Undefined when the chat does not exist (any more) or
 * may not be opened here; other failures (connection lost) reject, so callers can retry.
 */
export function ensureConversation(id: string): Promise<ConversationSummary | undefined> {
  const known = conversationMap.value.get(id);
  if (known) return Promise.resolve(known);
  let request = fetching.get(id);
  if (!request) {
    request = rpc.call('chats.get', { id })
      .then((chat) => { upsertById(conversations, chat); return chat; }, (error: unknown) => {
        if (error instanceof RpcError && (error.code === 'not_found' || error.code === 'forbidden' || error.code === 'bad_request')) return undefined;
        throw error;
      })
      .finally(() => { fetching.delete(id); });
    fetching.set(id, request);
  }
  return request;
}

/**
 * The fresh chat list plus the open chat when the list leaves it out (opened on demand), so a
 * reconnect does not unmount an open hidden chat. Its summary is refreshed in the background
 * and dropped when it no longer exists.
 */
function keepOpenChat(list: ConversationSummary[]): ConversationSummary[] {
  const open = activeConversationId.value;
  const held = open && !list.some((chat) => chat.id === open) ? conversationMap.value.get(open) : undefined;
  if (!held) return list;
  rpc.call('chats.get', { id: held.id }).then((chat) => upsertById(conversations, chat), (error: unknown) => {
    if (error instanceof RpcError && (error.code === 'not_found' || error.code === 'forbidden')) removeById(conversations, held.id);
  });
  return [...list, held];
}

/**
 * Puts a page of a chat's newest lines (asked with `limit`) into its held list without blanking it (owner 27.11.2026: a
 * chat opens with what is already here, the load fills in behind): the page stands for everything from its oldest seq
 * on; held lines older than that stay when the page joins them (its oldest seq at or below the held newest), so a view
 * scrolled into older pages keeps them. A page that does not join (more new lines than it holds) replaces the list. A
 * page shorter than `limit` reaches the chat's first line.
 */
export function takeNewest(conversationId: string, page: readonly Message[], limit: number): void {
  const sorted = page.slice().sort((a, b) => a.seq - b.seq);
  const list = messagesFor(conversationId);
  const held = list.peek();
  const first = sorted[0];
  const whole = page.length < limit;
  const joins = first !== undefined && held.length > 0 && first.seq <= held[held.length - 1].seq;
  const ids = new Set(sorted.map((message) => message.id));
  const kept = whole || !joins ? [] : held.filter((message) => message.seq < first.seq && !ids.has(message.id));
  list.value = kept.length ? [...kept, ...sorted] : sorted;
  if (whole) historyComplete.add(conversationId);
  else if (!kept.length) historyComplete.delete(conversationId);
  const floor = kept.length ? (pageFloor.get(conversationId) ?? kept[0].seq) : first?.seq;
  if (floor === undefined) pageFloor.delete(conversationId);
  else pageFloor.set(conversationId, floor);
}

export async function loadMessages(conversationId: string): Promise<void> {
  takeNewest(conversationId, await rpc.call('messages.list', { conversationId, limit: PAGE }), PAGE);
}

/** How many of a chat's newest lines a catch-up asks for. */
const NEWEST = 10;
const catching = new Set<string>();

/**
 * A chat of the list that has a line this page does not hold yet (its summary's lastSeq above the held newest – the
 * list's preview already shows it): its newest lines are asked for now, so the chat opens with that line at once
 * instead of after the open's load (owner 27.11.2026). Only chats of the main list (where the person reads and the
 * preview shows), one ask per chat at a time, never for the open chat (it hears its own lines on chat:<id>). Asked again
 * when the summary moved on meanwhile; a failed ask waits for the next open socket (loadAll).
 */
export function catchUp(chat: ConversationSummary): void {
  const id = chat.id;
  if (id === activeConversationId.peek() || chatSection(chat) !== 'main' || catching.has(id) || rpc.status.peek() !== 'open') return;
  const held = messages.get(id)?.peek() ?? [];
  if (!chat.lastSeq || chat.lastSeq <= (held[held.length - 1]?.seq ?? 0)) return;
  const asked = chat.lastSeq;
  catching.add(id);
  rpc.call('messages.list', { conversationId: id, limit: NEWEST })
    .then((page) => { if (id !== activeConversationId.peek()) takeNewest(id, page, NEWEST); }, () => undefined)
    .finally(() => {
      catching.delete(id);
      const now = conversationMap.peek().get(id);
      if (now && now.lastSeq > asked) catchUp(now);
    });
}

/** Loads one older page; returns how many messages were added. */
export async function loadOlder(conversationId: string): Promise<number> {
  if (historyComplete.has(conversationId)) return 0;
  const list = messagesFor(conversationId);
  const oldest = list.value[0];
  if (!oldest) return 0;
  const page = await rpc.call('messages.list', { conversationId, beforeSeq: oldest.seq, limit: PAGE });
  if (page.length < PAGE) historyComplete.add(conversationId);
  if (page.length) pageFloor.set(conversationId, Math.min(pageFloor.get(conversationId) ?? oldest.seq, ...page.map((message) => message.seq)));
  const known = new Set(list.value.map((message) => message.id));
  const fresh = page.filter((message) => !known.has(message.id)).sort((a, b) => a.seq - b.seq);
  if (fresh.length) list.value = [...fresh, ...list.value];
  return fresh.length;
}

export async function loadModels(refresh = false): Promise<ModelInfo[]> {
  const list = await rpc.call('models.list', refresh ? { refresh: true } : undefined);
  models.value = list;
  return list;
}

/**
 * Loads every snapshot the shell needs (lib/load.ts) and applies them in one batch. Called on
 * first connect and after reconnects. First asks session.info what this connection may call
 * (lib/session.ts); snapshots it may not read are not asked for (optional ones: only when
 * can(); scoped ones: skipped when the session says no, tried while it is unknown). A refused
 * snapshot never sets loadError or blocks `loaded` – it is empty. A failed load (session.info too) keeps every signal
 * as it was (D2, 19.11.2026: the shown data and the session stay) and records loadError. After the batch, without
 * waiting: the calendar window, the open chat's messages, the held chats' catch-up (catchUp), system.info and – where this
 * connection may – the model catalog. A failed load asks again after LOAD_RETRY_MS while the socket stays open.
 */
export async function loadAll(): Promise<void> {
  clearTimeout(retryLoad);
  retryLoad = undefined;
  try {
    await loadSession(rpc.call);
    void loadPeople(); // F-52: people of the organisation (only when this connection may read them)
    const snapshot = await loadSnapshots({ call: rpc.call, optional: can, scoped: (method) => session.peek() === null || can(method) });
    // Drafts: what this page holds wins (unsaved edits) – but not the device's old copy (pwa/offline-cache.ts): the PC's are newer.
    const fromCopy = cachedAt.peek() !== null;
    const merge = <T>(pc: Record<string, T> | undefined, here: Record<string, T>): Record<string, T> => (fromCopy ? { ...here, ...pc } : { ...pc, ...here });
    batch(() => {
      settings.value = snapshot.settings;
      conversations.value = keepOpenChat(snapshot.chats);
      agents.value = snapshot.agents;
      archivedAgents.value = snapshot.archivedAgents;
      activity.value = snapshot.activity;
      todos.value = snapshot.todos;
      tasks.value = snapshot.tasks;
      if (snapshot.accounts) accounts.value = snapshot.accounts;
      if (snapshot.usage) usage.value = snapshot.usage;
      drafts.value = merge(snapshot.drafts, drafts.value);
      secretDrafts.value = merge(snapshot.secretDrafts, secretDrafts.value);
      draftFiles.value = merge(snapshot.draftFiles, draftFiles.value);
      loadError.value = null;
      loaded.value = true;
      cachedAt.value = null;
    });
    // The Tasks page's calendar window (lib/day-store.ts; only what this connection may read).
    void loadDay(undefined, { tz: snapshot.settings.profile?.timezone });
    // Refresh the open chat (events may have been missed while disconnected) and catch up the chats this page holds lines of.
    const open = activeConversationId.value;
    if (open && messages.has(open)) void loadMessages(open).catch(() => undefined);
    for (const chat of conversations.peek()) if (messages.has(chat.id)) catchUp(chat);
    void rpc.call('system.info').then((info) => { systemInfo.value = info; }).catch(() => undefined);
    // The model catalog every picker and model name reads (models.updated keeps it fresh between connects).
    if (can('models.list')) void loadModels().catch(() => undefined);
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : 'Could not load data.';
    // the page asks again by itself while the socket stays open (owner 27.11.2026: no Try now); a new socket loads anyway
    if (rpc.status.peek() === 'open') retryLoad = setTimeout(() => { retryLoad = undefined; if (rpc.status.peek() === 'open') void loadAll(); }, LOAD_RETRY_MS);
  }
}

// ------------------------------------------------------------------ settings helpers

/** Optimistic settings change (local first, then persisted; reverts on error). */
export async function updateSettings(patch: SettingsPatch): Promise<void> {
  const before = settings.value;
  if (before) {
    const next = { ...before } as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      next[key] = { ...(before as unknown as Record<string, object>)[key], ...(value as object) };
    }
    settings.value = next as unknown as Settings;
  }
  try {
    settings.value = await rpc.call('settings.update', patch);
  } catch (error) {
    settings.value = before;
    throw error;
  }
}

export function updatePreferences(patch: Partial<Preferences>): Promise<void> {
  return updateSettings({ preferences: patch });
}

export const preferences = computed<Preferences>(() => settings.value?.preferences ?? {
  theme: 'system', sidebarOpen: true, sidebarWidth: 288,
  workspaceOpen: false, workspaceWidth: 360, enterSends: true, openAtLogin: false, autoDownloadUpdates: false, keepPcAwake: true, navOrder: [],
});
