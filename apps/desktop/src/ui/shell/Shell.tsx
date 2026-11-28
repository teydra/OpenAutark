// The one persistent frame (the frame draws the surfaces and header rows, views hand over content and cell
// data – shell/views.ts). Desktop zones, left to right:
//   rail | side (Sidebar: header row + scrolling body, resizable) | main
// and the person's own workspace pane (the global space, resizable) below the header row at the right, in the room the
// main zone keeps free for it: the main zone's header row runs on over the pane, so opening or closing it moves no header
// cell. Its tab strip is the row's part above it (`strip-in-row`) only where the row leaves it room for three titled tabs
// after the caption controls and the frame's cells (measured on .pane-row-room, shell.css; strip-slots.ts ROW_ROOM), else
// its first line under the row: a drag of the pane or the window may move the strip, a click never does. B-080: in a
// narrow window the pane yields its width: the chat keeps 340 px, the list 200 px; full view gives a page the whole zone.
// Each zone's header row is the top --header-h of the zone; its body scrolls below it. The main zone
// is `rightmost` (shell.css turns that into --caption-space: the caption controls plus the frame's workspace
// and feedback cells, WindowBar.tsx). The status line (StatusLine.tsx) lies over the top of the main zone.
// In full view (workspace/full-view.ts) the pane lies over the main zone's body. A chat's own tabs are its area
// in the chat column (chat/ChatArea.tsx), not here.
// Plus the global overlays (palette, new chat, feedback, confirm, Mark a region). The phone layout
// (MobileShell) is the same frame as a stack; the global tabs are a pushed sheet there instead of the pane. 19.11.2026 (D1):
// the frame shows from the first paint, also before data and with the PC away – views show their empty states, the
// status line says why (connection-line.ts).
// Owns: layout composition, the caption assignment and global hotkeys. Never: view content.

import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { GLOBAL_SPACE } from '../../shared/api/workspace-browser.ts';
import { isMobile, loadError, loaded, preferences, route, updatePreferences } from '../lib/store.ts';
import { rpc } from '../lib/rpc.ts';
import { watchConnection } from './connection-line.ts';
import { bridge, os, platform } from '../lib/platform.ts';
import { pushToast, toasts } from '../lib/toasts.ts';
import { restoreTextSizes, setSize, TEXT, textPx, zoomKey } from '../lib/text-size.ts';
import { hotkey } from '../lib/hotkeys.ts';
import { toggleSettings } from '../lib/router.ts';
import { ConfirmHost } from '../lib/dialog.tsx';
import { RememberWhyHost } from '../chat/RememberWhy.tsx';
import { newChatOpen, paletteOpen } from '../lib/shell-state.ts';
import { canStartChat } from './gates.ts';
import { FeedbackCell, toggleSidebar, WorkspaceCell } from './WindowBar.tsx';
import { Rail } from './Rail.tsx';
import { Sidebar, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from './Sidebar.tsx';
import { desktopViews, ZoneHeader } from './views.ts';
import { StatusLine, registerShellNotices } from './StatusLine.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import { MobileShell } from './MobileShell.tsx';
import { NewChatDialog } from '../chat/NewChatDialog.tsx';
import { WorkspacePane } from '../workspace/WorkspacePane.tsx';
import { watchWorkspaceAttention } from '../workspace/attention.ts'; // B-044: the cells' dots, browser.show, where ways in land
import { fullView } from '../workspace/full-view.ts';
import { ROW_ROOM } from '../workspace/strip-slots.ts';
import { RegionDialog } from '../workspace/RegionDialog.tsx'; // once for both surfaces (its ask is one signal)
import { FeedbackMenu } from '../feedback/FeedbackMenu.tsx'; // B-055 Q4: the menu under the feedback cell, "Paint over"
import { ColumnResize } from './ColumnResize.tsx';
import { desktopBubble } from './DesktopBubbleHandle.tsx';
import { TourDialog } from '../tour/TourDialog.tsx'; // B-055: the feedback tour (replay)
import { openTour } from '../tour/open.ts';
import { firstVideoHere } from '../pwa/native.ts';

function useGlobalHotkeys(): void {
  useEffect(() => {
    const off = [
      hotkey('mod+k', () => { paletteOpen.value = !paletteOpen.value; }),
      hotkey('mod+,', toggleSettings),
      hotkey('mod+b', toggleSidebar),
      hotkey('mod+n', () => { if (canStartChat()) newChatOpen.value = {}; }), // never a dialog whose Create is refused
    ];
    return () => off.forEach((fn) => fn());
  }, []);
  // 17.11.2026 (Theo, portrait videos): Ctrl +/−/0 sizes the text on the desktop (lib/text-size.ts) – after
  // workspace/pane-shortcuts.ts, which keeps the key for a website tab the keyboard is in. 21.11.2026: both stored sizes
  // apply on every device; the keys are the desktop's (a browser has its own zoom).
  useEffect(() => {
    restoreTextSizes();
    if (platform !== 'desktop') return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const dir = zoomKey({ key: event.key, mod: os === 'mac' ? event.metaKey : event.ctrlKey, alt: event.altKey });
      if (dir === undefined) return;
      event.preventDefault();
      const px = setSize(TEXT, dir === 0 ? TEXT.base : textPx.peek() + dir);
      toasts.value = toasts.peek().filter((toast) => !toast.title.startsWith('Text size ')); // one size line, not a pile
      pushToast({ title: `Text size ${px} px`, body: px === TEXT.base ? undefined : `${os === 'mac' ? '⌘' : 'Ctrl'}+0 resets` }, 1500);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Desktop: the caption controls follow the layout (main/title-bar.ts); sent on change only. */
function useCaptionLayout(compact: boolean): void {
  useEffect(() => { bridge?.setTitleBarLayout?.(compact ? 'compact' : 'columns'); }, [compact]);
}

function Overlays() {
  // Feedback 16.11.2026 (F15): the iPhone web app plays the feedback video once, on its second start after pairing (28.11.2026: not over the first screen).
  useEffect(() => { if (firstVideoHere()) openTour({ autoplay: true }); }, []);
  return (
    <>
      <CommandPalette />
      <NewChatDialog />
      <FeedbackMenu />
      <ConfirmHost />
      <RememberWhyHost />
      <TourDialog phone={isMobile.value} desktopBubble={desktopBubble.value.available} />
      <RegionDialog />
    </>
  );
}

function DesktopShell() {
  const prefs = preferences.value;
  const sidebarShown = prefs.sidebarOpen;
  const live = useSignal<number | null>(null);
  const paneLive = useSignal<number | null>(null);
  const stored = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, prefs.sidebarWidth || SIDEBAR_DEFAULT));
  const width = live.value ?? stored;
  const paneWidth = paneLive.value ?? Math.max(280, Math.min(800, prefs.workspaceWidth || 400));
  const showPane = prefs.workspaceOpen;
  const rowRoom = useRef<HTMLDivElement>(null); // the strip's tab room in the title row (shell.css .pane-row-room)
  const stripInRow = useSignal(false);
  useLayoutEffect(() => {
    const element = rowRoom.current;
    if (!element) return;
    const measure = () => { stripInRow.value = element.getBoundingClientRect().width >= ROW_ROOM; };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { side, main } = desktopViews(route.value);
  return (
    <div class="app">
      <div class="shell">
        <Rail />
        <div
          class={`app-frame${sidebarShown ? '' : ' sidebar-closed'}${showPane ? ' with-pane' : ''}${showPane && fullView.value === GLOBAL_SPACE ? ' pane-full' : ''}${stripInRow.value ? ' strip-in-row' : ''}`}
          style={{ '--sidebar-width': `${width}px`, '--pane-width': `${paneWidth}px` }}
        >
          {sidebarShown && <Sidebar view={side} width={width} onLiveWidth={(value) => { live.value = value; }} />}
          <main class="main-slot rightmost" id="main">
            {main.header && <ZoneHeader key={main.key} read={main.header} zone="main" />}
            {main.body}
            <StatusLine />
          </main>
          {showPane && (
            <aside class="global-pane" aria-label="Workspace" id="workspace">
              <ColumnResize label="Resize workspace" class="workspace-resize" width={paneWidth} min={280} max={800} defaultWidth={400} direction={-1}
                onLive={(value) => { paneLive.value = value; }} onSave={(value) => updatePreferences({ workspaceWidth: value })} />
              <WorkspacePane space={GLOBAL_SPACE} />
            </aside>
          )}
          <WorkspaceCell />
          <FeedbackCell />
          <div class="pane-row-room" ref={rowRoom} aria-hidden="true" />
        </div>
      </div>
      <Overlays />
    </div>
  );
}

export function Shell() {
  useGlobalHotkeys();
  useCaptionLayout(isMobile.value);
  useEffect(() => registerShellNotices(), []);
  useEffect(() => watchConnection(rpc.status), []); // the connection line comes after a short grace (connection-line.ts)
  const ready = loaded.value || Boolean(loadError.value);
  useEffect(() => (ready ? watchWorkspaceAttention() : undefined), [ready]); // both layouts: the phone's ways in land in the open chat's area, else in its global sheet
  // 19.11.2026 (D1): the frame is there from the first paint – before any data, with the PC away – never a lone word.
  if (isMobile.value) {
    return (
      <>
        <MobileShell />
        <Overlays />
      </>
    );
  }
  return <DesktopShell />;
}
