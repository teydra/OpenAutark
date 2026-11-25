// The desktop bridge: IPC channel names between preload and main, and the shape of
// `window.workforce` that the preload exposes to the UI (src/ui reads it only on desktop).
// Owns: channel names and the typed API surface. Never: business data – everything that is
// state lives in the runtime and travels over the RPC MessagePort, not over these channels.
// Speech never crosses this bridge: the page records and uploads over the runtime port, and only
// asks main to open the microphone (armMedia).

import type { FileRef, UpdateState } from '../model/system.ts';
import type { WorkspaceBrowserApi } from './workspace-browser.ts';

/** The desktop header row's height in CSS px (styles/tokens.css --header-h): native window
 *  controls share that row on every OS (main/title-bar.ts). */
export const TITLE_BAR_HEIGHT = 48;

/** The UI's layout as main needs it for the native caption controls: the column header row, or
 *  the compact (phone-stack) window – on Windows/Linux its top bar is a row of the same height
 *  that holds the controls (styles/mobile.css). */
export type TitleBarLayout = 'columns' | 'compact';

/** The feedback shortcut's key going down or up (shared/api/workspace-browser-keys.ts FeedbackKey: auto-repeats never
 *  arrive) – the feedback cell's press from the keyboard: short opens the snapshot, held is talk (ui/feedback/press.ts). */
export type FeedbackKeyStep = 'down' | 'up';

/** window.postMessage payload the preload uses to hand the runtime port to the page. */
export const PORT_MESSAGE = 'workforce-port';

export const IPC = {
  // runtime connection
  runtimeConnect: 'runtime:connect', // renderer → main (send)
  runtimePort: 'runtime:port', // main → renderer, carries the MessagePort
  runtimeStatus: 'runtime:status', // main → renderer
  // updates
  updateGet: 'update:get',
  updateApply: 'update:apply',
  updateDefer: 'update:defer',
  updateReady: 'update:ready', // renderer → main: UI is in a restart-safe state (sent on change only)
  updateState: 'update:state', // main → renderer
  prepareRestart: 'app:prepare-restart', // main → renderer (request id)
  prepareRestartAck: 'app:prepare-restart-ack', // renderer → main (request id, ok)
  // microphone / camera arming (user action): dictation, voice conversation, calls and recorder widgets
  mediaArm: 'media:arm',
  // misc host helpers
  captureWindow: 'capture:window',
  captureScreen: 'capture:screen',
  filesPick: 'files:pick',
  filesPickFolder: 'files:pick-folder',
  filesOpen: 'files:open',
  clipboardWrite: 'clipboard:write',
  openExternal: 'shell:open-external',
  navigate: 'app:navigate', // main → renderer (notification click)
  titleBarLayout: 'window:title-bar-layout', // renderer → main (send): TitleBarLayout, on change
  titleBarDim: 'window:title-bar-dim', // renderer → main (send): boolean, on change – a modal's backdrop dims the window (main/title-bar.ts dimmedColors)
  feedbackKey: 'feedback:key', // main → renderer: FeedbackKeyStep – Ctrl+Shift+F (Cmd on macOS) pressed or released anywhere in the window
  online: 'app:online', // renderer → main (send): the window's navigator 'online' event; main pushes host power 'online' (B-044)
  // owner 19.11.2026: voice goes on while the window is hidden, and the floating bubble shows and ends the page's call
  voiceLive: 'voice:live', // renderer → main (send): boolean, on change – a call, conversation or dictation of the page is live
  bubbleCall: 'bubble:call', // renderer → main (send): BubbleCall | null, on change – the page's call the bubble shows
  bubbleEnd: 'bubble:end-call', // main → renderer: conversation id – the bubble's End
  // 0.3.20 (owner 24.11.2026): the round bubble icon in the app's left rail pulls the floating bubble out under the mouse
  bubbleHandle: 'bubble:handle', // renderer → main (send): BubbleHandleStep – pull, move, drop, press (main reads the pointer itself)
  bubbleStateGet: 'bubble:state-get', // renderer → main (invoke): BubbleHandleState
  bubbleState: 'bubble:state', // main → renderer: BubbleHandleState – the bubble came out or was hidden
} as const;

/** The rail icon's gesture steps (coordinates are never sent: main takes the pointer's place from the screen). */
export type BubbleHandleStep = 'pull' | 'move' | 'drop' | 'press';
/** What the rail icon needs: this PC has the floating bubble (first company only), and whether it is out on the screen. */
export interface BubbleHandleState { available: boolean; out: boolean }

/** The call the page holds, as the floating bubble shows it (owner 19.11.2026): the chat and its title (the agent's name in a 1:1). */
export interface BubbleCall { conversationId: string; title: string }

/**
 * Envelope of every invoke channel's answer (main never throws across IPC, so the preload can
 * rethrow a clean Error with the code instead of Electron's wrapped message).
 */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export type RuntimeStatus =
  | { state: 'starting' }
  | { state: 'up' } // call connect() again after every 'up' (a restarted runtime closed the old port)
  | { state: 'restarting'; inMs: number }
  | { state: 'stopped' };

export type PickKind = 'files' | 'folder' | 'images' | 'audio' | 'video';
/** What a picked folder is for – main chooses the dialog's title and button from it (Settings › About: the backup to restore; Settings › Security: a folder the team works in). */
export type FolderPurpose = 'backup' | 'restore' | 'chats' | 'security';

/** Where the app window opens: a chat or a task; `call` (the floating to-do button, owner 18.11.2026) starts the chat's call there. */
export interface NavigateRequest { conversationId?: string; taskId?: string; call?: true }

/**
 * `window.workforce` (desktop only; the PWA has no such object).
 *
 * Connecting to the runtime (package C1): contextBridge cannot pass MessagePorts, so the preload re-posts the port to
 * the page with window.postMessage, where the main-world wrapper takes it (see the guarded hand-over below); the port
 * carries JSON-RPC frames (protocol.ts) both ways, owner scope. After `onRuntime({state:'up'})` following a restart,
 * connect again.
 */
export interface WorkforceDesktopApi {
  workspaceBrowser?: WorkspaceBrowserApi;
  platform: string;
  titleBarHeight: number;
  /** Reports the UI's layout so the caption controls match its header row (send on change). */
  setTitleBarLayout?(layout: TitleBarLayout): void;
  /** A modal dialog's backdrop dims the window (true) or none is open (false): the caption controls take the dimmed
   *  colors, so they never stay bright over a dark window (send on change). */
  setTitleBarDim?(dim: boolean): void;
  /** The feedback shortcut (Ctrl+Shift+F, Cmd+Shift+F on macOS) went down or up – in the app's page or a side browser
   *  page (main reads it in before-input-event; the page never gets it). */
  onFeedbackKey?(listener: (step: FeedbackKeyStep) => void): () => void;
  /** Asks main for a fresh runtime port; resolves once the port was posted to the page. */
  connect(): Promise<void>;
  onRuntime(listener: (status: RuntimeStatus) => void): () => void;
  updates: {
    state(): Promise<UpdateState>;
    apply(): Promise<UpdateState>;
    defer(): Promise<UpdateState>;
    /** Tell main whether the UI is safe to restart (no open dialog/settings, empty composer). Send on change. */
    setReady(ready: boolean): void;
  };
  onUpdate(listener: (state: UpdateState) => void): () => void;
  /** Called before an update restart; resolve after drafts are saved (they normally already are). */
  onPrepareRestart(handler: () => Promise<void> | void): () => void;
  /** Arms microphone/camera permission for 15 s (call from a user gesture before getUserMedia). */
  armMedia(kinds: Array<'audio' | 'video'>): Promise<void>;
  capture: {
    window(): Promise<string>; // PNG data URL
    screen(): Promise<string>; // PNG data URL of the primary display
  };
  files: {
    pick(kind: PickKind): Promise<FileRef[]>; // uploaded into the runtime blob store
    openPath(fileId: string, reveal?: boolean): Promise<void>;
    /** The absolute path of a folder the person chose (nothing is read or uploaded); null when cancelled. */
    pickFolder?(purpose: FolderPurpose): Promise<string | null>;
  };
  clipboard: { writeText(text: string): Promise<void> };
  openExternal(url: string): Promise<void>;
  onNavigate(listener: (request: NavigateRequest) => void): () => void;
  /** A call, conversation or dictation of this page is live (true) or none is: main keeps the hidden window's page at full
   *  speed meanwhile (send on change). */
  voiceLive?(on: boolean): void;
  /** The call this page holds now, or null – the floating bubble shows it (send on change). */
  bubbleCall?(call: BubbleCall | null): void;
  /** The floating bubble's End: end this page's call in that chat. */
  onEndCall?(listener: (conversationId: string) => void): () => void;
  /** The rail's bubble icon: one gesture step (send); main moves the floating bubble to the pointer. */
  bubbleHandle?(step: BubbleHandleStep): void;
  bubbleState?(): Promise<BubbleHandleState>;
  onBubbleState?(listener: (state: BubbleHandleState) => void): () => void;
}

/**
 * The guarded hand-over of the runtime port (preload/main-world.ts and ui/lib/runtime-port.ts) – the one way:
 *
 * - `window.workforce.claimConnector()` is one-shot: the UI boot claims it before any other
 *   code loads and gets a connector `(done: (port?: MessagePort, error?: unknown) => void) =>
 *   void` that opens one runtime port per call (calls run one at a time, in order). A second
 *   claim throws, and from then on the public `connect()` rejects ("The runtime connection
 *   belongs to the app window."). Reconnects after a runtime restart use the same connector.
 * - Tagged port message: the preload posts a real port with the data `${PORT_MESSAGE}:<random
 *   hex>` (a per-page tag only the wrapper knows), not with PORT_MESSAGE. A capture-phase
 *   window 'message' listener, registered before any page script, swallows every message whose
 *   data is the tag or PORT_MESSAGE (stopImmediatePropagation): page listeners never see a
 *   runtime port, and a port a page script posts with PORT_MESSAGE is closed unused.
 * The connector's type lives with its two ends (preload/main-world.ts PortConnector, mirrored
 * by ui/lib/runtime-port.ts); `claimConnector` is added to `window.workforce` by the wrapper,
 * not by the preload's WorkforceDesktopApi object.
 */
