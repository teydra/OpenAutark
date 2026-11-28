// Phone layout (PWA, narrow windows): the same frame as a stack – one top row, the status line
// over the body's top, the body, the bottom tabs – all from shell/views.ts phoneView. Tabs in the rail's
// order (the person's, rail-order.ts navOrder; by default Tasks – also the 'home' route, with the For-you badge – · Chats · Team); a chat, an agent or a person
// is pushed on top (Back, no tab bar) – and a to-do's or quest's detail on the Tasks page, which takes the
// list's place (its Close leads back), and Settings (the list and a section,
// Back in the frame's row) have no tab bar either: every screen with Back looks the same (C3 D-3). The top
// row (lib/header.tsx, zone 'phone', class mobile-top) is drawn by the frame unless the body draws
// its own with Back as its lead (a chat, an agent or a person – views.ts ownHeader):
// Back where the settings list goes Home and a settings section to all settings, the title, and
// fixed cells – on tab roots the compact update item (UpdateButton; only with the desktop bridge), search
// and the profile, which ends the row at the caption controls as the desktop header's last cell does. Search
// is the body's own in-place search where the body is a nav that has one (Chats, Tasks, the settings list),
// else the command palette. Every cell keeps its box while its control shows nothing, so nothing moves –
// but the update item's, which takes no room while empty: it is the first cell, so when an update comes
// only the title track gets shorter (search and the profile stay where they are).
// The global space's tabs (the desktop's pane; none fits beside a phone screen) are one pushed full-screen sheet over
// the stack (PhonePane, workspace/phone-pane.ts): its own row with Back, the tabs, no tab bar. A way in that lands in
// global opens it (Watch on a to-do, say); so does the row's Browser cell – in the desktop app's narrow window, where
// websites live, and on the phone, whose pane is its PC's (B-076, workspace/phone-tabs.ts) – the frame's cell of the
// wide window (its dot: an agent's new tab waits there). Back or any navigation closes it.
// The status line (StatusLine.tsx) takes its own place between the top row and the body (it pushes the body down, covers nothing). The three destination tabs are always there
// (19.11.2026, D2: a failed reconnect filtered them down to Team and every tab moved); a tab whose list this connection
// may not read shows its empty body.
// B-055 Q4: the feedback cell (feedback/cell.tsx: tap opens the feedback sheet, hold talks where this page can dictate)
// sits before the profile on every top row – a placeholder of the same box where this connection may not file feedback,
// so the profile never moves; the bodies that draw their own row end it with the same cell (feedback 16.11.2026).
// B-078: in a chat a sideways swipe switches between its messages and its area (workspace/phone-swipe.ts, on the main
// element) – F30: towards the right on a message, with the area closed, it replies to that message; Back goes layer by
// layer (pwa/back.ts). B-084: on a phone a pull down on a tab root refreshes (pwa/pull-refresh.ts).
// Owns: the phone frame, its top row, the tab bar and the global sheet. Never: view content or which view a route shows.

import { useEffect, useRef } from 'preact/hooks';
import { GLOBAL_SPACE } from '../../shared/api/workspace-browser.ts';
import { Icon } from '../lib/ui.tsx';
import type { IconName } from '../lib/ui.tsx';
import { Header, backCell, searchCell } from '../lib/header.tsx';
import type { HeaderCell } from '../lib/header.tsx';
import { forYouCount, messagesFor, route } from '../lib/store.ts';
import { navigate } from '../lib/router.ts';
import type { Route } from '../lib/router.ts';
import { platform } from '../lib/platform.ts';
import { DESTINATIONS } from '../lib/vocab.ts';
import { paletteOpen } from '../lib/shell-state.ts';
import { feedbackCell } from '../feedback/cell.tsx';
import { workspaceAttention } from '../workspace/attention.ts';
import { phonePaneOpen } from '../workspace/phone-pane.ts';
import { chatSwipe, watchChatSwipe } from '../workspace/phone-swipe.ts';
import { reply } from '../chat/message-tools.ts';
import { buzz } from '../lib/context-menu.tsx';
import { watchPullRefresh } from '../pwa/pull-refresh.ts';
import { refresh, rpc } from '../lib/rpc.ts';
import { isChatAreaOpen, setChatArea } from '../lib/shell-state.ts';
import { phonePane } from '../workspace/phone-tabs.ts';
import { WorkspacePane } from '../workspace/WorkspacePane.tsx';
import { ProfileButton } from './ProfileMenu.tsx';
import { UpdateButton } from './UpdateButton.tsx';
import { StatusLine } from './StatusLine.tsx';
import { phoneView } from './views.ts';
import type { RailKey } from './nav-order.ts';
import { navOrder } from './rail-order.ts';
import type { PhoneView } from './views.ts';

interface Tab { key: RailKey; icon: IconName; route: Route; match: (r: Route) => boolean }

const TABS: Readonly<Record<RailKey, Tab>> = {
  tasks: { key: 'tasks', icon: 'list-checks', route: { view: 'tasks' }, match: (r) => r.view === 'tasks' || r.view === 'home' },
  chats: { key: 'chats', icon: 'chat-circle', route: { view: 'chats' }, match: (r) => r.view === 'chats' || r.view === 'chat' },
  team: { key: 'team', icon: 'users-three', route: { view: 'team' }, match: (r) => r.view === 'team' },
};

const UPDATE: HeaderCell = { id: 'update', slot: <UpdateButton compact /> };
const PROFILE: HeaderCell = { id: 'profile', slot: <ProfileButton size={30} placement="bottom-end" /> };
const PALETTE: HeaderCell = { id: 'search', icon: 'magnifying-glass', label: 'Search', onClick: () => { paletteOpen.value = true; } };

/** The Browser cell (the desktop app, and the phone showing its PC's pane): the global tabs as the pushed sheet (a dot while an agent's new tab waits there). */
function browserCell(): HeaderCell {
  return {
    id: 'browser', icon: 'browsers', label: 'Browser', badge: workspaceAttention.value ? 'dot' : undefined,
    onClick: () => { workspaceAttention.value = false; phonePaneOpen.value = true; },
  };
}

/** The frame's top row of a phone screen (the body's own row replaces it where views.ts says so). */
function TopRow(props: { view: PhoneView }) {
  const { view } = props;
  const nav = view.header?.();
  const lead = view.back === 'home' ? backCell(() => navigate({ view: 'home' }))
    : view.back === 'settings' ? { ...backCell(() => navigate({ view: 'settings' })), label: 'All settings' } : undefined;
  // the update slot first: it takes no room while empty (mobile.css), and when an update arrives it opens left of
  // the magnifier – search and the profile keep their place at the caption controls, the title only gets shorter
  const desktop = platform === 'desktop';
  const cells = [...(desktop ? [UPDATE] : []), nav?.search ? searchCell(nav.search) : PALETTE, ...(desktop || phonePane() ? [browserCell()] : []), feedbackCell(), PROFILE]; // pushed screens draw their own row (views.ts)
  return <Header zone="phone" class="mobile-top" lead={lead} title={view.title} search={nav?.search} cells={cells} />;
}

/** A sideways swipe in a chat (workspace/phone-swipe.ts): F30 towards the right on a message, the area closed, replies to it with
 *  a tick; otherwise the area or the messages. */
function swiped(chatId: string, to: 'area' | 'messages', messageId?: string): void {
  const message = messageId ? messagesFor(chatId).peek().find((entry) => entry.id === messageId) : undefined;
  if (message && chatSwipe(to, message.id, isChatAreaOpen(chatId)) === 'reply' && reply(message)) { buzz(); return; }
  setChatArea(chatId, to === 'area');
}

/** The global space's surface: a pushed screen over the stack, under the status line (mobile.css). */
function PhonePane() {
  return (
    <section class="phone-pane" aria-label="Workspace" id="workspace">
      <Header zone="phone" lead={{ ...backCell(() => { phonePaneOpen.value = false; }), label: 'Close browser' }} title="Browser" />
      <WorkspacePane space={GLOBAL_SPACE} />
    </section>
  );
}

export function MobileShell() {
  const current = route.value;
  const view = phoneView(current);
  useEffect(() => () => { phonePaneOpen.value = false; }, [current]); // any navigation (a line's Open too) shows its screen
  const main = useRef<HTMLElement>(null);
  useEffect(() => (main.current ? watchChatSwipe(main.current, () => { const r = route.peek(); return r.view === 'chat' ? r.id : undefined; }, swiped) : undefined), []);
  useEffect(() => (main.current && platform !== 'desktop' ? watchPullRefresh(main.current, refresh, rpc.onOpen) : undefined), []); // phones only (pwa/pull-refresh.ts)
  // every screen with Back is pushed and has no tab bar: a task's detail (a detail page like the others) and the
  // frame's rows with Back – the settings list (Back to Home) and a settings section (Back to all settings)
  const pushed = view.pushed || view.back !== null || (current.view === 'tasks' && !!current.task);
  const badge = forYouCount.value;
  const tabs = navOrder.value.map((key) => TABS[key]);
  return (
    <div class={`mobile-shell${pushed ? ' pushed' : ''}${view.ownHeader ? ' own-header' : ''}`}>
      {!view.ownHeader && <TopRow key={view.key} view={view} />}
      <StatusLine />
      <main class="mobile-main" id="main" ref={main}>
        {view.body}
      </main>
      {!pushed && (
        <nav class="tab-bar" aria-label="Main" style={{ '--tabs': String(tabs.length) }}>
          {tabs.map((tab) => {
            const active = tab.match(current);
            return (
              <button type="button" key={tab.key} class={`tab${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => navigate(tab.route)}>
                <span class="tab-icon">
                  <Icon name={tab.icon} size={22} />
                  {tab.key === 'tasks' && badge > 0 && <span class="tab-badge tabular">{badge > 99 ? '99+' : badge}</span>}
                </span>
                <span class="tab-label">{DESTINATIONS[tab.key]}</span>
              </button>
            );
          })}
        </nav>
      )}
      {phonePaneOpen.value && <PhonePane />}
    </div>
  );
}
