// The newest line of a person in a chat (text or answer) – for a turn that has no line of its own in hand: what the person
// picked in the composer for their newest message is read off that line (routing/policies.ts newestLineChoice).
// 26.11.2026: replaces chat/suggestion-fresh.ts (F22), which told a pick made for one message from a value that stayed –
// a pick no longer stays (chat/sticky-model.ts withoutChoice).
// Owns: that lookup. Never: writes rows.

import type { Message } from '../../shared/model/chat.ts';
import type { RuntimeServices } from '../contracts.ts';

const PAGE = 50;
const PAGES = 4; // at most 200 lines back

const isLine = (message: Pick<Message, 'kind'>): boolean => message.kind === 'text' || message.kind === 'answer';

/** The newest line of a person in a chat (text or answer); undefined without one or when the history cannot be read. */
export function newestPersonLine(services: Pick<RuntimeServices, 'chats'>, conversationId: string | undefined): Message | undefined {
  if (!conversationId) return undefined;
  try {
    let before: number | undefined;
    for (let page = 0; page < PAGES; page += 1) {
      const lines = services.chats.messages(conversationId, { ...(before !== undefined ? { beforeSeq: before } : {}), limit: PAGE });
      for (let i = lines.length - 1; i >= 0; i -= 1) if (lines[i].authorKind === 'human' && isLine(lines[i])) return lines[i];
      if (lines.length < PAGE) return undefined;
      before = lines[0].seq;
    }
  } catch { /* no history: none */ }
  return undefined;
}
