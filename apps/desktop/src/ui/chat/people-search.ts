// Entwurf 2b (Mika 24.11.2026): the chat list's search finds agents by name and by role ("discord" → Jonas, Mira), so
// a sub-agent the list does not show is two taps away – the search, then "Message" on its row (chat/direct.ts opens the
// default 1:1; it shows in Chats with its first line). Each hit names whose team it is in (its manager, agent or person).
// Owns: which agents match and the team line. Never: reads the store or opens chats.

import type { Agent } from '../../shared/model/org.ts';

type Findable = Pick<Agent, 'id' | 'name' | 'role' | 'managerId' | 'archivedAt'> & { team?: string };

export const PEOPLE_HITS = 8;

/** Active agents whose name, role or team holds the query; name hits first, then by name. */
export function findAgents<A extends Findable>(agents: readonly A[], query: string, limit = PEOPLE_HITS): A[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const byName = (agent: A) => agent.name.toLowerCase().includes(q);
  return agents
    .filter((agent) => agent.archivedAt === undefined && (byName(agent) || agent.role.toLowerCase().includes(q) || (agent.team ?? '').toLowerCase().includes(q)))
    .sort((a, b) => Number(byName(b)) - Number(byName(a)) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** "In Konrad's team" for an agent with a manager (`nameOf` gives the manager's name; empty: no line). */
export function teamLine(agent: Pick<Agent, 'managerId'>, nameOf: (id: string) => string): string {
  const name = agent.managerId ? nameOf(agent.managerId).trim() : '';
  return name ? `In ${name}'s team` : '';
}
