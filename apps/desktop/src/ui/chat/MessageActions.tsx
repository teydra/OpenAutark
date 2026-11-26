// Message actions: the message's right-click (long-press) menu – B-080: first, for each attachment, "Open <name>" and
// (desktop) "Show <name> in folder"; then Reply, Start thread (B-078: or Open thread), Copy selection, Edit, Remember why…, Delete,
// each only where it applies – and the inline editor. Reply sets the composer's reply (draft.ts setReply) for a finished
// text message; Edit and Delete are offered for the caller's own text messages only, where this connection
// may call them. Edit opens the inline editor in place (Esc cancels, Ctrl+Enter or Save saves; the message
// then shows "edited"); Remember why… (own text messages) opens its one-field dialog (RememberWhy.tsx); Delete asks
// first, the runtime leaves a "Message deleted" tombstone.
// F30 (owner 16.11.2026: "man soll unten drunter ein Copy-Symbol haben", "antworten können … auf dem PC unten drunter
// Buttons"): the Copy button takes the whole message. The menu offers Copy selection only when text is selected
// inside the message. Touch long press uses native selection; the Select text sheet remains available to touch menus.
// MessageTools puts Copy and Reply into the message's meta row; message-tools.ts owns their eligibility.
// 16.11.2026: with a piece of the message marked, "Save as secret" stores it and puts its handle there (message-keys.ts).
// Owns: the menu entries, the meta row's two tools and the inline editor. Never: decides who may edit (the runtime
// refuses others' messages) or renders the message itself (MessageItem).

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Message } from '../../shared/model/chat.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { personalText } from '../../shared/model/message-changes.ts';
import { confirm, IconButton, type MenuItem, type MenuSection } from '../lib/ui.tsx';
import { openContextMenu, type MenuOpen } from '../lib/context-menu.tsx';
import { modKey } from '../lib/platform.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { pushToast, toastError } from '../lib/toasts.ts';
import { offersRemember } from './remember.ts';
import { rememberTarget } from './RememberWhy.tsx';
import { isThread, startThread, threadsByAnchor } from './threads.ts';
import { conversationMap } from '../lib/store.ts';
import { platform } from '../lib/platform.ts';
import { openAttachment, showAttachment } from './Attachments.tsx';
import { canReply, copyable, menuSelection, reply } from './message-tools.ts';
import { markedSecret, saveAsSecret } from './message-keys.ts';

/** The caller's own finished text message ('human' is the caller on every device) – the runtime's rule (chat/message-edits.ts). */
const own = (message: Message) => personalText(message) && message.authorId === HUMAN_ID && message.state === 'final';
const canEdit = (message: Message) => own(message) && message.body.trim().length > 0 && can('messages.edit');
const canDelete = (message: Message) => own(message) && can('messages.delete');

async function remove(message: Message): Promise<void> {
  const ok = await confirm({
    title: 'Delete message?', confirmLabel: 'Delete', danger: true,
    body: 'It is removed from this chat. Agents that already read it are told that it was deleted.',
  });
  if (!ok) return;
  try { await rpc.call('messages.delete', { id: message.id }); } catch (error) { toastError(error, 'Message not deleted'); }
}

async function copy(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); pushToast({ title: 'Copied', tone: 'info' }, 1500); } catch (error) { toastError(error, 'Copy failed'); }
}

/** B-080: a message's files as menu entries – Open <name>, and on the desktop Show <name> in folder. */
function fileItems(message: Message): MenuItem[] {
  const reveal = platform === 'desktop' && can('files.open');
  return (message.attachments ?? []).flatMap((attachment) => [
    { label: `Open ${attachment.name}`, onSelect: () => openAttachment(attachment, message.conversationId) },
    ...(reveal ? [{ label: `Show ${attachment.name} in folder`, onSelect: () => showAttachment(attachment) }] : []),
  ]);
}

/**
 * The message's menu: files first, then Reply, Start/Open thread, Copy selection, Select text (touch),
 * Edit, Remember why…, Delete – each only where it applies. Whole-message Copy lives in MessageTools.
 */
export function messageMenu(message: Message, open: MenuOpen, actions: { edit: () => void; selectText: () => void }): MenuSection[] {
  const files = fileItems(message);
  const items: MenuItem[] = [];
  if (canReply(message)) items.push({ label: 'Reply', onSelect: () => { reply(message); } });
  // B-078: a thread on this message – never inside a thread (the thread itself answers it)
  const chat = conversationMap.peek().get(message.conversationId);
  if (canReply(message) && chat && !isThread(chat) && !chat.settings.system) {
    items.push({ label: threadsByAnchor.peek().has(message.id) ? 'Open thread' : 'Start thread', onSelect: () => void startThread(message) });
  }
  const selected = menuSelection(open); // read now: the menu's own clicks may move the selection
  if (selected && message.body && message.state !== 'streaming') items.push({ label: 'Copy selection', onSelect: () => void copy(selected) });
  const secret = markedSecret(message, selected);
  if (secret) items.push({ label: 'Save as secret', onSelect: () => void saveAsSecret(message, secret) });
  if (open.touch && copyable(message)) items.push({ label: 'Select text', onSelect: actions.selectText });
  if (canEdit(message)) items.push({ label: 'Edit', onSelect: actions.edit });
  if (can('references.remember') && offersRemember(message, HUMAN_ID)) items.push({ label: 'Remember why…', onSelect: () => { rememberTarget.value = message; } });
  if (canDelete(message)) items.push({ label: 'Delete', danger: true, onSelect: () => void remove(message) });
  return files.length ? [{ items: files }, { items }] : [{ items }];
}

/**
 * F30: Copy (the whole message) and Reply as two small icons in the message's meta row – on finished text messages
 * (Copy also on failed/stopped text; Reply where this connection may send), always rendered, so nothing moves: seen on hover or
 * focus with a mouse, always on touch (chat.css .message-tool). Status lines, task cards and streaming rows have none.
 */
export function MessageTools(props: { message: Message; menu?: (open: MenuOpen) => MenuSection[] }) {
  const { message } = props;
  if (message.kind !== 'text' || message.state === 'streaming') return null;
  const final = message.state === 'final';
  return (
    <>
      {copyable(message) && <IconButton icon="copy" label="Copy" size="small" iconSize={14} class="message-tool" onClick={() => void copy(message.body)} />}
      {final && canReply(message) && <IconButton icon="arrow-bend-up-left" label="Reply" size="small" iconSize={14} class="message-tool" onClick={() => { reply(message); }} />}
      {final && props.menu && (
        <IconButton icon="dots-three" label="More" size="small" iconSize={14} class="message-tool" aria-haspopup="menu" onClick={(event) => {
          const box = (event.currentTarget as HTMLElement).getBoundingClientRect(); // the phone's menu: the button's, not a long press's
          openContextMenu(box.left, box.bottom, props.menu!({ touch: false, at: (event.currentTarget as HTMLElement).closest<HTMLElement>('.message') }));
        }} />
      )}
    </>
  );
}

/** The person's own message edited in place: Esc cancels, Ctrl+Enter (⌘+Enter) or Save saves. */
export function InlineEdit(props: { message: Message; onDone: () => void }) {
  const { message, onDone } = props;
  const [text, setText] = useState(message.body);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(innerHeight * 0.4))}px`;
  }, [text]);
  useEffect(() => { const el = field.current; el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); }, []);

  const save = async () => {
    if (busy || !text.trim()) return;
    if (text === message.body) { onDone(); return; }
    setBusy(true);
    let saved = false;
    try { await rpc.call('messages.edit', { id: message.id, body: text }); saved = true; } catch (error) { toastError(error, 'Message not changed'); }
    setBusy(false);
    if (saved) onDone();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDone(); }
    else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); }
  };

  return (
    <div class="message-edit">
      <textarea ref={field} class="message-edit-input" rows={1} value={text} aria-label="Edit message" readOnly={busy}
        onInput={(event) => setText((event.target as HTMLTextAreaElement).value)} onKeyDown={onKeyDown} />
      <div class="message-edit-actions">
        <span class="message-edit-hint">Esc to cancel · {modKey}Enter to save</span>
        <button type="button" class="button secondary" onClick={onDone}>Cancel</button>
        <button type="button" class="button primary" disabled={busy || !text.trim()} onClick={() => void save()}>Save</button>
      </div>
    </div>
  );
}
