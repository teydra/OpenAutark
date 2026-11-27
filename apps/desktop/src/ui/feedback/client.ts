// Where a feedback report was written (feedback 16.11.2026, F22/F15): the report's `client` – the device it came from,
// not the PC whose runtime stores it (that one adds its own version and OS). One line, ≤ FEEDBACK_CLIENT_MAX characters:
//   "Android app 0.3.15 · Android 16 · samsung SM-S918B · 412×915 @3x · de · <user agent>"
//   "iPhone web app · iOS 18.1 · 390×844 @3x · de · …", "browser · 1280×800 @2x · en · …", "PC window · 1600×900 · de · …"
// The Android shell's user agent carries its version and, from 0.3.15 on, its device after the marker
// ("AutarkAndroid/0.3.15 (Android 16; samsung SM-S918B)" – Chrome's reduced user agent hides the model).
// Owns: reading those facts and the line. Never: names the person or the company, or reads anything stored.

import { FEEDBACK_CLIENT_MAX } from '../../shared/model/feedback-delivery.ts';
import { hostedShell } from '../pwa/hosted.ts';
import { bridge } from '../lib/platform.ts';

/** What the line is made of (the page's globals; plain values in tests). */
export interface ClientEnv {
  userAgent: string;
  /** Inside the iPhone web app (pwa/hosted.ts). */
  hosted: boolean;
  /** The desktop window (the preload bridge). */
  desktop: boolean;
  width: number;
  height: number;
  pixelRatio: number;
  language?: string;
}

/** The Android shell's own facts from its user agent, or null outside it. */
export function androidShell(userAgent: string): { version: string; system?: string; device?: string } | null {
  const match = /\bAutarkAndroid\/([\w.+-]+)(?:\s*\(([^)]*)\))?/.exec(userAgent);
  if (!match) return null;
  const [system, device] = (match[2] ?? '').split(';').map((part) => part.trim());
  return { version: match[1]!, ...(system ? { system } : {}), ...(device ? { device } : {}) };
}

/** Where the page runs: the first part of the line. */
function origin(env: ClientEnv): string {
  const android = androidShell(env.userAgent);
  if (android) return [`Android app ${android.version}`, android.system, android.device].filter(Boolean).join(' · ');
  if (env.hosted) {
    const ios = /\bOS (\d+)[_.](\d+)/.exec(env.userAgent);
    return ios ? `iPhone web app · iOS ${ios[1]}.${ios[2]}` : 'iPhone web app';
  }
  return env.desktop ? 'PC window' : 'browser';
}

/** The report's `client` line. */
export function clientFacts(env: ClientEnv): string {
  const ratio = Math.round(env.pixelRatio * 100) / 100;
  const size = `${Math.round(env.width)}×${Math.round(env.height)}${ratio && ratio !== 1 ? ` @${ratio}x` : ''}`;
  const head = [origin(env), size, env.language?.trim()].filter(Boolean).join(' · ');
  const agent = env.userAgent.trim();
  const line = agent ? `${head} · ${agent}` : head;
  return line.length > FEEDBACK_CLIENT_MAX ? `${line.slice(0, FEEDBACK_CLIENT_MAX - 1)}…` : line;
}

/** This page's `client` line; `language` is the profile's language (the device's when it has none). */
export function currentClient(language?: string): string {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const win = typeof window === 'undefined' ? undefined : window;
  return clientFacts({
    userAgent: nav?.userAgent ?? '',
    hosted: hostedShell() !== undefined,
    desktop: Boolean(bridge),
    width: win?.innerWidth ?? 0,
    height: win?.innerHeight ?? 0,
    pixelRatio: win?.devicePixelRatio ?? 1,
    language: language || nav?.language,
  });
}
