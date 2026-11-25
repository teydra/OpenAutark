// The ticks of an own message (receipts.ts says which): a clock while it is on its way, one tick sent, two delivered,
// or a failure described in words. Drawn inline so the theme colors them.
// Owns: the ticks' markup and words. Never: deciding the receipt (receipts.ts).

import type { Receipt } from './receipts.ts';

const WORDS: Record<Receipt | 'sending' | 'transcribing' | 'failed', string> = {
  transcribing: 'Transcribing…',
  sending: 'Sending…',
  failed: 'Not sent',
  sent: 'Sent – stored on the PC',
  delivered: 'Delivered – it reached the agent\'s PC',
};

/** The words for a state (the ticks' title, a screen reader's label). */
export const receiptWords = (state: keyof typeof WORDS): string => WORDS[state];

export function ReceiptMark(props: { state: Receipt | 'sending' | 'transcribing' | 'failed' }) {
  const { state } = props;
  const title = WORDS[state];
  if (state === 'sending' || state === 'transcribing') {
    return (
      <span class="receipt pending" title={title} role="img" aria-label={title}>
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></svg>
      </span>
    );
  }
  if (state === 'failed') return null; // the failed line says it in words (PendingMessages.tsx)
  const two = state !== 'sent';
  return (
    <span class={`receipt ${state}`} title={title} role="img" aria-label={title}>
      <svg viewBox="0 0 20 16" width={two ? 17 : 13} height="13" aria-hidden="true">
        <path d="M1.5 8.5l3.5 3.5 7-8" />
        {two && <path d="M8 11.5l.5.5 7-8" />}
      </svg>
    </span>
  );
}
