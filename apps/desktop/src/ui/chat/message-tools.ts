// What a message's Copy and Reply do (F30, owner 16.11.2026: "vielleicht will ich ja nur den Teil kopieren", "außerdem
// möchte ich antworten können"). Copy takes the text the person selected with the mouse where the selection touches
// this message, else the whole message (its raw text, as before). A touch long press selects one word by itself – the
// browser's pick, not the person's (lib/context-menu.tsx drops it) – so on touch Copy takes the whole message, and
// a part is chosen with the phone's own handles and copied with its own copy bar (FCMWSYY3: no sheet of ours). reply() is the one way the
// menu entry, the meta row's Reply icon (MessageActions.tsx) and the phone's swipe (shell/MobileShell.tsx) answer a
// message: the composer's draft gets the reply (composer/draft.ts setReply), and the composer shows the quote and takes
// the focus.
// Owns: those rules. Never: writes the clipboard (MessageActions.tsx), changes the selection or renders.

import type { Message } from '../../shared/model/chat.ts';
import { can } from '../lib/session.ts';
import { setReply } from './composer/draft.ts';

/** A finished text message this connection may answer (also a failed or stopped one; never one still streaming). */
export const canReply = (message: Message) => message.kind === 'text' && message.state !== 'streaming' && can('messages.send');

/** A finished text message with words: Copy and Select text apply. */
export const copyable = (message: Message) => message.kind === 'text' && message.state === 'final' && message.body.trim().length > 0;

/** The next message of the chat answers `message`; false where it cannot (nothing changes then). */
export function reply(message: Message): boolean {
  if (!canReply(message)) return false;
  setReply(message.conversationId, message.id);
  return true;
}

/** The part of the DOM Selection this reads (a fake in tests). */
export interface SelectionLike {
  readonly isCollapsed: boolean;
  readonly rangeCount: number;
  getRangeAt(index: number): { intersectsNode(node: Node): boolean };
  toString(): string;
}

/** The selected text when the selection touches `element` ('' when nothing of it is selected there). */
export function selectedIn(element: Node | null, selection: SelectionLike | null): string {
  if (!element || !selection || selection.isCollapsed || !selection.rangeCount) return '';
  for (let index = 0; index < selection.rangeCount; index++) {
    if (!selection.getRangeAt(index).intersectsNode(element)) continue;
    const text = selection.toString();
    return text.trim() ? text : '';
  }
  return '';
}

/** What Copy writes: the selected part when there is one, else the whole body. */
export function copyText(body: string, selected: string): string {
  return selected.trim() ? selected : body;
}

/** The selection Copy may take for a menu opened on `at`: the mouse's, never a touch long press's. */
export function menuSelection(open: { touch: boolean; at: Node | null }, selection: SelectionLike | null = currentSelection()): string {
  return open.touch ? '' : selectedIn(open.at, selection);
}

function currentSelection(): SelectionLike | null {
  try { return typeof getSelection === 'function' ? getSelection() : null; } catch { return null; }
}
