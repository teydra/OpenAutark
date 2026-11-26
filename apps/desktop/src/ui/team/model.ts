// Pure helpers for the team views: the org tree (managers → reports), grouping its roots by space and the space a
// report names, "most used" ranking from real chat activity, agent status lines, the Team page headline, search,
// the archived list and pairing of run items (tool call ↔ result).
// Owns: these rules (unit-tested in test/unit/ui/team-model.test.ts).
// Never: imports the store, rpc or the DOM – callers pass data in.

import type { Agent, AgentStatus, Space } from '../../shared/model/org.ts';
import type { ConversationSummary } from '../../shared/model/chat.ts';
import type { AgentActivity, RunItem } from '../../shared/model/runs.ts';

const DAY_MS = 86_400_000;

export interface OrgEntry { agent: Agent; reports: OrgEntry[] }

export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  idle: 'Idle', working: 'Working', waiting: 'Waiting', paused: 'Paused', error: 'Error',
};

/**
 * "Most used" (G21 / desktop §18): the human's chats with an agent, weighted by recency with a
 * 30-day decay. Counts only chats the human is in; opening a chat does not count, nor does a chat nobody
 * wrote in (B-050 K1, Nachtrag Runde 4: every agent has its empty default 1:1 from the hire on).
 */
export function interactionScores(chats: Array<Pick<ConversationSummary, 'members' | 'lastMessageAt' | 'createdAt'>>, now: number, decayDays = 30): Map<string, number> {
  const scores = new Map<string, number>();
  for (const chat of chats) {
    if (chat.lastMessageAt === undefined) continue;
    const active = chat.members.filter((member) => !member.leftAt);
    if (!active.some((member) => member.kind === 'human')) continue;
    const age = Math.max(0, now - (chat.lastMessageAt ?? chat.createdAt));
    const weight = Math.exp(-age / (decayDays * DAY_MS));
    for (const member of active) {
      if (member.kind === 'agent') scores.set(member.memberId, (scores.get(member.memberId) ?? 0) + weight);
    }
  }
  return scores;
}

function byScoreThenName(scores: Map<string, number>) {
  return (a: OrgEntry, b: OrgEntry) => (scores.get(b.agent.id) ?? 0) - (scores.get(a.agent.id) ?? 0) || a.agent.name.localeCompare(b.agent.name);
}

/**
 * Builds the responsibility tree from `managerId`. Agents whose manager is missing or archived
 * report to the human (roots). Cycles are broken (an agent appears once). Siblings are ranked
 * by interaction score, then name.
 */
export function buildOrg(agents: Agent[], scores: Map<string, number> = new Map()): OrgEntry[] {
  const active = agents.filter((agent) => !agent.archivedAt);
  const byId = new Map(active.map((agent) => [agent.id, agent]));
  const children = new Map<string, Agent[]>();
  const roots: Agent[] = [];
  for (const agent of active) {
    const manager = agent.managerId && agent.managerId !== agent.id ? byId.get(agent.managerId) : undefined;
    if (!manager) { roots.push(agent); continue; }
    const list = children.get(manager.id);
    if (list) list.push(agent); else children.set(manager.id, [agent]);
  }
  const seen = new Set<string>();
  const sort = byScoreThenName(scores);
  const build = (agent: Agent): OrgEntry => {
    seen.add(agent.id);
    const reports = (children.get(agent.id) ?? []).filter((child) => !seen.has(child.id)).map(build).sort(sort);
    return { agent, reports };
  };
  const tree = roots.map(build);
  // Agents only reachable through a cycle (a manages b manages a) become roots too.
  for (const agent of active) if (!seen.has(agent.id)) tree.push(build(agent));
  return tree.sort(sort);
}

/** Number of agents below an entry (all levels). */
export function countReports(entry: OrgEntry): number {
  return entry.reports.reduce((sum, report) => sum + 1 + countReports(report), 0);
}

/** Entwurf 2c (Mika 24.11.2026): the row under a closed manager in the sidebar tree – "6 in Konrad's team" (every agent below it). */
export function teamMoreLabel(entry: OrgEntry): string {
  return `${countReports(entry)} in ${entry.agent.name}'s team`;
}

export interface SpaceGroup { space?: Space; entries: OrgEntry[] }

/** An agent's space while it is active; an archived or unknown space counts as none. */
export function activeSpace(agent: Pick<Agent, 'spaceId'>, spaces: readonly Space[]): Space | undefined {
  return agent.spaceId ? spaces.find((space) => space.id === agent.spaceId && !space.archivedAt) : undefined;
}

/**
 * Groups the top of the org by space (P05 areas): roots without an active space first (the seed
 * Manager spans all areas), then one group per active space in sort order. Only roots are grouped
 * – a report always stays under its manager, whatever its space (the row names its space instead,
 * see reportSpace). Archiving a space removes its heading, never its agents.
 */
export function groupBySpace(entries: OrgEntry[], spaces: Space[]): SpaceGroup[] {
  const known = spaces.filter((space) => !space.archivedAt).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  const groups: SpaceGroup[] = [{ entries: [] }, ...known.map((space) => ({ space, entries: [] as OrgEntry[] }))];
  for (const entry of entries) {
    const space = activeSpace(entry.agent, known);
    (groups.find((group) => group.space === space) ?? groups[0]).entries.push(entry);
  }
  return groups.filter((group) => group.entries.length > 0);
}

/**
 * The space a row names after its status: the agent's own active space when it differs from the one
 * it sits in (`above`: the group's space, or the nearest manager's with one; '' = none). `context` is
 * what its own reports sit in.
 */
export function reportSpace(agent: Pick<Agent, 'spaceId'>, above: string, spaces: readonly Space[]): { name: string; context: string } {
  const own = activeSpace(agent, spaces);
  if (!own) return { name: '', context: above };
  return { name: own.id === above ? '' : own.name, context: own.id };
}

/** The Team page's one headline: "12 agents · 3 working · 1 waiting" (zero counts beyond the first are left out). */
export function teamHeadline(agents: ReadonlyArray<Pick<Agent, 'id' | 'status' | 'archivedAt'>>, live: ReadonlyMap<string, unknown>): string {
  const active = agents.filter((agent) => !agent.archivedAt);
  const working = active.filter((agent) => live.has(agent.id) || agent.status === 'working').length;
  const waiting = active.filter((agent) => !live.has(agent.id) && agent.status === 'waiting').length;
  return [`${active.length} ${active.length === 1 ? 'agent' : 'agents'}`, working ? `${working} working` : '', waiting ? `${waiting} waiting` : '']
    .filter(Boolean).join(' · ');
}

/** The archived agents after an 'agent.upserted' event: an archived one comes in (newest first), a restored one goes out. */
export function applyArchived(list: Agent[], agent: Agent): Agent[] {
  const rest = list.filter((entry) => entry.id !== agent.id);
  return agent.archivedAt === undefined ? rest : [agent, ...rest].sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
}

export function matchesAgent(agent: Pick<Agent, 'name' | 'role' | 'team'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return agent.name.toLowerCase().includes(q) || agent.role.toLowerCase().includes(q) || (agent.team ?? '').toLowerCase().includes(q);
}

/** Effective status: a live run always means "working" (activity is the real source). */
export function effectiveStatus(agent: Pick<Agent, 'status'>, live: AgentActivity | undefined): AgentStatus {
  return live ? 'working' : agent.status;
}

/** The one-line status under an agent's name: live note, else status note, else role. */
export function agentStatusLine(agent: Pick<Agent, 'status' | 'statusNote' | 'role'>, live: AgentActivity | undefined): string {
  if (live?.note) return live.note;
  if (live) return AGENT_STATUS_LABELS.working;
  if (agent.statusNote && agent.status !== 'idle') return agent.statusNote;
  if (agent.status !== 'idle') return AGENT_STATUS_LABELS[agent.status];
  return agent.role;
}

export type RunEntry =
  | { kind: 'tool'; call: RunItem; result?: RunItem }
  | { kind: 'item'; item: RunItem };

/** Run items in order, each tool call joined with its result (by data.callId). */
export function runEntries(items: RunItem[]): RunEntry[] {
  const sorted = items.slice().sort((a, b) => a.seq - b.seq);
  const results = new Map<string, RunItem>();
  for (const item of sorted) {
    const callId = item.data.callId;
    if (item.kind === 'tool_result' && typeof callId === 'string') results.set(callId, item);
  }
  const used = new Set<string>();
  const out: RunEntry[] = [];
  for (const item of sorted) {
    const callId = typeof item.data.callId === 'string' ? item.data.callId : undefined;
    if (item.kind === 'tool_call') {
      const result = callId ? results.get(callId) : undefined;
      if (result) used.add(result.id);
      out.push({ kind: 'tool', call: item, result });
    } else if (item.kind === 'tool_result' && used.has(item.id)) {
      continue;
    } else {
      out.push({ kind: 'item', item });
    }
  }
  return out;
}

/** Short, safe preview of arbitrary JSON-ish data (already truncated by the runtime). */
export function previewData(value: unknown, max = 2000): string {
  if (value === undefined || value === null) return '';
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try { text = JSON.stringify(value, null, 2); } catch { text = String(value); }
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
