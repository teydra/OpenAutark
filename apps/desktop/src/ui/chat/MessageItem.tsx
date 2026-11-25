// One message. Agent: byline (avatar + name → agent view), body, small time below. The caller's own words:
// right-aligned bubble without a name. Another human's words (a colleague) sit on the left like an agent's,
// with name and round avatar (→ their page). Task messages render through TaskMessage; quiet status lines
// through StatusGroup (collapsible bursts; B-080: a task's line – "Done: …", "Mara took: …" – opens that task's
// detail in Work, same text and time; KI-Runde 17.11.2026: an agent's quiet line is a row there too – "<name>: <first
// sentence>", a click shows the whole line under it, the row stays; a burst has one shape for one line and many, and its next
// line comes below, so nothing above an opened line moves – message-rows.ts burstView). Failed/stopped messages show
// their short error and Retry. A person's line kept whole in a task's thread (a status line with details.quote) is a
// quoted block of its own (KeptLine.tsx).
// The meta row every message reserves holds the markers (important, silent, Ultra, scheduled, voice, from a
// messenger), the model tag (model-tag-view.ts), the time and "edited"/"imported" – nothing moves on hover. The time's
// title names what an agent's answer was written on (B-083: the model and effort the turn ended on, and its temperature).
// 13.11.2026: only real messages are here – who works shows in the live bar above the composer (LiveBar.tsx); a row an
// older version left (meta.live / meta.lines, a stopped or streaming state) renders as its body.
// Right-click (long press) opens the message's menu (MessageActions.tsx: Reply, Copy, Select text on touch, Edit,
// Delete); Edit swaps the body for the inline editor, Select text opens its sheet (SelectText.tsx). F30: the meta row
// also holds Copy and Reply as two small icons (MessageTools) – after the time on the left, before the markers in the own
// bubble, so the time keeps its edge. A reply shows its quote line above the body (ReplyQuote). B-078: a message with
// a thread shows one quiet line under it ("3 replies · Mara", threads.ts) that opens or closes the thread in the side panel.
// 16.11.2026: a key still in the text shows masked, with one quiet line under it – Show/Hide and Save as secret
// (KeysLine, message-keys.ts).
// Owner 24.11.2026 (task_3x012n3a): the own bubble's meta row ends with its ticks (Receipt.tsx; the list passes them).
// Owns: message chrome. Never: renders untrusted HTML itself (MessageBody sanitizes).

import { memo } from 'preact/compat';
import { useMemo, useState } from 'preact/hooks';
import { isTaskThread, messageLevel, type Message } from '../../shared/model/chat.ts';
import { fromBridgeOwner } from '../../shared/model/bridges.ts';
import { isExternalAgent } from '../../shared/model/external-agents.ts';
import { isAgentNotice } from '../../shared/model/message-changes.ts';
import { AgentAvatar, Icon } from '../lib/ui.tsx';
import { agentName } from '../lib/store.ts';
import { go } from '../lib/router.ts';
import { fullDate, time } from '../lib/format.ts';
import { modelShortName } from '../lib/model-name.ts';
import { rpc } from '../lib/rpc.ts';
import { toastError } from '../lib/toasts.ts';
import { messageSide } from '../team/people-model.ts';
import { MessageBody } from '../blocks/MessageBody.tsx';
import { TaskMessage } from '../tasks/TaskMessage.tsx';
import { openTaskDetail } from '../tasks/jump.ts';
import { AttachmentList } from './Attachments.tsx';
import { SecretAttachments } from './SecretAttachments.tsx';
import { InlineEdit, MessageTools, messageMenu } from './MessageActions.tsx';
import { SelectText } from './SelectText.tsx';
import { useContextMenu } from '../lib/context-menu.tsx';
import type { MenuOpen } from '../lib/context-menu.tsx';
import type { MenuSection } from '../lib/popover.tsx';
import { ReplyQuote } from './ReplyQuote.tsx';
import { ScheduledLine } from './ScheduledLine.tsx';
import { statusText } from './status-text.ts';
import { burstView, isQuietLine, quietLineText, quoteOf } from './message-rows.ts';
import { KeptLine } from './KeptLine.tsx';
import { messageModelTag } from './model-tag-view.ts';
import { temperatureTitle } from './live-text.ts';
import { ModelTagMark } from './ModelTagMark.tsx';
import { threadLine, threadsByAnchor } from './threads.ts';
import { chatPanel, chatThread, toggleThread } from '../lib/shell-state.ts';
import { canSaveFrom, keysIn, keysLine, maskedBody, saveAsSecret } from './message-keys.ts';
import { ReceiptMark } from './Receipt.tsx';
import type { Receipt } from './receipts.ts';

function Failure(props: { message: Message }) {
  const { message } = props;
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    try { await rpc.call('messages.retry', { messageId: message.id }); } catch (error) { toastError(error, 'Retry failed'); } finally { setBusy(false); }
  };
  return (
    <div class={`message-failure state-${message.state}`} role="status">
      <Icon name={message.state === 'failed' ? 'warning-circle' : 'stop'} size={14} />
      <span>{message.meta.error ?? (message.state === 'failed' ? 'Failed' : 'Stopped')}</span>
      <button type="button" class="text-button" disabled={busy} onClick={() => void retry()}>Retry</button>
    </div>
  );
}

const bridgeKind = (message: Message): unknown => (message.meta.bridge as { kind?: unknown } | undefined)?.kind;

/** K6: the model a person's message asked for or an agent's message recommended – its short name, a pin when pinned; nothing for Auto. */
function ModelTag(props: { message: Message }) {
  return <ModelTagMark tag={messageModelTag(props.message, modelShortName)} />;
}

function Actions(props: { message: Message; own: boolean; menu: (open: MenuOpen) => MenuSection[]; receipt?: Receipt }) {
  const { message } = props;
  const warmth = temperatureTitle(message.meta.temperature); // B-083
  const via = message.meta.model ? ` · ${message.meta.model}${message.meta.effort ? ` ${message.meta.effort}` : ''}${warmth ? ` · ${warmth}` : ''}` : '';
  const level = messageLevel(message);
  return (
    <div class="message-actions">
      {props.own && <MessageTools message={message} menu={props.menu} />}
      {level === 'important' && <span class="important-marker" title="Important"><Icon name="exclamation-mark" size={12} /></span>}
      {level === 'silent' && !message.meta.call && <Icon name="bell-slash" size={12} class="silent-marker" title="Silent" />}
      {message.meta.ultra === true && <Icon name="lightning" size={12} class="ultra-marker" title="Ultra suggested" />}
      {message.meta.via === 'schedule' && <Icon name="clock" size={12} title="Scheduled" />}
      {message.meta.via === 'voice' && <Icon name={message.meta.call ? 'phone' : 'microphone'} size={12} title={message.meta.call ? `Said in the call · ${message.meta.call.name}` : 'Voice'} />}
      {fromBridgeOwner(message) && <Icon name="chat-text" size={12} title={bridgeKind(message) === 'telegram' ? 'Sent from Telegram' : 'Sent from a linked messenger'} />}
      <ModelTag message={message} />
      <time class="tabular" dateTime={new Date(message.createdAt).toISOString()} title={`${fullDate(message.createdAt)}${via}`}>{time(message.createdAt)}</time>
      {message.editedAt !== undefined && <span class="edited-marker" title={`Edited ${fullDate(message.editedAt)}`}>edited</span>}
      {message.meta.imported === true && <span class="edited-marker" title="Imported from a chat folder (another PC or an export)">imported</span>}
      {props.own && props.receipt && <ReceiptMark state={props.receipt} />}
      {!props.own && <MessageTools message={message} menu={props.menu} />}
    </div>
  );
}

/** The quiet line under a text with keys: Show/Hide (one fixed cell) and Save as secret. */
function KeysLine(props: { message: Message; count: number; shown: boolean; onShow: (shown: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); await saveAsSecret(props.message); setBusy(false); };
  return (
    <div class="message-keys">
      <Icon name="key" size={12} />
      <span>{keysLine(props.count)}</span>
      <button type="button" class="text-button message-keys-show" onClick={() => props.onShow(!props.shown)}>{props.shown ? 'Hide' : 'Show'}</button>
      {canSaveFrom(props.message) && <button type="button" class="text-button" disabled={busy} onClick={() => void save()}>Save as secret</button>}
    </div>
  );
}

/** B-078: the quiet line under a message that has a thread – it opens or closes the thread in the side panel. */
function ThreadLink(props: { message: Message }) {
  const thread = threadsByAnchor.value.get(props.message.id);
  const text = thread ? threadLine(thread) : '';
  if (!thread || !text) return null;
  const open = chatPanel.value === 'thread' && chatThread.value === thread.id;
  return (
    <button type="button" class={`thread-link${thread.unread > 0 ? ' unread' : ''}`} aria-expanded={open}
      onClick={() => toggleThread(props.message.conversationId, thread.id)}>
      <Icon name="chat-circle" size={12} /><span>{text}</span>
    </button>
  );
}

function MessageItemInner(props: { message: Message; receipt?: Receipt }) {
  const { message } = props;
  const [editing, setEditing] = useState(false);
  const [selecting, setSelecting] = useState(false); // F30: the Select text sheet (touch)
  const build = (open: MenuOpen) => messageMenu(message, open, { edit: () => setEditing(true), selectText: () => setSelecting(true) });
  const menu = useContextMenu(build, { touchByButton: true }); // 17.11.2026: a finger's long press selects text natively; the menu is the "More" button
  const [shown, setShown] = useState(false); // a key in the text shows only when the person asks
  const keys = useMemo(() => keysIn(message), [message.body, message.kind]);
  const visible = useMemo(() => (keys.length && !shown ? { ...message, body: maskedBody(message.body, keys) } : message), [message, keys, shown]);
  if (message.kind === 'task') {
    return <div class="message task-message" data-message-id={message.id}><TaskMessage message={message} /></div>;
  }
  if (message.kind === 'status') {
    const quote = quoteOf(message); // a person's line kept whole in a task's thread
    return quote ? <KeptLine message={message} quote={quote} /> : <StatusGroup messages={[message]} />;
  }
  const side = messageSide(message);
  const human = side === 'own'; // only the caller's own words are the right-hand bubble
  const open = message.authorKind === 'agent' ? () => go.agent(message.authorId) : side === 'person' ? () => go.person(message.authorId) : undefined;
  return (
    <article class={`message ${human ? 'human' : side === 'person' ? 'person' : 'agent'}${messageLevel(message) === 'important' ? ' important' : ''}`} data-message-id={message.id}
      {...(editing ? {} : menu)}>
      {!human && (
        <div class="message-author">
          {open && <AgentAvatar agentId={message.authorId} size={26} onClick={open} />}
          {open
            ? <button type="button" class="author-name" onClick={open}>{agentName(message.authorId)}</button>
            : <span class="author-name">{message.authorKind === 'external' ? message.authorId.split(':').pop() : agentName(message.authorId)}</span>}
          {isExternalAgent(message.authorId) && <span class="author-tag">External agent</span>}
        </div>
      )}
      <div class={`message-content${editing ? ' editing' : ''}`}>
        {message.replyTo && <ReplyQuote conversationId={message.conversationId} messageId={message.replyTo} />}
        {editing ? <InlineEdit message={message} onDone={() => setEditing(false)} />
          : message.body ? <MessageBody message={visible} /> : null}
        {keys.length > 0 && !editing && <KeysLine message={message} count={keys.length} shown={shown} onShow={setShown} />}
        {message.attachments.length > 0 && <AttachmentList attachments={message.attachments} conversationId={message.conversationId} message={human ? message : undefined} />}
        <SecretAttachments ids={message.meta.secrets} />
      </div>
      {(message.state === 'failed' || message.state === 'stopped') && <Failure message={message} />}
      <Actions message={message} own={human} menu={build} receipt={props.receipt} />
      <ThreadLink message={message} />
      {selecting && <SelectText message={message} onClose={() => setSelecting(false)} />}
    </article>
  );
}

export const MessageItem = memo(MessageItemInner);

/** B-080: the task a task_* status line is about (its details' taskId, else the message's own), undefined for any other line. */
export function statusTaskId(message: Message): string | undefined {
  const status = message.meta.status;
  if (!status?.type.startsWith('task_')) return undefined;
  const id = status.details?.taskId;
  return typeof id === 'string' && id ? id : message.taskId;
}

/** One status line: a task's line is a button that opens the task (same text and time, nothing moves), any other a quiet row. */
function StatusLineRow(props: { message: Message; text: string }) {
  const { message } = props;
  const taskId = statusTaskId(message);
  const kind = 'status-line nested'; // a row of its burst (StatusGroup)
  // In a task's own thread an agent's change line names who made it (the line carries no "(by …)" of its own then).
  const who = isTaskThread(message.conversationId) && message.authorKind === 'agent' ? agentName(message.authorId) : '';
  const parts = <><span>{who ? `${who} · ${props.text}` : props.text}</span><time class="tabular">{time(message.createdAt)}</time></>;
  if (!taskId) return <div class={kind} data-message-id={message.id}>{parts}</div>;
  return <button type="button" class={`${kind} open`} data-message-id={message.id} title="Open the task" onClick={() => openTaskDetail(taskId)}>{parts}</button>;
}

/** An agent's quiet line in a burst: its first sentence; a click shows the whole line under it (the row stays where it
 *  is). Whether it is open is its burst's (StatusGroup), so a line arriving in the burst leaves it open. */
function QuietLineRow(props: { message: Message; open: boolean; onToggle: () => void }) {
  const { message, open } = props;
  return (
    <div class="quiet-line" data-message-id={message.id}>
      <button type="button" class="status-line open nested" aria-expanded={open} title={open ? 'Hide the line' : 'Show the whole line'}
        onClick={props.onToggle}>
        <span>{quietLineText(message, agentName(message.authorId))}</span><time class="tabular">{time(message.createdAt)}</time>
      </button>
      {open && <MessageItem message={message} />}
    </div>
  );
}

/** Quiet status lines and agents' quiet lines in one shape for one line and for many (message-rows.ts burstView): earlier
 *  lines fold into one row in their place, a new line comes below. C6: notices for agents are left out – the message shows the change. */
export function StatusGroup(props: { messages: Message[] }) {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set()); // the quiet lines the person opened
  const list = props.messages.filter((message) => !isAgentNotice(message));
  if (!list.length) return null;
  const last = list[list.length - 1];
  const byId = new Map(list.map((message) => [message.id, message]));
  const toggleLine = (id: string) => setOpened((now) => { const next = new Set(now); if (!next.delete(id)) next.add(id); return next; });
  const row = (message: Message) => {
    if (message.meta.status?.type === 'schedule_created') return <ScheduledLine key={message.id} message={message} />; // B-044: "Scheduled · <when>" → Chat details › Scheduled
    if (isQuietLine(message)) return <QuietLineRow key={message.id} message={message} open={opened.has(message.id)} onToggle={() => toggleLine(message.id)} />;
    return <StatusLineRow key={message.id} message={message} text={statusText(message)} />; // a cut-off call in the run line's words (status-text.ts)
  };
  const fold = (key: string, expanded: boolean, label: string) => (
    <button key={key} type="button" class="status-line toggle" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
      <Icon name={expanded ? 'caret-down' : 'caret-right'} size={11} />
      <span>{label}</span>
    </button>
  );
  const updates = (count: number) => `${count} earlier ${count === 1 ? 'update' : 'updates'}`;
  return (
    <div class="status-group" data-message-id={last.id}>
      {burstView(list, open, opened).map((item) => (item.kind === 'line' ? row(byId.get(item.id)!)
        : item.kind === 'earlier' ? fold('earlier', false, updates(item.count)) : fold('hide', true, `Hide ${updates(item.count)}`)))}
    </div>
  );
}
