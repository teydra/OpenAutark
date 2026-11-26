// Copy takes the whole message. Marking text lets the person copy just that part; a touch long press
// uses the device's own selection. reply() sets the composer's reply draft, whether from a menu, button or swipe.
// Owns: those rules. Never: writes the clipboard, changes the selection or renders.

import type { Message } from '../../shared/model/chat.ts';
import { can } from '../lib/session.ts';
import { setReply } from './composer/draft.ts';

/** A finished text message this connection may answer (also a failed or stopped one; never one still streaming). */
export const canReply = (message: Message) => message.kind === 'text' && message.state !== 'streaming' && can('messages.send');

/** A non-streaming text message with words can be copied, including failed or stopped replies. */
export const copyable = (message: Message) => message.kind === 'text' && message.state !== 'streaming' && message.body.trim().length > 0;

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

/** The selection the menu may copy for a menu opened on `at`: the mouse's, never a touch long press's. */
export function menuSelection(open: { touch: boolean; at: Node | null }, selection: SelectionLike | null = currentSelection()): string {
  return open.touch ? '' : selectedIn(open.at, selection);
}

function currentSelection(): SelectionLike | null {
  try { return typeof getSelection === 'function' ? getSelection() : null; } catch { return null; }
}
