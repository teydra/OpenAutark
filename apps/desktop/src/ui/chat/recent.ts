// Entwurf 2 (Mika 24.11.2026, after the owner 17.11.: "nicht die ganze Zeit … offen … dass ich die Unteragenten sehe"):
// the chat list's main section shows only what is being worked with – a chat with a line in the last RECENT_DAYS, or one
// that is pinned, unread, has an agent at work or open tasks. Everything else waits in the collapsed "Older" group at the
// end (ChatList.tsx), so nothing is lost. An empty default 1:1 with a sub-agent (an agent reporting to another agent)
// never counts as recent by itself: a newly hired sub-agent does not appear in Chats until someone writes there.
// Owns: that split. Never: reads the store, orders (list-order.ts) or decides the other sections (archive.ts).

import type { ConversationSummary } from '../../shared/model/chat.ts';
import type { Agent } from '../../shared/model/org.ts';
import { directAgent } from './list-order.ts';

export const RECENT_DAYS = 7;
export const RECENT_WINDOW_MS = RECENT_DAYS * 24 * 60 * 60 * 1000;

type Splittable = Pick<ConversationSummary, 'id' | 'settings' | 'members' | 'pinned' | 'unread' | 'working' | 'openTasks' | 'lastMessageAt' | 'createdAt'>;
type OrgAgent = Pick<Agent, 'id' | 'managerId'>;

/** True when the chat is the person's default 1:1 with an agent that reports to another agent. */
export function subAgentDirect(chat: Splittable, agents: ReadonlyMap<string, OrgAgent>): boolean {
  const agentId = directAgent(chat, agents);
  const manager = agentId ? agents.get(agentId)?.managerId : undefined;
  return manager !== undefined && agents.has(manager);
}

/** True when the chat belongs above "Older": pinned, unread, at work, open tasks, or activity inside the window. */
export function isRecent(chat: Splittable, now: number, agents: ReadonlyMap<string, OrgAgent> = new Map()): boolean {
  if (chat.pinned || chat.unread > 0 || chat.working.length > 0 || chat.openTasks > 0) return true;
  if (chat.lastMessageAt !== undefined) return now - chat.lastMessageAt < RECENT_WINDOW_MS;
  if (chat.settings.direct === true && subAgentDirect(chat, agents)) return false; // a new sub-agent's empty 1:1
  return now - chat.createdAt < RECENT_WINDOW_MS;
}

/** The section's chats split into the shown ones and "Older", each keeping the given order. */
export function splitRecent<C extends Splittable>(list: readonly C[], now: number, agents?: ReadonlyMap<string, OrgAgent>): { recent: C[]; older: C[] } {
  const recent: C[] = [];
  const older: C[] = [];
  for (const chat of list) (isRecent(chat, now, agents) ? recent : older).push(chat);
  return { recent, older };
}
