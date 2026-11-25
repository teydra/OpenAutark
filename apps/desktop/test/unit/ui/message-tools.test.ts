// F30 (owner 16.11.2026): a message's Copy and Reply (src/ui/chat/message-tools.ts, MessageActions.tsx, MessageItem.tsx,
// chat.css). Copy takes the mouse selection where it touches the message, else the whole message; a touch long press's
// own one-word pick never counts, and on touch the menu offers "Select text" (its sheet, SelectText.tsx). Copy and Reply
// are two small icons in every finished text message's meta row – after the time on the left, before the markers in the
// own bubble – always rendered (nothing moves), seen on hover or focus, always on touch. reply() is the one way the menu,
// the icon and the phone's swipe answer a message: the draft's reply, never on a streaming or non-text row.
// Owns: these assertions. Never: renders or a real selection (the selection is a fake).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Message } from '../../../src/shared/model/chat.ts';
import type { SessionInfo } from '../../../src/shared/api/methods.ts';
import { rpc } from '../../../src/ui/lib/rpc.ts';
import { session } from '../../../src/ui/lib/session.ts';

(rpc as unknown as { onOpen: unknown }).onOpen = () => () => undefined;
(rpc as unknown as { call: unknown }).call = async () => ({ ok: true });
const { canReply, copyText, copyable, menuSelection, reply, selectedIn } = await import('../../../src/ui/chat/message-tools.ts');
const { draftFor } = await import('../../../src/ui/chat/composer/draft.ts');

const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
const message = (patch: Partial<Message> = {}): Message => ({
  id: 'msg_1', conversationId: 'cv_tools', seq: 1, authorId: 'ag_mara', authorKind: 'agent', kind: 'text', body: 'Call **Anna** back at 10.', attachments: [], mentions: [],
  priority: 'normal', state: 'final', silent: false, meta: {}, createdAt: 1, ...patch,
}) as Message;

/** A fake selection of `text` whose range touches the nodes in `touches`. */
const selection = (text: string, touches: unknown[]) => ({
  isCollapsed: text.length === 0, rangeCount: text ? 1 : 0, toString: () => text,
  getRangeAt: () => ({ intersectsNode: (node: unknown) => touches.includes(node) }),
});

test('Copy takes the mouse selection where it touches the message, else the whole message', () => {
  const row = {} as Node;
  const other = {} as Node;
  assert.equal(selectedIn(row, selection('Anna back', [row])), 'Anna back', 'a selection inside the message');
  assert.equal(selectedIn(row, selection('elsewhere', [other])), '', 'a selection in another message is not this one\'s');
  assert.equal(selectedIn(row, selection('', [row])), '', 'no selection');
  assert.equal(selectedIn(row, selection('   ', [row])), '', 'only blanks selected');
  assert.equal(selectedIn(null, selection('Anna', [row])), '');
  assert.equal(copyText('Call **Anna** back at 10.', 'Anna back'), 'Anna back');
  assert.equal(copyText('Call **Anna** back at 10.', ''), 'Call **Anna** back at 10.', 'nothing selected: the whole message, its raw text');
  assert.equal(menuSelection({ touch: false, at: row }, selection('Anna', [row])), 'Anna', 'the mouse\'s selection counts');
  assert.equal(menuSelection({ touch: true, at: row }, selection('Anna', [row])), '', 'a long press\'s one word is the browser\'s pick: the whole message');
});

test('the menu: Copy uses the selection read when it opens; Select text only on touch and only with words', () => {
  const actions = read('src/ui/chat/MessageActions.tsx');
  assert.match(actions, /const selected = menuSelection\(open\);[^\n]*\n\s*if \(message\.body && message\.state !== 'streaming'\) items\.push\(\{ label: 'Copy', onSelect: \(\) => void copy\(copyText\(message\.body, selected\)\) \}\);/);
  assert.match(actions, /if \(open\.touch && copyable\(message\)\) items\.push\(\{ label: 'Select text', onSelect: actions\.selectText \}\);/);
  assert.match(read('src/ui/chat/MessageItem.tsx'), /const build = \(open: MenuOpen\) => messageMenu\(message, open, \{ edit: \(\) => setEditing\(true\), selectText: \(\) => setSelecting\(true\) \}\);\s*const menu = useContextMenu\(build, \{ touchByButton: true \}\);/, '17.11.2026: a finger selects natively, the menu is the More button');
  const menu = read('src/ui/lib/context-menu.tsx');
  assert.match(menu, /if \(touch\.current\) dropTouchSelection\(\);\s*openContextMenu\(x, y, build\(\{ touch: touch\.current, at \}\), container\);/, 'a touch open drops the browser\'s one-word pick: one menu');
  assert.match(menu, /touch\.current = event\.pointerType === 'touch';/);
  const sheet = read('src/ui/chat/SelectText.tsx');
  assert.match(sheet, /createPortal\(\s*<Dialog open onClose=\{onClose\} title="Select text"/, 'outside the message: none of our press handlers inside');
  assert.match(sheet, /<div class="select-text-body">\{props\.message\.body\}<\/div>/, 'the text Copy copies');
  assert.match(sheet, /addBackLayer\(/, 'the phone\'s Back closes it first');
  assert.match(read('src/ui/styles/chat.css'), /\.select-text-body \{[^}]*user-select: text; -webkit-user-select: text;/);
});

test('the meta row: Copy and Reply on finished text messages only, after the time on the left, before the markers in the own bubble', () => {
  assert.equal(copyable(message()), true);
  assert.equal(copyable(message({ state: 'streaming' })), false, 'not while it streams');
  assert.equal(copyable(message({ kind: 'status' })), false, 'no status line');
  assert.equal(copyable(message({ kind: 'task' })), false, 'no task card');
  assert.equal(copyable(message({ body: '  ' })), false, 'nothing to copy');
  const actions = read('src/ui/chat/MessageActions.tsx');
  assert.match(actions, /if \(message\.kind !== 'text' \|\| message\.state !== 'final'\) return null;/);
  assert.match(actions, /<IconButton icon="copy" label="Copy" size="small" iconSize=\{14\} class="message-tool" onClick=\{\(\) => void copy\(message\.body\)\} \/>/);
  assert.match(actions, /\{canReply\(message\) && <IconButton icon="arrow-bend-up-left" label="Reply" [^>]*class="message-tool" onClick=\{\(\) => \{ reply\(message\); \}\} \/>\}/);
  const item = read('src/ui/chat/MessageItem.tsx');
  assert.match(item, /<div class="message-actions">\s*\{props\.own && <MessageTools message=\{message\} menu=\{props\.menu\} \/>\}/, 'own bubble: before the markers, the time keeps the edge');
  // Owner 24.11.2026 (task_3x012n3a, "wie bei WhatsApp"): the own bubble's ticks come right after its time, at the edge.
  assert.match(item, /imported<\/span>\}\s*\{props\.own && props\.receipt && <ReceiptMark state=\{props\.receipt\} \/>\}\s*\{!props\.own && <MessageTools message=\{message\} menu=\{props\.menu\} \/>\}\s*<\/div>/, 'others: after the time');
  assert.match(item, /<Actions message=\{message\} own=\{human\} menu=\{build\} receipt=\{props\.receipt\} \/>/);
});

test('the tools never move anything: always rendered, opacity only, 24 px inside the 26 px row, always seen on touch', () => {
  const css = read('src/ui/styles/chat.css');
  assert.match(css, /\.message-tool\.icon-button \{ width: 24px; height: 24px; [^}]*opacity: 0;/);
  assert.match(css, /\.message:hover \.message-tool, \.message:focus-within \.message-tool \{ opacity: 1; \}/);
  assert.match(css, /@media \(hover: none\) \{ \.message-tool\.icon-button \{ opacity: 1; \} \}/);
  assert.match(css, /\.message-actions \{[^}]*min-height: 26px;/, 'the row is reserved under every message');
  assert.doesNotMatch(css, /\.message-tool[^{]*\{[^}]*display: none/, 'never taken out of the row');
});

test('reply(): the draft answers the message; nothing on a streaming or non-text row or where this connection cannot send', () => {
  session.value = { kind: 'owner', allowedMethods: [], capabilities: [] } as unknown as SessionInfo;
  assert.equal(reply(message()), true);
  assert.equal(draftFor('cv_tools').value.replyTo, 'msg_1');
  assert.equal(reply(message({ id: 'msg_2', state: 'streaming' })), false);
  assert.equal(reply(message({ id: 'msg_3', kind: 'status' })), false);
  assert.equal(draftFor('cv_tools').value.replyTo, 'msg_1', 'unchanged');
  assert.equal(reply(message({ id: 'msg_4', state: 'failed' })), true, 'a failed answer can be answered too (as the menu always could)');
  session.value = { kind: 'device', allowedMethods: ['messages.list'], capabilities: [] } as unknown as SessionInfo;
  assert.equal(canReply(message()), false);
  assert.equal(reply(message({ id: 'msg_5' })), false, 'a phone that may not send has no reply');
  assert.equal(draftFor('cv_tools').value.replyTo, 'msg_4');
  session.value = null;
  assert.match(read('src/ui/chat/Composer.tsx'), /useEffect\(\(\) => \{ if \(replyTo\) fieldRef\.current\?\.focus\(\); \}, \[replyTo\]\);/, 'the composer takes the focus for the reply');
});
