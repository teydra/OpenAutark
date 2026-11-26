// Hash router for the single shell. Views:
//   #/home · #/tasks[/<taskId>][?date=<YYYY-MM-DD>][&owner=<agentId>] · #/chats · #/chat/<id>
//   · #/team[/<agentId>] · #/team/<agentId>/work · #/team/<agentId>/split/<splitId> · #/team/person/<personId>
//   · #/team/person/new (F13: Add person – a page, person ids are 'per_…')
//   · #/settings[/<page>]  (a split's page under its agent; a Settings page, or an older name mapped to the page that
//     holds those rows, see settingsPage)
// Quests 20.11.2026: one Tasks page instead of My day and Work – `task` is the to-do or quest open in its detail (a
// task id in the path; an older ?task= still opens it), `date` the calendar's day (none: today), `owner` narrows "AI at
// work" to one agent (an agent's "All tasks"). An older '#/day[/<date>]' link (My day before – a push, a bookmark) opens
// the page on that day; it is no route of its own. 'home' (the default) is the page.
// 'chats' is the phone list view; on desktop it shows the last chat or the empty main slot. F11 16.11.2026: an agent's
// `work` page – what it does now, its active tasks and its log. An in-app `<a href="#/…">` navigates through routeLink.
// '#/chat/<id>?call=1' (owner 18.11.2026, the floating to-do button) also asks for that chat's call (callRequest).
// A chat route to a task's own thread ('#/chat/task_…' – a search hit, a notification tap) opens the task (chatRoute),
// since the thread lives in the task's detail.
// Owns: the current route signal, parsing/formatting, navigation, in-app link clicks and back.
// Never: loads data – views react to the route themselves.

import { signal } from '@preact/signals';
import { isId } from '../../shared/ids.ts';
import { isLocalDate } from '../../shared/model/calendar.ts';
import { isTaskThread } from '../../shared/model/chat.ts';

export type Route =
  | { view: 'home' }
  | { view: 'chats' }
  | { view: 'chat'; id: string }
  | { view: 'tasks'; task?: string; date?: string; owner?: string }
  | { view: 'team'; agentId?: string; personId?: string; splitId?: string; work?: true; addPerson?: true }
  | { view: 'settings'; section?: string };

export type RouteView = Route['view'];

/** The Settings pages (settings/sections.ts holds their titles and keywords), in nav order. */
export const SETTINGS_PAGES = ['general', 'models', 'calendar', 'scheduled', 'secrets', 'security', 'apps', 'skills', 'devices', 'feedback', 'about'] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number];
export const DEFAULT_SETTINGS_PAGE: SettingsPage = 'general';

/** Other Settings names (older sections, the one-page groups) → the page that holds those rows now. */
const PAGE_OF: Readonly<Record<string, SettingsPage>> = {
  accounts: 'models', providers: 'models', routing: 'models', usage: 'models', abilities: 'models',
  voice: 'models', speech: 'models', // B-078: the Voice page joined Models
  knowledge: 'skills', memory: 'skills',
  schedules: 'scheduled', schedule: 'scheduled', // owner 21.11.2026: Settings › Scheduled
  permissions: 'security', access: 'security', // owner 16.11.2026: Settings › Security holds the PC access
  remote: 'devices', phone: 'devices', android: 'devices',
  profile: 'general', appearance: 'general', notifications: 'general', customize: 'general',
  advanced: 'about', updates: 'about', privacy: 'about', backup: 'about',
};

/** The Settings page a section name opens: itself when it is one, the nearest page for an older name, else undefined (the first page). */
export function settingsPage(section: string | undefined): SettingsPage | undefined {
  if (!section) return undefined;
  const name = section.toLowerCase();
  const page = SETTINGS_PAGES.find((entry) => entry === name);
  return page ?? (Object.hasOwn(PAGE_OF, name) ? PAGE_OF[name] : undefined);
}

/** A settings route for a section name, mapped to its page. */
function settingsRoute(section: string | undefined): Route {
  const page = settingsPage(section);
  return page ? { view: 'settings', section: page } : { view: 'settings' };
}

export function parseRoute(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  switch (parts[0]) {
    case 'activity':
    case 'work': return { view: 'tasks' }; // retired top-level pages, not an agent's /team/<id>/work
    case 'day': return tasksRoute(isLocalDate(parts[1]) ? parts[1] : undefined); // My day before: the page on that day
    case 'chat': return parts[1] ? chatRoute(parts[1]) : { view: 'chats' };
    case 'chats': return { view: 'chats' };
    case 'tasks': {
      const search = new URLSearchParams(query);
      const task = isId(parts[1]) ? parts[1] : search.get('task') || undefined; // an older link's ?task=; an old filter name is no task
      const owner = search.get('owner') || undefined;
      const date = search.get('date') ?? undefined;
      return { ...tasksRoute(isLocalDate(date) ? date : undefined), ...(task ? { task } : {}), ...(owner ? { owner } : {}) };
    }
    case 'team':
      if (parts[1] === 'person') return parts[2] === 'new' ? { view: 'team', addPerson: true } : parts[2] ? { view: 'team', personId: parts[2] } : { view: 'team' };
      if (parts[1] && parts[2] === 'split' && parts[3]) return { view: 'team', agentId: parts[1], splitId: parts[3] }; // B-057
      if (parts[1] && parts[2] === 'work') return { view: 'team', agentId: parts[1], work: true }; // F11
      return parts[1] ? { view: 'team', agentId: parts[1] } : { view: 'team' };
    case 'settings':
      if (parts[1] === 'agents') return { view: 'team' }; // B-044: Settings › Agents went; its agents are on Team
      return settingsRoute(parts[1]);
    default: return { view: 'home' };
  }
}

export function formatRoute(route: Route): string {
  const enc = encodeURIComponent;
  switch (route.view) {
    case 'chat': return `#/chat/${enc(route.id)}`;
    case 'tasks': {
      const query = [route.date && `date=${enc(route.date)}`, route.owner && `owner=${enc(route.owner)}`].filter(Boolean).join('&');
      return `#/tasks${route.task ? `/${enc(route.task)}` : ''}${query ? `?${query}` : ''}`;
    }
    case 'team':
      if (route.addPerson) return '#/team/person/new';
      if (route.personId) return `#/team/person/${enc(route.personId)}`;
      if (route.agentId && route.splitId) return `#/team/${enc(route.agentId)}/split/${enc(route.splitId)}`;
      if (route.agentId && route.work) return `#/team/${enc(route.agentId)}/work`;
      return route.agentId ? `#/team/${enc(route.agentId)}` : '#/team';
    case 'settings': return route.section ? `#/settings/${enc(route.section)}` : '#/settings';
    default: return `#/${route.view}`;
  }
}

/** The Tasks page on `date` (none: today). */
function tasksRoute(date: string | undefined): Extract<Route, { view: 'tasks' }> {
  return date ? { view: 'tasks', date } : { view: 'tasks' };
}

export const route = signal<Route>(typeof location === 'undefined' ? { view: 'home' } : parseRoute(location.hash));

/** Last non-settings route, so closing Settings returns where the user was. */
let lastWorkRoute: Route = route.value.view === 'settings' ? { view: 'home' } : route.value;

/** Where chat `id` opens: the chat – or, for a task's own thread (its id is the task's), the task. */
export function chatRoute(id: string): Route {
  return isTaskThread(id) ? { view: 'tasks', task: id } : { view: 'chat', id };
}

export function navigate(requested: Route, options: { replace?: boolean } = {}): void {
  // an older section name opens its page; a task's thread opens its task
  const next = requested.view === 'settings' ? settingsRoute(requested.section)
    : requested.view === 'chat' ? chatRoute(requested.id) : requested;
  const hash = formatRoute(next);
  if (route.value.view !== 'settings') lastWorkRoute = route.value;
  if (location.hash === hash) { route.value = next; return; }
  if (options.replace) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
  route.value = next;
}

/**
 * Props of an in-app link, `<a {...routeLink(next)}>`: its '#/…' href, and a click that navigate()s
 * instead of the browser following the URL.
 */
export function routeLink(next: Route): { href: string; onClick: (event: Event) => void } {
  return { href: formatRoute(next), onClick: (event) => { event.preventDefault(); navigate(next); } };
}

export function closeSettings(): void {
  navigate(lastWorkRoute.view === 'settings' ? { view: 'home' } : lastWorkRoute);
}

export function toggleSettings(): void {
  if (route.value.view === 'settings') closeSettings();
  else navigate({ view: 'settings' });
}

export function back(): void {
  if (history.length > 1) history.back();
  else navigate({ view: 'home' });
}

/** Owner 18.11.2026 (the floating to-do button): the chat whose call starts once its header shows (CallHeader.tsx). */
export const callRequest = signal<string | null>(null);

/** '#/chat/<id>?call=1' asks for that chat's call: the request is noted and the address loses its query. */
export function takeCallRoute(hash: string): void {
  const next = parseRoute(hash);
  if (next.view !== 'chat' || !/[?&]call=1(&|$)/.test(hash)) return;
  callRequest.value = next.id;
  history.replaceState(null, '', formatRoute(next));
}

export function startRouter(): void {
  takeCallRoute(location.hash);
  window.addEventListener('popstate', () => { route.value = parseRoute(location.hash); });
  window.addEventListener('hashchange', () => { takeCallRoute(location.hash); route.value = parseRoute(location.hash); });
}

/** Convenience helpers used across the app. */
export const go = {
  home: () => navigate({ view: 'home' }),
  chat: (id: string) => navigate({ view: 'chat', id }),
  agent: (agentId: string) => navigate({ view: 'team', agentId }),
  /** B-057: a split's page under its agent. */
  split: (agentId: string, splitId: string) => navigate({ view: 'team', agentId, splitId }),
  /** F11: an agent's Work page – what it does now, its active tasks, its activity log. */
  work: (agentId: string) => navigate({ view: 'team', agentId, work: true }),
  /** A person's page in Team (F-52 people: 'per_…'). */
  person: (personId: string) => navigate({ view: 'team', personId }),
  /** F13: Team › Add person, a page. */
  addPerson: () => navigate({ view: 'team', addPerson: true }),
  settings: (section?: string) => navigate(section ? { view: 'settings', section } : { view: 'settings' }),
  /** The Tasks page; `owner` narrows "At work" to that agent (an older first argument, a Work filter, means nothing now). */
  tasks: (_filter?: string, owner?: string) => navigate({ view: 'tasks', ...(owner ? { owner } : {}) }),
};
