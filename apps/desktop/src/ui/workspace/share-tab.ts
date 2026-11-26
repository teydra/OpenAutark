// A tab handed on (owner 18.11.2026: "from one device you decide that it opens on another device"; 21.11.2026: "drei
// Punkte … auf welchem PC vom User … mit anderen Mitgliedern teilen"). A tab runs on one PC – its origin – and shows in
// the panes of the people it is given to (shared/model/pane.ts). The three-dots menu (PaneMenu.tsx) offers, for every
// kind of tab, "Open on": the PCs of each person (mine first, "My PCs"; pane-targets.ts), the one the tab runs on ticked,
// an offline one still choosable – pane.open puts the tab there (a website then runs there). A file, folder or media tab
// on one of my own PCs keeps what it did before: the same path of that PC in the tab's place (file-tabs.ts openPathOn).
// "Share with" (a tab with a share key: a website, an agent's browser, a path): the other people, ticked the ones it is
// shared with now (asked from where it runs when the row opens – readShares – and pane.share's answers, kept here), Everyone, Stop sharing. "Share in chat" opens a
// website as a tab of a chat's area (chat:<id>), which everyone in that chat sees.
// Owns: these sections, the tab's entry they send and what they do. Never: which tabs exist (pages.ts), who reaches a
// shared tab (the runtime) or the list of people and PCs (pane-targets.ts).

import { signal } from '@preact/signals';
import { chatSpace, type SideEntry } from '../../shared/api/workspace-browser.ts';
import type { ConversationSummary } from '../../shared/model/chat.ts';
import { shareKey, type PanePc, type PanePerson } from '../../shared/model/pane.ts';
import { chatTitle } from '../lib/chat-naming.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { setChatArea } from '../lib/shell-state.ts';
import { pushToast, toastError } from '../lib/toasts.ts';
import type { MenuSection } from '../lib/ui.tsx';
import { isThread } from '../chat/threads.ts';
import { isAppTab, type TabEntry } from './browser-model.ts';
import { openPathOn } from './file-tabs.ts';
import { openCopy } from './pages.ts';

/** The chats "Share in chat" offers: the latest ones in the person's list. */
export const SHARE_CHATS = 6;

/** The people each tab is shared with, by tab id: pane.share's last answer (best effort – another PC may change it). */
export const sharesOf = signal<Record<string, string[]>>({});

/** A tab as side-tabs.json holds it, with a website's current address: what pane.open and pane.share send. A blank tab: none. */
export function paneEntry(tab: TabEntry | undefined, url?: string): SideEntry | undefined {
  if (!tab || tab.kind === 'new') return undefined;
  if (!isAppTab(tab)) return { id: tab.id, ...(url ? { url } : {}) };
  const { kind, ...rest } = tab;
  return { ...rest, panel: kind };
}

/** The PC a tab runs on, when it is one of the pane's: a website here, another PC's website, a path where it lies. */
export function originOf(entry: SideEntry, self: string | undefined): string | undefined {
  if (entry.panel === undefined) return self;
  if (entry.panel === 'remote') return entry.device;
  if ((entry.panel === 'file' || entry.panel === 'folder' || entry.panel === 'media') && typeof entry.path === 'string') return entry.device ?? self;
  return undefined;
}

const isPathEntry = (entry: SideEntry): entry is SideEntry & { panel: 'file' | 'folder' | 'media'; path: string } =>
  (entry.panel === 'file' || entry.panel === 'folder' || entry.panel === 'media') && typeof entry.path === 'string';

/** Puts `entry` on PC `pc` of `person` (pane.open) – on one of my own PCs a path tab shows that PC's path in its place. */
export async function openOn(entry: SideEntry, person: PanePerson, pc: PanePc, space: string): Promise<void> {
  if (person.me && isPathEntry(entry)) {
    openPathOn({ id: entry.id, kind: entry.panel, path: entry.path, ...(typeof entry.name === 'string' ? { name: entry.name } : {}) }, pc.self ? undefined : pc.id, space);
    return;
  }
  try {
    await rpc.call('pane.open', { person: person.id, pc: pc.id, entry });
    pushToast({ title: `Opened on ${pc.name}`, tone: 'info' }, 2000);
  } catch (error) { toastError(error, `${pc.name} could not open that tab`); }
}

/** "Open on": per person with a PC (mine first, as "My PCs"), each PC by name; the tab's own PC ticked, an offline one marked. */
export function openOnSections(entry: SideEntry | undefined, targets: readonly PanePerson[], space: string): MenuSection[] {
  if (!entry || !can('pane.open')) return [];
  const self = targets.find((person) => person.me)?.pcs.find((pc) => pc.self)?.id;
  const on = originOf(entry, self);
  const sections = targets.filter((person) => person.pcs.length).map((person) => ({
    title: person.me ? 'My PCs' : person.name,
    items: person.pcs.map((pc) => ({
      label: pc.name,
      hint: pc.self ? 'This PC' : pc.online ? undefined : 'Offline',
      checked: pc.id === on,
      onSelect: () => { if (pc.id !== on) void openOn(entry, person, pc, space); },
    })),
  }));
  return sections.some((section) => section.items.some((item) => !item.checked)) ? sections : [];
}

/** Who has the tab now, asked from where it runs (another window or an agent may have changed it): for the ticks. */
export async function readShares(entry: SideEntry | undefined): Promise<void> {
  if (!entry || !shareKey(entry) || !can('pane.share')) return;
  try {
    const answer = await rpc.call('pane.share', { entry });
    sharesOf.value = { ...sharesOf.peek(), [entry.id]: answer.people };
  } catch { /* the ticks stay as they were */ }
}

/** Adds or removes people, or sets the whole set ([]: with nobody any more), and keeps the answer for the ticks. */
export async function shareWith(entry: SideEntry, change: { add?: string[]; remove?: string[]; people?: string[] }, names: readonly PanePerson[]): Promise<void> {
  try {
    const answer = await rpc.call('pane.share', { entry, ...change });
    sharesOf.value = { ...sharesOf.peek(), [entry.id]: answer.people };
    const named = answer.people.map((id) => names.find((person) => person.id === id)?.name ?? id);
    pushToast({ title: named.length ? `Shared with ${named.join(', ')}` : 'Stopped sharing', tone: 'info' }, 2000);
  } catch (error) { toastError(error, 'Could not share that tab'); }
}

/** "Share with": the other people (ticked: shared with now), Everyone, Stop sharing – for a tab with a share key. */
export function shareWithSection(entry: SideEntry | undefined, targets: readonly PanePerson[], shared: readonly string[] = entry ? sharesOf.value[entry.id] ?? [] : []): MenuSection[] {
  const others = targets.filter((person) => !person.me);
  if (!entry || !shareKey(entry) || !others.length || !can('pane.share')) return [];
  const all = others.map((person) => person.id);
  const toggled = (id: string) => (shared.includes(id) ? { remove: [id] } : { add: [id] }); // a change, never a stale whole set
  return [{ items: [
    ...others.map((person) => ({ label: person.name, checked: shared.includes(person.id), onSelect: () => void shareWith(entry, toggled(person.id), targets) })),
    { label: 'Everyone', checked: all.every((id) => shared.includes(id)), onSelect: () => void shareWith(entry, { add: all }, targets) },
  ] }, { items: [
    { label: 'Stop sharing', disabled: !shared.length, onSelect: () => void shareWith(entry, { people: [] }, targets) },
  ] }];
}

/** Opens `url` as a tab of chat `chat`'s area and opens that area. */
export async function shareInChat(url: string, chat: ConversationSummary): Promise<void> {
  try {
    await openCopy(url, chatSpace(chat.id));
    setChatArea(chat.id, true);
    pushToast({ title: `Shared in ${chatTitle(chat)}`, tone: 'info' }, 2000);
  } catch (error) { toastError(error, 'Could not share that page'); }
}

/** The chats a page can be shared in, newest first: listed ones (no app-owned or hidden chat, no thread), not `except`'s. */
export function shareChats(chats: readonly ConversationSummary[], except?: string): ConversationSummary[] {
  return chats.filter((chat) => chat.id !== except && chat.archivedAt === undefined && !chat.settings.system && !chat.settings.hiddenFromList && !isThread(chat))
    .sort((a, b) => (b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt)).slice(0, SHARE_CHATS);
}

/** One Share in chat menu, with distinct choices for a message draft and a tab in another chat. */
export function chatSections(url: string, space: string, chats: readonly ConversationSummary[], addToMessage?: () => void): MenuSection[] {
  if (!url) return [];
  const targets = shareChats(chats, space.startsWith('chat:') ? space.slice(5) : undefined);
  return [
    ...(addToMessage ? [{ items: [{ label: 'Add page to message', onSelect: addToMessage }] }] : []),
    ...(targets.length ? [{ title: 'Open as a tab in', items: targets.map((chat) => ({ label: chatTitle(chat), onSelect: () => void shareInChat(url, chat) })) }] : []),
  ];
}
