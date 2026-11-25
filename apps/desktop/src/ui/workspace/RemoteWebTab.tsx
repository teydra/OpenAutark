// A website tab that runs on another of the person's PCs – or, on the phone, on its PC (B-076, the owner's 05.11.2026
// wish). The page stays where it was opened: it loads, sends and keeps its logins there; this view shows its live
// picture (side.pull, B-081: up to 10 frames a second on a PC and about 3 on a phone, only while the window is shown)
// and sends every click, drag, wheel turn, key and paste there (side.input through BrowserSurface – always usable, no
// takeover step; the keyboard comes to the picture only with a click on it, and the pane's tab shortcuts stay the
// app's), plus back / forward / reload and a new address (side.nav). B-081: every pull names this view's picture box
// (`view`, a ResizeObserver; a changed box pulls at once), so the page takes this box's shape on its PC while it is
// watched (a PC from before B-081 refuses the box once and is then asked without it); input goes on without waiting for each answer (REMOTE_IN_FLIGHT on their way, in order); the feed keeps the
// last picture of the KEPT_FRAMES tabs shown last, so switching back never shows an empty field. On a touch screen a
// tap clicks, a finger scrolls, Type opens the keyboard and Zoom shows the page at twice the size (browser-touch.ts,
// BrowserKeys.tsx). B-081 T9 (the owner's 08.11.2026 wishes): two fingers pinch between 1 and 4 and one finger pans the
// zoomed picture to every edge (view-zoom.ts); a fixed cell switches touch (tap where you click) and touchpad (a cursor
// on the picture, browser-pad.ts) – this viewer's own convenience in localStorage (INPUT_MODE_KEY), not a setting; the
// page says each time a tap left a text field focused (state.editing, a new stamp) and the keyboard opens by itself within
// KEYS_AFTER_TAP_MS of this viewer's own tap (Type – blur, then focus, in its own tap – stays for every other case), and while the key field has focus a box that only got
// shorter (the keyboard opening, Android adjustResize) is not sent, so the page there keeps its layout. A blue glow lies
// inside the view's edge. The toolbar keeps the address row's cells where every other tab has them – Back, Forward and
// Reload first, the pane's menu cell last (`trail`) – with the PC's mark ("on office-pc"; in a narrow pane its icon) and,
// on a touch screen, the touch / touchpad switch as fixed cells before the address. A dialog the page opens there
// (alert, confirm …) lies over the picture in one fixed place with its answers. While that PC cannot be reached one
// calm line takes the picture's place after PROBLEM_GRACE_MS and the pulls try again every RETRY_MS. Konrad 24.11.2026: while
// this window's own connection is away the last picture stays and nothing shows here (the status line's one quiet line
// comes after 5 s); clicks, keys and pastes made meanwhile wait in order and go once it is back (rpc.ts, up to its
// QUEUE_LIMIT_MS – later ones are said once afterwards); only without any picture the offline line stands there.
// Nothing moves: the cells are fixed, buttons only change their color, the touch buttons float.
// Owns: the feed of remote side tabs, their picture boxes, this view and its PC-name lookup (helpers: remote-web.ts).
// Never: loads the page here, runs a feed per view (browser-feed.ts shares one per tab), or keeps what the person types.

import type { ComponentChildren, RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { PULL_DEFAULT_BYTES, type BrowserInput } from '../../shared/model/browser.ts';
import { SIDE_WAIT_MS, clampView, refusesView, sameView, type SideDialog, type SideFrame, type SideNav, type SideViewSize, type SideViewState } from '../../shared/model/side-view.ts';
import { errorText, rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { toastError } from '../lib/toasts.ts';
import { Button, Icon, IconButton, Spinner } from '../lib/ui.tsx';
import { createBrowserFeed, type FeedView } from './browser-feed.ts';
import { Address, useCoarsePointer, useDocumentVisible } from './BrowserLive.tsx';
import { BrowserSurface } from './BrowserSurface.tsx';
import { down } from '../shell/connection-line.ts';
import { PROBLEM_GRACE_MS, farProblem, pictureProblem, remoteKey, remoteTarget, sayOnce } from './remote-web.ts';
import { useSpace } from './space.ts';

/** After a failed pull (the PC is offline), the next try while the view stays. */
export const RETRY_MS = 5000;
/** The same input failure is said once in this time. */
const SAY_AGAIN_MS = 5000;
/** B-081: inputs on their way at once (the runtime takes 64 per connection; every hop keeps their order). */
export const REMOTE_IN_FLIGHT = 8;
/** B-081: remote tabs not shown that keep their last picture for a quick switch back. */
export const KEPT_FRAMES = 6;
/** B-081 T9: the page reporting a focused text field this soon after this viewer's tap opens the keyboard. */
export const KEYS_AFTER_TAP_MS = 2000;
/** B-081 T9: this viewer's touch screen mode (a convenience of this browser, never synced). */
export const INPUT_MODE_KEY = 'wf.remote.inputMode';

type InputMode = 'touch' | 'pad';
function storedMode(): InputMode {
  try { return localStorage.getItem(INPUT_MODE_KEY) === 'pad' ? 'pad' : 'touch'; } catch { return 'touch'; }
}
function keepMode(mode: InputMode): void {
  try { localStorage.setItem(INPUT_MODE_KEY, mode); } catch { /* storage may be blocked: the mode holds while the tab is open */ }
}

export interface RemoteWebTabProps { device: string; tab: string; url: string; title?: string; trail?: ComponentChildren }

/** Each remote tab's picture box here (feed key → CSS px): every pull names it, so the page there takes this shape. */
const boxes = new Map<string, SideViewSize>();
/** PCs that refused `view` (a version before B-081): asked without it for the rest of this session. */
const noView = new Set<string>();

/** One pull; a PC that refuses the box is asked again without it (its picture then has its own size, as before). */
function pullSide(key: string, after: { state?: number; frame?: number }) {
  const target = remoteTarget(key);
  const pc = target.device ?? '';
  const ask = (view?: SideViewSize) => rpc.call('side.pull', { ...target, after, maxBytes: PULL_DEFAULT_BYTES, waitMs: SIDE_WAIT_MS, ...(view ? { view } : {}) });
  const view = noView.has(pc) ? undefined : boxes.get(key);
  if (!view) return ask();
  return ask(view).catch((error: unknown) => {
    if (!refusesView(error)) throw error;
    noView.add(pc);
    return ask();
  });
}

const feed = createBrowserFeed<SideViewState, SideFrame>({
  subscribe: () => Promise.reject(new Error('Side tabs are pulled.')), // pull mode only (pulls below)
  unsubscribe: async () => undefined,
  onState: () => () => {},
  onFrame: () => () => {},
  onOpen: (listener) => rpc.onOpen(listener),
  errorText,
  pulls: () => true,
  pull: pullSide,
  pullPart: (key, at, index) => rpc.call('side.pullPart', { ...remoteTarget(key), at, index }),
  retryMs: RETRY_MS,
  keep: KEPT_FRAMES,
});

/** A remote tab was closed: its kept picture goes too (pages.ts, on close). */
export function forgetRemoteTab(device: string, tab: string): void {
  const key = remoteKey(device, tab);
  feed.drop(key);
  boxes.delete(key);
}

/** The view's picture box follows its size (whole CSS px); a changed box goes out with a pull at once – but not one that
 *  only got shorter while the key field has focus (the on-screen keyboard took the room; the picture just fits it). */
function useBox(key: string, box: RefObject<HTMLElement>, keys: RefObject<HTMLInputElement>): void {
  useEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((seen) => {
      const rect = seen[0]?.contentRect;
      if (!rect || rect.width < 1 || rect.height < 1) return; // hidden: the last box stays
      const view = clampView(rect.width, rect.height);
      const was = boxes.get(key);
      if (sameView(was, view)) return;
      if (was && keys.current && document.activeElement === keys.current && view.width === was.width && view.height < was.height) return;
      boxes.set(key, view);
      feed.refresh(key);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [key]);
}

/** PC names this window learned (from the pulls, or the owner's device list while a PC is offline). */
const pcNames = new Map<string, string>();
let listing: Promise<void> | null = null;

function usePcName(device: string, state: SideViewState | null): string {
  const [, redraw] = useState(0);
  if (state?.pc) pcNames.set(device, state.pc);
  useEffect(() => {
    if (pcNames.has(device) || !can('devices.list')) return;
    listing ??= rpc.call('devices.list').then((list) => { for (const pc of list) pcNames.set(pc.id, pc.name); }, () => { listing = null; });
    let live = true;
    void listing?.then(() => { if (live) redraw((n) => n + 1); });
    return () => { live = false; };
  }, [device]);
  return pcNames.get(device) ?? 'another PC';
}

function useRemoteView(key: string, watching: boolean): FeedView<SideViewState, SideFrame> {
  const lastOf = () => feed.last(key) ?? { state: null, frame: null, error: null }; // a tab shown lately: its last picture at once
  const [view, setView] = useState<FeedView<SideViewState, SideFrame>>(lastOf);
  useEffect(() => { setView(lastOf()); }, [key]);
  useEffect(() => (watching ? feed.subscribe(key, setView) : undefined), [key, watching]);
  return view;
}

/** `problem` once it has stood `ms` (its text may change meanwhile, e.g. "seen 2 min ago"); null before and once it is gone. */
function useLate(problem: string | null, ms: number): string | null {
  const has = problem !== null;
  const [late, setLate] = useState(false);
  useEffect(() => {
    setLate(false);
    if (!has) return;
    const timer = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(timer);
  }, [has]);
  return has && late ? problem : null;
}

const fresh = sayOnce(SAY_AGAIN_MS);
/** An input the page did not take: said in the status line, the same text at most once per SAY_AGAIN_MS. */
function inputFailed(error: unknown): void {
  if (fresh(errorText(error))) toastError(error, 'The page did not take that');
}

/** The page's dialog on its PC: the page waits for this answer (an alert has only OK). */
function PageDialog(props: { dialog: SideDialog; pc: string; onAnswer: (answer: 'accept' | 'dismiss') => void }) {
  const { dialog } = props;
  const text = dialog.message || (dialog.type === 'beforeunload' ? 'Leave this page?' : 'The page asks for an answer.');
  return (
    <div class="remote-web-dialog" role="alertdialog" aria-label={`The page on ${props.pc} asks`}>
      <p class="remote-web-dialog-text">{text}</p>
      <div class="remote-web-dialog-actions">
        {dialog.type !== 'alert' && <Button variant="secondary" onClick={() => props.onAnswer('dismiss')}>Cancel</Button>}
        <Button variant="primary" onClick={() => props.onAnswer('accept')}>OK</Button>
      </div>
    </div>
  );
}

export function RemoteWebTab(props: RemoteWebTabProps) {
  const { device, tab } = props;
  const key = remoteKey(device, tab);
  const space = useSpace(); // Ctrl+L in this space focuses the address row (pane-shortcuts.ts)
  const visible = useDocumentVisible();
  const { state, frame, error } = useRemoteView(key, visible);
  const pc = usePcName(device, state);
  const touch = useCoarsePointer();
  const [zoom, setZoom] = useState(1);
  const [mode, setMode] = useState<InputMode>(storedMode);
  const keys = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const pressAt = useRef(Number.NEGATIVE_INFINITY);
  useBox(key, box, keys);
  const editing = state?.editing; // a new stamp each time a press there left a text field focused
  useEffect(() => { // that soon after this viewer's tap: the keyboard comes (unless it is there); no text field: it goes
    const field = keys.current;
    if (!field) return;
    const focused = document.activeElement === field;
    if (editing !== undefined) { if (!focused && Date.now() - pressAt.current < KEYS_AFTER_TAP_MS) field.focus({ preventScroll: true }); }
    else if (focused) field.blur();
  }, [editing]);
  // Konrad 24.11.2026: a drop under PROBLEM_GRACE_MS shows nothing – the last picture stays and input waits (rpc.ts holds it)
  const late = useLate(farProblem(error, state?.error), PROBLEM_GRACE_MS);
  const problem = pictureProblem({ late, away: down.value, picture: Boolean(frame) });
  const shown = problem ? null : frame;
  const usable = can('side.input');
  const ready = Boolean(state && !problem && can('side.nav'));
  const title = state?.title || props.title || '';
  const go = (nav: Omit<SideNav, 'device' | 'tab'>) => {
    rpc.call('side.nav', { ...remoteTarget(key), ...nav }).catch((failure) => toastError(failure, 'The page could not do that'));
  };
  const send = (frameTab: string, input: BrowserInput) => {
    if (input.kind === 'mouse' && input.type === 'up') pressAt.current = Date.now(); // this viewer's own tap: the keyboard may follow it
    return rpc.call('side.input', { ...remoteTarget(remoteKey(device, frameTab)), input }); // while the connection is away it waits in order
  };
  const switchMode = () => { const next: InputMode = mode === 'pad' ? 'touch' : 'pad'; keepMode(next); setMode(next); };

  return (
    <div class="workspace-screen remote-web">
      <div class="browser-live-toolbar">
        <IconButton icon="caret-left" label="Back" size="small" disabled={!ready || !state?.back} onClick={() => go({ action: 'back' })} />
        <IconButton icon="caret-right" label="Forward" size="small" disabled={!ready || !state?.forward} onClick={() => go({ action: 'forward' })} />
        <IconButton icon="arrow-clockwise" label="Reload" size="small" disabled={!ready} onClick={() => go({ action: 'reload' })} />
        <span class="remote-web-mark" role="note" title={`This page runs on ${pc} – clicks and keys go there`}>
          <Icon name="monitor" size={14} /><span class="remote-web-pc">on {pc}</span>
        </span>
        {touch && (
          <IconButton icon="cursor-click" size="small" pressed={mode === 'pad'} onClick={switchMode}
            label={mode === 'pad' ? 'Touchpad: drag to move the cursor, tap to click' : 'Touch: tap where you click'} />
        )}
        <Address url={state?.url || props.url} disabled={!ready} onGo={(url) => go({ url })} focusSpace={space} />
        {props.trail && <span class="browser-live-trail">{props.trail}</span>}
      </div>
      <div ref={box} class="workspace-screen-view remote-web-view">
        {shown
          ? <BrowserSurface frame={shown} alt={`Page on ${pc}${title ? `: ${title}` : ''}`} takeover={usable} autoFocus={false} appKeys ring="var(--remote)" zoom={touch ? zoom : 1}
              onZoom={setZoom} mode={touch ? mode : 'touch'} keys={touch ? keys : undefined} send={send} onError={inputFailed} inFlight={REMOTE_IN_FLIGHT} />
          : problem
            ? <div class="browser-live-empty"><Icon name="monitor" size={24} /><p>{problem}</p></div>
            : <Spinner size={18} />}
        {shown && touch && usable && (
          <div class="remote-web-touch">
            <Button variant="ghost" onClick={() => { const field = keys.current; field?.blur(); field?.focus({ preventScroll: true }); }}
              title="Open the keyboard and type into the page">Type</Button>
            <IconButton icon={zoom > 1 ? 'arrows-in-simple' : 'arrows-out-simple'} label={zoom > 1 ? 'Fit the page into the view' : 'Show the page at twice the size'}
              pressed={zoom > 1} onClick={() => setZoom(zoom > 1 ? 1 : 2)} />
          </div>
        )}
        {ready && state?.dialog && <PageDialog dialog={state.dialog} pc={pc} onAnswer={(answer) => go({ dialog: answer })} />}
      </div>
    </div>
  );
}
