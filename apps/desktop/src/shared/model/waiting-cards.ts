// "Waiting on you" (Mika's task system, P7): what hangs on the person, bundled into cards – one question, one card. Work
// that waits on the person (`waitingOn` on 'who' = them) and the person's own asks that other work waits on (a wait on
// that task, an order after it, or its quest waiting on them) become cards: the same ask, or the same question in
// other words only by case, punctuation or a leading "<name>:", is one card. Each card says the question in one sentence,
// who asks, since when and how many tasks hang on it, and which answers fit (Yes, ready · Accept / Decline · the options
// of a short choice · Open for anything richer). A card the person put off ("Later") rests until its follow-up.
// One rule for the Tasks page and the runtime (runtime/tasks/cards.ts answers a card by the ids it lists).
// Owns: the bundling, the card's words and its answer kind. Never: reads a clock or the store – callers pass both in.

import { HUMAN_ID } from '../ids.ts';
import { isFinished, isPaused, type Task } from './tasks.ts';

/** How a card is answered: Yes, ready · Accept / Decline · one of up to 3 options · in the task itself. */
export type CardKind = 'ready' | 'accept' | 'choice' | 'open';

export interface WaitingCard {
  key: string; // 'ask:<task id>' or 'q:<the question, normalised>'
  question: string; // one sentence
  askId?: string; // the person's own to-do the card is about, when there is one
  waiting: string[]; // the work that waits on the answer (not the ask itself)
  taskIds: string[]; // every task the card answers: the ask first, then the waiting work
  from: string[]; // who asks: the owners of the waiting work and the ask's maker, the earliest first
  since: number; // the earliest wait or ask
  kind: CardKind;
  options?: Array<{ value: string; label: string }>; // a short choice's options
  later: boolean; // the person said "Later": it rests until `until`
  until?: number; // the earliest follow-up of its waits
}

/** At most this many cards show; the rest sit behind "See all" (Konrad E4). */
export const CARDS_SHOWN = 3;

const CHOICE_MAX = 3;

/** A wait's line without "<name>:" in front, its first sentence, cut at 160 characters. */
export function questionOf(why: string): string {
  const bare = why.replace(/^\s*[^:–\n?]{1,40}\s*[:–]\s*/, '').trim() || why.trim();
  const first = /^(.+?[.?!])(\s|$)/.exec(bare)?.[1] ?? bare;
  const cut = first.length > 160 ? `${first.slice(0, 159).trimEnd()}…` : first;
  return cut ? `${cut[0].toUpperCase()}${cut.slice(1)}` : cut;
}

/** The words that make two questions the same one. */
export function questionKey(why: string): string {
  return questionOf(why).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const ownerOf = (task: Task): string => task.assigneeKind === 'agent' ? task.assigneeId ?? '' : task.assigneeId ?? HUMAN_ID;
const unfinished = (task: Task) => !isFinished(task.status);

/** The person's own to-do someone else asked of them (an ask). */
function isAsk(task: Task, person: string): boolean {
  return !isPaused(task) && task.kind !== 'quest' && task.assigneeKind === 'human' && (task.assigneeId ?? HUMAN_ID) === person && task.createdBy !== person && unfinished(task);
}

function kindOf(ask: Task | undefined): Pick<WaitingCard, 'kind' | 'options'> {
  const widget = ask?.widget as { type?: string; options?: unknown; multi?: boolean } | undefined;
  if (!widget || widget.type === 'confirm') return { kind: 'ready' };
  if (widget.type === 'approve' || widget.type === 'review') return { kind: 'accept' };
  if (widget.type === 'choice' && !widget.multi && Array.isArray(widget.options) && widget.options.length && widget.options.length <= CHOICE_MAX) {
    const options = widget.options.map((option) => {
      if (typeof option === 'string') return { value: option, label: option };
      const o = (option ?? {}) as { value?: unknown; label?: unknown };
      const value = String(o.value ?? o.label ?? '');
      return { value, label: String(o.label ?? value) };
    }).filter((option) => option.value);
    if (options.length) return { kind: 'choice', options };
  }
  return { kind: 'open' };
}

/** An ask's question in one sentence: its widget's question, else its title. */
export const askQuestion = (ask: Task): string => {
  const widget = ask.widget as { question?: unknown; instructions?: unknown } | undefined;
  const words = typeof widget?.question === 'string' && widget.question.trim() ? widget.question : ask.title;
  return questionOf(words);
};

/**
 * The cards of what waits on `person` among `tasks` (open work of every owner and the person's to-dos), the ones to
 * show first: those not resting, the most tasks first, then the oldest.
 */
export function waitingCards(tasks: Iterable<Task>, now: number, person: string = HUMAN_ID): WaitingCard[] {
  const all = [...tasks];
  const asks = new Map(all.filter((task) => isAsk(task, person)).map((task) => [task.id, task]));
  const askIn = new Map<string, Task>(); // a quest's open ask to the person
  for (const ask of asks.values()) if (ask.parentId && !askIn.has(ask.parentId)) askIn.set(ask.parentId, ask);
  const groups = new Map<string, { ask?: Task; waiting: Task[] }>();
  const put = (key: string, task: Task | undefined, ask?: Task) => {
    const group = groups.get(key) ?? { waiting: [] };
    if (ask) group.ask = ask;
    if (task && !group.waiting.some((known) => known.id === task.id)) group.waiting.push(task);
    groups.set(key, group);
  };
  for (const task of all) {
    if (task.status !== 'waiting' || isPaused(task) || asks.has(task.id) || ownerOf(task) === person) continue;
    const wait = task.waitingOn;
    if (!wait) continue;
    const on = wait.on === 'task' ? [...(wait.ids ?? []), ...(task.dependsOn ?? [])].map((id) => asks.get(id)).find(Boolean) : undefined;
    if (on) { put(`ask:${on.id}`, task, on); continue; }
    if (wait.on !== 'who' || wait.who !== person) continue;
    const inner = askIn.get(task.id);
    if (inner) { put(`ask:${inner.id}`, task, inner); continue; }
    const key = questionKey(wait.why);
    if (key) put(`q:${key}`, task);
  }
  const cards: WaitingCard[] = [];
  for (const [key, { ask, waiting }] of groups) {
    waiting.sort((a, b) => (a.waitingOn?.since ?? a.createdAt) - (b.waitingOn?.since ?? b.createdAt));
    const sinceOf = (task: Task) => task.waitingOn?.since ?? task.createdAt;
    const since = Math.min(...waiting.map(sinceOf), ask?.createdAt ?? Infinity);
    const from: string[] = [];
    for (const id of [...(ask ? [{ id: ask.createdBy, at: ask.createdAt }] : []), ...waiting.map((task) => ({ id: ownerOf(task), at: sinceOf(task) }))].sort((a, b) => a.at - b.at).map((entry) => entry.id)) {
      if (id && id !== person && !from.includes(id)) from.push(id);
    }
    const untils = waiting.map((task) => task.waitingOn?.until).filter((at): at is number => at !== undefined);
    const until = untils.length ? Math.min(...untils) : undefined;
    const resting = waiting.length > 0 && waiting.every((task) => task.waitingOn?.later && (task.waitingOn.until ?? 0) > now) && (!ask || (ask.at ?? 0) > now);
    cards.push({
      key, question: ask ? askQuestion(ask) : questionOf(waiting[0].waitingOn!.why), ...(ask ? { askId: ask.id } : {}),
      waiting: waiting.map((task) => task.id), taskIds: [...(ask ? [ask.id] : []), ...waiting.map((task) => task.id)],
      from, since, ...kindOf(ask), later: resting, ...(until !== undefined ? { until } : {}),
    });
  }
  return cards.sort((a, b) => Number(a.later) - Number(b.later) || b.taskIds.length - a.taskIds.length || a.since - b.since);
}

/** The ids of the person's to-dos a card stands for (For you leaves them to the card). */
export function cardAsks(cards: readonly WaitingCard[]): Set<string> {
  return new Set(cards.flatMap((card) => (card.askId && !card.later ? [card.askId] : [])));
}
