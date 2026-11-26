// The one org tree, drawn by TeamNav.tsx with carets and splits: People (the owner on top, people under whom they report to, with the
// agents that report to them), then the top agents grouped by space under real headings – space-less ones such as
// the Manager first ("Agents", whenever another group stands beside it) – each report nested under its manager
// whatever its space. A report in another space than the one it sits in names it first on its status line, as a
// label that is never cut off (model.ts reportSpace). Each level is indented one step; every branch (row + its
// subtree + splits) is one `.team-branch`, which draws its parent's 1 px guide beside it – the last one down to its
// row's middle only, so a guide ends at its parent's last direct report. Team-Call 21.11.2026: rows drag and drop –
// an agent onto an agent reports to it, a person onto an agent makes it theirs (team-drag.ts, drop-model.ts). Every row: real
// status ring/dot, a live status line with the remote PC when known, and the tiny "AI"; right-click or long-press opens its menu (menus.ts).
// An agent's splits are rows inside the same expansion, below its reports (splits/SplitNav.tsx).
// Owns: the rows, branches and grouped body of the tree. Never: keeps expand state (the caller passes `open`),
// edits the org or draws header markup.

import type { Agent } from '../../shared/model/org.ts';
import type { Person } from '../../shared/model/people.ts';
import { AgentAvatar, Icon } from '../lib/ui.tsx';
import { runsOn, watchPcs } from './runs-on.ts';
import { useContextMenu } from '../lib/context-menu.tsx';
import { agentName } from '../lib/store.ts';
import { go } from '../lib/router.ts';
import { countReports, groupBySpace, reportSpace, teamMoreLabel } from './model.ts';
import type { OrgEntry } from './model.ts';
import { countPersonReports, statusLabel } from './people-model.ts';
import type { PersonEntry } from './people-model.ts';
import { agentLine, AgentStatusAvatar, AiTag } from './parts.tsx';
import { orgTree, peopleTree, spaces } from './org-state.ts';
import { agentMenu, personMenu } from './menus.ts';
import { dropTarget, rowDrag } from './team-drag.ts';
import { SplitCount, SplitNavRows, hasSplits } from '../splits/SplitNav.tsx'; // B-057

type Toggle = { expanded: boolean; onToggle: () => void } | null;

function Caret(props: { name: string; toggle: Toggle; what?: string }) {
  if (!props.toggle) return <span class="team-caret-space" aria-hidden="true" />;
  const { expanded, onToggle } = props.toggle;
  return (
    <button type="button" class="team-caret" aria-expanded={expanded} aria-label={`${expanded ? 'Hide' : 'Show'} ${props.what ?? 'reports'} of ${props.name}`} onClick={onToggle}>
      <Icon name={expanded ? 'caret-down' : 'caret-right'} size={12} />
    </button>
  );
}

export function AgentRow(props: { agent: Agent; depth: number; reports: number; toggle?: Toggle; activeId?: string; what?: string; space?: string }) {
  const { agent } = props;
  const active = agent.id === props.activeId;
  const toggle = props.toggle ?? null;
  watchPcs();
  const where = runsOn(agent);
  const line = [agentLine(agent), where && !where.here ? `on ${where.name}` : ''].filter(Boolean).join(' · ');
  const menu = useContextMenu(() => agentMenu(agent));
  return (
    <div class={`team-row${active ? ' active' : ''}${dropTarget.value === agent.id ? ' drop-target' : ''}`} style={{ '--depth': String(props.depth) }} {...menu} {...rowDrag({ kind: 'agent', id: agent.id })}>
      <Caret name={agent.name} toggle={toggle} what={props.what} />
      <button type="button" class="team-row-open" aria-current={active ? 'page' : undefined} onClick={() => go.agent(agent.id)}>
        <AgentStatusAvatar agent={agent} size={30} />
        <span class="team-row-text">
          <span class="team-row-name"><span class="row-title">{agent.name}</span><AiTag /></span>
          {props.space ? (
            <span class="row-preview team-row-sub"><span class="team-row-space">{props.space}</span><span class="team-row-status">{line && ` · ${line}`}</span></span>
          ) : <span class="row-preview">{line}</span>}
        </span>
        {toggle && !toggle.expanded && props.reports > 0 && <span class="nav-count tabular" title={`${props.reports} reports`}>{props.reports}</span>}
        <SplitCount agentId={agent.id} shown={!toggle?.expanded} />
      </button>
    </div>
  );
}

export function PersonRow(props: { person: Person; depth: number; reports: number; toggle?: Toggle; activeId?: string }) {
  const { person } = props;
  const active = person.id === props.activeId;
  const toggle = props.toggle ?? null;
  const name = person.id === 'human' ? agentName('human') : person.name;
  const status = statusLabel(person);
  const line = [person.title, status === 'Active' || person.owner ? '' : status].filter(Boolean).join(' · ');
  const menu = useContextMenu(() => personMenu(person));
  return (
    <div class={`team-row person${active ? ' active' : ''}${dropTarget.value === person.id ? ' drop-target' : ''}`} style={{ '--depth': String(props.depth) }} {...menu} {...rowDrag({ kind: 'person', id: person.id }, person.fromEmployer)}>
      <Caret name={name} toggle={toggle} />
      <button type="button" class="team-row-open" aria-current={active ? 'page' : undefined} onClick={() => go.person(person.id)}>
        <AgentAvatar agentId={person.id} size={30} />
        <span class="team-row-text">
          <span class="row-title">{name}</span>
          {line && <span class="row-preview">{line}</span>}
        </span>
        {toggle && !toggle.expanded && <span class="nav-count tabular" title={`${props.reports} reports`}>{props.reports}</span>}
      </button>
    </div>
  );
}

/** The navigation's expand state and current selection. */
export interface Expand { open: (id: string) => boolean; toggle: (id: string) => void; activeId?: string; splitId?: string; personId?: string }

/** One agent and – while open – its reports and its splits. `space`: the space it sits in ('' = none). */
function Branch(props: { entry: OrgEntry; depth: number; expand: Expand; space: string }) {
  const { entry, expand } = props;
  const { toggle } = expand;
  const open = expand.open(entry.agent.id);
  const hasReports = entry.reports.length > 0;
  const splits = hasSplits(entry.agent.id); // B-057: the same expansion shows its split rows (never opened by itself)
  const where = reportSpace(entry.agent, props.space, spaces.value);
  const more = hasReports && !open; // Entwurf 2c: a closed team says how many are in it, one tap opens it
  return (
    <div class="team-branch" style={{ '--depth': String(props.depth) }}>
      <AgentRow agent={entry.agent} depth={props.depth} reports={more ? 0 : countReports(entry)} activeId={expand.splitId && splits && open ? undefined : expand.activeId}
        what={hasReports ? (splits ? 'reports and splits' : 'reports') : 'splits'} space={where.name}
        toggle={hasReports || splits ? { expanded: open, onToggle: () => toggle(entry.agent.id) } : null} />
      {more && (
        <button type="button" class="team-more" style={{ '--depth': String(props.depth + 1) }} aria-expanded={false} onClick={() => toggle(entry.agent.id)}>
          <Icon name="caret-right" size={12} /> {teamMoreLabel(entry)}
        </button>
      )}
      {hasReports && open && (
        <div class="team-reports" role="group" aria-label={`Reports of ${entry.agent.name}`}>
          {entry.reports.map((report) => <Branch key={report.agent.id} entry={report} depth={props.depth + 1} expand={expand} space={where.context} />)}
        </div>
      )}
      {splits && open && <SplitNavRows agentId={entry.agent.id} depth={props.depth + 1} activeSplitId={expand.splitId} />}
    </div>
  );
}

function PersonBranch(props: { entry: PersonEntry; depth: number; expand: Expand }) {
  const { entry, expand } = props;
  const { toggle } = expand;
  const id = entry.person.id;
  const reports = entry.people.length + entry.agents.length;
  const open = expand.open(id);
  return (
    <div class="team-branch" style={{ '--depth': String(props.depth) }}>
      <PersonRow person={entry.person} depth={props.depth} reports={countPersonReports(entry)} activeId={expand.personId}
        toggle={reports ? { expanded: open, onToggle: () => toggle(id) } : null} />
      {reports > 0 && open && (
        <div class="team-reports" role="group" aria-label={`Reports of ${entry.person.name}`}>
          {entry.people.map((report) => <PersonBranch key={report.person.id} entry={report} depth={props.depth + 1} expand={expand} />)}
          {entry.agents.map((report) => <Branch key={report.agent.id} entry={report} depth={props.depth + 1} expand={expand} space="" />)}
        </div>
      )}
    </div>
  );
}

/** People, then the agents of the top grouped by space, each group under its heading. */
export function TeamTree(props: { expand: Expand }) {
  const { expand } = props;
  const people = peopleTree.value;
  const groups = groupBySpace(orgTree.value, spaces.value);
  return (
    <>
      {people.length > 0 && (
        <div class="team-space team-people">
          <h3 class="team-space-title">People</h3>
          {people.map((entry) => <PersonBranch key={entry.person.id} entry={entry} depth={0} expand={expand} />)}
        </div>
      )}
      {groups.map((group, index) => (
        <div class="team-space" key={group.space?.id ?? `rest-${index}`}>
          {(group.space || people.length > 0 || groups.length > 1) && <h3 class="team-space-title">{group.space?.name ?? 'Agents'}</h3>}
          {group.entries.map((entry) => <Branch key={entry.agent.id} entry={entry} depth={0} expand={expand} space={group.space?.id ?? ''} />)}
        </div>
      ))}
    </>
  );
}
