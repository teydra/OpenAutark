// Sidebar content for #/team (and the phone's Team tab): the one org chart (TeamTree.tsx) with carets. Header data
// (teamNavHeader – "Team", the in-place search and ONE fixed "Add" cell whose menu holds Agent, Person, Set up with AI…
// and Start setup again). A manager row (or a person with
// reports) expands its reports right below; branches open by hand (remembered per device) and above the open agent.
// While searching: matching people and agents as flat rows. At the very end – F14 – a collapsed "Invited (n)" group for the
// owner (people who never joined: not in the tree until they do; their menu offers Remove), then the collapsed
// "Archived (n)" group (ArchivedGroup.tsx; a right click on its rows offers Restore). Opening either only adds rows below.
// F13: Add › Person opens the Add person page (#/team/person/new, PersonNew.tsx) – no pop-up.
// Owns: the team navigation, its expand state (per device), search, the Invited group and the Add menu with its dialogs.
// Never: edits the org, draws the tree's rows itself (TeamTree.tsx) or header markup (lib/header.tsx does).

import { useEffect, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import type { Agent } from '../../shared/model/org.ts';
import type { Person } from '../../shared/model/people.ts';
import type { MenuSection } from '../lib/ui.tsx';
import { Icon } from '../lib/ui.tsx';
import type { HeaderProps } from '../lib/header.tsx';
import { openContextMenu } from '../lib/context-menu.tsx';
import { go } from '../lib/router.ts';
import { agents, isMobile, route } from '../lib/store.ts';
import { can } from '../lib/session.ts';
import { setupAgainAllowed, startSetupAgain } from '../onboarding/setup-again.ts';
import { matchesAgent } from './model.ts';
import { ensureSpaces, invitedPeople, teamPeople } from './org-state.ts';
import { AgentRow, PersonRow, TeamTree } from './TeamTree.tsx';
import type { Expand } from './TeamTree.tsx';
import { ArchivedGroup } from './ArchivedGroup.tsx';
import { NewAgentDialog } from './NewAgentDialog.tsx';
import { PersonDialogs } from './person-dialogs.tsx';
import { setUpWithAi, teamSetupRequest } from './set-up-with-ai.ts';
import { useSplitNav } from '../splits/SplitNav.tsx'; // B-057
import { notLoaded } from '../shell/connection-line.ts';

const EXPANDED_KEY = 'wf.teamExpanded';

/** The team search, shared by the header (field in the title's place) and the rows. */
const search = signal({ open: false, query: '' });

const addingAgent = signal(false);

/** The Add menu: Agent, Person (owner), Set up with AI… (the Manager's chat, prepared) and – apart – Start setup again. */
function addMenu(): MenuSection[] {
  const sections: MenuSection[] = [{ items: [
    { label: 'Agent', onSelect: () => { addingAgent.value = true; } },
    ...(can('people.save') ? [{ label: 'Person', onSelect: () => go.addPerson() }] : []),
    { label: 'Set up with AI…', onSelect: () => { void setUpWithAi(teamSetupRequest()); } },
  ] }];
  if (setupAgainAllowed()) sections.push({ items: [{ label: 'Start setup again', onSelect: () => { void startSetupAgain(); } }] });
  return sections;
}

/** The Team side header: "Team", the fixed Add cell and the magnifier, whose field takes the title's place. */
export function teamNavHeader(): HeaderProps {
  const state = search.value;
  return {
    title: 'Team',
    cells: [{ id: 'add', icon: 'plus', label: 'Add', menu: addMenu() }],
    search: {
      label: 'Search the team', open: state.open, query: state.query,
      onQuery: (query) => { search.value = { ...search.peek(), query }; },
      onOpenChange: (open) => { search.value = { ...search.peek(), open }; },
    },
  };
}

function readExpanded(): string[] {
  try { return JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]') as string[]; } catch { return []; }
}

/** Managers above the open agent (agents, then the person they report to), so its row is visible without persisting that expansion. */
function ancestorsOf(agentId: string | undefined, list: Agent[], people: readonly Person[]): Set<string> {
  const out = new Set<string>();
  const byId = new Map(list.map((agent) => [agent.id, agent]));
  const personIds = new Set(people.map((person) => person.id));
  let current = agentId ? byId.get(agentId) : undefined;
  while (current?.managerId && !out.has(current.managerId)) {
    if (personIds.has(current.managerId)) { out.add(current.managerId); break; }
    if (!byId.has(current.managerId)) break;
    out.add(current.managerId);
    current = byId.get(current.managerId);
  }
  return out;
}

function matchesPerson(person: Person, query: string): boolean {
  const q = query.trim().toLowerCase();
  return person.name.toLowerCase().includes(q) || person.title.toLowerCase().includes(q);
}

/** F14: "Invited (n)" – the owner's people who never joined, collapsed (open while one of them is the open page). */
function InvitedGroup(props: { activeId?: string }) {
  const list = invitedPeople.value;
  const [open, setOpen] = useState<boolean | undefined>(undefined); // undefined: by itself (open on one of theirs)
  if (!list.length) return null;
  const shown = open ?? list.some((person) => person.id === props.activeId);
  return (
    <div class="team-space team-archived team-invited">
      <button type="button" class="team-archived-toggle" aria-expanded={shown} onClick={() => setOpen(!shown)}>
        <Icon name={shown ? 'caret-down' : 'caret-right'} size={12} />
        <span>Invited ({list.length})</span>
      </button>
      {shown && list.map((person) => <PersonRow key={person.id} person={person} depth={0} reports={0} activeId={props.activeId} />)}
    </div>
  );
}

export function TeamNav() {
  const query = search.value.query;
  const [stored, setStored] = useState<string[]>(readExpanded);
  useEffect(() => { ensureSpaces(); }, []);
  useEffect(() => () => { search.value = { open: false, query: '' }; }, []); // shown again: no search
  useSplitNav(); // B-057: the agents' newest split groups

  const current = route.value.view === 'team' ? route.value : undefined;
  const activeId = current?.agentId;
  const personId = current?.personId;
  const list = agents.value.filter((agent) => !agent.archivedAt);
  const [collapsed, setCollapsed] = useState<string[]>([]); // closed by hand this session (wins over auto-open)
  const auto = [...ancestorsOf(activeId, list, teamPeople.value)];
  const expanded = new Set([...stored, ...auto].filter((id) => !collapsed.includes(id)));
  const toggle = (id: string) => {
    const open = expanded.has(id);
    const next = open ? stored.filter((entry) => entry !== id) : [...stored.filter((entry) => entry !== id), id];
    setStored(next);
    setCollapsed(open ? [...collapsed, id] : collapsed.filter((entry) => entry !== id));
    try { localStorage.setItem(EXPANDED_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };
  const expand: Expand = { open: (id) => expanded.has(id), toggle, activeId, splitId: current?.splitId, personId };
  const q = query.trim();
  const agentMatches = q ? list.filter((agent) => matchesAgent(agent, q)).sort((a, b) => a.name.localeCompare(b.name)) : [];
  const personMatches = q ? teamPeople.value.filter((person) => matchesPerson(person, q)).sort((a, b) => a.name.localeCompare(b.name)) : [];

  return (
    <div class="team-nav">
      {isMobile.value && ( // the phone has no side header: its Add sits at the top of the list
        <button type="button" class="text-button team-add" aria-haspopup="menu" onClick={(event) => { const box = (event.currentTarget as HTMLElement).getBoundingClientRect(); openContextMenu(box.left, box.bottom, addMenu()); }}>Add</button>
      )}
      <div class="team-rows">
        {q
          ? (agentMatches.length || personMatches.length
            ? (
              <>
                {personMatches.map((person) => <PersonRow key={person.id} person={person} depth={0} reports={0} activeId={personId} />)}
                {agentMatches.map((agent) => <AgentRow key={agent.id} agent={agent} depth={0} reports={0} activeId={activeId} />)}
              </>
            )
            : <p class="empty-state team-empty">Nobody found</p>)
          : <TeamTree expand={expand} />}
        {!q && !list.length && <p class="empty-state team-empty">{notLoaded.value ?? 'No agents yet'}</p>}
        {!q && <InvitedGroup activeId={personId} />}
        {!q && <ArchivedGroup />}
      </div>
      <NewAgentDialog open={addingAgent.value} onClose={() => { addingAgent.value = false; }} />
      <PersonDialogs />
    </div>
  );
}
