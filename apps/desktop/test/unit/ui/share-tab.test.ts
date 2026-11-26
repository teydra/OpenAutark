// A tab handed on (src/ui/workspace/share-tab.ts, phone-tabs.ts withShared). "Share in chat" offers the latest listed
// chats but the area the page is in; a person's device takes the websites shared in its chats' areas in place of the
// ones it had and keeps its own tabs. "Open on" and "Share with": pane-menu-share.test.ts.
// Owns: these assertions only. Never: a socket or a window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationSummary } from '../../../src/shared/model/chat.ts';
import { chatSections, shareChats, SHARE_CHATS } from '../../../src/ui/workspace/share-tab.ts';
import { withShared } from '../../../src/ui/workspace/phone-tabs.ts';

const chat = (id: string, at: number, extra: Partial<ConversationSummary> = {}) => ({ id, title: id, titleNamed: true, createdBy: 'human', pinned: false, settings: {}, lastSeq: 0, createdAt: 0, updatedAt: 0, lastMessageAt: at, members: [], unread: 0, working: [], openTasks: 0, ...extra }) as ConversationSummary;

test('Share in chat: the latest listed chats, not the area the page is in', () => {
  const chats = [chat('a', 1), chat('b', 3), chat('c', 2, { archivedAt: 5 }), chat('d', 4, { settings: { hiddenFromList: true } }), ...Array.from({ length: 9 }, (_, i) => chat(`x${i}`, 0))];
  assert.deepEqual(shareChats(chats, 'b').slice(0, 2).map((entry) => entry.id), ['a', 'x0']);
  assert.equal(shareChats(chats).length, SHARE_CHATS);
  assert.equal(shareChats(chats)[0].id, 'b');
});

test('Share in chat offers a draft action and tabs in other chats; nothing without an address', () => {
  let drafted = false;
  const sections = chatSections('https://a.example/', 'chat:a', [chat('a', 1), chat('b', 2)], () => { drafted = true; });
  assert.deepEqual(sections.map((section) => [section.title, section.items.map((item) => item.label)]),
    [[undefined, ['Add page to message']], ['Open as a tab in', ['b']]]);
  sections[0].items[0].onSelect();
  assert.equal(drafted, true);
  assert.deepEqual(chatSections('https://a.example/', 'chat:a', [chat('a', 1)]), [], 'remote page without another target');
  assert.deepEqual(chatSections('', 'global', [chat('b', 2)]), []);
});

test('a person\'s device: shared websites replace the shared ones it had, its own tabs stay', () => {
  const shared = { id: 'remote:pc:web-1', panel: 'remote', device: 'pc', tab: 'web-1', url: 'https://one.example/' };
  const gone = { id: 'remote:pc:web-0', panel: 'remote', device: 'pc', tab: 'web-0', url: 'https://old.example/' };
  const notes = { id: 'notes:a', panel: 'notes', conversationId: 'a' };
  const next = withShared({ global: { shown: 'day', tabs: [{ id: 'day', panel: 'day' }] }, 'chat:a': { shown: gone.id, tabs: [gone, notes] }, 'chat:b': { tabs: [gone] } }, { 'chat:a': { shown: shared.id, tabs: [shared] } });
  assert.deepEqual(next, {
    global: { shown: 'day', tabs: [{ id: 'day', panel: 'day' }] },
    'chat:a': { tabs: [shared, notes] },
  });
});
