// What the side driver knows about one side tab from its DevTools events – console and
// network buffers, an open page dialog, main-frame navigations (the document count refs belong to),
// loading, and the person's own input reported from the driver's isolated world. The agents' own mouse
// and key events reach that listener too (they are trusted input): points and keys the driver just
// dispatched are told apart and never count as the person's. B-081: a watched tab (caster.ts) also knows when the
// watcher's input last went in (`watcherAt`) and the watcher's viewport it has (`watcherView`); a click's end ('up')
// or a key of the person here that is neither an agent's nor the watcher's echo calls `localPress`. B-081: the Pin button's picker
// (pick-script.ts) – `picking` is what the button wants, set at once (armed again in every new document of the main
// frame while it holds), its pins and its end (Esc) from the top frame's world only, checked by pagePick, to `pick`;
// `holdPicking` lets main's own input through to the page while it goes in (an agent's act batch, a watcher's input).
// Owns: the per-tab state and the person/agent/watcher input split. Never: decides what an agent may do (driver.ts).

import { pagePick, type PickedElement } from '../../shared/model/page-pick.ts';
import type { PointerAction } from '../../shared/model/pointers.ts';
import type { Point } from '../../shared/model/pointer-motion.ts';
import type { SideViewSize } from '../../shared/model/side-view.ts';
import { BINDING, TabCdp, WORLD, type ContentsLike } from './cdp.ts';
import { ConsoleLog, NetworkLog } from './logs.ts';
import { SideGuard } from './guard.ts';
import type { RefInfo } from './snapshot.ts';

/** The person's report from the page: input kind, viewport CSS px (top frame only), what is under it (control, short selector). */
export interface PersonInput { action: PointerAction; x?: number; y?: number; target?: { role?: string; name?: string; selector?: string }; frame: boolean }
export interface SideTabOptions {
  now: () => number;
  person: (tab: SideTab, input: PersonInput) => void;
  /** B-081: a pin from the picker, or null when it ended in the page (Esc). */
  pick?: (tab: SideTab, pick: PickedElement | null) => void;
}

const OWN_POINT_MS = 1500;
const OWN_KEY_MS = 800;
/** A press reported within this time of the watcher's input is the watcher's own, echoed by the page. */
export const WATCHER_ECHO_MS = 1000;
const CONSOLE_RELEASE_EVERY = 100;

export class SideTab {
  readonly id: string;
  readonly cdp: TabCdp;
  /** 25.11.2026: Secure mode's guard while an agent drives this tab (guard.ts). */
  readonly guard: SideGuard;
  readonly console = new ConsoleLog();
  readonly network = new NetworkLog();
  /** Counts main-frame documents: refs and looks belong to one. */
  doc = 0;
  /** A main-frame load runs; `domReady`: its document is parsed (DOMContentLoaded, load, or loading stopped). */
  navigating = false;
  domReady = false;
  dialog?: { type: string; message: string };
  /** When the person last used this tab (epoch ms; 0 = never since attach). */
  personAt = 0;
  /** B-081: when a watcher's input last went to the page (caster.ts), its viewport while the page has it, a press here. */
  watcherAt = 0;
  watcherView?: SideViewSize;
  localPress?: () => void;
  /** B-081: the Pin button's picker is on here (the button's wish; the page follows it). */
  picking = false;
  private pickSeq = 0;
  private holds = 0;
  private held: Promise<unknown> = Promise.resolve();
  /** What the latest snapshot or find said about each ref (role and name). */
  refs = new Map<string, RefInfo>();
  /** Each agent's cursor position here. */
  readonly cursors = new Map<string, Point>();
  private ownPoints: Array<{ x: number; y: number; at: number }> = [];
  private ownLast?: Point;
  private ownKeyAt = 0;
  private ownAt = 0;
  private readonly now: () => number;
  private readonly waiters = new Set<() => void>();
  private readonly mutations = new Set<() => void>();
  private onPerson: (input: PersonInput) => void;
  private onPick: (pick: PickedElement | null) => void;

  constructor(id: string, contents: ContentsLike, options: SideTabOptions) {
    this.id = id;
    this.now = options.now;
    this.onPerson = (input) => options.person(this, input);
    this.onPick = (pick) => options.pick?.(this, pick);
    const cdp = (this.cdp = new TabCdp(contents));
    this.guard = new SideGuard(cdp);
    cdp.on('Runtime.executionContextCreated', (p) => { // a new document of the main frame: the picker goes on again there
      const context = p?.context;
      if (!this.picking || context?.name !== WORLD || typeof context.id !== 'number' || !cdp.isTopWorld(context.id)) return;
      void cdp.send('Runtime.evaluate', { expression: `__wfSide.pick(true, ${this.holds > 0})`, contextId: context.id }).catch(() => {});
    });
    cdp.on('Runtime.consoleAPICalled', (p) => {
      this.console.api(p);
      // Console arguments stay alive in the page until released: let go of them now and then.
      if (this.console.count % CONSOLE_RELEASE_EVERY === 0) void cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'console' }).catch(() => {});
    });
    cdp.on('Runtime.exceptionThrown', (p) => this.console.exception(p));
    cdp.on('Log.entryAdded', (p) => this.console.entry(p));
    cdp.on('Network.requestWillBeSent', (p) => { this.network.sent(p); this.kick(); });
    cdp.on('Network.responseReceived', (p) => this.network.response(p));
    cdp.on('Network.loadingFinished', (p) => { this.network.finished(p); this.kick(); });
    cdp.on('Network.loadingFailed', (p) => { this.network.failed(p); this.kick(); });
    cdp.on('Page.javascriptDialogOpening', (p) => { this.dialog = { type: String(p.type ?? 'alert'), message: String(p.message ?? '').slice(0, 300) }; this.kick(); });
    cdp.on('Page.javascriptDialogClosed', () => { this.dialog = undefined; this.kick(); });
    const parsed = () => { this.navigating = false; this.domReady = true; this.kick(); };
    cdp.on('Page.frameStartedLoading', (p) => { if (p.frameId === cdp.mainFrame) { this.navigating = true; this.domReady = false; this.kick(); } });
    cdp.on('Page.frameStoppedLoading', (p) => { if (p.frameId === cdp.mainFrame) parsed(); });
    cdp.on('Page.domContentEventFired', parsed);
    cdp.on('Page.loadEventFired', parsed);
    cdp.on('Page.frameNavigated', (p) => {
      if (p.frame?.parentId) return;
      this.doc += 1;
      this.domReady = false;
      this.refs.clear();
      this.dialog = undefined;
      this.console.navigated(String(p.frame?.url ?? ''));
      this.kick();
    });
    cdp.on('Page.navigatedWithinDocument', (p) => { if (p.frameId === cdp.mainFrame) this.kick(); });
    cdp.on('Runtime.bindingCalled', (p) => this.binding(p));
  }

  get contents(): ContentsLike { return this.cdp.contents; }

  /** Something happened in the page (wakes waits). */
  private kick(): void { for (const wake of [...this.waiters]) wake(); }

  /** Calls `wake` on every page event (navigation, load, dialog, network, document change) until unsubscribed. */
  onEvent(wake: () => void): () => void { this.waiters.add(wake); return () => { this.waiters.delete(wake); }; }

  /** Calls `wake` on each document change the page reports (only while a wait watches). */
  onMutation(wake: () => void): () => void { this.mutations.add(wake); return () => { this.mutations.delete(wake); }; }

  private binding(p: { name?: string; payload?: string; executionContextId?: number }): void {
    if (p.name !== BINDING || typeof p.payload !== 'string' || p.payload.length > 4000) return;
    let data: Record<string, unknown>;
    try { data = JSON.parse(p.payload) as Record<string, unknown>; } catch { return; }
    if (data.k === 'mut') { for (const wake of [...this.mutations]) wake(); this.kick(); return; }
    const top = typeof p.executionContextId === 'number' && this.cdp.isTopWorld(p.executionContextId) && data.frame !== 1;
    if (data.k === 'pick') { if (top) this.picked(data); return; }
    if (data.k !== 'in') return;
    const action = data.e === 'click' || data.e === 'type' || data.e === 'scroll' ? data.e : 'move';
    const x = typeof data.x === 'number' && Number.isFinite(data.x) ? data.x : undefined;
    const y = typeof data.y === 'number' && Number.isFinite(data.y) ? data.y : undefined;
    const key = typeof data.key === 'string' ? data.key : undefined;
    // a press ends here: no report of its own (personAt and the pointer line stay with its down), only the give-back
    if (data.e === 'up') { if (!this.own('click', top ? x : undefined, top ? y : undefined, key) && this.now() - this.watcherAt > WATCHER_ECHO_MS) this.localPress?.(); return; }
    if (this.own(action, top ? x : undefined, top ? y : undefined, key)) return;
    this.personAt = this.now();
    if (action === 'type' && this.personAt - this.watcherAt > WATCHER_ECHO_MS) this.localPress?.(); // a click: on its up ('up')
    const raw = data.target as { role?: unknown; name?: unknown; sel?: unknown } | undefined;
    const target = raw && typeof raw === 'object'
      ? {
        ...(typeof raw.role === 'string' && raw.role ? { role: raw.role.slice(0, 40) } : {}), ...(typeof raw.name === 'string' && raw.name ? { name: raw.name.slice(0, 80) } : {}),
        ...(typeof raw.sel === 'string' && raw.sel ? { selector: raw.sel.slice(0, 100) } : {}),
      }
      : undefined;
    this.onPerson({ action, frame: !top, ...(top && x !== undefined && y !== undefined ? { x, y } : {}), ...(target && (target.role || target.name || target.selector) ? { target } : {}) });
  }

  /** B-081: a pin (checked; a click the driver dispatched lately is none) or the picker's end in the page. */
  private picked(data: Record<string, unknown>): void {
    if (data.off === 1) { this.picking = false; this.onPick(null); return; }
    const pick = pagePick(data);
    if (!pick || (pick.at && this.ownPoint(pick.at.x, pick.at.y, this.now()))) return;
    this.personAt = this.now();
    this.onPick(pick);
  }

  /** B-081: the picker on or off – at once for every new document, then in the page; true when the page took it. */
  async setPicking(on: boolean): Promise<boolean> {
    const seq = ++this.pickSeq;
    this.picking = on;
    const ok = await this.applyPicking();
    if (on && !ok && seq === this.pickSeq) this.picking = false; // the page cannot take it: the button goes back (driver.pick)
    return ok;
  }

  /** B-081: main's own input goes in (an act batch, a watcher's): the page's picker lets it through until the last hold ends. */
  async holdPicking(hold: boolean): Promise<void> {
    const before = this.holds > 0;
    this.holds = Math.max(0, this.holds + (hold ? 1 : -1));
    if (this.picking && before !== this.holds > 0) this.held = this.applyPicking();
    if (hold) await this.held;
  }

  /** The page's picker as it should be now (on, held); true when the page agrees. */
  private applyPicking(): Promise<boolean> {
    const on = this.picking;
    return this.cdp.inWorld<boolean>(`__wfSide.pick(${on}, ${this.holds > 0})`).then((value) => value === on, () => false);
  }

  /** Was this input the driver's own (a point it dispatched, a key it pressed)? */
  private own(action: PointerAction, x: number | undefined, y: number | undefined, key: string | undefined): boolean {
    const now = this.now();
    if (action === 'type') return now - this.ownKeyAt < OWN_KEY_MS && key !== undefined;
    if (x === undefined || y === undefined) return now - this.ownAt < 1000;
    if (this.ownLast && Math.abs(this.ownLast.x - x) <= 1.5 && Math.abs(this.ownLast.y - y) <= 1.5) return true; // Chromium's moves at the last CDP point
    return this.ownPoint(x, y, now);
  }

  /** A point the driver dispatched within OWN_POINT_MS (3 px). */
  private ownPoint(x: number, y: number, now: number): boolean {
    return this.ownPoints.some((p) => now - p.at < OWN_POINT_MS && Math.abs(p.x - x) <= 3 && Math.abs(p.y - y) <= 3);
  }

  /** The driver dispatches a mouse event at this point. */
  agentPoint(x: number, y: number): void {
    const now = this.now();
    this.ownAt = now;
    this.ownLast = { x, y };
    this.ownPoints.push({ x, y, at: now });
    if (this.ownPoints.length > 120) this.ownPoints = this.ownPoints.filter((p) => now - p.at < OWN_POINT_MS).slice(-120);
  }

  /** The driver dispatches a key. */
  agentKey(): void { this.ownKeyAt = this.now(); this.ownAt = this.ownKeyAt; }

  private watching = 0;
  private watchedDoc = -1;

  /** Document changes are reported while at least one wait watches (re-armed on a new document). */
  async watch(on: boolean): Promise<void> {
    this.watching = Math.max(0, this.watching + (on ? 1 : -1));
    await this.rewatch();
  }

  /** After a navigation the new document starts unwatched: switch it on again while someone waits. */
  async rewatch(): Promise<void> {
    const want = this.watching > 0;
    if (want && this.watchedDoc === this.doc) return;
    this.watchedDoc = want ? this.doc : -1;
    await this.cdp.inWorld(`__wfSide.watch(${want})`).catch(() => { this.watchedDoc = -1; });
  }

  /** Did the person use this tab within `ms`? */
  personActive(ms = 2000): boolean { return this.personAt > 0 && this.now() - this.personAt < ms; }

  dispose(): void {
    this.waiters.clear();
    this.mutations.clear();
    this.guard.dispose();
    this.cdp.dispose();
  }
}
