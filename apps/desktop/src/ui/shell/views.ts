// The one route table (a fixed frame draws the surfaces and header rows, the views hand over content and cell
// data): for every route what the desktop frame's side and main zones show and what the phone stack shows.
// Shell.tsx, Sidebar.tsx and MobileShell.tsx draw the zones from it; nothing else switches on the route.
//   side  – the sidebar's content and its header as data (the navs: Chats, Team, the Tasks page's quests, Settings)
//   main  – the main zone's content; `header` when the route hands its header row over as data (the empty
//           #/chats). Without it the view draws its own top row with lib/header.tsx.
//   phone – the stack: tab root or pushed (back, no tab bar), the top row's title, the body, the nav's header
//           data when the body is a nav or a settings page (its search replaces the palette search), and `ownHeader` when the
//           body draws its own top row with Back as its lead (a chat, an agent, a person, Add person) – one top row.
// A chat route on a connection that may not read chats (To-do-only phone) shows the Tasks page (shell/gates.ts).
// Quests round 20.11.2026: one Tasks page (tasks/TasksPage.tsx) instead of My day and Work – the default route 'home'
// and 'tasks' show it in the same zones with the same key, so going between them changes nothing on screen; while the
// first run is open its place shows the first-run layer (onboarding/FirstRun.tsx).
// On a phone a to-do's or quest's detail (#/tasks/<id>) is a pushed screen whose own top row has its close.
// Owns: route → view mapping, the phone's title and push rule. Never: layout chrome, header markup or view content.

import { h } from 'preact';
import type { ComponentChildren } from 'preact';
import { Header } from '../lib/header.tsx';
import type { HeaderProps, HeaderZone } from '../lib/header.tsx';
import type { Route } from '../lib/router.ts';
import { DESTINATIONS } from '../lib/vocab.ts';
import type { NavKey } from '../lib/vocab.ts';
import { ChatView } from '../chat/ChatView.tsx';
import { ChatList, chatListHeader } from '../chat/ChatList.tsx';
import { FirstRun } from '../onboarding/FirstRun.tsx';
import { firstRunActive } from '../onboarding/first-run.ts';
import { FIRST_RUN_TITLE } from '../onboarding/first-run-model.ts';
import { TasksPage } from '../tasks/TasksPage.tsx';
import { QuestNav, questNavHeader } from '../tasks/QuestNav.tsx';
import { searchState } from '../tasks/task-search.ts';
import { TeamView } from '../team/TeamView.tsx';
import { TeamNav, teamNavHeader } from '../team/TeamNav.tsx';
import { AgentView } from '../team/AgentView.tsx';
import { PersonView } from '../team/PersonView.tsx';
import { PersonNew } from '../team/PersonNew.tsx'; // F13: #/team/person/new
import { SplitView } from '../splits/SplitView.tsx'; // B-057: #/team/<agentId>/split/<splitId>
import { AgentWork } from '../team/AgentWork.tsx'; // F11: #/team/<agentId>/work
import { Settings, settingsSectionTitle } from '../settings/Settings.tsx';
import { SettingsNav, settingsNavHeader } from '../settings/SettingsNav.tsx';
import { chatRouteAllowed } from './gates.ts';

/** A zone's header row as data (lib/header.tsx props; the frame sets the zone). */
export type HeaderSource = () => HeaderProps;

export interface ZoneView {
  /** The frame remounts the zone's content (and header) when this changes. */
  key: string;
  body: ComponentChildren;
  /** The zone's header row as data; absent = the body draws its own top row (main zone only). */
  header?: HeaderSource;
}

export interface DesktopViews {
  side: ZoneView & { header: HeaderSource };
  main: ZoneView;
}

export interface PhoneView {
  key: string;
  body: ComponentChildren;
  /** Pushed on top of a tab: the body's own top row with Back, no tab bar. */
  pushed: boolean;
  /** The top row's title ('' when the body's own heading names it). */
  title: string;
  /** The frame's row has Back to Home (the settings list) or to all settings (a page); pushed screens draw their own row with Back. */
  back: 'home' | 'settings' | null;
  /** The body's header data – a nav's (Chats) or the Tasks page's: its search takes the place of the palette search. */
  header?: HeaderSource;
  /** The body draws its own top row (every pushed screen – ownsTopRow): the frame draws none. */
  ownHeader: boolean;
}

/** Draws a zone's header row from its source (keyed by the zone's key in the frame). */
export function ZoneHeader(props: { read: HeaderSource; zone: HeaderZone }) {
  return h(Header, { ...props.read(), zone: props.zone });
}

/** The chat route's view: the chat, or the Tasks page where this connection may not read chats. */
function chatBody(id: string): { key: string; body: ComponentChildren } {
  return chatRouteAllowed() ? { key: `chat:${id}`, body: h(ChatView, { key: id, conversationId: id }) } : { key: 'tasks', body: h(TasksPage, null) };
}

function sideView(current: Route): DesktopViews['side'] {
  switch (current.view) {
    case 'team': return { key: 'team', body: h(TeamNav, null), header: teamNavHeader };
    case 'settings': return { key: 'settings', body: h(SettingsNav, null), header: settingsNavHeader };
    case 'home': // the Tasks page everywhere: one side column, the quests
    case 'tasks': return { key: 'tasks', body: h(QuestNav, null), header: questNavHeader };
    default: return { key: 'chats', body: h(ChatList, null), header: chatListHeader };
  }
}

/** The team route's page: Add person (F13), a person, a split of an agent (B-057), an agent's Work page (F11), an agent or the overview. */
function teamBody(current: Extract<Route, { view: 'team' }>): { key: string; body: ComponentChildren } {
  if (current.addPerson) return { key: 'person-new', body: h(PersonNew, null) };
  if (current.personId) return { key: `person:${current.personId}`, body: h(PersonView, { key: current.personId, personId: current.personId }) };
  if (current.agentId && current.splitId) return { key: `split:${current.splitId}`, body: h(SplitView, { key: current.splitId, agentId: current.agentId, splitId: current.splitId }) };
  if (current.agentId && current.work) return { key: `work:${current.agentId}`, body: h(AgentWork, { key: current.agentId, agentId: current.agentId }) };
  if (current.agentId) return { key: `agent:${current.agentId}`, body: h(AgentView, { key: current.agentId, agentId: current.agentId }) };
  return { key: 'team', body: h(TeamView, null) };
}

const EMPTY_CHATS: HeaderSource = () => ({ title: '' });

function mainView(current: Route): ZoneView {
  switch (current.view) {
    case 'chat': return chatBody(current.id);
    case 'chats': return { key: 'chats', body: h('div', { class: 'main-empty' }), header: EMPTY_CHATS };
    case 'team': return teamBody(current);
    case 'settings': return { key: 'settings', body: h(Settings, null) };
    default: return homeBody();
  }
}

/** Home and the Tasks page: the first-run layer while it is open, else the page. */
function homeBody(): ZoneView {
  return firstRunActive() ? { key: 'first-run', body: h(FirstRun, null) } : { key: 'tasks', body: h(TasksPage, null) };
}

/** The desktop frame's side and main zones for a route. */
export function desktopViews(current: Route): DesktopViews {
  return { side: sideView(current), main: mainView(current) };
}

/** The top row's title of a tab: the destination's name, Settings for the settings list. */
export function tabTitle(current: Route): string {
  if (current.view === 'settings') return 'Settings';
  if ((current.view === 'home' || current.view === 'tasks') && firstRunActive()) return FIRST_RUN_TITLE; // the computer's header says the same
  const key: NavKey = current.view === 'chat' ? 'chats' : current.view;
  return DESTINATIONS[key];
}

/** Pushed screens: a chat, an agent, a person, Add person and a to-do's or quest's detail. */
export function isPushed(current: Route): boolean {
  if (current.view === 'chat') return chatRouteAllowed();
  if (current.view === 'tasks') return !!current.task;
  return current.view === 'team' && !!(current.agentId || current.personId || current.addPerson);
}

/** The phone body draws its own top row (Back as its lead): every pushed screen – the frame's row has no
 *  Back for them, so a new pushed screen must bring its own (lib/header.tsx backCell). */
export function ownsTopRow(current: Route): boolean {
  return isPushed(current);
}

/** The phone stack for a route. */
export function phoneView(current: Route): PhoneView {
  const pushed = isPushed(current);
  switch (current.view) {
    case 'chat': {
      const chat = chatBody(current.id);
      return { ...chat, pushed, title: pushed ? '' : tabTitle({ view: 'tasks' }), back: null, ownHeader: ownsTopRow(current) };
    }
    case 'chats': return { key: 'chats', body: h(ChatList, null), pushed, title: tabTitle(current), back: null, header: chatListHeader, ownHeader: false };
    case 'tasks': return { key: 'tasks', body: h(TasksPage, null), pushed, title: tabTitle(current), back: null, header: () => ({ title: '', search: searchState() }), ownHeader: ownsTopRow(current) }; // its search in the top row
    case 'settings': return current.section
      ? { key: 'settings', body: h(Settings, null), pushed, title: settingsSectionTitle(current.section), back: 'settings', header: settingsNavHeader, ownHeader: false } // F20: the settings search, not the palette
      : { key: 'settings-list', body: h(SettingsNav, null), pushed, title: tabTitle(current), back: 'home', header: settingsNavHeader, ownHeader: false };
    case 'team': {
      if (!pushed) return { key: 'team', body: h('div', { class: 'team-view' }, h('div', { class: 'team-scroll' }, h(TeamNav, null))), pushed, title: tabTitle(current), back: null, ownHeader: false };
      const page = teamBody(current);
      return { ...page, pushed, title: pushed ? '' : tabTitle(current), back: null, ownHeader: ownsTopRow(current) };
    }
    default: {
      const page = mainView(current);
      return { key: page.key, body: page.body, pushed, title: tabTitle(current), back: null, ownHeader: false };
    }
  }
}
