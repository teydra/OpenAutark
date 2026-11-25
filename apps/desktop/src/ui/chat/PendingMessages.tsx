// The person's unsent lines at the end of a chat (pending-sends.ts): the own bubble as it will
// stand, with a clock while it is on its way. Sent while dictating, it shows the typed text and the words heard so far
// ("Transcribing…"), so the chat is never empty between the tap and the stored message (owner 24.11.2026). A failed line
// says so, with Send again (the retry keeps the whole send).
// Owns: those bubbles. Never: sending (composer/send.ts) or deciding which still show (receipts.ts).

import { useState } from 'preact/hooks';
import type { Message } from '../../shared/model/chat.ts';
import { Icon } from '../lib/ui.tsx';
import { time } from '../lib/format.ts';
import { pendingSends, unsentLines, type PendingSend } from './pending-sends.ts';
import { keysIn, maskedBody } from './message-keys.ts';
import { resendPending } from './composer/send.ts';
import { ReceiptMark } from './Receipt.tsx';

/** The words a line shows: while transcribing, the typed text and the take's words heard so far. */
function shownText(line: PendingSend): string {
  const body = [line.body, line.preview?.()].filter(Boolean).join(' ');
  return maskedBody(body, keysIn({ kind: 'text', body }));
}

function PendingLine(props: { line: PendingSend }) {
  const { line } = props;
  const [busy, setBusy] = useState(false);
  const text = shownText(line);
  const again = async () => { setBusy(true); await resendPending(line.clientId); setBusy(false); };
  return (
    <article class={`message human pending-line state-${line.state}`} data-pending-id={line.clientId} aria-busy={line.state !== 'failed'}>
      <div class="message-content">
        {text ? <div class="md pending-text">{text}</div> : null}
        {line.attachments.length > 0 && (
          <div class="pending-files">{line.attachments.map((file) => <span key={file.fileId} class="pending-file"><Icon name="paperclip" size={12} />{file.name}</span>)}</div>
        )}
        {!text && !line.attachments.length && <div class="pending-text muted">{line.state === 'transcribing' ? 'Transcribing…' : ' '}</div>}
      </div>
      {line.state === 'failed' && (
        <div class="message-failure state-failed" role="status">
          <Icon name="warning-circle" size={14} />
          <span>{line.error ? `Not confirmed: ${line.error}` : 'Not confirmed'}</span>
          <button type="button" class="text-button" disabled={busy} onClick={() => void again()}>Send again</button>
        </div>
      )}
      <div class="message-actions">
        {line.state === 'transcribing' && (text || line.attachments.length > 0) && <span class="pending-note">Transcribing…</span>}
        <time class="tabular" dateTime={new Date(line.createdAt).toISOString()}>{time(line.createdAt)}</time>
        <ReceiptMark state={line.state} />
      </div>
    </article>
  );
}

/** The unsent lines of `conversationId` that its loaded `list` does not hold yet. */
export function PendingMessages(props: { conversationId: string; list: readonly Message[] }) {
  const lines = unsentLines(pendingSends.value.filter((line) => line.conversationId === props.conversationId), props.list);
  if (!lines.length) return null;
  return <>{lines.map((line) => <PendingLine key={line.clientId} line={line} />)}</>;
}
