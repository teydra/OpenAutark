// FCMWSZNH (24.11.2026, Samsung, Android app 0.3.17): a picture picked in the keyboard's clipboard row was struck through
// and could not be attached. The app now takes it from the keyboard (KeyboardContent.java) and sends `paste {name, mime,
// data}` over the native port; here it becomes a File and a paste event on the focused field – the composer's own paste
// handler (Composer.tsx onPaste) attaches it as it does a picture pasted on the PC.
// Owns: turning the message into a File and the paste on the focused field. Never: uploads or keeps the picture itself,
// takes a non-image type, or pastes into a field that has no focus (the picture is dropped, as the keyboard's was).

import { onNative } from './native-port.ts';

/** The largest picture taken here, as base64 characters (the app sends at most 15 MB of bytes). */
export const PASTE_MAX_CHARS = Math.ceil((15 * 1024 * 1024) / 3) * 4;

/** The app's message as a File; null for a missing, oversized or non-image picture. */
export function pastedPicture(msg: Record<string, unknown>): File | null {
  const { data, mime, name } = msg;
  if (typeof data !== 'string' || !data || data.length > PASTE_MAX_CHARS) return null;
  if (typeof mime !== 'string' || !/^image\/[a-z0-9.+-]+$/i.test(mime)) return null;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const raw = atob(data);
    bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  } catch { return null; }
  if (!bytes.length) return null;
  const base = typeof name === 'string' ? name.replace(/^.*[\\/]/, '').trim().slice(-120) : '';
  return new File([bytes], base || `pasted-${Date.now()}.${mime.split('/')[1]?.replace(/\+.*/, '') || 'png'}`, { type: mime.toLowerCase() });
}

/** The field the keyboard typed into: the focused textarea, input or editable element. */
export function pasteTarget(active: Element | null): HTMLElement | null {
  if (!active || !(active instanceof HTMLElement)) return null;
  const tag = active.tagName;
  return tag === 'TEXTAREA' || tag === 'INPUT' || active.isContentEditable ? active : null;
}

let started = false;
/** Listens for pictures from the keyboard (phone-companies.ts startPhoneShell, once). */
export function startKeyboardPaste(): void {
  if (started || typeof document === 'undefined') return;
  started = true;
  onNative('paste', (msg) => {
    const file = pastedPicture(msg);
    const target = pasteTarget(document.activeElement);
    if (!file || !target) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
}
