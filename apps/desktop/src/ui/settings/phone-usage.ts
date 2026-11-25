// 25.11.2026 (anonymous usage count): this phone's own switch, shown on the Settings › Security page inside the Android app.
// The Android app counts by itself (usage/UsageCount.java) and keeps its own switch; the page only shows it and asks to flip it
// over the app's port – {t:'usage', on?} → {t:'usage', on, text}. Nothing of this reaches the PC or its settings.
// Owns: the signal of the phone's switch and the one message that sets it. Never: counts, sends or stores anything.

import { signal } from '@preact/signals';
import { isAndroidApp } from '../pwa/native.ts';
import { onNative, sendNative } from '../pwa/native-port.ts';

/** The phone's switch as the app last said it; null before the app answered (or without the app). */
export const phoneUsage = signal<{ on: boolean; text: string } | null>(null);
let listening = false;

/** The phone's switch and its sentence, or null where this page is not the Android app (or the app is too old to count). */
export function usePhoneUsage(): { on: boolean; text: string } | null {
  if (!isAndroidApp()) return null;
  if (!listening) {
    listening = true;
    onNative('usage', (msg) => {
      if (typeof msg.on === 'boolean' && typeof msg.text === 'string') phoneUsage.value = { on: msg.on, text: msg.text.slice(0, 400) };
    });
    sendNative({ t: 'usage' });
  }
  return phoneUsage.value;
}

/** Turns this phone's count on or off; the app answers with the new state. False without a port. */
export function setPhoneUsage(on: boolean): boolean {
  return sendNative({ t: 'usage', on });
}
