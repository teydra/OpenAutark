// Pure helpers of the remote website tab (RemoteWebTab.tsx, B-076): the feed key of a tab on a PC and the call target
// it stands for (no device: this PC), the rule that says the same input failure only once in a while, and what stands
// in the picture's place. Konrad 24.11.2026 (Stanislaus: red banners on every short drop): a drop of this window's
// connection keeps the last picture and shows nothing here – the status line's one quiet line says it after 5 s – and
// what the person does meanwhile is held in order and sent once the connection is back (rpc.ts, up to QUEUE_LIMIT_MS).
// Owns: these helpers. Never: renders, calls the runtime or keeps input.

import { connectionFailure } from '../lib/rpc-error.ts';

/** The calm line in the picture's place while this window has no connection and no picture yet. */
export const OFFLINE = 'Offline – the page shows again when the connection is back.';

/** The feed key of `tab` on `device` (device ids never hold a '|'). */
export const remoteKey = (device: string, tab: string): string => `${device}|${tab}`;

/** The side.* target of a feed key; an empty device means this PC (no `device` sent). */
export function remoteTarget(key: string): { device?: string; tab: string } {
  const at = key.indexOf('|');
  const device = at > 0 ? key.slice(0, at) : '';
  const tab = key.slice(at + 1);
  return device ? { device, tab } : { tab };
}

/** True when `text` should be said now: it differs from the last one said, or that was `ms` or more ago. */
export function sayOnce(ms: number, now: () => number = Date.now): (text: string) => boolean {
  let last = { text: '', at: Number.NEGATIVE_INFINITY };
  return (text) => {
    const at = now();
    if (text === last.text && at - last.at < ms) return false;
    last = { text, at };
    return true;
  };
}

/** A problem only shows after it stood this long (Konrad 24.11.2026: a drop under 5 s shows nothing; the last picture stays). */
export const PROBLEM_GRACE_MS = 5000;

/**
 * The problem the far side reports (a failed pull's text, the page's own error) – but not this window's own connection
 * going away (connectionFailure: the status line's one connection line says that, and the pulls start again on reconnect).
 */
export function farProblem(error: string | null | undefined, pageError?: string | null): string | null {
  if (error && !connectionFailure(error)) return error;
  return pageError || null;
}

/**
 * What stands in the picture's place: the far side's problem once it stood PROBLEM_GRACE_MS (`late`), else – only while
 * there is no picture yet – the offline line once this window's connection is away longer than its grace (`away`).
 * With a picture it stays through a drop: input made meanwhile waits in order (rpc.ts holds it up to QUEUE_LIMIT_MS).
 */
export function pictureProblem(view: { late: string | null; away: boolean; picture: boolean }): string | null {
  if (view.late) return view.late;
  return view.away && !view.picture ? OFFLINE : null;
}
