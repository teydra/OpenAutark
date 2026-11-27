// Host capabilities the feedback panel uses: window screenshot (desktop preload,
// capture.window() → PNG data URL); without a bridge (phone, browser) an image the person picks
// (file input: a screenshot from the gallery or a new camera photo), scaled to PICK_MAX_SIDE and
// re-encoded through a canvas, so photo metadata such as the location never leaves the device;
// and dictation with both tap-to-toggle and hold-to-talk (press > 300 ms) through lib/dictation.ts
// (recorded, uploaded, voice.transcribe) where it gives text (dictationNote is empty).
// B-055: the header cell's talk (press.ts recognizes the hold) drives a DictationButton through
// beginHold/endHold; the window shot includes the side browser (main/capture.ts composites it).
// Feedback 16.11.2026: the Android app takes the shot of its own window over the port
// (native-port.ts requestNativeShot, at most 2 s); the picker ("Add photo", the form's +) works everywhere.
// Owner 20.11.2026: a report is its words – the feedback dictation gives text, never a recording. Its cancel
// (the form's + turned into ×) drops a take while it records and while it is transcribed: the words of a
// dropped take never reach the field.
// Owns: the screenshot and picked-image helpers and the dictation button. Never: uploads anything
// (the panel does, on its action button) or keeps audio.

import { useEffect, useRef, useState } from 'preact/hooks';
import { bridge } from '../lib/platform.ts';
import { DictationCancelled, TakeNotTranscribed, dictation, dictationNote, type KeptPiece } from '../lib/dictation.ts';
import { errorText } from '../lib/rpc.ts';
import { settings } from '../lib/store.ts';
import { pushToast } from '../lib/toasts.ts';
import { appendDraftText } from './draft.ts';
import { hasNativePort, requestNativeShot } from '../pwa/native-port.ts';
import { isAndroidApp } from '../pwa/native.ts';
import { HOLD_MS } from './press.ts';

/** The Android app can take the shot of its window (its port is here; the page is the app's own, so it answers). */
export function nativeShotHere(userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return hasNativePort() && isAndroidApp(userAgent);
}

/** Takes a screenshot of the app window if the host can; null otherwise. */
export async function captureWindow(): Promise<string | null> {
  if (!bridge && nativeShotHere()) return requestNativeShot();
  try {
    return (await bridge?.capture.window()) || null;
  } catch {
    return null;
  }
}

/** True when this host can screenshot the app window itself (desktop, the Android app); else the panel offers a picker. */
export function canCaptureWindow(): boolean {
  return typeof bridge?.capture?.window === 'function' || nativeShotHere();
}

/** Longest side of a picked image after scaling (enough to read a phone screenshot). */
export const PICK_MAX_SIDE = 1600;
/** Largest image file the picker accepts before decoding. */
export const PICK_MAX_BYTES = 30 * 1024 * 1024;

/** Why a picked file cannot be used, or null (an unknown type is left to decoding). */
export function pickProblem(file: { type: string; size: number }): string | null {
  if (file.type && !/^image\//i.test(file.type)) return 'Choose an image – a screenshot or a photo.';
  if (file.size > PICK_MAX_BYTES) return `This image is larger than ${PICK_MAX_BYTES / (1024 * 1024)} MB.`;
  return null;
}

/** `width`×`height` scaled down (never up) so the longer side is at most `max`. */
export function fitWithin(width: number, height: number, max: number = PICK_MAX_SIDE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Photos stay JPEG (small), everything else becomes PNG (sharp text). */
export function pickedMime(type: string): 'image/jpeg' | 'image/png' {
  return /^image\/(jpe?g|heic|heif)$/i.test(type) ? 'image/jpeg' : 'image/png';
}

/** File name for an uploaded screenshot data URL. */
export function screenshotName(dataUrl: string, base = 'screenshot'): string {
  return `${base}.${/^data:image\/jpeg[;,]/i.test(dataUrl) ? 'jpg' : 'png'}`;
}

/** A picked image as a scaled data URL (re-encoded: no metadata). Throws with a readable message. */
export async function pickedImage(file: File): Promise<string> {
  const problem = pickProblem(file);
  if (problem) throw new Error(problem);
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    try { await image.decode(); } catch { throw new Error('This image could not be opened. Try a PNG or JPEG.'); }
    const size = fitWithin(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This image could not be opened.');
    context.drawImage(image, 0, 0, size.width, size.height);
    return canvas.toDataURL(pickedMime(file.type), 0.9);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(',', 2);
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? 'application/octet-stream';
  const raw = atob(body ?? '');
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export type DictationState = 'idle' | 'listening' | 'transcribing';

/** Pressing longer than this records until release (hold-to-talk); shorter is a tap (press.ts). */
export { HOLD_MS };
/** A click this soon after a release belongs to that press (it already started or stopped). */
const CLICK_AFTER_RELEASE_MS = 500;

/** What a mic button dictates with (lib/dictation.ts; a fake in tests). */
export interface ButtonDictation {
  /** `onEnded` fires when the take ends without finish/cancel (another dictation took the microphone). */
  start(onEnded: (error?: string) => void): Promise<void>;
  /** Stops the take and returns its text ('' when nothing was understood) – or, when part of it was not heard, a PartlyHeard. */
  finish(language?: string): Promise<string | PartlyHeard>;
  cancel(): void;
}

/** A take part of which was not heard: its words, what the form says, and the offer to hear the rest again. */
export interface PartlyHeard {
  text: string;
  note: string;
  /** Offers "Transcribe again" for the pieces not heard – only for a take that was not cancelled. */
  unheard(): void;
}

/** The form's line when part of a take was not heard (review 20.11.2026: never lost in silence). */
export const PART_NOT_HEARD = 'Part of the dictation was not transcribed – "Transcribe again" waits in the status line.';

/**
 * The composer's offer for a piece not heard (chat/composer/voice.ts offerRetry), for the feedback text: a lasting
 * status-line toast whose "Transcribe again" hears the stored piece once more and appends its words to the draft. The
 * piece stays a file on this PC for that – a report never carries it. A piece held in this page (no link) has no button.
 */
function offerAgain(pieces: readonly KeptPiece[], error?: string): void {
  for (const piece of pieces) {
    const fileId = piece.ref?.id;
    const run = fileId ? () => void dictation.hear(fileId, { language: settings.peek()?.profile.language }).then(
      (heard) => { if (heard.text.trim()) appendDraftText(heard.text.trim()); else pushToast({ title: 'Nothing heard in the recording' }); },
      (failed: unknown) => offerAgain([piece], errorText(failed))) : undefined;
    const body = `${error ? `${error} ` : ''}${fileId ? 'The recording is kept.' : 'The recording waits in this page.'}`;
    pushToast({ title: 'Dictation not transcribed', tone: 'error', body, ...(run ? { action: { label: 'Transcribe again', run } } : {}) }, 0);
  }
}

/** The feedback mics' dictation: the page's words (lib/dictation.ts); pieces not heard come back as a PartlyHeard. */
const pageButton: ButtonDictation = {
  start: (onEnded) => dictation.start(onEnded),
  finish: async (language) => {
    try {
      const heard = await dictation.finish(language);
      const kept = heard.kept ?? [];
      if (!kept.length) return heard.text;
      return { text: heard.text, note: PART_NOT_HEARD, unheard: () => offerAgain(kept, kept.find((piece) => piece.error)?.error) };
    } catch (error) {
      if (!(error instanceof TakeNotTranscribed) || !error.kept.length) throw error;
      return { text: '', note: `${error.message} "Transcribe again" waits in the status line.`, unheard: () => offerAgain(error.kept, error.message) };
    }
  },
  cancel: () => dictation.cancel(),
};

/** The panel can dictate to text here now (reactive). */
export function panelDictationAvailable(): boolean {
  return !dictationNote();
}

/** What a take started now dictates with. */
export function panelDictation(): ButtonDictation {
  return pageButton;
}

/** Where one button's dictation shows (the hook's state setters). */
export interface DictationView {
  state(state: DictationState): void;
  error(message: string | null): void;
  text(text: string): void;
  language(): string | undefined;
}

const failure = (error: unknown) => (error instanceof Error && error.message ? error.message : 'Dictation failed');

/**
 * One mic button: a short tap starts and the next tap stops; holding longer than HOLD_MS records
 * until release. A release or second tap while the microphone still opens drops that take (the
 * microphone was not on yet, nothing was heard). Only this button's own take is ever cancelled –
 * the composer may be dictating elsewhere.
 */
export class DictationButton {
  private readonly engine: () => ButtonDictation;
  private readonly view: DictationView;
  private readonly now: () => number;
  private phase: DictationState | 'starting' = 'idle';
  private running: ButtonDictation | null = null; // the engine of this button's take
  private ticket = 0;
  private downAt = 0;
  private upAt = Number.NEGATIVE_INFINITY;
  private byPress = false;
  private drop = false; // drop the take once its start resolves
  private disposed = false;

  constructor(engine: () => ButtonDictation, view: DictationView, now: () => number = Date.now) {
    this.engine = engine;
    this.view = view;
    this.now = now;
  }

  /** Pointer down: starts when idle (a tap or the start of a hold). */
  press(): void {
    this.downAt = this.now();
    this.byPress = this.phase === 'idle';
    if (this.byPress) void this.start();
  }

  /** Pointer up (or cancelled): a hold ends here, a tap keeps listening, a second tap stops. */
  release(): void {
    this.upAt = this.now();
    if (this.byPress && this.upAt - this.downAt <= HOLD_MS) return;
    this.end();
  }

  /** A click without a pointer press (Enter/Space, a screen reader): start or stop. */
  activate(): void {
    if (this.now() - this.upAt < CLICK_AFTER_RELEASE_MS) return;
    if (this.phase === 'idle') void this.start();
    else this.end();
  }

  /** A hold recognized elsewhere (the header cell, press.ts): the take starts now… */
  beginHold(): void {
    this.byPress = false;
    if (this.phase === 'idle') void this.start();
  }

  /** …and always ends on release (a take whose microphone still opens is dropped: nothing was heard). */
  endHold(): void {
    this.end();
  }

  /** Discards this button's take (never another caller's) – while it records, and while it is transcribed (its words are dropped). */
  cancel(): void {
    if (this.phase === 'starting') { this.drop = true; return; }
    if (this.phase === 'transcribing') { this.ticket += 1; this.show('idle'); return; }
    if (this.phase !== 'listening') return;
    this.running?.cancel();
    this.running = null;
    this.show('idle');
  }

  /** The panel closed: its take must not keep the microphone on. */
  dispose(): void {
    this.cancel();
    this.disposed = true;
  }

  private async start(): Promise<void> {
    if (this.phase !== 'idle') return;
    const engine = this.engine();
    const ticket = ++this.ticket;
    this.phase = 'starting';
    this.drop = false;
    this.view.error(null);
    const ended = (error?: string) => {
      if (ticket !== this.ticket) return;
      if (this.phase === 'starting') this.drop = true;
      else if (this.phase === 'listening') { this.running = null; this.show('idle'); } else return;
      if (error) this.view.error(error);
    };
    try {
      await engine.start(ended);
    } catch (error) {
      this.show('idle');
      if (!(error instanceof DictationCancelled)) this.view.error(failure(error));
      return;
    }
    if (this.drop || this.disposed || ticket !== this.ticket) { engine.cancel(); this.show('idle'); return; }
    this.running = engine;
    this.show('listening');
  }

  private end(): void {
    if (this.phase === 'starting') this.drop = true;
    else void this.stop();
  }

  private async stop(): Promise<void> {
    const engine = this.running;
    if (this.phase !== 'listening' || !engine) return;
    this.running = null;
    const ticket = this.ticket;
    this.show('transcribing');
    try {
      // A take without words comes back as '' (the runtime's answer, SM9): nothing to show.
      const heard = await engine.finish(this.view.language());
      if (ticket !== this.ticket || this.disposed) return; // cancelled meanwhile: no words, no offer
      const text = (typeof heard === 'string' ? heard : heard.text).trim();
      if (text) this.view.text(text);
      if (typeof heard !== 'string') { heard.unheard(); this.view.error(heard.note); }
    } catch (error) {
      if (ticket === this.ticket && !this.disposed) this.view.error(failure(error));
    } finally {
      if (ticket === this.ticket) this.show('idle'); // a cancelled take showed idle already (a new one may run)
    }
  }

  private show(phase: DictationState): void {
    this.phase = phase;
    if (!this.disposed) this.view.state(phase);
  }
}

/**
 * Dictation controls for one mic button (DictationButton): tap to toggle, or hold to talk.
 * `onText` receives the transcript to append; `language` is a hint for the transcription service.
 */
export function useDictation(onText: (text: string) => void, language?: string) {
  const [state, setState] = useState<DictationState>('idle');
  const [error, setError] = useState<string | null>(null);
  const latest = useRef({ onText, language });
  latest.current = { onText, language };
  const button = useRef<DictationButton | null>(null);
  button.current ??= new DictationButton(panelDictation, {
    state: setState, error: setError, text: (text) => latest.current.onText(text), language: () => latest.current.language,
  });
  const control = button.current;
  const available = panelDictationAvailable();

  // Closing the panel mid-dictation (or while it starts) must not leave the microphone on.
  useEffect(() => () => control.dispose(), []);

  const handlers = {
    onPointerDown: (event: PointerEvent) => {
      if (!available) return;
      // The release reaches this button even when the finger slides off it while holding.
      try { (event.currentTarget as Element | null)?.setPointerCapture?.(event.pointerId); } catch { /* not capturable */ }
      control.press();
    },
    onPointerUp: () => control.release(),
    onPointerCancel: () => control.release(),
    onContextMenu: (event: Event) => event.preventDefault(), // a long press opens no menu on a phone
    onClick: (event: MouseEvent) => { if (available && event.detail === 0) control.activate(); }, // Enter/Space, screen readers
  };

  return { available, state, error, handlers, cancel: () => control.cancel() };
}
