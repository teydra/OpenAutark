// The error every rpc.call rejects with, and the short text the UI shows for any error (split out of lib/rpc.ts,
// which re-exports both, so `import { RpcError, errorText } from './rpc.ts'` keeps working).
// Owns: the error shape and its user-safe text. Never: the connection.

import type { ErrorCode, WorkforceErrorData } from '../../shared/errors.ts';

/** Error thrown by rpc.call: carries the runtime's safe error code + message. */
export class RpcError extends Error {
  readonly code: ErrorCode;
  readonly data: WorkforceErrorData;
  constructor(data: WorkforceErrorData) {
    super(data.message);
    this.name = 'RpcError';
    this.code = data.code;
    this.data = data;
  }
}

/** A pending call's error when the connection went away under it (lib/rpc.ts): it may or may not have arrived. */
export const LOST_TEXT = 'Connection to the runtime was lost.';
/** A queued call's error after QUEUE_LIMIT_MS without a connection (lib/rpc.ts picks the platform's): nothing went out. */
export const NOT_SENT_DESKTOP = 'Autark’s engine is not answering – nothing was sent.';
export const NOT_SENT_PHONE = 'Your PC is not reachable right now – nothing was sent.';

/**
 * Konrad 24.11.2026 (Stanislaus: "selbst wenn sie eine Sekunde abbricht, muss man nicht direkt so blöde Meldungen
 * anzeigen"): an error that only says this window's connection was away – 'lost' (on its way when it broke: it may have
 * arrived) or 'unsent' (it waited for the connection and nothing went out) – never becomes a line of its own; the status
 * line's one connection line speaks for all of them (lib/toasts.ts toastError, shell/connection-line.ts). Null for any other error.
 */
export function connectionFailure(error: unknown): 'lost' | 'unsent' | null {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (text === LOST_TEXT) return 'lost';
  if (text === NOT_SENT_DESKTOP || text === NOT_SENT_PHONE) return 'unsent';
  return null;
}

/** Short user-safe text for any error thrown by rpc.call. */
export function errorText(error: unknown): string {
  if (error instanceof RpcError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong.';
}
