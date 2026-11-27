// Event wiring: applies runtime deltas to the store signals and keeps the subscription set
// in sync with the open chat. Called once from main.tsx.
// Owns: event → signal mapping, the `chat:<id>` topic lifecycle, the one start notice (RC1), when a toast is
// seen already (its chat or the Tasks page open), the For-you clock's timing (F04); the calendar's events are applied
// by lib/day-store.ts (wireDay, called here). Who works for a chat arrives
// with its summary (conversation.upserted, its `live` – the live bar); agent.activity still feeds `activity` for Team, tasks and the work stop
// (F10: with the runs of the person's other PCs, each with its deviceId). F25: a start notice saying an update did not install stays until Dismiss.
// Never: fetches big snapshots on every event (only on reconnect, see store.loadAll).

import { effect } from '@preact/signals';
import type { TaskView } from '../../shared/model/tasks.ts';
import type { Agent } from '../../shared/model/org.ts';
import { rpc } from './rpc.ts';
import {
  accounts, activeConversationId, activity, agents, archivedAgents, catchUp, conversations, loadAll, messages, models, putMessage,
  removeById, route, settings, systemInfo, tasks, todoClock, todos, updateState, upsertById, usage,
} from './store.ts';
import { onForYouList } from '../../shared/model/todo-later.ts';
import { nextListChange } from '../tasks/todo-time.ts';
import type { Topic } from '../../shared/api/protocol.ts';
import type { Route } from './router.ts';
import { dismissToastsWhere, toastNotification, toastStartNotice } from './toasts.ts';
import { wirePeople } from './people.ts';
import { wireDay } from './day-store.ts';
import { wireSplits } from '../splits/split-model.ts';

/** A start notice older than this is not news any more (a window opened much later). */
const NOTICE_FRESH_MS = 6 * 60 * 60_000;
const NOTICE_KEY = 'wf.startNotice';

/** The id of the start notice this browser/window already showed (survives reloads). */
function shownNotice(): string | null {
  try { return localStorage.getItem(NOTICE_KEY); } catch { return null; }
}

function rememberNotice(id: string): void {
  try { localStorage.setItem(NOTICE_KEY, id); } catch { /* storage blocked: shown again after a reload */ }
}

/** The person is where a toast's Open leads (shell/StatusLine.tsx) or sees what it is about: its chat, or the Tasks page
 *  (#/tasks or Home – an older #/day link parses to #/tasks) for a to-do outside a chat and – 17.11.2026, a second line
 *  over the page said the list's rows again – for any to-do its For-you list shows. The route and the list default to
 *  the store's. */
export function atToastTarget(
  item: { conversationId?: string; taskId?: string }, at: Route = route.peek(), list: ReadonlyArray<Pick<TaskView, 'id'>> = todos.peek(),
): boolean {
  if (at.view === 'chat') return item.conversationId === at.id;
  const onTasks = at.view === 'home' || at.view === 'tasks';
  return onTasks && item.taskId !== undefined && (!item.conversationId || list.some((task) => task.id === item.taskId));
}

/**
 * On the For-you list – the same rule as the runtime's todos.list (tasks/repo.ts todos): the person's own
 * unfinished to-dos, in a quest or not (shared/model/todo-later.ts onForYouList); "Later" is a time, never a wait.
 */
function isOpenTodo(task: TaskView): boolean {
  return onForYouList(task);
}

/** A phone hears an agent whose only news is its status without the instructions it already holds (runtime/rpc/scopes.ts
 *  deviceAgent, 18.11.2026): they stay as known. */
export function withInstructions(event: Agent | Omit<Agent, 'instructions'>): Agent {
  if ('instructions' in event && typeof event.instructions === 'string') return event as Agent;
  const known = agents.peek().find((agent) => agent.id === event.id) ?? archivedAgents.peek().find((agent) => agent.id === event.id);
  return { ...event, instructions: known?.instructions ?? '' };
}

/** setTimeout's longest reliable delay is ~24.8 days; the clock re-arms after a day at most. */
const MAX_CLOCK_DELAY = 86_400_000;

/**
 * F04: moves the For-you clock (store.todoClock) whenever the to-dos change and at the next
 * moment a row reads differently by time alone – a timer leaving "Later", a countdown minute,
 * "2 minutes ago" moving on, a due time passing, "Tomorrow" at midnight (tasks/todo-time.ts
 * nextListChange). One timeout to that moment, never an interval.
 */
function wireTodoClock(): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    clearTimeout(timer);
    timer = undefined;
    const now = Date.now();
    todoClock.value = now;
    const next = nextListChange(todos.peek(), now);
    if (next !== undefined) timer = setTimeout(tick, Math.min(next - now + 25, MAX_CLOCK_DELAY));
  };
  effect(() => {
    void todos.value; // re-read at every change of the list
    tick();
  });
}

export function wireEvents(): void {
  rpc.subscribe(['chats', 'tasks', 'org', 'providers', 'system']);
  rpc.onOpen(() => { void loadAll(); });

  // chats / messages
  rpc.on('conversation.upserted', (chat) => { upsertById(conversations, chat); catchUp(chat); }); // its new line, before it is opened
  rpc.on('conversation.removed', ({ id }) => { removeById(conversations, id); messages.delete(id); });
  rpc.on('message.created', putMessage);
  rpc.on('message.updated', putMessage);
  rpc.on('message.removed', ({ id, conversationId }) => {
    const list = messages.get(conversationId);
    if (list) list.value = list.value.filter((message) => message.id !== id);
  });

  // tasks
  rpc.on('task.upserted', (task) => {
    if (task.status === 'done' || task.status === 'dropped') {
      removeById(tasks, task.id);
      dismissToastsWhere((toast) => toast.taskId === task.id); // answered elsewhere (phone, an agent): its toast goes
    } else upsertById(tasks, task);
    if (isOpenTodo(task)) upsertById(todos, task);
    else removeById(todos, task.id);
  });
  rpc.on('task.removed', ({ id }) => { removeById(tasks, id); removeById(todos, id); dismissToastsWhere((toast) => toast.taskId === id); });
  wireDay(); // B-041: calendar.upserted/removed and the day clock

  // org
  rpc.on('agent.upserted', (event) => {
    const agent = withInstructions(event);
    upsertById(agents, agent);
    if (agent.archivedAt !== undefined) upsertById(archivedAgents, agent); else removeById(archivedAgents, agent.id);
  });
  rpc.on('agent.removed', ({ id }) => { removeById(agents, id); removeById(archivedAgents, id); });
  rpc.on('agent.activity', ({ active }) => { activity.value = active; });
  wirePeople(); // F-52: person.upserted
  wireSplits(); // B-057: split.upserted, and an agent's groups read again when its split runs start or end

  // providers
  rpc.on('account.upserted', (account) => upsertById(accounts, account));
  rpc.on('account.removed', ({ id }) => removeById(accounts, id));
  rpc.on('usage.updated', (list) => { usage.value = list; });
  rpc.on('models.updated', (list) => { models.value = list; });

  // system
  rpc.on('settings.updated', (value) => { settings.value = value; });
  rpc.on('update.state', (state) => { updateState.value = state; }); // also right after every (re)connect's subscribe (runtime/rpc/server.ts KEPT): a phone has no other way to read it
  rpc.on('notify', (note) => {
    // OS notifications and their sound are main's job; in-window we show a toast for what matters (a to-do, a
    // blocker or an important message stays until Open or Dismiss, see below). The
    // runtime's `toast` flag follows the chat's notification level (C3); older runtimes send none.
    if (!(note.toast ?? (note.kind !== 'info' && note.kind !== 'reply'))) return;
    if (atToastTarget(note) && document.hasFocus()) return; // the person sees it already
    toastNotification(note);
  });

  // RC1: the start notice ("Updated to X · N tasks continued") once per start, also after a reload. F25: one saying an
  // update did not install stays until Dismiss (toastStartNotice).
  effect(() => {
    const notice = systemInfo.value?.notice;
    if (!notice || Date.now() - notice.at > NOTICE_FRESH_MS || shownNotice() === notice.id) return;
    rememberNotice(notice.id);
    toastStartNotice(notice);
  });

  // Keep exactly the open chat's topic subscribed.
  let current: Topic | null = null;
  effect(() => {
    const id = activeConversationId.value;
    const next: Topic | null = id ? `chat:${id}` : null;
    if (next === current) return;
    if (current) rpc.unsubscribe([current]);
    if (next) rpc.subscribe([next]);
    current = next;
  });

  // A toast goes once the person is where its Open leads, also when the window comes back to that view.
  effect(() => { void route.value; void todos.value; dismissToastsWhere(atToastTarget); }); // a to-do reaching the list after its toast too
  window.addEventListener('focus', () => dismissToastsWhere(atToastTarget));

  wireTodoClock();
}
