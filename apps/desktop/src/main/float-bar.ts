// Owner 18.11.2026 ("To-Do-Button … überall auf dem Bildschirm, auch wenn unsere App gerade nicht geöffnet ist"): the
// floating to-do button over the whole desktop. Three looks of one small always-on-top window: the dot (DOT px, drag it
// anywhere, a tap opens the panel), the panel (icons only: one more screenshot, dictate, call, send, fold to the edge,
// close; one text field; the shots as thumbnails, each removable) and the tab (TAB_W × TAB_H, glued to the nearest
// screen edge; a tap brings the dot back). The first opening of a draft takes a screenshot of the display under the
// button – the window is out of every capture (content protection), so the shot shows the screen, not us; closing and
// opening again shows the draft as it was (owner 19.11.2026: one automatic shot per draft, the camera adds more). Send
// uploads the shots (files.upload) and posts the words as one quick task (tasks.quickCreate, no target: Autark picks
// the owner). Call does the same and starts the call in the picked agent's 1:1 in the app's page without bringing the
// window up (deps.call; owner 19.11.2026: "da kann ich direkt einfach sprechen"); a task without an agent opens the task.
// While the page holds a call (setCall, from the page over IPC), the dot is the call pill: who, a live mark, the app
// and End (one tap). A retried post keeps its clientId, so a lost answer never makes a second task. Dictation: the page
// records a 16 kHz WAV, heard here through files.upload + voice.transcribe. The place, look and whether the bubble is
// hidden are kept in float-bar.json. Hidden (right-click › Hide bubble, or the tray): nothing shows; the global
// shortcut (FLOAT_KEYS) brings it back with the panel open, and otherwise opens or closes the panel.
// Holding the dot is the quick task (owner 18.11.2026): the screen at the hold's start ('hold'), the words heard at
// the release and posted at once ('quick'); nothing heard or a failed post opens the panel with both.
// Owns: the button's state, its actions and their RPC calls. Never: imports electron (the window comes from
// float-bar-window.ts), keeps a shot after the post, runs the call (the app's page does) or decides who does the task.

import { randomUUID } from 'node:crypto';
import type { BubbleCall, NavigateRequest } from '../shared/api/desktop.ts';
import type { MethodName, ParamsOf, ResultOf } from '../shared/api/methods.ts';
import { DOT, dotFromTab, dotOfPanel, inside, panelAt, sizeOf, tabAt, type FloatLook, type Rect } from './float-bar-place.ts';

export const MAX_SHOTS = 6;
export const FLOAT_KEYS = 'CommandOrControl+Alt+N';
/** How long the pill says "Calling…" before the page reports the call; a call that never starts drops it then. */
export const CALL_START_MS = 45_000;

export interface FloatPlace { x: number; y: number; look: 'dot' | 'tab'; hidden?: boolean }
export interface FloatShot { data: Uint8Array; mime: string; thumb: string }
/** One entry of the button's right-click menu. */
export interface FloatMenuItem { label: string; run(): void }

export interface FloatRpc {
  call<M extends MethodName>(method: M, params?: ParamsOf<M>, timeoutMs?: number): Promise<ResultOf<M>>;
}

/** What the window gives the logic (float-bar-window.ts, a fake in tests). */
export interface FloatWindow {
  bounds(): Rect;
  setBounds(rect: Rect): void;
  /** The work area of the display holding `point` (DIP). */
  workArea(point: { x: number; y: number }): Rect;
  /** The look changed: the page redraws (and the panel gets the keyboard). */
  show(look: FloatLook, focus: boolean): void;
  /** The bubble is hidden: nothing shows until the next show. */
  hide(): void;
  /** The view changed without a new look: the page redraws, nothing moves or takes focus. */
  redraw(): void;
  /** The right-click menu at the pointer. */
  menu(items: FloatMenuItem[]): void;
  /** Where the pointer is on the screen (DIP) – the rail icon's pull follows it. */
  cursor(): { x: number; y: number };
}

export interface FloatDeps {
  rpc: FloatRpc;
  /** A screenshot of the display holding `point`, as JPEG with a small thumbnail. */
  shot(point: { x: number; y: number }): Promise<FloatShot>;
  load(): FloatPlace | null;
  save(place: FloatPlace): void;
  /** Shows the app window at a chat or task (desktop.ts: the window's navigate). */
  open(request: NavigateRequest): void;
  /** Starts the chat's call in the app's page; the window stays as it is (hidden, minimized or behind). */
  call(conversationId: string): void;
  /** Ends the page's call in that chat. */
  endCall(conversationId: string): void;
  /** The bubble shows (true) or was hidden (false): the tray's Show/Hide entry. */
  shownChanged?(shown: boolean): void;
  /** A timer (default setTimeout); returns its cancel. */
  after?(ms: number, fn: () => void): () => void;
  /** The primary display's work area – where a first start puts the dot. */
  primaryArea(): Rect;
  log(line: string): void;
}

/** What the page sees after every action. */
export interface FloatView {
  look: FloatLook;
  shots: string[];
  text: string;
  note?: string;
  done?: boolean;
  /** The page's call (the pill; a folded tab shows it as its colour); `title` is "Calling…" until the page reports it. */
  call?: { title: string };
}

export type FloatAction =
  | { act: 'view' }
  | { act: 'open' }
  | { act: 'close' }
  | { act: 'fold' }
  | { act: 'unfold' }
  | { act: 'shot' }
  | { act: 'drop'; index: number }
  | { act: 'move'; x: number; y: number }
  | { act: 'moved' }
  | { act: 'text'; text: string }
  | { act: 'hear'; wav: string }
  | { act: 'unhear' }
  | { act: 'send'; text: string; call?: boolean }
  | { act: 'hold' }
  | { act: 'quick'; wav: string }
  | { act: 'menu' }
  | { act: 'hide' }
  | { act: 'app' }
  | { act: 'hangup' };

export class FloatBar {
  private look: FloatLook = 'dot';
  private dot: Rect;
  private shots: FloatShot[] = [];
  private text = '';
  private note: string | undefined;
  private done = false;
  private clientId = randomUUID();
  private busy = false;
  private held: FloatShot | null = null;
  /** This draft had its automatic screenshot (the first opening); a sent draft starts again. */
  private autoShot = false;
  private hidden = false;
  /** The rail icon holds the bubble under the pointer (handle). */
  private pulling = false;
  /** Counts the panel's cancels of a take being heard: a take heard across one drops its words. */
  private hearing = 0;
  /** The call the app's page reports, and the one asked for until the page reports it (with its expiry). */
  private call: BubbleCall | null = null;
  private calling: { conversationId: string; cancel(): void } | null = null;

  private readonly deps: FloatDeps;
  private readonly window: FloatWindow;

  constructor(deps: FloatDeps, window: FloatWindow) {
    this.deps = deps;
    this.window = window;
    const kept = deps.load();
    const area = deps.primaryArea();
    const start: Rect = kept ? { x: kept.x, y: kept.y, width: DOT, height: DOT } : { x: area.x + area.width - DOT - 16, y: area.y + Math.round(area.height * 0.6), width: DOT, height: DOT };
    this.dot = inside(start, window.workArea(start));
    this.hidden = kept?.hidden === true;
    if (kept?.look === 'tab') this.place('tab', false);
    else this.place('dot', false);
    deps.shownChanged?.(!this.hidden);
  }

  view(): FloatView {
    const call = this.call ? { title: this.call.title } : this.calling ? { title: 'Calling…' } : undefined;
    return {
      look: this.look, shots: this.shots.map((shot) => shot.thumb), text: this.text,
      ...(this.note ? { note: this.note } : {}), ...(this.done ? { done: true } : {}), ...(call ? { call } : {}),
    };
  }

  /** Whether the bubble shows (the tray's Show/Hide entry). */
  get shown(): boolean { return !this.hidden; }

  /** The shortcut: a hidden bubble comes back with the panel open; otherwise the panel opens or closes. */
  async toggle(): Promise<FloatView> {
    return this.look === 'panel' && !this.hidden ? this.act({ act: 'close' }) : this.act({ act: 'open' });
  }

  /** The tray's Show/Hide bubble: hidden keeps the draft and the place; shown comes back as the dot (or the tab, the pill). */
  setHidden(hidden: boolean): FloatView {
    if (hidden === this.hidden) return this.view();
    this.pulling = false;
    this.hidden = hidden;
    this.place(this.look === 'tab' ? 'tab' : 'dot', false);
    this.deps.shownChanged?.(!hidden);
    return this.view();
  }

  /**
   * 0.3.20 (owner 24.11.2026): the round icon in the app's left rail. `pull` brings the bubble out as the dot under the
   * pointer (also a hidden one), `move` keeps it under the pointer, `drop` leaves it where it is and keeps that place;
   * `press` (a click without a drag) brings a hidden bubble back to its last place. Main reads the pointer itself.
   */
  handle(step: 'pull' | 'move' | 'drop' | 'press'): void {
    if (step === 'press') { if (this.hidden) this.setHidden(false); return; }
    if (step === 'pull') {
      if (this.hidden) { this.hidden = false; this.deps.shownChanged?.(true); }
      const at = this.window.cursor();
      this.dot = { x: Math.round(at.x - DOT / 2), y: Math.round(at.y - DOT / 2), width: DOT, height: DOT };
      this.pulling = true;
      this.place('dot', false);
      return;
    }
    if (!this.pulling) return;
    const at = this.window.cursor();
    this.dot = inside({ x: Math.round(at.x - DOT / 2), y: Math.round(at.y - DOT / 2), width: DOT, height: DOT }, this.window.workArea(at));
    const area = this.area();
    this.window.setBounds(this.look === 'call' || this.look === 'panel' ? panelAt(this.dot, area, this.look) : this.dot);
    if (step === 'drop') {
      this.pulling = false;
      this.keep();
    }
  }

  /**
   * The app's page holds this call now, or none (IPC bubbleCall). The pill shows it in place of the dot; an open panel
   * or a folded tab stays and only redraws (the tab takes the call's colour).
   */
  setCall(call: BubbleCall | null): void {
    if (call && this.calling?.conversationId === call.conversationId) this.stopCalling();
    if (JSON.stringify(call) === JSON.stringify(this.call)) return;
    this.call = call;
    this.restyle();
  }

  /** The app's page is gone (window closed, renderer died): its call – and one still starting – ended with it. */
  pageGone(): void {
    if (this.pulling) { this.pulling = false; this.keep(); }
    if (!this.call && !this.calling) return;
    this.stopCalling();
    this.call = null;
    this.restyle();
  }

  async act(action: FloatAction): Promise<FloatView> {
    this.done = false;
    switch (action.act) {
      case 'view': break;
      case 'open':
        if (this.hidden) { this.hidden = false; this.deps.shownChanged?.(true); }
        if (this.look === 'tab') this.dot = dotFromTab(this.window.bounds(), this.area());
        this.note = undefined;
        this.place('panel', true);
        if (!this.autoShot) { this.autoShot = true; await this.takeShot(); } // one automatic shot per draft
        break;
      case 'close': this.place('dot', false); break;
      case 'fold': this.place('tab', false); break;
      case 'unfold': this.dot = dotFromTab(this.window.bounds(), this.area()); this.place('dot', false); break;
      case 'menu': this.window.menu([
        { label: 'Open Autark', run: () => this.deps.open(this.call ? { conversationId: this.call.conversationId } : {}) },
        { label: 'Hide bubble (Ctrl+Alt+N brings it back)', run: () => { this.setHidden(true); } },
      ]); break;
      case 'hide': this.setHidden(true); break;
      case 'app': this.deps.open(this.call ? { conversationId: this.call.conversationId } : {}); break;
      case 'hangup': this.hangUp(); break;
      case 'shot': await this.takeShot(); break;
      case 'drop': this.shots.splice(action.index, 1); break;
      case 'move': { // always the look's own size: Windows grows a scaled window that is moved by setPosition alone
        const at = { x: Math.round(action.x), y: Math.round(action.y), ...sizeOf(this.look) };
        this.window.setBounds(inside(at, this.window.workArea(at)));
        break;
      }
      case 'moved': {
        const now = { ...this.window.bounds(), ...sizeOf(this.look) };
        if (this.look === 'dot') this.dot = now;
        else if (this.look === 'panel' || this.look === 'call') this.dot = dotOfPanel(now, this.window.workArea(now));
        if (this.look === 'tab') this.window.setBounds(tabAt(now, this.window.workArea(now)));
        this.keep();
        break;
      }
      case 'text': this.text = action.text.slice(0, 8000); break;
      case 'hear': await this.hear(action.wav); break;
      case 'unhear': this.hearing++; this.note = undefined; break; // the panel's ×: the words still being heard go nowhere
      case 'send': await this.send(action.text, action.call === true); break;
      case 'hold': await this.hold(); break;
      case 'quick': await this.quick(action.wav); break;
    }
    return this.view();
  }

  private area(): Rect {
    return this.window.workArea({ x: this.dot.x + DOT / 2, y: this.dot.y + DOT / 2 });
  }

  /** Shows `look` – the dot is the call pill while a call runs; a hidden bubble only keeps the look for later. */
  private place(asked: FloatLook, focus: boolean): void {
    const look: FloatLook = asked === 'dot' && this.view().call ? 'call' : asked === 'call' && !this.view().call ? 'dot' : asked;
    this.look = this.hidden && look === 'panel' ? 'dot' : look;
    const area = this.area();
    const rect = this.look === 'panel' || this.look === 'call' ? panelAt(this.dot, area, this.look) : this.look === 'tab' ? tabAt(this.dot, area) : inside(this.dot, area);
    this.window.setBounds(rect);
    if (this.hidden) this.window.hide();
    else this.window.show(this.look, focus);
    this.keep();
  }

  /** The call came, changed or went: the dot and the pill swap; the panel and the tab only redraw. */
  private restyle(): void {
    if (this.look === 'dot' || this.look === 'call') this.place('dot', false);
    else if (!this.hidden) this.window.redraw();
  }

  private keep(): void {
    const look = this.look === 'tab' ? 'tab' : 'dot';
    try { this.deps.save({ x: this.dot.x, y: this.dot.y, look, ...(this.hidden ? { hidden: true } : {}) }); } catch { /* the place is a convenience */ }
  }

  /** Call: the page starts it in the chat; the pill says "Calling…" until the page reports it, at most CALL_START_MS. */
  private startCall(conversationId: string): void {
    this.stopCalling();
    const after = this.deps.after ?? ((ms: number, fn: () => void) => { const timer = setTimeout(fn, ms); timer.unref?.(); return () => clearTimeout(timer); });
    const cancel = after(CALL_START_MS, () => { if (this.calling?.conversationId === conversationId) { this.calling = null; this.restyle(); } });
    this.calling = { conversationId, cancel };
    this.deps.call(conversationId);
  }

  private stopCalling(): void {
    this.calling?.cancel();
    this.calling = null;
  }

  /** End: the page ends the call (and one still starting); the pill goes at once. */
  private hangUp(): void {
    const id = this.call?.conversationId ?? this.calling?.conversationId;
    this.stopCalling();
    this.call = null;
    if (id) this.deps.endCall(id);
    this.restyle();
  }

  private async takeShot(): Promise<void> {
    if (this.shots.length >= MAX_SHOTS) { this.note = `${MAX_SHOTS} screenshots at most.`; return; }
    try {
      const middle = { x: this.dot.x + DOT / 2, y: this.dot.y + DOT / 2 };
      this.shots.push(await this.deps.shot(middle));
    } catch (error) {
      this.note = 'No screenshot: ' + message(error);
    }
  }

  /** A hold on the dot began: the screen as it is now (the words follow at the release). */
  private async hold(): Promise<void> {
    try {
      this.held = await this.deps.shot({ x: this.dot.x + DOT / 2, y: this.dot.y + DOT / 2 });
    } catch (error) {
      this.held = null;
      this.deps.log(`float bar hold shot failed: ${message(error)}`);
    }
  }

  /**
   * Owner 18.11.2026 ("drückt einfach nur drauf, spricht rein … und geht in den Task rein mit dem Bildschirm"): the
   * hold's words, heard and posted at once with the hold's shot. When nothing was heard or the post fails, the panel
   * opens with the shot and the words, so nothing is lost.
   */
  private async quick(wav: string): Promise<void> {
    const shot = this.held;
    this.held = null;
    const before = { shots: this.shots, text: this.text, clientId: this.clientId, autoShot: this.autoShot };
    this.shots = shot ? [shot] : [];
    this.text = '';
    await this.hear(wav);
    if (this.text.trim()) {
      this.clientId = randomUUID();
      await this.send(this.text, false);
      if (this.done) { Object.assign(this, before); return; }
    } else {
      this.note ??= 'Nothing heard – say it again or type it.';
    }
    this.autoShot = before.autoShot || this.shots.length > 0; // the hold's shot is this draft's own
    this.shots = [...before.shots, ...this.shots].slice(0, MAX_SHOTS);
    this.text = [before.text.trim(), this.text.trim()].filter(Boolean).join(' ');
    this.place('panel', true);
  }

  private async upload(name: string, mime: string, data: Uint8Array): Promise<string> {
    const ref = await this.deps.rpc.call('files.upload', { name, mime, dataBase64: Buffer.from(data).toString('base64') }, 60_000);
    return ref.id;
  }

  private async hear(wav: string): Promise<void> {
    const take = this.hearing;
    try {
      const data = Buffer.from(wav, 'base64');
      if (data.length < 1000) return; // a tap, not a take
      const fileId = await this.upload(`dictation-${Date.now()}.wav`, 'audio/wav', data);
      const heard = await this.deps.rpc.call('voice.transcribe', { fileId }, 120_000);
      if (take !== this.hearing) return; // cancelled meanwhile
      const words = heard.text.trim();
      if (words) this.text = this.text.trim() ? `${this.text.trimEnd()} ${words}` : words;
      this.note = undefined;
    } catch (error) {
      if (take === this.hearing) this.note = 'Not heard: ' + message(error);
    }
  }

  private async send(text: string, call: boolean): Promise<void> {
    if (this.busy) return;
    this.text = text.slice(0, 8000);
    if (!this.text.trim() && !this.shots.length) { this.note = 'Type or say what should be done.'; return; }
    this.busy = true;
    try {
      const attachments: Array<{ fileId: string; name: string }> = [];
      for (const [index, shot] of this.shots.entries()) {
        const name = `screen-${index + 1}.jpg`;
        attachments.push({ fileId: await this.upload(name, shot.mime, shot.data), name });
      }
      const { task } = await this.deps.rpc.call('tasks.quickCreate', { text: this.text.trim(), attachments, clientId: this.clientId }, 60_000);
      if (call && task.assigneeKind === 'agent' && task.assigneeId) {
        const chat = await this.deps.rpc.call('chats.direct', { memberId: task.assigneeId });
        this.startCall(chat.id); // the window stays where it is: the pill shows the call
      } else if (call) {
        this.deps.open({ taskId: task.id });
      }
      this.shots = [];
      this.text = '';
      this.note = undefined;
      this.clientId = randomUUID();
      this.autoShot = false;
      this.place('dot', false);
      this.done = true;
    } catch (error) {
      this.note = 'Not sent: ' + message(error);
      this.deps.log(`float bar post failed: ${message(error)}`);
    } finally {
      this.busy = false;
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'error';
}
