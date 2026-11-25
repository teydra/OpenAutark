// Sending the composer's draft (split from Composer.tsx): Send, and /important or /silent with text
// (composer/slash.ts) and the Plus menu's levels send the whole draft – the text (or the command's text), its
// files, secret handles, how it was dictated (SM8) and its hidden marks (B-082 `marks`, only when it has some) and the message it replies to – at one level.
// B-083 (owner 08.11.: "Die soll es einfach selbst erkennen"): no Ultra hint any more – the agent splits itself when it pays.
// The field empties at once and the draft is fresh for the next message (level back to normal); a failed
// send keeps its retry payload and gives back the draft if the field was untouched. Owner 24.11.2026 (task_ec8e4ztn): the sent line stands in the chat
// from the tap on (pending-sends.ts) until its stored message takes its place; a failed one stays marked, with Send again.
// The composer sends `silent: true` only for a silent message, never `silent: false`.
// 16.11.2026: a key in the text is stored by the runtime before the message (runtime/secrets/text-capture.ts); the
// message comes back with its handle, and one notice in the status line says so (message-keys.ts noteSavedKeys).
// Owns: that one send path and Send again. Never: parses commands (slash.ts), or renders.

import { newId } from '../../../shared/ids.ts';
import type { MessageLevel } from '../../../shared/model/chat.ts';
import { rpc } from '../../lib/rpc.ts';
import { messagesFor, systemInfo } from '../../lib/store.ts';
import { session } from '../../lib/session.ts';
import { toastError } from '../../lib/toasts.ts';
import { clearDraft, draftFor, stageDraftSend, updateDraft, type Draft } from './draft.ts';
import { takeDraftSpeech } from './draft-speech.ts';
import { marksFor } from './draft-marks.ts';
import { heldKey } from '../../lib/take-store.ts';
import { noteSavedKeys } from '../message-keys.ts';
import type { ParamsOf } from '../../../shared/api/methods.ts';
import { addPending, beginRetry, confirmedSend, failPending, removePending, resolvePending } from '../pending-sends.ts';

export interface DraftSend {
  conversationId: string;
  /** The text to send: the draft's, or a level command's text. */
  body: string;
  level: MessageLevel;
  /** The agents the sent text @mentions (composer/target.ts mentionsIn). */
  mentions: (body: string) => string[];
}

/** B-082: true (with a notice) while the draft still holds a recording that waits in this page for the connection –
 *  it is no file yet, so the draft stays as it is until it has uploaded. */
export function heldWaiting(conversationId: string): boolean {
  if (!draftFor(conversationId).peek().attachments.some((a) => heldKey(a.fileId))) return false;
  toastError(new Error('A recording is still waiting for the connection.'), 'Not sent yet');
  return true;
}

// An untouched restored draft retries its original request. Equal-looking new drafts are independent.
const restored = new WeakMap<Draft, { clientId: string; body: string; level: MessageLevel }>();

/** Shows the line before the RPC. clientId can name the line already shown while dictating. */
export async function sendDraft(send: DraftSend & { clientId?: string }): Promise<boolean> {
  const { conversationId, level } = send;
  const clientId = send.clientId ?? newId('req');
  if (heldWaiting(conversationId)) { removePending(clientId); return false; }
  const draft = draftFor(conversationId);
  const saved = draft.peek();
  const body = send.body.trim();
  const before = restored.get(saved);
  if (before && before.body === body && before.level === level) {
    if (send.clientId) removePending(send.clientId);
    return resendPending(before.clientId);
  }
  const attachments = saved.attachments;
  const deviceId = systemInfo.peek()?.deviceId;
  const remote = session.peek()?.kind === 'device';
  const spoken = takeDraftSpeech(conversationId);
  addPending({ clientId, conversationId, body, attachments, state: 'sending' });
  const empty = stageDraftSend(conversationId);
  const marks = marksFor(saved.text, saved.marks, body);
  const params: ParamsOf<'messages.send'> = {
    conversationId, body,
    attachments: attachments.length ? attachments : undefined,
    secrets: saved.secrets?.length ? saved.secrets : undefined,
    mentions: send.mentions(body),
    priority: level === 'important' ? 'important' : 'normal', ...(level === 'silent' ? { silent: true } : {}),
    clientId, replyTo: saved.replyTo,
    ...(spoken.speech ? { speech: spoken.speech } : {}),
    ...(marks ? { marks } : {}),
  };
  try {
    const sent = await rpc.call('messages.send', params);
    resolvePending(clientId, sent);
    if (draft.peek() === empty) clearDraft(conversationId);
    noteSavedKeys(body, sent?.body ?? body);
    return true;
  } catch (error) {
    const sent = confirmedSend(messagesFor(conversationId).peek(), clientId, conversationId);
    if (sent) {
      resolvePending(clientId, sent);
      if (draft.peek() === empty) clearDraft(conversationId);
      noteSavedKeys(body, sent.body);
      return true;
    }
    if (draft.peek() === empty) {
      updateDraft(conversationId, saved);
      restored.set(draft.peek(), { clientId, body, level });
      spoken.restore();
    }
    failPending(clientId, errorText(error), { params, deviceId, remote });
    toastError(error, 'Message not confirmed');
    return false;
  }
}

/** Retries with the original request id. That key deduplicates only on the originating PC. */
export async function resendPending(clientId: string): Promise<boolean> {
  const retry = beginRetry(clientId);
  if (!retry) return false; // also guards against a second tap during the await
  const { params, deviceId, remote } = retry;
  const { conversationId, body } = params;
  const draft = draftFor(conversationId);
  const saved = draft.peek();
  const clearRestored = () => {
    if (draft.peek() === saved && restored.get(saved)?.clientId === clientId) clearDraft(conversationId);
  };
  const confirmed = () => confirmedSend(messagesFor(conversationId).peek(), clientId, conversationId);
  try {
    let sent = confirmed();
    if (!sent && remote && !deviceId) throw new Error('The original PC could not be identified. Check the chat before sending a new message.');
    if (!sent && deviceId) {
      if (rpc.status.peek() !== 'open') throw new Error('Reconnect to the original PC and try again.');
      const pc = await rpc.call('system.info');
      if (pc.deviceId !== deviceId || rpc.status.peek() !== 'open') {
        throw new Error('This send was started on another PC. Reconnect to that PC before retrying.');
      }
      sent = confirmed();
    }
    sent ??= await rpc.call('messages.send', params);
    resolvePending(clientId, sent);
    clearRestored();
    noteSavedKeys(body, sent?.body ?? body);
    return true;
  } catch (error) {
    const sent = confirmed();
    if (sent) {
      resolvePending(clientId, sent);
      clearRestored();
      noteSavedKeys(body, sent.body);
      return true;
    }
    failPending(clientId, errorText(error), retry);
    toastError(error, 'Message not confirmed');
    return false;
  }
}

const errorText = (error: unknown): string => (error instanceof Error && error.message ? error.message : 'Not confirmed');
