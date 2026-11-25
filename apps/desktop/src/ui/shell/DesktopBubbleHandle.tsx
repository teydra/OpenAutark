// Owns: the desktop sidebar's bubble handle, pointer capture and visibility state from main.
// Never: places the native floating window or decides which PC owns it.

import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { BubbleHandleState } from '../../shared/api/desktop.ts';
import type { HeaderCell } from '../lib/header-model.ts';
import { bridge as desktop } from '../lib/platform.ts';

export const desktopBubble = signal<BubbleHandleState>({ available: false, out: false });

if (desktop?.bubbleState && desktop.onBubbleState) {
  let newer = false;
  desktop.onBubbleState((state) => { newer = true; desktopBubble.value = state; });
  void desktop.bubbleState().then((state) => { if (!newer) desktopBubble.value = state; }).catch(() => {});
}

export const desktopBubbleLead: HeaderCell = { id: 'bubble', slot: <DesktopBubbleHandle /> };

function DesktopBubbleHandle() {
  const { out } = desktopBubble.value;
  const drag = useRef<{ id: number; x: number; y: number; pulling: boolean } | undefined>(undefined);
  const swept = useRef(false);
  const send = desktop?.bubbleHandle;
  const finish = (event?: PointerEvent) => {
    const active = drag.current;
    if (!active || (event && active.id !== event.pointerId)) return;
    drag.current = undefined;
    swept.current = active.pulling;
    if (active.pulling) send?.('drop');
  };
  useEffect(() => () => finish(), []);
  return (
    <button type="button" class={`desktop-bubble-handle${out ? ' out' : ''}`}
      aria-label="Show or move the floating Autark bubble" title="Click to show the bubble, drag to move it"
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        swept.current = false;
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, pulling: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (!active || active.id !== event.pointerId) return;
        if (active.pulling) send?.('move');
        else if (Math.hypot(event.clientX - active.x, event.clientY - active.y) >= 5) {
          active.pulling = true;
          send?.('pull');
        }
      }}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
      onClick={(event) => {
        if (event.detail === 0 || !swept.current) send?.('press');
        swept.current = false;
      }}>
      <svg width="18" height="18" viewBox="0 0 512 512" aria-hidden="true">
        <path fill="currentColor" d="M216,43 L296,43 L480,468 L396,468 L256,138 L116,468 L32,468 Z" />
        <path fill="currentColor" d="M208,351 a48,48 0 1,0 96,0 a48,48 0 1,0 -96,0 Z" />
      </svg>
    </button>
  );
}
