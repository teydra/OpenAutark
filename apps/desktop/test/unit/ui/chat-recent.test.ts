// Entwurf 2 (Mika 24.11.2026; owner 17.11.: sub-agents must not stay open in the list all the time): the chat list shows
// chats with activity in the last 7 days, pinned/unread/at-work/open-task chats always, and puts the rest into the
// collapsed "Older" group (src/ui/chat/recent.ts, ChatList.tsx); a new sub-agent's empty 1:1 does not appear by itself.
// The chat search finds agents by name and role with their team (src/ui/chat/people-search.ts), and the team sidebar
// says how many sit in a closed manager's team (src/ui/team/model.ts teamMoreLabel).
// Owns: these assertions. Never: renders (checked in the window).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationSummary, Member } from '../../../src/shared/model/chat.ts';
import { isRecent, RECENT_WINDOW_MS, splitRecent } from '../../../src/ui/chat/recent.ts';
import { orderChats } from '../../../src/ui/chat/list-order.ts';
import { findAgents, teamLine } from '../../../src/ui/chat/people-search.ts';
import { countReports, teamMoreLabel, type OrgEntry } from '../../../src/ui/team/model.ts';
import type { Agent } from '../../../src/shared/model/org.ts';

const NOW = Date.UTC(2026, 10, 25, 9);
const DAY = 86_400_000;

type Row = Pick<ConversationSummary, 'id' | 'title' | 'settings' | 'members' | 'pinned' | 'unread' | 'working' | 'openTasks' | 'lastMessageAt' | 'createdAt'>;

function member(memberId: string): Member {
  return { conversationId: 'c', memberId, kind: memberId === 'human' ? 'human' : 'agent', role: 'member', readSeq: 0, joinedAt: 0 } as Member;
}

function row(id: string, over: Partial<Row> = {}): Row {
  return { id, title: id, settings: {}, members: [member('human'), member(`ag_${id}`)], pinned: false, unread: 0, working: [], openTasks: 0, createdAt: NOW - 30 * DAY, ...over };
}

const direct = (agentId: string, over: Partial<Row> = {}): Row =>
  row(agentId, { settings: { direct: true, directPair: [agentId, 'human'] }, members: [member('human'), member(agentId)], ...over });

const agent = (id: string, managerId?: string): Pick<Agent, 'id' | 'managerId'> => ({ id, ...(managerId ? { managerId } : {}) });
const org = new Map([['konrad', agent('konrad')], ['felix', agent('felix', 'konrad')]]);

test('isRecent: the 7-day line by the last message', () => {
  assert.equal(isRecent(row('a', { lastMessageAt: NOW - DAY }), NOW), true);
  assert.equal(isRecent(row('b', { lastMessageAt: NOW - RECENT_WINDOW_MS + 1 }), NOW), true, 'just inside');
  assert.equal(isRecent(row('c', { lastMessageAt: NOW - RECENT_WINDOW_MS }), NOW), false, 'exactly 7 days: older');
  assert.equal(isRecent(row('d', { lastMessageAt: NOW - 8 * DAY }), NOW), false);
});

test('isRecent: pinned, unread, at work and open tasks stay on top whatever their age', () => {
  const old = { lastMessageAt: NOW - 60 * DAY };
  assert.equal(isRecent(row('p', { ...old, pinned: true }), NOW), true);
  assert.equal(isRecent(row('u', { ...old, unread: 2 }), NOW), true);
  assert.equal(isRecent(row('w', { ...old, working: ['ag_w'] }), NOW), true);
  assert.equal(isRecent(row('t', { ...old, openTasks: 1 }), NOW), true);
});

test('isRecent: a chat without lines counts by its creation; a sub-agent\'s empty 1:1 never by itself', () => {
  assert.equal(isRecent(row('new', { createdAt: NOW - DAY }), NOW), true, 'a new group chat');
  assert.equal(isRecent(direct('konrad', { createdAt: NOW - DAY }), NOW, org), true, 'a new top agent\'s 1:1');
  assert.equal(isRecent(direct('felix', { createdAt: NOW - DAY }), NOW, org), false, 'a new sub-agent stays out of Chats');
  assert.equal(isRecent(direct('felix', { createdAt: NOW - DAY, lastMessageAt: NOW - DAY }), NOW, org), true, 'with its first line it shows');
  assert.equal(isRecent(direct('felix', { createdAt: NOW - DAY, unread: 1 }), NOW, org), true, 'or when it has news');
});

test('splitRecent: keeps the list order in both groups and loses nothing', () => {
  const list = orderChats([
    row('old', { lastMessageAt: NOW - 20 * DAY }),
    row('today', { lastMessageAt: NOW - 1000 }),
    row('pinnedOld', { pinned: true, lastMessageAt: NOW - 90 * DAY }),
    row('week', { lastMessageAt: NOW - 3 * DAY }),
    row('older', { lastMessageAt: NOW - 10 * DAY }),
    row('unreadOld', { unread: 1, lastMessageAt: NOW - 40 * DAY }),
  ]);
  const { recent, older } = splitRecent(list, NOW);
  assert.deepEqual(recent.map((chat) => chat.id), ['pinnedOld', 'today', 'week', 'unreadOld']);
  assert.deepEqual(older.map((chat) => chat.id), ['older', 'old']);
  assert.equal(recent.length + older.length, list.length);
});

type Findable = Pick<Agent, 'id' | 'name' | 'role' | 'managerId' | 'archivedAt' | 'team'>;
const team: Findable[] = [
  { id: 'paula', name: 'Paula', role: 'Head of communication' },
  { id: 'jonas', name: 'Jonas', role: 'Discord: company account and own server', managerId: 'paula' },
  { id: 'mira', name: 'Mira', role: 'Discord presence in AI communities', managerId: 'paula' },
  { id: 'old', name: 'Discordia', role: 'Gone', archivedAt: NOW },
  { id: 'disco', name: 'Disco', role: 'Parties' },
];

test('findAgents: name and role match, name hits first, archived agents never', () => {
  assert.deepEqual(findAgents(team, 'discord').map((a) => a.id), ['jonas', 'mira']);
  assert.deepEqual(findAgents(team, 'disc').map((a) => a.id), ['disco', 'jonas', 'mira'], 'name hit first');
  assert.deepEqual(findAgents(team, '  '), []);
  assert.equal(findAgents(team, 'a', 2).length, 2, 'limited');
});

test('teamLine: names the manager; none for a top agent', () => {
  const names: Record<string, string> = { paula: 'Paula' };
  assert.equal(teamLine(team[1]!, (id) => names[id] ?? ''), "In Paula's team");
  assert.equal(teamLine(team[0]!, (id) => names[id] ?? ''), '');
});

test('teamMoreLabel: counts every agent below a closed manager', () => {
  const leaf = (id: string): OrgEntry => ({ agent: { id, name: id } as Agent, reports: [] });
  const konrad: OrgEntry = { agent: { id: 'konrad', name: 'Konrad' } as Agent, reports: [
    { agent: { id: 'felix', name: 'Felix' } as Agent, reports: [leaf('noah'), leaf('mika')] },
    leaf('lena'), leaf('juri'), leaf('theo'),
  ] };
  assert.equal(countReports(konrad), 6);
  assert.equal(teamMoreLabel(konrad), "6 in Konrad's team");
});
