// The page inside one of Autark's phone apps: the Android app (apps/android: its WebView adds "AutarkAndroid/" to the
// user agent) or the iPhone web app (the website's shell, window.autarkHosted – pwa/hosted.ts). What the web UI does
// differently there – no "Install app" row, Back from the app's own Back (window.autarkBack, back.ts; the iPhone app
// calls it from an edge swipe), and "Forget this phone" (Settings › Devices since B-084): the Android app takes it over
// its port (native-port.ts) or, before the port is there, intercepts the autark-app: address, and asks before it clears
// this company's pairing; the iPhone app asks, then clears its own. The apps have no toolbar of their own, so the phone
// looks like the web UI. Feedback 16.11.2026 F15: Pair again opens the Android app's pairing over this company instead
// of forgetting it first; when the PC refuses this page's token (a socket that opened closes
// with 4401), the phone app hears {t:'refused'} and tries the next PC of the company that has not refused in this
// link session, then sends 'resume' (19.11.2026: also on 4404, a PC that does not know the token; owner 27.11.2026: also
// a PC too old for this interface, lib/pc-floor.ts; the page says each in its status line, never on a screen of its own
// – shell/connection-line.ts). The interface is the app's own (owner 27.11.2026): the Android app ("AutarkAndroid/") and
// the iPhone app ("AutarkIOS/") serve it from their files, so the page and its app are always one version. The feedback video
// (F15) has no automatic start on a phone any more (owner 26.11.2026: the feedback bubble is explained in the PC's
// introduction, not on the phone; 28.11.2026: not over the first screen): neither the web UI nor the Android app plays it
// on its own; it stays a person's own tap (Settings › Feedback, the palette, the Android pairing screen's link).
// Owns: those facts. Never: talks to the Android app other than through the port or an autark-app: address the person
// taps (no JavaScript bridge object).

import { effect, type ReadonlySignal } from '@preact/signals';
import type { Refusal } from '../lib/refusal.ts';
import { hostedShell } from './hosted.ts';
import { onNative, sendNative } from './native-port.ts';

/** The address the app's WebView intercepts for "Forget this phone" (MainActivity / PhoneNavigation). */
export const FORGET_ADDRESS = 'autark-app:forget';

/** True inside the Autark Android app. */
export function isAndroidApp(agent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /\bAutarkAndroid\//.test(agent);
}

/** True inside a phone app that carries this interface in its own files (Android or the iPhone app). */
export function inNativeApp(agent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /\bAutark(?:Android|IOS)\//.test(agent);
}

/** True inside the iPhone web app (the website's shell loaded this PC's UI). */
export function inHostedApp(): boolean {
  return hostedShell() !== undefined;
}

/** True inside any phone app (Android, the iPhone app or the iPhone web app). */
export function isPhoneApp(): boolean {
  return inNativeApp() || inHostedApp();
}

/** "Forget this phone": the app asks, then clears its pairing and shows its connect screen. */
export function forgetThisPhone(): void {
  const hosted = hostedShell();
  if (hosted) { void hosted.forget(); return; }
  if (!sendNative({ t: 'forget' })) location.href = FORGET_ADDRESS;
}

/**
 * "Pair again" (feedback 16.11.2026 F15: it forced Forget first, a loop that destroyed a pairing that might still work):
 * the Android app opens its pairing screens over this company ('add'); a success replaces it in place and Back returns
 * to it unchanged. The iPhone web app, and an Android app before its port arrived, go the Forget way.
 */
export function pairAgain(): void {
  if (hostedShell() || !sendNative({ t: 'add' })) forgetThisPhone();
}

/** What reportRefusals reads of the connection (lib/rpc.ts's signals). */
export interface RefusalSource {
  /** Counts the sockets that opened and were sent off (refused, or their PC too old). */
  turnedAway: ReadonlySignal<number>;
  refused: ReadonlySignal<Refusal | null>;
  /** The PC that was too old for this interface (lib/pc-floor.ts), or null. */
  outdated: ReadonlySignal<string | null>;
}

/** A send-off after which the phone app tries the company's next PC: refused (4401), unknown there (4404) or too old – not removed. */
const nextPc = (source: RefusalSource): boolean => source.refused.peek() === 4401 || source.refused.peek() === 4404 || source.outdated.peek() !== null;

/**
 * Tells the phone app {t:'refused'} each time a socket that opened was sent off: refused (4401), unknown (4404, a PC the
 * company's roster has not reached yet: 19.11.2026) or too old for this interface (owner 27.11.2026) – the app then moves
 * the page to the company's next PC. A refused socket always opened, since the token goes in its first frame; a PC out
 * of reach never opens one. Without the port yet (and in a plain browser, which never gets one) the next port carries it.
 * Returns the stop.
 */
export function reportRefusals(source: RefusalSource): () => void {
  let seen = source.turnedAway.peek();
  let owed = false;
  const send = () => { owed = !sendNative({ t: 'refused' }); };
  const stopEffect = effect(() => {
    const now = source.turnedAway.value;
    if (now !== seen && nextPc(source)) send();
    seen = now;
  });
  const stopPort = onNative('port', () => { if (owed && nextPc(source)) send(); });
  return () => { stopEffect(); stopPort(); };
}
