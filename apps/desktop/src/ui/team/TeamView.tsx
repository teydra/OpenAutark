// Desktop Team overview: live summary and, only with the sidebar closed, its usual interactive navigation.
// Owns: the desktop Team page, never the tree or its controls (TeamNav).

import { Header } from '../lib/header.tsx';
import { agents, preferences } from '../lib/store.ts';
import { teamHeadline } from './model.ts';
import { liveByAgent } from './org-state.ts';
import { TeamNav, teamNavHeader } from './TeamNav.tsx';

export function TeamView() {
  const sidebar = preferences.value.sidebarOpen;
  return (
    <div class="team-view">
      <Header zone="main" class="team-header" {...(sidebar ? { title: 'Team' } : teamNavHeader())} />
      <div class="team-scroll">
        <div class="team-overview">
          <p class="team-headline tabular">{teamHeadline(agents.value, liveByAgent.value)}</p>
          {!sidebar && <TeamNav />}
        </div>
      </div>
    </div>
  );
}
