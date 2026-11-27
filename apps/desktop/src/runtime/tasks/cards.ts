// The person's answers to a "Waiting on you" card (P7; the cards: shared/model/waiting-cards.ts):
// - answerCard: one answer for every task on the card. Each waiting task gets the person's words in its thread as their
//   own line and is open again; its agent owner hears it once for all of its tasks on the card ("Stanislaus answered …").
//   The person's own ask on the card is answered as its widget is (or done with the words; Decline drops it with them) –
//   its maker hears that the usual way (answer-receipt.ts, lifecycle.ts), not twice.
// - laterCard: "Later" puts it off – every wait keeps its reason and gets a follow-up (default tomorrow 09:00 local,
//   follow-up.ts) and rests as `later` until then, the ask moves to that time; at the follow-up its owner is woken as for
//   any expired wait. Nothing disappears.
// - askDropped: an ask to the person that ends dropped without their word (an agent dropped it, not a quest's close) asks
//   back: its maker and its quest's owner hear it – the one who dropped it reads the same in its tool answer.
// Owns: those three. Never: answers for anyone but the person who tapped, or ends work that no longer waits.

import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { isHumanActor } from '../../shared/model/people.ts';
import { isFinished, isPaused, type Task, type TaskView } from '../../shared/model/tasks.ts';
import { askQuestion, questionOf, waitingCards } from '../../shared/model/waiting-cards.ts';
import type { TaskServiceImpl } from './service.ts';
import { recordChange } from './changes.ts';
import { nameOf, tell } from './give.ts';
import { threadOf } from './thread.ts';

export const MAX_CARD_TASKS = 1000;

export interface CardAnswer {
  ids: readonly string[]; // every task on the card (WaitingCard.taskIds)
  reply?: string; // the person's words ("Reply"); without them the button's own
  choice?: string; // a short choice's option value
  decline?: boolean; // "Decline"
}

const ownerOf = (task: Task): string => task.assigneeKind === 'agent' ? task.assigneeId ?? '' : task.assigneeId ?? HUMAN_ID;
const isAskOf = (task: Task, by: string) => task.kind !== 'quest' && task.assigneeKind === 'human' && (task.assigneeId ?? HUMAN_ID) === by && task.createdBy !== by;

function cardTasks(t: TaskServiceImpl, ids: readonly string[], by: string) {
  if (!ids.length || ids.length > MAX_CARD_TASKS) throw new WorkforceError('bad_request', `A card holds 1 to ${MAX_CARD_TASKS} tasks.`);
  const tasks = [...new Set(ids)].map((id) => t.repo.get(id));
  const live = tasks.filter((task): task is Task => !!task && !isFinished(task.status));
  const [card, ...others] = waitingCards(live, t.s.clock.now(), by);
  if (!card || others.length || card.taskIds.length !== tasks.length) {
    throw new WorkforceError('conflict', 'This card changed. Check the current question and try again.');
  }
  return { tasks: live, card };
}

/** The words of an answer: the person's own, else the button's. */
function wordsOf(input: CardAnswer, ask: Task | undefined): string {
  const typed = input.reply?.trim();
  if (typed) return typed;
  if (input.choice) {
    const options = (ask?.widget as { options?: unknown } | undefined)?.options;
    const found = Array.isArray(options) ? options.find((option) => (typeof option === 'string' ? option : String((option as { value?: unknown })?.value ?? (option as { label?: unknown })?.label ?? '')) === input.choice) : undefined;
    return typeof found === 'object' && found && typeof (found as { label?: unknown }).label === 'string' ? (found as { label: string }).label : input.choice;
  }
  if (input.decline) return 'Declined';
  return ask?.widget?.type === 'approve' || ask?.widget?.type === 'review' ? 'Accepted' : 'Yes, ready';
}

/** The person's line in a task's thread, as their own words – stored there, no second wake (the owner hears it from answerCard). */
function personLine(t: TaskServiceImpl, task: Task, body: string, by: string): void {
  try {
    threadOf({ ...t.s, tasks: t }, task.id, by);
    t.s.chats.send({ conversationId: task.id, body, authorId: by, authorKind: 'human', taskId: task.id, deliver: false });
  } catch (error) {
    t.s.log?.warn('the card answer line was not written', { taskId: task.id, error: String(error) });
  }
}

/** The answer an ask's widget takes for this button. */
function widgetAnswer(ask: Task, input: CardAnswer, words: string): unknown {
  const note = input.reply?.trim();
  switch (ask.widget?.type) {
    case 'approve': return { approved: !input.decline, ...(note ? { note } : {}) };
    case 'review': return { verdict: input.decline ? 'Decline' : 'Accept', ...(note ? { note } : {}) };
    case 'choice': return input.choice ? { choice: input.choice } : { other: words };
    default: return { done: true, ...(note ? { note } : {}) };
  }
}

/** One answer for the whole card (see the header); returns the tasks as they are now. */
export function answerCard(t: TaskServiceImpl, input: CardAnswer, by: string = HUMAN_ID): TaskView[] {
  const { tasks, card } = cardTasks(t, input.ids, by);
  if (card.kind === 'open') throw new WorkforceError('bad_request', 'Open the request to answer it.');
  if (input.choice && !card.options?.some((option) => option.value === input.choice)) throw new WorkforceError('bad_request', 'Choose an answer on this card.');
  if (input.decline && card.kind !== 'accept') throw new WorkforceError('bad_request', 'This card cannot be declined here.');
  const ask = tasks.find((task) => task.id === card.askId);
  const words = wordsOf(input, ask);
  const question = ask ? askQuestion(ask) : questionOf(tasks.find((task) => task.waitingOn)?.waitingOn?.why ?? '');
  const now = t.s.clock.now();
  const owners = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task === ask || task.status !== 'waiting' || isPaused(task)) continue;
    const blockers = [...new Set([...(task.waitingOn?.ids ?? []), ...(task.dependsOn ?? [])])].filter((id) => {
      if (id === ask?.id) return false;
      const other = t.repo.get(id);
      return !!other && !isFinished(other.status);
    });
    const opened = t.mutate(task.id, (draft) => {
      draft.status = blockers.length ? 'waiting' : 'open';
      if (blockers.length) draft.waitingOn = { on: 'task', ids: blockers, why: 'Waiting on other tasks', since: now };
      else delete draft.waitingOn;
      draft.ledger = { ...draft.ledger, movedAt: now };
      recordChange(draft, task, by, 'update', now);
    });
    personLine(t, opened, words, by);
    t.line(opened, { type: 'note', text: `Answered: ${excerpt(question, 80)} – ${blockers.length ? 'other tasks still pending' : 'no longer waiting'}`, details: { taskId: opened.id, status: opened.status } }, by);
    t.emit(opened);
    const owner = ownerOf(opened);
    if (opened.assigneeKind === 'agent' && owner) owners.set(owner, [...(owners.get(owner) ?? []), opened]);
  }
  if (ask) {
    if (ask.widget && !(input.decline && ask.widget.type !== 'approve' && ask.widget.type !== 'review')) {
      t.answer({ taskId: ask.id, answer: widgetAnswer(ask, input, words), by });
    } else if (input.decline) {
      t.answer({ taskId: ask.id, answer: { declined: true, ...(input.reply?.trim() ? { reason: input.reply.trim() } : {}) }, by, decline: true });
    } else {
      t.finish(ask.id, { status: 'done', summary: words, answer: { value: words } }, by);
    }
  }
  const who = nameOf(t.s, by);
  for (const [owner, list] of owners) {
    if (ask && owner === ask.createdBy && list.every((task) => task.id === ask.parentId)) continue; // the ask's maker reads the answer on its quest
    const [first] = list;
    const names = list.map((task) => `"${excerpt(task.title, 80)}" (${task.id})`).join(', ');
    const affected = list.length === 1 ? `My task ${names}` : `My ${list.length} tasks: ${names}`;
    const note = `${who} answered "${excerpt(question, 160)}": ${excerpt(words, 600)}. ${affected}. No longer waiting on this answer.`;
    tell(t.s, owner, { reason: 'task', taskId: first.id, conversationId: first.conversationId, key: `card:${ask?.id ?? first.id}`, note });
  }
  return tasks.flatMap((task) => { const view = t.get(task.id); return view ? [view] : []; });
}

/** "Later" (see the header): every wait gets its follow-up at `until` and rests; the ask moves to that time. */
export function laterCard(t: TaskServiceImpl, ids: readonly string[], until: number, by: string = HUMAN_ID): TaskView[] {
  const { tasks } = cardTasks(t, ids, by);
  for (const task of tasks) {
    if (isFinished(task.status)) continue;
    if (isAskOf(task, by)) { t.snooze(task.id, until); continue; }
    if (task.status !== 'waiting' || !task.waitingOn || isPaused(task)) continue;
    const { since: _since, followedUp: _sent, ...wait } = task.waitingOn;
    t.update(task.id, { status: 'waiting', waitingOn: { ...wait, until, later: true } }, by);
  }
  return tasks.flatMap((task) => { const view = t.get(task.id); return view ? [view] : []; });
}

const QUEST_CLOSED = 'Quest closed: ';

/** An ask to a person that ended dropped without their word (by an agent, not a quest's close). */
export function droppedAsk(task: Task, by: string): boolean {
  if (task.status !== 'dropped' || task.kind === 'quest' || task.assigneeKind !== 'human') return false;
  if (isHumanActor(task.createdBy) || isHumanActor(by)) return false; // the person's own to-do, or their own word (a decline says why)
  if (by === SYSTEM_ID && task.result?.summary.startsWith(QUEST_CLOSED)) return false; // its quest's owner closed the quest
  return task.result?.answer === undefined;
}

/** The question back to whoever needed the answer (see the header). */
export function askBackLine(s: Parameters<typeof nameOf>[0], task: Task, by: string): string {
  const person = nameOf(s, task.assigneeId ?? HUMAN_ID);
  const dropper = by === task.createdBy ? '' : ` by ${nameOf(s, by)}`;
  const why = task.result?.summary?.trim();
  return `My ask to ${person} "${excerpt(task.title, 120)}" was dropped${dropper} without their answer${why ? ` (${excerpt(why, 200)})` : ''}. `
    + 'A question to the person never just disappears: does the work still need it? Then ask again (tasks.add for the person) or set the wait anew; '
    + 'otherwise close what waited on it with a line why.';
}

/** After finish(): an ask dropped without the person's word asks its maker and its quest's owner back (not the one who dropped it). */
export function askDropped(t: TaskServiceImpl, task: Task, by: string): void {
  if (!droppedAsk(task, by)) return;
  const quest = task.parentId ? t.repo.get(task.parentId) : undefined;
  const questOwner = quest && !isFinished(quest.status) && quest.assigneeKind === 'agent' ? quest.assigneeId : undefined;
  const line = askBackLine(t.s, task, by);
  for (const who of new Set([task.createdBy, questOwner])) {
    if (!who || who === by || isHumanActor(who) || who === SYSTEM_ID) continue;
    const onQuest = who === questOwner && quest;
    const chat = task.ledger.givenIn ?? task.conversationId;
    tell(t.s, who, {
      reason: 'child', taskId: onQuest ? quest.id : task.id, ...(chat ? { conversationId: chat } : {}), key: `asked:${task.id}`,
      note: who === task.createdBy ? line : line.replace(/^My ask/, 'An ask in my quest'),
    });
  }
}
