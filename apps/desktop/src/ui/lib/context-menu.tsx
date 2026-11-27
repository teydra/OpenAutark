// One right-click menu for the whole app (owner, 31.10.2026: "mit Rechtsklicks arbeiten … generell in
// unserem System"). Any row spreads `useContextMenu(() => sections)` on its root: a right click (mouse)
// or a long press (touch) opens the shared Menu at the pointer. <ContextMenuHost/> is mounted once in
// App.tsx. Builders run when the menu opens, so they always see current state.
// A row inside a modal keeps the menu's anchor and popover inside that dialog's top layer.
// B-084: a long press that opens the menu gives a light haptic tick (the Android app's, else navigator.vibrate).
// F30 (16.11.2026): the builder learns how the menu was opened ({ touch, at: the row }) – a message's Copy takes the
// mouse selection inside it (a finger selects natively, FCMWSYY3); a touch open clears the one-word selection the browser made
// under the finger, so only this menu shows (the phone's own copy bar does not stack on it).
// 17.11.2026 (the owner twice, "soll einfach so sein, wie es normalerweise ist"): a row of text (a message) takes `{ touchByButton: true }` – a finger's
// long press then opens nothing of ours and the phone's own selection (handles, its copy bar) works as everywhere; the menu is the row's own button
// (message tools "More"). The mouse's right click still opens it.
// Owns: where the menu opens, the touch long-press and its tick. Never: what an item does (the caller's builder).

import { signal } from '@preact/signals';
import { addBackLayer } from './back-layers.ts';
import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Menu } from './popover.tsx';
import type { MenuSection } from './popover.tsx';
import { sendNative } from '../pwa/native-port.ts';

interface OpenMenu { x: number; y: number; sections: MenuSection[]; host?: HTMLElement | null }

const current = signal<OpenMenu | null>(null);

const LONG_PRESS_MS = 500;
const MOVE_SLOP = 10;
/** Native controls keep their own right-click (text fields, links inside messages keep copy/paste). */
const NATIVE = 'input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"], select';

/** Opens the shared menu at a point (also usable from a ⋯ button: pass its rect's bottom-left). */
export function openContextMenu(x: number, y: number, sections: MenuSection[], host?: HTMLElement | null): void {
  const filled = sections.filter((section) => section.items.length > 0);
  if (filled.length) current.value = { x, y, sections: filled, host };
}

export function closeContextMenu(): void {
  current.value = null;
}

addBackLayer({ open: () => current.peek() !== null, close: closeContextMenu }); // the phone's Back closes it first

/** The light tick a native app gives when a long press opens a menu (or a swipe replies): the Android app's own (over
 *  its port), else the browser's vibrate where it has one. */
export function buzz(): void {
  if (sendNative({ t: 'haptic' })) return;
  try { navigator.vibrate?.(8); } catch { /* no vibration here */ }
}

/** How a menu was opened: by touch (a long press), and on which row. */
export interface MenuOpen { touch: boolean; at: HTMLElement | null }

/** The selection a long press made under the finger is the browser's, not a choice: gone once this menu opens. */
function dropTouchSelection(): void {
  try { getSelection()?.removeAllRanges(); } catch { /* no selection here */ }
}

/** Props for an element: right-click and touch long-press open `build()`'s sections. */
export function useContextMenu(build: (open: MenuOpen) => MenuSection[], options: { touchByButton?: boolean } = {}) {
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const fired = useRef(false);
  const touch = useRef(false); // the last press on this row was a finger (a long press's own contextmenu event comes too)
  const cancel = () => { if (press.current) clearTimeout(press.current.timer); press.current = null; };
  useEffect(() => cancel, []);
  const native = (event: Event) => Boolean((event.target as Element | null)?.closest?.(NATIVE));
  const host = (event: Event) => (event.target as Element | null)?.closest?.<HTMLElement>('dialog[open]');
  const open = (x: number, y: number, at: HTMLElement | null, container: HTMLElement | null | undefined) => {
    if (touch.current) dropTouchSelection();
    openContextMenu(x, y, build({ touch: touch.current, at }), container);
  };
  return {
    onContextMenu: (event: MouseEvent) => {
      if (native(event)) return;
      if (options.touchByButton && touch.current) return; // a finger's long press selects text natively: nothing of ours, and the event is not stopped
      event.preventDefault();
      event.stopPropagation();
      cancel();
      if (fired.current) { if (touch.current) dropTouchSelection(); return; } // the long press already opened it
      open(event.clientX, event.clientY, event.currentTarget as HTMLElement | null, host(event));
    },
    onPointerDown: (event: PointerEvent) => {
      fired.current = false;
      cancel();
      touch.current = event.pointerType === 'touch' || event.pointerType === ''; // adb's input events (the test phone) carry no pointer type: a finger all the same (S9, 27.11.2026)
      if (!touch.current || native(event) || options.touchByButton) return;
      const { clientX: x, clientY: y } = event;
      const container = host(event);
      const at = event.currentTarget as HTMLElement | null;
      press.current = { x, y, timer: setTimeout(() => {
        fired.current = true;
        press.current = null;
        open(x, y, at, container);
        if (current.peek()) buzz();
      }, LONG_PRESS_MS) };
    },
    onPointerMove: (event: PointerEvent) => {
      const at = press.current;
      if (at && Math.hypot(event.clientX - at.x, event.clientY - at.y) > MOVE_SLOP) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture: (event: MouseEvent) => {
      // the click that ends a long press must not also open the row
      if (!fired.current) return;
      fired.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}

/** The one menu; mounted once at the app root. */
export function ContextMenuHost() {
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const open = current.value;
  return (
    <>
      {createPortal(<div
        ref={setAnchor}
        class="context-menu-anchor"
        aria-hidden="true"
        style={{ position: 'fixed', left: `${open?.x ?? -9999}px`, top: `${open?.y ?? -9999}px`, width: '0px', height: '0px', pointerEvents: 'none' }}
      />, open?.host?.isConnected ? open.host : document.body)}
      <Menu
        key={open ? `${open.x},${open.y}` : 'closed'}
        anchor={anchor}
        open={open !== null}
        onClose={closeContextMenu}
        placement="bottom-start"
        label="Context menu"
        sections={open?.sections ?? []}
      />
    </>
  );
}
