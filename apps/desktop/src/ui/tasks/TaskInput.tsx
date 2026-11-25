// The Tasks page's one input line (owner 19.11.2026: "nur diese eine Eingabezeile … dort kann man einfach reinsprechen"):
// type or dictate; as the person types, every time phrase (shared/text/when.ts findTimes, in the person's zone) is
// marked blue in place – a mirror behind the field draws the marks, the field's own text stays the person's. Under it
// one row of chips that is always there (nothing moves): the quest the to-dos go into while a quest's detail is open,
// whom the line goes to, Only me and its files (what the line's + set – LineExtras.tsx), the used time (a single phrase
// with a clock time is used at once, its × drops it; a day alone or two phrases wait for a click – owner 20.11.2026:
// "morgen … dass am Freitag"), and a hint. Enter adds the line – each non-empty line its own to-do (Shift+Enter: a new
// line; dictation stays one line and the assistant splits it); a click into a calendar slot adds it at that time
// (submitLine with `slotAt`). After "+" in the quest column the line names a new quest.
// Owns: the line's markup and its submit. Never: decides who does what (the assistant does; tasks.quickCreate wakes it).

import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Task } from '../../shared/model/tasks.ts';
import { findTimes, type TimePhrase } from '../../shared/text/when.ts';
import { dayZone } from '../lib/day-store.ts';
import { agents, isMobile, todoClock } from '../lib/store.ts';
import { pushToast } from '../lib/toasts.ts';
import { Icon, IconButton, Spinner } from '../lib/ui.tsx';
import { targetLabel } from './center-model.ts';
import { FieldMic } from './FieldMic.tsx';
import { NO_CHOICE, drop, lineHint, lineTodos, phraseKey, pick, usedPhrase } from './input-model.ts';
import { ExtraChips, LinePlus, lineOnlyMe } from './LineExtras.tsx';
import { addLines, addQuest } from './page-actions.ts';
import { questHue } from './page-model.ts';
import { clearLine, lineOf, openDetail, type PageScope } from './page-state.ts';
import { recipientPeople } from './RecipientMenu.tsx';
import { useFieldDictation } from './use-dictation.ts';
import { joinSaid, phraseText } from './when-text.ts';

/** Adds the line's to-dos (into `quest`; at `slotAt` for a calendar click). True when every line was added. */
export async function submitLine(scope: PageScope, quest?: string, slotAt?: number): Promise<boolean> {
  const line = lineOf(scope);
  const text = line.text.peek();
  if (line.questMode.peek()) {
    const title = text.trim();
    if (!title) return false;
    const made = await addQuest(title);
    if (!made) return false;
    line.text.value = '';
    line.questMode.value = false;
    openDetail(scope, made.id);
    return true;
  }
  const used = usedPhrase(findTimes(text, Date.now(), dayZone.peek()), line.choice.peek());
  const list = lineTodos(text, used, slotAt, dayZone.peek());
  if (!list.length) return false;
  const target = line.target.peek();
  const failed = await addLines(list, { ...(quest ? { quest } : {}), ...(target ? { target } : {}), private: lineOnlyMe(line), files: line.files.peek() });
  if (failed.length === list.length) return false;
  const to = target ? targetLabel(target, agents.peek(), recipientPeople(true)) : undefined;
  if (to) pushToast({ title: `Sent to ${to}` }, 3000);
  clearLine(line);
  if (failed.length) line.text.value = failed.map((todo) => todo.title).join('\n'); // what did not stand stays to try again
  return !failed.length;
}

/** The typed text in pieces, the found phrases marked (`used` the one that counts). */
function Marks(props: { text: string; phrases: readonly TimePhrase[]; used: TimePhrase | undefined; mirror: { current: HTMLDivElement | null } }) {
  const parts = [];
  let at = 0;
  for (const phrase of props.phrases) {
    if (phrase.start > at) parts.push(props.text.slice(at, phrase.start));
    parts.push(<mark key={phrase.start} class={phrase === props.used ? 'used' : ''}>{props.text.slice(phrase.start, phrase.end)}</mark>);
    at = phrase.end;
  }
  parts.push(`${props.text.slice(at)}​`); // a trailing newline still takes its line in the mirror
  return <div ref={props.mirror} class="task-input-mirror" aria-hidden="true">{parts}</div>;
}

export function TaskInput(props: { scope: PageScope; quest?: Task; onLeaveQuest?: () => void }) {
  const line = lineOf(props.scope);
  const text = line.text.value;
  const questMode = line.questMode.value;
  const [busy, setBusy] = useState(false);
  const [uploads, setUploads] = useState(0);
  const field = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const mic = useFieldDictation(`tasks:${props.scope}`, (said) => { line.text.value = joinSaid(line.text.peek(), said); });
  const now = todoClock.value;
  const zone = dayZone.value;
  const phrases = questMode ? [] : findTimes(text, Date.now(), zone);
  const used = usedPhrase(phrases, line.choice.value);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    line.field.current = el;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const submit = async () => {
    if (busy || uploads > 0) return;
    const said = await mic.settle();
    if (said) line.text.value = joinSaid(line.text.peek(), said);
    setBusy(true);
    await submitLine(props.scope, props.quest?.id);
    setBusy(false);
    field.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (mic.cancel) mic.cancel.run();
      else if (questMode) line.questMode.value = false;
      else clearLine(line);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !isMobile.value) { event.preventDefault(); void submit(); }
  };
  const has = text.trim().length > 0;
  const placeholder = mic.active ? 'Listening…' : questMode ? 'Name a goal – e.g. Tax return 2026' : 'Add anything – a to-do, a time, or just talk…';
  return (
    <form class={`task-input${questMode ? ' quest-mode' : ''}`} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div class="task-input-row">
        {busy ? <span class="task-input-plus" aria-hidden="true"><Spinner size={14} /></span>
          : <LinePlus line={line} mic={mic} field={field} questMode={questMode} onBusy={(delta) => setUploads((count) => count + delta)} />}
        <div class="task-input-box">
          <Marks text={text} phrases={phrases} used={used} mirror={mirror} />
          <textarea ref={field} class="task-input-field" rows={1} value={text} maxLength={4000} disabled={busy} placeholder={placeholder}
            aria-label={questMode ? 'New quest' : 'New to-do'}
            onInput={(event) => { line.text.value = (event.currentTarget as HTMLTextAreaElement).value; }}
            onScroll={(event) => { if (mirror.current) mirror.current.scrollTop = (event.currentTarget as HTMLTextAreaElement).scrollTop; }}
            onKeyDown={onKeyDown} />
        </div>
        <FieldMic mic={mic} disabled={busy} />
        <IconButton icon="arrow-up" size="small" label={questMode ? 'Start quest' : 'Add'} type="submit" class="task-input-go"
          disabled={busy || uploads > 0 || (!has && !mic.active && !mic.transcribing)} />
      </div>
      <div class="task-input-chips">
        {props.quest && !questMode && (
          <span class="task-chip quest" title={`In ${props.quest.title}`} style={{ '--qc': `var(--wf-c${questHue(props.quest.id)})` }}>
            <span class="task-dot" aria-hidden="true" /><span class="task-chip-text" title={`In ${props.quest.title}`}>In {props.quest.title}</span>
            <button type="button" class="task-chip-x" aria-label="Not into this quest" title="Not into this quest" onClick={props.onLeaveQuest}>×</button>
          </span>
        )}
        {!questMode && <ExtraChips line={line} busy={uploads} />}
        {used && (
          <span class="task-chip when">
            <Icon name="bell" size={13} />{phraseText(used, now, zone)}
            <button type="button" class="task-chip-x" aria-label="Remove the time" title="Remove the time" onClick={() => { line.choice.value = drop(line.choice.peek(), used); }}>×</button>
          </span>
        )}
        {phrases.filter((phrase) => phrase !== used).map((phrase) => (
          <button key={phraseKey(phrase) + phrase.start} type="button" class="task-chip open" title="Use this time"
            onClick={() => { line.choice.value = pick(line.choice.peek(), phrase); }}>
            {phraseText(phrase, now, zone)}
          </button>
        ))}
        <span class="task-input-hint">{questMode ? 'Enter starts the quest · Esc leaves' : lineHint(text, phrases, used)}</span>
      </div>
    </form>
  );
}
