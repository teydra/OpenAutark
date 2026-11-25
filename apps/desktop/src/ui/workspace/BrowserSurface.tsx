// The frame of the browser live view and – while the person has taken the browser over (MP9) –
// the surface that sends their clicks, drags, wheel turns, keys and pastes to the agent's tab
// (browser.input through browser-input.ts). Not taken over, it is a plain picture: watching
// never steers. Focus follows a click on the picture; Esc returns the keyboard to the app.
// X02 touch: a tap clicks, one finger scrolls the page (browser-touch.ts; touch-action none – every
// gesture is ours); the handled touchend cancels the browser's synthetic mouse events. The hidden key
// field for the on-screen keyboard (BrowserKeys.tsx, `keys`) sits here too. Mouse and keyboard paths are as before.
// B-081 T9: the zoom is a view over the picture (view-zoom.ts {s, x, y}; the img gets translate + scale around its
// top-left, so framePoint over getBoundingClientRect maps clicks as before): `zoom` is what the Zoom button asks for
// (centred), two fingers pinch it between 1 and ZOOM_MAX (settled and told to `onZoom` when the last finger lifts), one finger pans the
// zoomed picture to every edge and scrolls the page with what is left. `mode` 'pad' makes the screen a touchpad
// (browser-pad.ts): the cursor is drawn over the picture as the person's thin arrow (an overlay, it takes no room) and
// the zoomed picture follows it near the view's edge.
// B-044 visual pass: the picture carries the page's size (--frame-w/-h) so the stylesheet never shows
// it larger than the page; the surface's layout is CSS (workspace-chrome.css .browser-touch), so a view can align it
// like its plain picture.
// B-076: a side-browser tab watched from another PC (RemoteWebTab.tsx) is always this surface, its frame without an
// agent and its ring in the remote color (`ring`); a picture appearing there never takes the keyboard (`autoFocus`
// false – only a click on it does) and the pane's tab shortcuts stay the app's (`appKeys`). B-081: there input does not wait
// for each answer (`inFlight`, the sender's window).
// Owns: the frame element and its input listeners. Never: forwards input while not taken over,
// or keeps typed text (only the sender holds it until it is sent).

import type { Ref } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { BrowserFrame, BrowserInput } from '../../shared/model/browser.ts';
import { connectionFailure } from '../lib/rpc-error.ts';
import { frameSrc } from './browser-feed.ts';
import { buttonOf, createInputSender, drawnArea, framePoint, keyInput, modifiersOf, pasteText, wheelPixels, type FramePoint } from './browser-input.ts';
import { padGestures } from './browser-pad.ts';
import { touchGestures } from './browser-touch.ts';
import { BrowserKeys } from './BrowserKeys.tsx';
import { FIT, drawnPoint, follow, pan, pinch, settle, zoomTo, type ZoomRoom, type ZoomView } from './view-zoom.ts';

/** B-081 T9: the touchpad's cursor stays this far inside a zoomed view (the picture follows it). */
const CURSOR_MARGIN = 24;
const sameZoom = (a: ZoomView, b: ZoomView) => a.s === b.s && a.x === b.x && a.y === b.y;

/** The frame the surface shows: an agent browser's, or (B-076) a side tab's from another PC – no agent there. */
export type SurfaceFrame = Pick<BrowserFrame, 'tab' | 'data' | 'width' | 'height' | 'at'> & { agentId?: string };

export interface BrowserSurfaceProps {
  frame: SurfaceFrame;
  alt: string;
  /** The person has taken the browser over: input goes to the page. */
  takeover: boolean;
  /** Sends one input for the tab the person saw (browser.input). */
  send(tab: string, input: BrowserInput): Promise<unknown>;
  onError(error: unknown): void;
  /** X02, B-081 T9: the zoom the Zoom button asks for (1 fits; 2 twice the size around the view's centre) – touch devices. */
  zoom?: number;
  /** B-081 T9: the zoom a pinch ended at (the Zoom button shows it). */
  onZoom?(s: number): void;
  /** B-081 T9: how a touch screen steers – 'touch' (default) clicks where the finger taps, 'pad' moves a cursor like a touchpad. */
  mode?: 'touch' | 'pad';
  /** X02: the hidden key field "Type" focuses. */
  keys?: Ref<HTMLInputElement>;
  /** The ring while it takes input (a CSS color; default var(--focus)). */
  ring?: string;
  /** The keyboard comes here when the takeover starts (the person pressed Take over); false: only a click on the picture brings it. */
  autoFocus?: boolean;
  /** The pane's tab shortcuts (Ctrl+T, Ctrl+W, Ctrl+Tab …) stay the app's, as in a page of this PC (pane-shortcuts.ts acts first). */
  appKeys?: boolean;
  /** B-081: inputs on their way at once (browser-input.ts window; default 1 – an agent's browser waits for each answer). */
  inFlight?: number;
}

export function BrowserSurface(props: BrowserSurfaceProps) {
  const { frame, takeover } = props;
  const want = props.zoom ?? 1;
  const surface = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const pressed = useRef(false);
  const last = useRef<FramePoint | undefined>(undefined);
  const latest = useRef(props);
  latest.current = props;
  const zoomed = useRef<ZoomView>(FIT);
  const [, redraw] = useState(0);
  const show = (next: ZoomView) => { if (!sameZoom(next, zoomed.current)) { zoomed.current = next; redraw((n) => n + 1); } };
  /** The surface's box and the picture's layout box in it (transforms do not count). */
  const room = (): ZoomRoom | undefined => {
    const box = surface.current;
    const pic = image.current;
    return box && pic && pic.offsetWidth > 0 ? { box: { width: box.clientWidth, height: box.clientHeight }, picture: { left: pic.offsetLeft, top: pic.offsetTop, width: pic.offsetWidth, height: pic.offsetHeight } } : undefined;
  };
  // an input the dropped connection took with it drops nothing behind it (Konrad 24.11.2026): the rest goes once it is back
  const sender = useMemo(() => createInputSender((tab, input) => latest.current.send(tab, input), (error) => latest.current.onError(error),
    { window: props.inFlight, lost: (error) => connectionFailure(error) === 'lost' }), [frame.agentId, props.inFlight]);
  const toPage = (input: BrowserInput) => { const tab = latest.current.frame.tab; if (tab) sender.push(tab, input); };
  const [touch, pad] = useMemo(() => {
    const scale = () => {
      const rect = image.current?.getBoundingClientRect();
      const size = latest.current.frame;
      const area = rect ? drawnArea(rect, size) : undefined;
      return area && area.width > 0 && size.width > 0 ? size.width / area.width : 1;
    };
    const pinchAt = (x: number, y: number, ratio: number, dx: number, dy: number) => {
      const r = room();
      const rect = surface.current?.getBoundingClientRect();
      if (r && rect) show(pinch(pan(zoomed.current, dx, dy, r).view, { x: x - rect.left, y: y - rect.top }, ratio, r));
    };
    return [touchGestures({
      point: (x, y) => {
        const rect = image.current?.getBoundingClientRect();
        const size = latest.current.frame;
        return rect ? framePoint(x, y, rect, { width: size.width, height: size.height }) : undefined;
      },
      scale,
      pan: (dx, dy) => {
        const r = room();
        if (!r) return { x: dx, y: dy };
        const moved = pan(zoomed.current, dx, dy, r);
        show(moved.view);
        return moved.rest;
      },
      pinch: pinchAt,
    }, toPage), padGestures({ frame: () => ({ width: latest.current.frame.width, height: latest.current.frame.height }), scale, pinch: pinchAt }, toPage, (at) => {
      const r = room();
      const spot = r && drawnPoint(zoomed.current, r, latest.current.frame, at);
      if (r && spot) zoomed.current = follow(zoomed.current, r, spot, CURSOR_MARGIN); // the zoomed picture keeps the cursor in sight
      redraw((n) => n + 1);
    })] as const;
  }, [sender]);
  const gestures = props.mode === 'pad' ? pad : touch;

  useEffect(() => {
    if (takeover) { if (props.autoFocus !== false) surface.current?.focus({ preventScroll: true }); }
    else { sender.clear(); pressed.current = false; touch.cancel(); pad.cancel(); }
  }, [takeover, sender]);
  useEffect(() => () => sender.clear(), [sender]);
  useEffect(() => { // the Zoom button: that zoom around the view's centre; a pinch that ended there stays where it is
    if (Math.abs(want - zoomed.current.s) < 0.01) return;
    const r = room();
    show(r ? zoomTo(want, r) : FIT);
  }, [want]);

  // the page's own size caps the picture (workspace-browser.css letterboxes it into the room left): a
  // frame captured at the screen's scale is never shown larger than the agent's page
  const view = takeover ? zoomed.current : FIT;
  const size = [
    frame.width > 0 && frame.height > 0 ? `--frame-w: ${frame.width}px; --frame-h: ${frame.height}px` : '',
    view.s > 1 ? `transform: translate(${view.x.toFixed(1)}px, ${view.y.toFixed(1)}px) scale(${view.s.toFixed(3)})` : '',
  ].filter(Boolean).join('; ') || undefined;
  const src = useMemo(() => frameSrc(frame), [frame.data]); // a pan redraws often: the same string, no new compare
  const img = <img ref={image} src={src} width={frame.width || undefined} height={frame.height || undefined} style={size} alt={props.alt} draggable={false} />;
  if (!takeover) return img;
  const cursorAt = props.mode === 'pad' ? pad.at() : undefined;
  const pictureRoom = cursorAt && room();
  const cursor = cursorAt && pictureRoom ? drawnPoint(view, pictureRoom, frame, cursorAt) : undefined;

  const point = (event: MouseEvent): FramePoint | undefined => {
    const rect = image.current?.getBoundingClientRect();
    return rect ? framePoint(event.clientX, event.clientY, rect, { width: frame.width, height: frame.height }) : undefined;
  };
  const push = toPage;
  /** All fingers lifted: a pinch that ended just above 1 fits again (settle), and the Zoom button hears where it ended. */
  const lifted = () => { show(settle(zoomed.current)); if (zoomed.current.s !== want) props.onZoom?.(zoomed.current.s); };
  const release =(at: FramePoint | undefined, event: MouseEvent) => {
    if (!pressed.current || !at) return;
    pressed.current = false;
    push({ kind: 'mouse', type: 'up', ...at, button: buttonOf(event.button) ?? 'left', buttons: event.buttons, clicks: Math.min(Math.max(event.detail, 1), 3), modifiers: modifiersOf(event) });
  };

  return (
    <div ref={surface} tabIndex={0} role="application" class="browser-touch" data-app-keys={props.appKeys ? '' : undefined}
      aria-label={`${props.alt}. You are using this browser: clicks and keys go to the page. Esc returns the keyboard to the app.`}
      style={{ alignSelf: 'stretch', justifySelf: 'stretch', minWidth: 0, minHeight: 0, outline: `2px solid ${props.ring ?? 'var(--focus)'}`, outlineOffset: '-2px', borderRadius: 'var(--r-lg)' }}
      onTouchStart={(event) => gestures.start(event)}
      onTouchMove={(event) => gestures.move(event)}
      onTouchEnd={(event) => {
        if (gestures.end(event)) event.preventDefault();
        if (event.touches.length === 0) lifted();
      }}
      onTouchCancel={() => { gestures.cancel(); lifted(); }}
      onMouseDown={(event) => {
        surface.current?.focus({ preventScroll: true });
        const at = point(event);
        const button = buttonOf(event.button);
        if (!at || !button) return;
        event.preventDefault();
        pressed.current = true;
        last.current = at;
        push({ kind: 'mouse', type: 'down', ...at, button, buttons: event.buttons, clicks: Math.min(Math.max(event.detail, 1), 3), modifiers: modifiersOf(event) });
      }}
      onMouseUp={(event) => release(point(event) ?? last.current, event)}
      onMouseLeave={(event) => release(last.current, event)}
      onMouseMove={(event) => {
        const at = point(event);
        if (!at) return;
        last.current = at;
        push({ kind: 'mouse', type: 'move', ...at, buttons: event.buttons, modifiers: modifiersOf(event) });
      }}
      onWheel={(event) => {
        const at = point(event);
        if (!at) return;
        event.preventDefault();
        push({ kind: 'wheel', ...at, deltaX: wheelPixels(event.deltaX, event.deltaMode), deltaY: wheelPixels(event.deltaY, event.deltaMode), modifiers: modifiersOf(event) });
      }}
      onContextMenu={(event) => event.preventDefault()}
      onDragStart={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.target !== surface.current || event.defaultPrevented) return; // the hidden key field handles its own keys; a pane shortcut was the app's
        if (event.key === 'Escape') { surface.current?.blur(); return; }
        const input = keyInput(event, 'down');
        if (!input) return;
        event.preventDefault();
        event.stopPropagation(); // the app's shortcuts stay quiet while the person types into the page
        push(input);
      }}
      onKeyUp={(event) => {
        if (event.target !== surface.current) return;
        const input = keyInput(event, 'up');
        if (!input) return;
        event.preventDefault();
        event.stopPropagation();
        push(input);
      }}
      onPaste={(event) => {
        event.preventDefault();
        const text = pasteText(event.clipboardData?.getData('text/plain') ?? '');
        if (text) push({ kind: 'text', text });
      }}>
      {img}
      {cursor && (
        <span class="browser-pad-cursor" aria-hidden="true" style={{ transform: `translate(${Math.round(cursor.left - 1.5)}px, ${Math.round(cursor.top - 1.5)}px)` }}>
          <svg width="16" height="20" viewBox="0 0 16 20"><path d="M1.5 1.5v14.2l3.9-3.7 2.6 6.3 2.6-1.1-2.6-6.2h5.4z" stroke-width="1.3" stroke-linejoin="round" /></svg>
        </span>
      )}
      {props.keys && <BrowserKeys push={push} field={props.keys} label={`Type into ${props.alt}`} />}
    </div>
  );
}
