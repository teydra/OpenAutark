// The connection's one quiet state (Sicher-Runde 19.11.2026, D3–D5; owner 27.11.2026): calm and the same while the PC is
// away – "Office-PC not reachable · reconnecting by itself · as of 14:02" – instead of "Reconnecting…"/"Offline" flipping
// with every retry; it comes only after the connection was down DOWN_GRACE_MS (a resume's quick new socket shows nothing)
// and goes the moment it is open again. It has no button: the page reconnects by itself at once (lib/rpc.ts), and every
// PC of the company that is online is linked, so there is nothing to pick (owner 27.11.2026: "Try now" mostly changed
// nothing, "Choose PC" brought nothing – both are gone). In an open chat it is the chat header's sub line
// (chat/ChatHeader.tsx, the line the header always reserves), so it covers nothing; elsewhere it is a quiet line of the
// status line. What truly needs the person keeps its words and its one action: a PC that does not know this phone's token
// (4404 – one the company's roster has not reached yet) or no longer accepts it (4401) is a line with Pair again in the
// phone apps (it pairs over this company, pwa/native.ts); the pairing screen comes only for a removed phone (4403,
// App.tsx). On the desktop the line names Autark's engine. "Connection to the runtime was lost." (rpc LOST_TEXT) is never
// a line of its own. Konrad 24.11.2026: the state stands for every action that failed meanwhile – none of them is a toast
// of its own (lib/toasts.ts toastError); what did not go out at all is said once in one quiet toast when the connection
// is back (unsentToast).
// Owns: the state's text, tone and the refusal's action (awayText, connectionLine, pure), the facts it reads
// (connectionFacts) and the down timer (watchConnection). Never: renders (StatusLine.tsx via notices.ts connectionNotice,
// ChatHeader.tsx via connectionAway), reconnects or pairs itself.

import { computed, effect, signal } from '@preact/signals';
import { LOST_TEXT, rpc } from '../lib/rpc.ts';
import type { ConnectionStatus } from '../lib/rpc.ts';
import type { Refusal } from '../lib/refusal.ts';
import { logTime } from '../lib/format.ts';
import { platform } from '../lib/platform.ts';
import { activeConversationId, cachedAt, loadError, loaded, systemInfo } from '../lib/store.ts';
import { pushToast, unsent } from '../lib/toasts.ts';
import { isPhoneApp, pairAgain } from '../pwa/native.ts';
import { phoneCompanies, phoneStatus } from '../pwa/phone-companies.ts';
import type { Notice, NoticeAction } from './notices.ts';

/** How long the connection is down before the state shows (Konrad 24.11.2026: a drop under 5 s shows nothing at all). */
export const DOWN_GRACE_MS = 5_000;
/** The line's place in the status line: above everything else (NOTICE_PRIORITY.connection). */
export const CONNECTION_PRIORITY = 100;

export interface ConnectionFacts {
  status: ConnectionStatus;
  loaded: boolean;
  loadError: string | null;
  refused: Refusal | null;
  /** Not open for longer than DOWN_GRACE_MS (watchConnection). */
  down: boolean;
  /** When the connection went away (null while open). */
  downSince: number | null;
  /** When the shown data was saved, while it is this device's copy. */
  cachedAt: number | null;
  /** The PC's name as the phone knows it ('' when it knows none). */
  pc: string;
  desktop: boolean;
  /** Inside either phone app (Pair again). */
  phoneApp: boolean;
  /** A chat is open: its header's sub line shows the away state, not the status line. */
  chatOpen: boolean;
  /** Text of a lost connection (rpc LOST_TEXT): never a line of its own. */
  lostText: string;
  now: number;
}

export interface ConnectionActions { pairAgain(): unknown }

/** The away state's words, or null while the connection is open or within the grace. */
export function awayText(facts: ConnectionFacts): string | null {
  if (facts.status === 'open' || !facts.down) return null;
  if (facts.desktop) return facts.loaded ? 'Autark’s engine is not answering · reconnecting by itself' : 'Autark’s engine is starting…';
  const asOf = facts.cachedAt ?? (facts.loaded ? facts.downSince : null);
  return `${facts.pc || 'Your PC'} not reachable · reconnecting by itself${asOf ? ` · as of ${logTime(asOf, facts.now)}` : ''}`;
}

/** The status line's line, or null while all is well, within the grace, or while an open chat's header says it. */
export function connectionLine(facts: ConnectionFacts, act: ConnectionActions): Notice | null {
  const line = (tone: Notice['tone'], text: string, actions: NoticeAction[]): Notice => ({ id: 'connection', tone, text, detail: text, actions, priority: CONNECTION_PRIORITY });
  if (!facts.desktop && (facts.refused === 4401 || facts.refused === 4404)) {
    const pc = facts.pc || 'Your PC';
    const text = facts.refused === 4404 ? `${pc} doesn't know this phone yet` : `${pc} no longer accepts this phone`;
    return line('warn', text, facts.phoneApp ? [{ label: 'Pair again', run: act.pairAgain }] : []);
  }
  if (facts.status === 'open') {
    return facts.loadError && facts.loadError !== facts.lostText ? line('error', facts.loadError, []) : null;
  }
  const away = awayText(facts);
  // the connection away: one quiet line (info, never red or amber – Konrad 24.11.2026), the same for every failed action
  return away && !facts.chatOpen ? line('info', away, []) : null;
}

/** When the connection went away (null while open) and whether that is longer than DOWN_GRACE_MS. */
export const downSince = signal<number | null>(null);
export const down = signal(false);

/** The PC's name as this page knows it: the Android app's link, its current company's PC, the PC's own system info. */
function pcName(): string {
  const name = phoneStatus.value?.pc ?? phoneCompanies.value.find((company) => company.current)?.pc ?? systemInfo.value?.deviceName ?? '';
  return name.trim().slice(0, 40);
}

/** What the line needs beyond the status line's own state, read from the signals (reactive inside a provider). */
export function connectionFacts(state: Pick<ConnectionFacts, 'status' | 'loaded' | 'loadError'>): ConnectionFacts {
  const desktop = platform === 'desktop';
  return {
    ...state, refused: desktop ? null : rpc.refused.value, down: down.value, downSince: downSince.value, cachedAt: cachedAt.value,
    pc: desktop ? '' : pcName(), desktop, phoneApp: isPhoneApp(), chatOpen: activeConversationId.value !== null, lostText: LOST_TEXT, now: Date.now(),
  };
}

export const CONNECTION_ACTIONS: ConnectionActions = { pairAgain };

/** The away state for an open chat's header sub line (chat/ChatHeader.tsx), or null. */
export const connectionAway = computed(() => awayText(connectionFacts({ status: rpc.status.value, loaded: loaded.value, loadError: loadError.value })));

/** The one quiet toast for what did not go out while the connection was away (lib/toasts.ts unsent), or null. */
export function unsentToast(titles: readonly string[]): { title: string; body: string; tone: 'info' } | null {
  if (!titles.length) return null;
  return { title: titles.length === 1 ? 'Not sent while the connection was away' : `${titles.length} things not sent while the connection was away`, body: titles.join(' · '), tone: 'info' };
}

/**
 * Follows the connection's status: the first moment it is not open (the retries' connecting/closed flips keep it), and
 * one timeout to DOWN_GRACE_MS after it – never polling. While it is open, what did not go out meanwhile (unsent) is said
 * once in one quiet toast. Returns the stop.
 */
export function watchConnection(status: { value: ConnectionStatus }, now: () => number = Date.now): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = effect(() => {
    if (status.value === 'open') {
      if (timer) { clearTimeout(timer); timer = null; }
      downSince.value = null;
      down.value = false;
      const toast = unsentToast(unsent.value);
      if (toast) { unsent.value = []; pushToast(toast); }
      return;
    }
    if (downSince.peek() !== null) return;
    downSince.value = now();
    timer = setTimeout(() => { timer = null; down.value = true; }, DOWN_GRACE_MS);
  });
  return () => { stop(); if (timer) clearTimeout(timer); timer = null; };
}
