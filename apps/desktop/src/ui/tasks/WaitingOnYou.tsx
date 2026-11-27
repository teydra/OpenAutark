// "Waiting on you" on the Tasks page (P7, Mika's task system): what hangs on the person, one card per question
// (shared/model/waiting-cards.ts bundles them). Each card says the question in one sentence, who asks, since when and
// how many tasks hang on it, with 44-px answers: Yes, ready · Accept / Decline · a short choice's options · Reply (a
// line of the person's own) · Later (back tomorrow 09:00) – or Open for an ask that needs its own tool. One answer
// reaches every task on the card. At most three cards show; "See all" opens the rest (Konrad E4), put-off ones last.
// Owns: the cards' markup. Never: the bundling (waiting-cards.ts) or the answer itself (runtime/tasks/cards.ts).

import { useState } from 'preact/hooks';
import { CARDS_SHOWN, type WaitingCard } from '../../shared/model/waiting-cards.ts';
import { dayZone } from '../lib/day-store.ts';
import { agentName } from '../lib/store.ts';
import { answerCard, laterCard } from './page-actions.ts';
import { openDetail, type PageScope } from './page-state.ts';
import { momentText, noteWhenText } from './when-text.ts';

/** "Lena asks", "Lena and Ben ask", "Lena, Ben and 2 more ask". */
export function askers(from: readonly string[], nameOf: (id: string) => string = agentName): string {
  const names = from.map(nameOf);
  if (!names.length) return 'Someone asks';
  if (names.length === 1) return `${names[0]} asks`;
  if (names.length === 2) return `${names[0]} and ${names[1]} ask`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more ask`;
}

function Card(props: { scope: PageScope; card: WaitingCard; now: number }) {
  const { card, now } = props;
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const zone = dayZone.value;
  const run = async (call: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(true);
    try { if (await call()) { setReplying(false); setText(''); } } finally { setBusy(false); }
  };
  const answer = (input: { reply?: string; choice?: string; decline?: boolean } = {}) => run(() => answerCard(card.taskIds, input));
  const count = card.waiting.length;
  const answers = card.kind === 'ready' ? [<button key="y" type="button" class="wcard-btn primary" onClick={() => answer()}>Yes, ready</button>]
    : card.kind === 'accept' ? [
        <button key="a" type="button" class="wcard-btn primary" onClick={() => answer()}>Accept</button>,
        <button key="d" type="button" class="wcard-btn" onClick={() => answer({ decline: true })}>Decline</button>,
      ]
    : card.kind === 'choice' ? (card.options ?? []).map((option, index) => (
        <button key={option.value} type="button" class={`wcard-btn${index === 0 ? ' primary' : ''}`} onClick={() => answer({ choice: option.value })}>{option.label}</button>
      ))
    : [<button key="o" type="button" class="wcard-btn primary" onClick={() => { if (card.askId) openDetail(props.scope, card.askId); }} disabled={!card.askId}>Open</button>];
  return (
    <li class={`wcard${card.later ? ' resting' : ''}`} data-card={card.key} aria-busy={busy}>
      <p class="wcard-question">{card.question}</p>
      <p class="wcard-meta">
        {askers(card.from)} · since {momentText(card.since, now, zone)} · <span class="tabular">{count}</span> {count === 1 ? 'task' : 'tasks'}
        {card.later && card.until !== undefined && <> · Follow up on {noteWhenText(card.until, now, zone)}</>}
      </p>
      {replying ? (
        <form class="wcard-reply" onSubmit={(event) => { event.preventDefault(); if (text.trim()) void answer({ reply: text.trim() }); }}>
          <textarea rows={2} value={text} placeholder="Your answer" aria-label="Your answer" onInput={(event) => setText((event.currentTarget as HTMLTextAreaElement).value)} autoFocus />
          <div class="wcard-actions">
            <button type="submit" class="wcard-btn primary" disabled={busy || !text.trim()}>Send</button>
            <button type="button" class="wcard-btn" onClick={() => { setReplying(false); setText(''); }}>Cancel</button>
          </div>
        </form>
      ) : (
        <div class="wcard-actions" aria-disabled={busy}>
          {answers}
          {card.kind !== 'open' && card.kind !== 'accept' && <button type="button" class="wcard-btn" onClick={() => setReplying(true)}>Reply</button>}
          {!card.later && <button type="button" class="wcard-btn quiet" onClick={() => run(() => laterCard(card.taskIds))}>Later</button>}
        </div>
      )}
    </li>
  );
}

export function WaitingOnYou(props: { scope: PageScope; cards: readonly WaitingCard[]; now: number }) {
  const [all, setAll] = useState(false);
  const { cards } = props;
  if (!cards.length) return null;
  const awake = cards.filter((card) => !card.later).length;
  const shown = all ? cards : cards.slice(0, CARDS_SHOWN);
  const rest = cards.length - shown.length;
  return (
    <section class="wcards" aria-label="Waiting on you">
      <h3 class="tasks-sec">Waiting on you <span class="tabular">{awake}</span></h3>
      <ul class="wcard-list">
        {shown.map((card) => <Card key={card.key} scope={props.scope} card={card} now={props.now} />)}
      </ul>
      {(rest > 0 || all) && cards.length > CARDS_SHOWN && (
        <button type="button" class="wcards-all" aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'Show less' : `See all ${cards.length}`}</button>
      )}
    </section>
  );
}
