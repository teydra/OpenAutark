// The PhoneDriver seam: what phone tools need from whatever drives an Android phone – AdbPhone (adb.ts, USB or
// wireless debugging) and AppPhones (app-driver.ts, the Autark app's phone use; only it has a bubble to say something
// in). Wireless pairing is ADB-specific (PhoneWireless).
// Owns: the interface and its small value types. Never: behaviour.

import type { NearbyPhone } from '../../shared/model/phone.ts';
import type { PhoneSayAnswer } from '../../shared/api/methods-phone.ts';
import type { PhoneDevice, PhoneNode } from './uiautomator.ts';

/** What phone.open opens: a link, a package, or the name under an app's icon (`app`, through the Autark app). */
export interface PhoneOpenTarget { url?: string; package?: string; app?: string }

export interface PhoneStepOptions {
  /** Ends the step before its next command (a cancelled run). */
  signal?: AbortSignal;
  /** The run the step belongs to: the phone's ✕ ends exactly this job (owner 10.11.2026). */
  job?: string;
  /** The agent acting: the app's bubble names it (feedback 16.11.2026 F16). */
  by?: string;
}

/** What phone.say brought back: the person's answer when it asked. */
export interface PhoneSaid { serial: string; answer?: PhoneSayAnswer }

export interface PhoneShot { serial: string; data: Uint8Array; mime: string; width: number; height: number; scale: number; screen: { width: number; height: number } }
export interface PhoneTree { serial: string; text: string; count: number; truncated: boolean; nodes: PhoneNode[]; screen?: { width: number; height: number } }

export interface PhoneDriver {
  available(): Promise<boolean>;
  devices(): Promise<PhoneDevice[]>;
  screenshot(serial?: string, step?: PhoneStepOptions): Promise<PhoneShot>;
  uiTree(serial?: string, step?: PhoneStepOptions): Promise<PhoneTree>;
  tap(serial: string | undefined, x: number, y: number, step?: PhoneStepOptions): Promise<void>;
  /** `via`: points between `from` and `to` that one unlifted finger passes (a lock pattern; the Autark app only). */
  swipe(serial: string | undefined, from: { x: number; y: number }, to: { x: number; y: number }, durationMs?: number, step?: PhoneStepOptions, via?: Array<{ x: number; y: number }>): Promise<void>;
  /** Types into the focused field; resolves to what the field reads afterwards when the phone tells it (the Autark app). */
  type(serial: string | undefined, value: string, step?: PhoneStepOptions): Promise<string | void>;
  /** Presses a key; returns the key code it sent. */
  key(serial: string | undefined, name: string, step?: PhoneStepOptions): Promise<string>;
  /** A link, an app by its package, or (the Autark app) an app by the name under its icon. */
  open(serial: string | undefined, target: PhoneOpenTarget, step?: PhoneStepOptions): Promise<string>;
  /** My line in the phone's bubble; with `buttons` a question the person answers with one of them or ✕ (waits for it;
   *  ✓ among them answers 'yes'). */
  say(serial: string | undefined, text: string, buttons: string[] | undefined, step?: PhoneStepOptions): Promise<PhoneSaid>;
}

/** Wireless debugging (ADB only): pairing with the phone's code, connecting, phones nearby. */
export interface PhoneWireless {
  pair(address: string, code: string): Promise<{ address: string; name?: string }>;
  connect(address: string): Promise<{ address: string; already: boolean }>;
  disconnect(serial: string): Promise<{ serial: string; was: boolean }>;
  discover(): Promise<NearbyPhone[]>;
}
