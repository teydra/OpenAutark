// The phone's side pane is its PC's (B-076, owner 05.11.2026: "Mach das es bitte auch am Handy gut funktioniert"): the
// PWA reads the PC's spaces (tabs.get) and follows each change (event tabs.changed) – the PC's websites are 'remote'
// tabs of that PC (their live picture: RemoteWebTab.tsx), its files show their content – and what the person changes
// here (open, close, reorder, choose) goes back (tabs.set): each space that differs from the PC's, and the remote tabs
// no space here lists any more, so a tab the PC opened meanwhile stays. A blank tab stays on the phone and leaves the
// PC's shown tab as it is; a blank tab shown on the PC (its space names no shown tab) leaves the phone's as it is, and
// that one never goes back to pull the PC's away. While the connection is down nothing goes: the read on reconnect
// brings the PC's spaces as they are now, so a stale whole space never replaces newer tabs. Nothing of it is kept on
// the phone. 16.11.2026: a page that has to run on the PC – a sign-in whose answer returns to the PC's own address (Google
// Calendar, an app's OAuth) – opens in the PC's pane (side.open, shown there at once) and this phone's pane sheet opens on it
// (openInPcPane), so the person finishes it from the phone. A page the runtime itself already opened there for the phone (a
// plan sign-in, accounts.* – rpc/handlers/providers.ts openOnPc) only opens the sheet (showOpenedOnPc), never a second tab.
// 18.11.2026: a person's device (a colleague, scope 'person') reads the same way only the websites shared in the areas of
// its chats (people/rpc-pane.ts) – 21.11.2026 also an agent's own browser it put there; they come into its own spaces
// (withShared, always as the PC has them now) and nothing goes back.
// Owns: that link. Never: tab logic (pages.ts) or a tab's picture.

import '../../shared/api/methods-tabs.ts';
import '../../shared/model/side-view.ts'; // side.open
import type { PaneTabs } from '../../shared/api/methods-tabs.ts';
import type { SideSpace, SideSpaces } from '../../shared/api/workspace-browser.ts';
import { bridge } from '../lib/platform.ts';
import { rpc } from '../lib/rpc.ts';
import { can, isOwner, session } from '../lib/session.ts';
import { toastError } from '../lib/toasts.ts';
import { fromSideSpace, restoredTabId, toSideSpace } from './browser-model.ts';
import { acceptLayout, linkPhone, ownLayout, pagesListed, shownOf } from './pages.ts';
import { phonePaneOpen } from './phone-pane.ts';

/** This pane shows its PC's side pane: no browser of its own here, and the session reads the PC's. */
export function phonePane(): boolean {
  return !bridge?.workspaceBrowser && can('tabs.get');
}

/** A page that runs on the PC opens in the PC's pane from here (the phone): true when side.open may be called. */
export function opensInPcPane(): boolean {
  return phonePane() && can('side.open');
}

/** Opens `url` in a new tab of the PC's pane, shown there, and opens this phone's pane sheet on it; a failure is a toast. */
export async function openInPcPane(url: string): Promise<void> {
  try {
    await rpc.call('side.open', { url });
    phonePaneOpen.value = true;
  } catch (error) { toastError(error, 'The PC could not open that page'); }
}

/**
 * A page the runtime already opened in the PC's pane for this phone (a device's sign-in, providers.ts openOnPc): this
 * phone's sheet opens on it – true; false in the owner's window or without the PC's pane here (the caller opens the page).
 */
export function showOpenedOnPc(): boolean {
  if (isOwner() || !phonePane()) return false;
  phonePaneOpen.value = true;
  return true;
}

/** A space as this pane would send it back (what it shows of it, in its order). */
function normal(space: SideSpace | undefined): SideSpace {
  if (!space) return { tabs: [] };
  const tabs = fromSideSpace(space);
  return toSideSpace(tabs, restoredTabId(tabs, space.shown ?? ''));
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What goes to the PC after `next` (this pane's spaces): each space that differs from `known` (the PC's), and the remote tabs closed here. */
export function phoneChanges(known: SideSpaces, next: SideSpaces): { spaces: SideSpaces; closed: string[] } | undefined {
  const spaces: SideSpaces = {};
  for (const key of new Set([...Object.keys(known), ...Object.keys(next)])) {
    const before = normal(known[key]);
    let mine = next[key] ?? { tabs: [] };
    // a blank tab shown here leaves the PC's choice as it is
    if (mine.shown === undefined && before.shown !== undefined && mine.tabs.some((tab) => tab.id === before.shown)) mine = { shown: before.shown, tabs: mine.tabs };
    if (!same(before, normal(mine))) spaces[key] = mine;
  }
  if (!Object.keys(spaces).length) return undefined;
  const listed = new Set(Object.values(next).flatMap((space) => space.tabs.map((tab) => tab.id)));
  const closed = Object.values(known).flatMap((space) => space.tabs).filter((tab) => tab.panel === 'remote' && !listed.has(tab.id)).map((tab) => tab.id);
  return { spaces, closed: [...new Set(closed)] };
}

/** `own` (this device's spaces) with the shared websites of `shared` in place of those `own` had: the rest stays this device's – pure. */
export function withShared(own: SideSpaces, shared: SideSpaces): SideSpaces {
  const next: SideSpaces = {};
  for (const key of new Set([...Object.keys(own), ...Object.keys(shared)])) {
    const tabs = [...(shared[key]?.tabs ?? []), ...(own[key]?.tabs ?? []).filter((tab) => tab.panel !== 'remote' && tab.panel !== 'agent')];
    const shown = own[key]?.shown ?? shared[key]?.shown;
    if (tabs.length) next[key] = { ...(shown !== undefined && tabs.some((tab) => tab.id === shown) ? { shown } : {}), tabs };
  }
  return next;
}

let started = false;

/** Keeps this pane in step with its PC (idempotent; the phone only). */
export function watchPhoneTabs(): void {
  if (started || !phonePane()) return;
  started = true;
  let known: SideSpaces | undefined;
  const send = (layout: SideSpaces) => {
    const change = known && phoneChanges(known, layout);
    if (!change) return;
    known = { ...known, ...change.spaces }; // what the PC holds once it took it (its tabs.changed follows)
    rpc.call('tabs.set', change).catch((error: unknown) => toastError(error, 'The PC did not take that tab change'));
  };
  const take = (pane: PaneTabs) => {
    if (session.peek()?.kind === 'person') { acceptLayout(withShared(ownLayout(), pane.spaces)); pagesListed.value = true; return; }
    // first: taking them over below sends nothing back – where the PC shows a blank tab, the tab shown here stays
    // (acceptLayout) and counts as the PC's
    known = Object.fromEntries(Object.entries(pane.spaces).map(([key, space]) => [key, space.shown === undefined && shownOf(key) ? { ...space, shown: shownOf(key) } : space]));
    linkPhone({ device: pane.device, send });
    acceptLayout(pane.spaces);
    pagesListed.value = true;
  };
  const read = () => { rpc.call('tabs.get').then(take, () => undefined); };
  rpc.status.subscribe((status) => { if (status !== 'open') known = undefined; }); // nothing goes until the next read
  rpc.on('tabs.changed', take);
  rpc.onOpen(read);
  read();
}
