// Left rail: global destinations in the order of the phone tabs (by default Tasks – the one task page, also the 'home'
// route, with the For-you badge – · Chats · Team; feedback 20031F6D: the person arranges them by drag, Alt+Arrow or the
// right-click menu, rail-order.ts) and, from the bottom up, Profile → weekly quotas → Update (only when relevant).
// Owns: rail layout and destination highlighting. Never: sidebar content or the order rule (nav-order.ts, rail-order.ts).

import { IconButton } from '../lib/ui.tsx';
import type { IconName } from '../lib/ui.tsx';
import { forYouCount, preferences, route } from '../lib/store.ts';
import { navigate } from '../lib/router.ts';
import type { RouteView } from '../lib/router.ts';
import { useContextMenu } from '../lib/context-menu.tsx';
import { DESTINATIONS } from '../lib/vocab.ts';
import { openChats } from './navigation.ts';
import type { RailKey } from './nav-order.ts';
import { dropSide, isDragged, navDrag, navMenu, navOrder, onNavKey } from './rail-order.ts';
import { UpdateButton } from './UpdateButton.tsx';
import { QuotaRail } from './QuotaRail.tsx';
import { ProfileButton } from './ProfileMenu.tsx';
import { desktopBubble } from './DesktopBubbleHandle.tsx';
import { SidebarToggle } from './WindowBar.tsx';

interface Destination {
  icon: IconName;
  views: RouteView[];
  open: () => void;
}

const destinations: Readonly<Record<RailKey, Destination>> = {
  tasks: { icon: 'list-checks', views: ['home', 'tasks'], open: () => navigate({ view: 'tasks' }) },
  chats: { icon: 'chat-circle', views: ['chats', 'chat'], open: openChats },
  team: { icon: 'users-three', views: ['team'], open: () => navigate({ view: 'team' }) },
};

/** One destination: its button, the Tasks badge, the drag and the right-click menu (rail-order.ts). */
function RailItem(props: { id: RailKey }) {
  const { id } = props;
  const destination = destinations[id];
  const current = destination.views.includes(route.value.view);
  const badge = id === 'tasks' ? forYouCount.value : 0;
  const menu = useContextMenu(() => navMenu(id));
  const side = dropSide(id);
  return (
    <div class={`rail-item${side ? ` drop-${side}` : ''}${isDragged(id) ? ' dragging' : ''}`} data-nav={id} {...menu} {...navDrag(id)}>
      <IconButton
        icon={destination.icon}
        label={DESTINATIONS[id]}
        pressed={current}
        aria-current={current ? 'page' : undefined}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        onClick={destination.open}
        onKeyDown={(event) => onNavKey(id, event)}
      />
      {badge > 0 && <span class="rail-badge tabular" aria-label={`${badge} in ${DESTINATIONS.tasks}`}>{badge > 99 ? '99+' : badge}</span>}
    </div>
  );
}

export function Rail() {
  return (
    <nav class="rail" aria-label="Main">
      <div class="rail-header">{(!desktopBubble.value.available || !preferences.value.sidebarOpen) && <SidebarToggle />}</div>
      <div class="rail-top">
        {navOrder.value.map((id) => <RailItem key={id} id={id} />)}
      </div>
      <div class="rail-bottom">
        <UpdateButton />
        <QuotaRail />
        <ProfileButton />
      </div>
    </nav>
  );
}
