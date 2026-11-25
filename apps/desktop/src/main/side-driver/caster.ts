// A side tab watched from another of the person's PCs or from their phone (B-076, host ops sideCast / sideInput /
// sideNav): the page stays here – it loads, sends and keeps its logins only on this PC – and the watcher gets its
// picture and sends input back. `sideCast on` wakes the page through the workspace browser (sideContents: a page
// nobody here looks at moves to the off-screen host, where it paints) and runs a DevTools screencast on the tab's
// shared connection (TabCdp): JPEG quality 45 for the remote side tab (agents' live views are unchanged),
// at most 1280 px on either side, every frame acknowledged at once, at most one per CAST_FRAME_GAP_MS passed on – the
// newest – with the page's address, title and history (`send`, host bridge message 'side-view'). Each renewal keeps
// the page awake; CAST_IDLE_MS without one, or `on: false`, ends the cast. While it runs the workspace browser keeps
// the page loaded (`watched`) and the page counts as focused (its caret shows); when it ends the page may leave the host
// again (`release` – it stays there while an agent used it lately). Input is the person's own: agents wait
// (SideTab.personAt, PERSON_PRIORITY_MS) and an agent's preview tab stays (`keep`). A dialog the page opens (alert,
// confirm …) travels with the page; the watcher answers it (sideNav `dialog`), and input waits for that answer.
// B-081: the watcher names its picture box (`view`); while the cast runs, a page on the off-screen host has that box as
// its size (`size`, workspace-host.ts – a DevTools viewport override was measured to leave the screencast at the view's
// own box), so frames fill the watcher's box; a page the person here shows in their pane keeps the pane's size. A
// changed box applies at once and the end of the cast clears it. If the person here uses the page too: a press here (SideTab.localPress – not within tab.ts WATCHER_ECHO_MS of the
// watcher's own input, SideTab.watcherAt) gives the page back its pane's size GIVE_BACK_MS later (after its up), the
// end of the watcher's next press takes it again; a renewal that names no box (no watcher has one) gives it back too.
// B-081 T9: a watcher's press that ends asks the page if its focus takes text (page-script.ts): each yes a new stamp.
// B-081: a watcher's input goes past this PC's Pin picker (SideTab.holdPicking), as an agent's act batch does.
// Owns: the casts, their viewport, throttle and end. Never: imports electron, runs any DevTools command a watcher names
// other than the three Input ones and the dialog's answer, or keeps a frame or what is typed.

import { WorkforceError } from '../../shared/errors.ts';
import { sameView, type SideCastUpdate, type SideDialog, type SidePage, type SideViewSize } from '../../shared/model/side-view.ts';
import { castCommands, castNav, castView, endsPress, finite, frameFits, isPress, pageOf, record, tabOf, bad, type CastContents } from './cast-params.ts';

/** At most one frame per this many ms goes to the runtime (B-081: up to 10 per second; was 500). */
export const CAST_FRAME_GAP_MS = 100;
/** A cast nobody renewed this long ends (the runtime renews it with every pull). */
export const CAST_IDLE_MS = 60_000;
export const CAST_MAX_SIDE = 1280;
/** B-081: a press here gives the page its pane's size back this long after it (a click's up comes ~100 ms after its down). */
export const GIVE_BACK_MS = 500;
const SCREENCAST = { format: 'jpeg', quality: 45, maxWidth: CAST_MAX_SIDE, maxHeight: CAST_MAX_SIDE, everyNthFrame: 1 };
const CLOSED = 'This tab is not open on its PC any more.';
const IN_DIALOG = 'The page shows a dialog – answer it first.';

/** A side tab as the driver keeps it (side-driver/tab.ts SideTab). */
export interface CastTab {
  readonly id: string;
  readonly contents: CastContents;
  readonly cdp: { send(method: string, params?: object): Promise<any>; on(method: string, listener: (params: any) => void): () => void; inWorld?(expression: string): Promise<unknown> };
  personAt: number;
  /** The page's open dialog (the tab's own DevTools events keep it). */
  dialog?: SideDialog;
  /** B-081: when the watcher's input last went to the page (its echo is no press here). */
  watcherAt: number;
  /** B-081: the watcher's box the page has now (its size on the off-screen host, workspace-host.ts). */
  watcherView?: SideViewSize;
  /** B-081: the tab calls it for the person's own press here (a click's up or a key that is neither an agent's nor the watcher's). */
  localPress?: () => void;
  /** B-081: the tab's Pin picker lets this input through while it goes in (SideTab.holdPicking). */
  holdPicking?(hold: boolean): Promise<void>;
}

export interface CasterDeps {
  /** The tab with its page awake (SideDriver.side); undefined when it is not open here. */
  tab(id: string): CastTab | undefined;
  /** The person used the tab: an agent's preview tab stays as a tab of its own. */
  keep?(id: string): void;
  /** Nobody watches the tab any more: its page leaves the off-screen host unless an agent used it lately. */
  release?(id: string): void;
  /** B-081: the watcher's box as the page's size while it is on the off-screen host (undefined: its own size again). */
  size?(id: string, box: SideViewSize | undefined): boolean;
  /** To the runtime (best effort, only while it is up). */
  send(update: SideCastUpdate): void;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

interface ScreencastFrame { data?: unknown; sessionId?: unknown; metadata?: Record<string, unknown> }

interface Cast {
  id: string;
  tab: CastTab;
  offs: Array<() => void>;
  lastAt: number;
  pending?: ScreencastFrame;
  timer?: unknown;
  idle?: unknown;
  starting: Promise<void>;
  error?: string;
  ended: boolean;
  /** The watcher's picture box (B-081), the press handler here and its give-back that waits; T9: focus takes text. */
  view?: SideViewSize;
  local?: () => void;
  back?: unknown; editing?: number;
}

export class SideCaster {
  private readonly deps: CasterDeps;
  private readonly casts = new Map<string, Cast>();

  constructor(deps: CasterDeps) {
    this.deps = deps;
  }

  /** Someone watches this tab now (the workspace browser keeps its page loaded). */
  watched(id: string): boolean { return this.casts.has(id); }

  /** sideCast: on – wake, start or renew (a changed `view` applies at once); off – end now. */
  async cast(args: unknown): Promise<{ ok: true; page?: SidePage }> {
    const o = record(args, 'cast');
    const id = tabOf(o);
    if (typeof o.on !== 'boolean') bad('on');
    const view = castView(o.view);
    // Off with no cast left (its start failed and kept the page for the next try): the page may still leave now.
    if (!o.on) { const held = this.casts.has(id); this.stop(id); if (!held) this.deps.release?.(id); return { ok: true }; }
    const tab = this.deps.tab(id);
    if (!tab) { this.stop(id); throw new WorkforceError('not_found', CLOSED); }
    let cast = this.casts.get(id);
    if (cast && cast.tab !== tab) { this.stop(id, undefined, true); cast = undefined; } // its page was made anew: cast that one
    if (!cast) cast = this.start(id, tab, view);
    else if (view ? !sameView(view, cast.view) : cast.view) { cast.view = view; if (view) void this.fit(cast); else this.unfit(cast); } // a new box, or none any more
    this.renew(cast);
    await cast.starting;
    if (cast.error) throw new WorkforceError('unavailable', cast.error);
    return { ok: true, page: pageOf(tab.contents, tab.dialog) };
  }

  /** sideInput: the watcher's input, as the person's own. */
  async input(args: unknown): Promise<{ ok: true }> {
    const o = record(args, 'input');
    const id = tabOf(o);
    const commands = castCommands(o.commands);
    const tab = this.deps.tab(id);
    if (!tab) throw new WorkforceError('not_found', CLOSED);
    if (tab.dialog) throw new WorkforceError('unavailable', IN_DIALOG); // the page takes no input until it is answered
    tab.personAt = this.now(); // the person goes first: an agent's next step there waits
    const cast = this.casts.get(id);
    if (commands.some(isPress)) { this.deps.keep?.(id); if (cast) this.hold(cast); } // used there last: the size stays the watcher's
    if (cast) this.renew(cast);
    try {
      await tab.holdPicking?.(true); // the watcher's input reaches the page as it is, never this PC's Pin picker
      for (const command of commands) { tab.watcherAt = this.now(); await tab.cdp.send(command.method, command.params); }
    } catch {
      throw new WorkforceError('unavailable', 'The page did not take that input. Try again.'); // never the input itself
    } finally { void tab.holdPicking?.(false); }
    tab.watcherAt = this.now();
    // Given back by a press here: the END of the watcher's next press takes the size again (it lands where it was seen).
    if (cast?.tab === tab && cast.view && !tab.watcherView && commands.some(endsPress)) await this.fit(cast);
    if (cast?.tab === tab && commands.some(endsPress)) void tab.cdp.inWorld?.('__wfSide.editing()').then((on) => { if (!cast.ended && (on === true || cast.editing)) { cast.editing = on === true ? Math.max(this.now(), (cast.editing ?? 0) + 1) : undefined; this.tell(id, cast); } }, () => undefined);
    return { ok: true };
  }

  /** sideNav: a new address, back, forward, reload, or the answer to the page's dialog. */
  async nav(args: unknown): Promise<{ ok: true }> {
    const { tab: id, url, action, dialog } = castNav(args);
    const tab = this.deps.tab(id);
    if (!tab) throw new WorkforceError('not_found', CLOSED);
    tab.personAt = this.now();
    this.deps.keep?.(id);
    if (dialog) {
      if (!tab.dialog) return { ok: true }; // answered meanwhile (here, or by an agent)
      await tab.cdp.send('Page.handleJavaScriptDialog', { accept: dialog === 'accept' });
      tab.dialog = undefined;
      this.tell(id);
    } else if (tab.dialog) {
      throw new WorkforceError('unavailable', IN_DIALOG);
    } else if (url) {
      const out = await tab.cdp.send('Page.navigate', { url }) as { errorText?: string } | undefined;
      if (out?.errorText) throw new WorkforceError('unavailable', `The page could not be loaded (${out.errorText}).`);
    } else if (action === 'reload') {
      await tab.cdp.send('Page.reload');
    } else {
      const history = await tab.cdp.send('Page.getNavigationHistory') as { currentIndex?: number; entries?: Array<{ id: number }> };
      const entry = history.entries?.[finite(history.currentIndex) + (action === 'back' ? -1 : 1)];
      if (entry) await tab.cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id });
    }
    return { ok: true };
  }

  /** Every cast ends (the runtime went away). */
  stopAll(): void {
    for (const id of [...this.casts.keys()]) this.stop(id);
  }

  // ------------------------------------------------------------------ internals

  private start(id: string, tab: CastTab, view?: SideViewSize): Cast {
    const cast: Cast = { id, tab, offs: [], lastAt: Number.NEGATIVE_INFINITY, starting: Promise.resolve(), ended: false, view };
    this.casts.set(id, cast);
    const page = () => this.tell(id, cast);
    cast.offs.push(
      tab.cdp.on('Page.screencastFrame', (event: ScreencastFrame) => this.frame(cast, event)),
      tab.cdp.on('Page.frameNavigated', (event: { frame?: { parentId?: string } }) => { if (!event?.frame?.parentId) { cast.editing = undefined; page(); } }),
      tab.cdp.on('Page.navigatedWithinDocument', page),
      tab.cdp.on('Page.loadEventFired', page),
      tab.cdp.on('Page.javascriptDialogOpening', page), // the tab's own listener (side-driver/tab.ts) noted it first
      tab.cdp.on('Page.javascriptDialogClosed', page),
    );
    cast.local = () => this.giveBack(cast);
    tab.localPress = cast.local;
    cast.starting = (async () => {
      await tab.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined); // the caret shows
      if (cast.ended) return;
      if (cast.view) await this.fit(cast);
      await tab.cdp.send('Page.startScreencast', SCREENCAST);
      if (cast.ended) await tab.cdp.send('Page.stopScreencast').catch(() => undefined); // stopped while it started
    })().catch((error: unknown) => {
      cast.error = error instanceof Error && error.message ? error.message.split('\n')[0]!.slice(0, 200) : 'The live picture could not start for this tab.';
      // The viewer tries again with its next pull: the page stays where it is (no host window made and destroyed each time).
      this.stop(id, cast, true);
    });
    return cast;
  }

  /** The page takes the watcher's box as its size where it sits on the off-screen host (workspace-host.ts). */
  private fit(cast: Cast): Promise<void> {
    const view = cast.view;
    if (!view || cast.ended) return Promise.resolve();
    this.hold(cast);
    cast.tab.watcherView = view;
    this.deps.size?.(cast.id, view);
    return Promise.resolve();
  }

  /** A press here (SideTab.localPress): the pane's size again GIVE_BACK_MS after the last one – never between its down and up. */
  private giveBack(cast: Cast): void {
    if (this.casts.get(cast.id) !== cast || !cast.tab.watcherView) return;
    this.hold(cast);
    cast.back = this.setTimer(() => { cast.back = undefined; if (!cast.ended) this.unfit(cast); }, GIVE_BACK_MS);
  }

  private hold(cast: Cast): void { this.clearTimer(cast.back); cast.back = undefined; } // a give-back that waits is off

  /** The page's own size again (the box of its view here). */
  private unfit(cast: Cast): void {
    if (!cast.tab.watcherView) return;
    cast.tab.watcherView = undefined;
    this.deps.size?.(cast.id, undefined);
  }

  private renew(cast: Cast): void {
    this.clearTimer(cast.idle);
    cast.idle = this.setTimer(() => { if (this.casts.get(cast.id) === cast) this.stop(cast.id); }, CAST_IDLE_MS);
  }

  /** The page (and its dialog) to the runtime while the cast runs. */
  private tell(id: string, cast = this.casts.get(id), frame?: SideCastUpdate['frame']): void {
    const page = cast && { ...pageOf(cast.tab.contents, cast.tab.dialog), ...(cast.editing ? { editing: cast.editing } : {}) }; // T9: its focus takes text
    if (cast && page && !cast.ended) this.deps.send({ tab: id, page, live: true, ...(frame ? { frame } : {}) });
  }

  /** `again`: a new cast of the tab follows at once, so its page stays where it paints. */
  private stop(id: string, only?: Cast, again = false): void {
    const cast = this.casts.get(id);
    if (!cast || (only && cast !== only)) return;
    this.casts.delete(id);
    try { this.unfit(cast); } catch { /* the page is gone: nothing to give back */ }
    cast.ended = true;
    for (const off of cast.offs) off();
    if (cast.tab.localPress === cast.local) cast.tab.localPress = undefined;
    this.hold(cast);
    this.clearTimer(cast.timer);
    this.clearTimer(cast.idle);
    cast.pending = undefined;
    void cast.tab.cdp.send('Page.stopScreencast').catch(() => undefined);
    void cast.tab.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => undefined);
    if (!again) { try { this.deps.release?.(id); } catch { /* the page is gone with its window */ } }
  }

  private frame(cast: Cast, event: ScreencastFrame): void {
    if (this.gone(cast)) return;
    if (typeof event?.sessionId === 'number') void cast.tab.cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined);
    if (cast.ended || typeof event?.data !== 'string' || !frameFits(event.data, event.metadata ?? {})) return; // B-081: no squeezed in-between frame
    const wait = cast.lastAt + CAST_FRAME_GAP_MS - this.now();
    if (cast.timer === undefined && wait <= 0) { this.pass(cast, event); return; }
    cast.pending = event; // the newest waits for the next slot
    if (cast.timer !== undefined) return;
    cast.timer = this.setTimer(() => {
      cast.timer = undefined;
      const next = cast.pending;
      cast.pending = undefined;
      if (next && !cast.ended) this.pass(cast, next);
    }, Math.max(wait, 0));
  }

  private pass(cast: Cast, event: ScreencastFrame): void {
    if (this.gone(cast)) return; // 17.11.2026: a frame waited for its slot while its window closed – nobody to send it to
    cast.lastAt = this.now();
    const m = event.metadata ?? {};
    let zoom: number;
    try { zoom = finite(cast.tab.contents.getZoomFactor?.(), 1); } catch { this.stop(cast.id, cast); return; } // closed between the check and the read
    this.tell(cast.id, cast, {
      data: event.data as string,
      meta: { deviceWidth: finite(m.deviceWidth), deviceHeight: finite(m.deviceHeight), offsetTop: finite(m.offsetTop), pageScaleFactor: finite(m.pageScaleFactor, 1), zoom: zoom > 0 ? zoom : 1 },
    });
  }

  /**
   * The tab's page is gone (its window or tab was closed): the cast ends with it. Electron throws "Object has been
   * destroyed" on every read of a destroyed page, and a timer that threw it showed the app's default error dialog in front
   * of the shared screen (feedback 17.11.2026), so nothing here reads a page without asking first.
   */
  private gone(cast: Cast): boolean {
    let destroyed: boolean;
    try { destroyed = cast.tab.contents.isDestroyed(); } catch { destroyed = true; }
    if (destroyed) this.stop(cast.id, cast);
    return destroyed;
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  /** Unref'd: a waiting frame or give-back never keeps the app alive. */
  private setTimer(fn: () => void, ms: number): unknown { return this.deps.setTimer ? this.deps.setTimer(fn, ms) : setTimeout(fn, ms).unref(); }

  private clearTimer(handle: unknown): void {
    if (handle !== undefined) (this.deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(handle);
  }
}
