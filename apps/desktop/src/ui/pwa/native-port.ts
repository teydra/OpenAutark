// B-084 (decision 4) the one channel between the page and the Android app: after every main-frame page load the app
// (NativePort.java) posts the string 'autark-port' with ONE MessagePort to this page's origin (WebView.postWebMessage);
// messages are JSON strings `{t: <type>, ...}` both ways. No addJavascriptInterface: an agent's sandboxed iframe can
// neither receive this port (opaque origin) nor hand the page a fake one (only a message from the top window counts).
// App → page types: companies, status, share, speechDone, saved, resume, shot, crash, feedback, woken, voice.stop; page → app:
// colors, card, switch, add, forget, pcs, speak, stopSpeech, download, haptic, shot, wake (W 19.11.: settings/device-wake.ts),
// voice.live {on, kind} (19.11.: boot/voice-live.ts – the app keeps voice running in the background; voice.stop ends it all,
// boot/desktop.ts stopAllVoice). Owner 19.11.2026 (the to-do bubble's way back, pwa/bubble-handle.tsx): page → app
// bubble.pull {x?, y?}, bubble.move {x, y}, bubble.drop {x, y} (CSS px of the viewport); app → page bubble.state
// {available, out}. The last 'companies', 'status', 'crash' and 'bubble.state' are
// replayed to a late subscriber, and the local type 'port' tells a subscriber that a (new) port arrived – right away when
// one is already here. Feedback 16.11.2026: {t:'shot'} asks the Android app for a picture of its own window
// (PixelCopy) and requestNativeShot waits at most SHOT_WAIT_MS for {t:'shot', data} – a JPEG data URL – or {t:'shot',
// error}; the app sends {t:'crash', text} once the person tapped "Report" on its crash screen (the feedback form takes
// it), and {t:'feedback', down} for its quick way in – volume up and volume down pressed together go down (true) and are
// let go (false); feedbackKeySteps reads it, the feedback cell answers it as its own press (FeedbackButton.tsx).
// STIMME 21.11.2026: page → app {t:'hear', id, data, mime, language?} – a dictation piece (base64) the app (its
// 'status' says hear:true – nativeCan('hear'); the iPhone app does not) posts to the person's ChatGPT plan itself; app → page {t:'heard', id, text}
// or {t:'heard', id, error} (lib/dictation-direct.ts).
// USAGE 25.11.2026: page → app {t:'usage', on?} sets this phone's anonymous usage count switch (when `on` is given) and asks
// for its state; app → page {t:'usage', on, text} (replayed; settings/phone-usage.ts).
// Owns: the port, parsing and dispatch. Never: what a message means (phone-companies.ts, share.ts, … decide).

type NativeMessage = Record<string, unknown>;
type Handler = (msg: NativeMessage) => void;

let port: MessagePort | null = null;
let started = false;
const handlers = new Map<string, Set<Handler>>();
const last = new Map<string, NativeMessage>();
const REPLAYED = new Set(['companies', 'status', 'crash', 'usage', 'bubble.state']);

/** True once the app handed the page its port. */
export function hasNativePort(): boolean {
  return port !== null;
}

/** Whether the app's latest 'status' names `feature` (e.g. 'hear'; 'wake') while its port is here. */
export function nativeCan(feature: string): boolean {
  return port !== null && last.get('status')?.[feature] === true;
}

/** Sends one message to the app; false when there is no port (a browser, the iPhone web app, before the app's hello). */
export function sendNative(msg: { t: string } & Record<string, unknown>): boolean {
  if (!port) return false;
  try { port.postMessage(JSON.stringify(msg)); return true; } catch { return false; }
}

/** Calls `fn` for every app message of this type; returns the unsubscribe. */
export function onNative(type: string, fn: (msg: Record<string, unknown>) => void): () => void {
  let set = handlers.get(type);
  if (!set) { set = new Set(); handlers.set(type, set); }
  set.add(fn);
  const seen = type === 'port' ? (port ? { t: 'port' } : undefined) : last.get(type);
  if (seen) call(fn, seen);
  return () => { handlers.get(type)?.delete(fn); };
}

/** How long a picture of the app's window may take before the report goes without one. */
export const SHOT_WAIT_MS = 2000;
/** The longest picture taken (a 1600 px JPEG is far smaller). */
const SHOT_MAX_CHARS = 8 * 1024 * 1024;

/**
 * A picture of the Android app's window as a JPEG data URL; null without a port, on the app's error, for anything that
 * is not an image, or after `waitMs`. Several requests at once share the next answer.
 */
export function requestNativeShot(waitMs: number = SHOT_WAIT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let off: () => void = () => undefined;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      off();
      resolve(value);
    };
    off = onNative('shot', (msg) => {
      const data = msg.data;
      finish(typeof data === 'string' && data.length <= SHOT_MAX_CHARS && /^data:image\/(?:jpeg|png|webp);base64,/.test(data) ? data : null);
    });
    if (done) return;
    timer = setTimeout(() => finish(null), waitMs);
    if (!sendNative({ t: 'shot' })) finish(null);
  });
}

/**
 * The steps of the app's {t:'feedback'} – its volume keys pressed together: `down: true` goes down, `down: false` is let
 * go, and a message without `down` is one whole press (down, then up at once).
 */
export function feedbackKeySteps(msg: NativeMessage): Array<'down' | 'up'> {
  if (msg.down === true) return ['down'];
  if (msg.down === false) return ['up'];
  return ['down', 'up'];
}

/** Forgets the replayed message of `type` once it was handled (a crash report is taken once). */
export function consumeNative(type: string): void {
  last.delete(type);
}

function call(fn: Handler, msg: NativeMessage): void {
  try { fn(msg); } catch (error) { console.error('[native-port] handler failed', error); }
}

function deliver(msg: NativeMessage): void {
  const type = msg.t;
  if (typeof type !== 'string' || !type || type === 'port') return; // 'port' is only ever local
  if (REPLAYED.has(type)) last.set(type, msg);
  for (const fn of [...(handlers.get(type) ?? [])]) call(fn, msg);
}

/** One app message (a JSON string; an object is taken as it is). */
export function parseNative(data: unknown): NativeMessage | null {
  let value: unknown = data;
  if (typeof data === 'string') { try { value = JSON.parse(data); } catch { return null; } }
  return value && typeof value === 'object' && !Array.isArray(value) && typeof (value as NativeMessage).t === 'string' ? value as NativeMessage : null;
}

/** Keeps the newest port (a reload or a new page load hands a new one; the old one is closed). */
export function adoptPort(next: MessagePort): void {
  if (port === next) return;
  port?.close();
  port = next;
  next.onmessage = (event: MessageEvent) => { if (port === next) { const msg = parseNative(event.data); if (msg) deliver(msg); } };
  for (const fn of [...(handlers.get('port') ?? [])]) call(fn, { t: 'port' });
}

/** Whether a window message is the app's hello: exactly 'autark-port' with a port, not from a frame inside the page. */
export function isPortHello(event: Pick<MessageEvent, 'data' | 'ports' | 'source'>, top: unknown): boolean {
  if (event.data !== 'autark-port' || !event.ports?.[0]) return false;
  return event.source === null || event.source === top; // postWebMessage has no source window; an iframe always has one
}

/** Listens for the app's hello (once; main.tsx). A page framed by another site never takes a port: the app's page is
 *  always the top window, and a framing site must not pose as the app (it would get downloads and spoken text). */
export function startNativePort(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  if (window.top !== window) return;
  window.addEventListener('message', (event) => { if (isPortHello(event, window)) adoptPort(event.ports[0]!); });
}

/** Tests only: forget the port, the handlers and the replayed messages. */
export function resetNativePort(): void {
  port?.close();
  port = null;
  handlers.clear();
  last.clear();
}
