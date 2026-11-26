// The routes of the hash router (src/ui/lib/router.ts) – Quests 20.11.2026: the Tasks page (#/tasks, a to-do or quest
// open in its detail as #/tasks/<id>, the calendar's day as ?date=, "AI at work" narrowed by ?owner=), My day's older
// links opening it, a person's page and a split – parsed and formatted both ways, unknown or broken parts falling back
// to the plain view.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRoute, parseRoute, SETTINGS_PAGES, settingsPage } from '../../../src/ui/lib/router.ts';
import type { Route } from '../../../src/ui/lib/router.ts';

const TASK = 'task_0123456789ab';

test('retired Activity and Work links open Tasks without changing an agent’s Work page', () => {
  for (const link of ['#/activity', '#/work']) assert.equal(formatRoute(parseRoute(link)), '#/tasks');
  assert.equal(formatRoute(parseRoute('#/team/ag_1/work')), '#/team/ag_1/work');
});

test('an older #/day link (My day before) opens the Tasks page – on its day when the date is real; it is no route of its own', () => {
  assert.deepEqual(parseRoute('#/day'), { view: 'tasks' });
  assert.deepEqual(parseRoute('#/day/2026-10-24'), { view: 'tasks', date: '2026-10-24' });
  assert.deepEqual(parseRoute('#/day/2026-02-30'), { view: 'tasks' }, 'a day that does not exist');
  assert.deepEqual(parseRoute('#/day/tomorrow'), { view: 'tasks' });
  assert.equal(formatRoute(parseRoute('#/day/2026-10-24')), '#/tasks?date=2026-10-24');
});

test('#/tasks/<id>: the open to-do or quest; an older ?task= opens it too; an old Work filter is no task', () => {
  assert.deepEqual(parseRoute(`#/tasks/${TASK}`), { view: 'tasks', task: TASK });
  assert.deepEqual(parseRoute(`#/tasks?task=${TASK}`), { view: 'tasks', task: TASK });
  assert.deepEqual(parseRoute('#/tasks/done?owner=ag_mara'), { view: 'tasks', owner: 'ag_mara' });
  assert.deepEqual(parseRoute('#/tasks/for-you'), { view: 'tasks' });
  assert.deepEqual(parseRoute(`#/tasks/${TASK}?date=2026-11-21&owner=ag_mara`), { view: 'tasks', task: TASK, date: '2026-11-21', owner: 'ag_mara' });
  assert.deepEqual(parseRoute('#/tasks?date=2026-13-01'), { view: 'tasks' }, 'no such day: today');
  assert.equal(formatRoute({ view: 'tasks', task: TASK }), `#/tasks/${TASK}`);
  assert.equal(formatRoute({ view: 'tasks', date: '2026-11-21', owner: 'a b' }), '#/tasks?date=2026-11-21&owner=a%20b');
});

test('#/team/person/<id>; an agent page stays as it was', () => {
  assert.deepEqual(parseRoute('#/team/person/per_anna'), { view: 'team', personId: 'per_anna' });
  assert.deepEqual(parseRoute('#/team/person'), { view: 'team' }, 'no id: the team');
  assert.deepEqual(parseRoute('#/team/ag_mara'), { view: 'team', agentId: 'ag_mara' });
  assert.equal(formatRoute({ view: 'team', personId: 'per_anna' }), '#/team/person/per_anna');
  assert.equal(formatRoute({ view: 'team', agentId: 'ag_mara' }), '#/team/ag_mara');
  assert.equal(formatRoute({ view: 'team' }), '#/team');
});

test('F13: #/team/person/new is the Add person page – never looked up as a person id', () => {
  assert.deepEqual(parseRoute('#/team/person/new'), { view: 'team', addPerson: true });
  assert.equal(formatRoute({ view: 'team', addPerson: true }), '#/team/person/new');
  assert.deepEqual(parseRoute(formatRoute({ view: 'team', addPerson: true })), { view: 'team', addPerson: true });
  assert.deepEqual(parseRoute('#/team/person/per_new00001'), { view: 'team', personId: 'per_new00001' }, 'a person id stays one');
});

test('#/settings/agents opens Team; a settings page stays the section', () => {
  assert.deepEqual(parseRoute('#/settings/agents'), { view: 'team' });
  assert.deepEqual(parseRoute('#/settings/models'), { view: 'settings', section: 'models' });
  assert.deepEqual(parseRoute('#/settings'), { view: 'settings' });
});

test('every page opens itself, an older name the page that holds its rows, an unknown one the first page', () => {
  for (const page of SETTINGS_PAGES) assert.deepEqual(parseRoute('#/settings/' + page), { view: 'settings', section: page });
  assert.deepEqual(parseRoute('#/settings/remote'), { view: 'settings', section: 'devices' });
  assert.deepEqual(parseRoute('#/settings/abilities'), { view: 'settings', section: 'models' });
  assert.deepEqual(parseRoute('#/settings/advanced'), { view: 'settings', section: 'about' });
  assert.deepEqual(parseRoute('#/settings/usage'), { view: 'settings', section: 'models' });
  assert.deepEqual(parseRoute('#/settings/profile'), { view: 'settings', section: 'general' });
  assert.deepEqual(parseRoute('#/settings/memory'), { view: 'settings', section: 'skills' });
  assert.deepEqual(parseRoute('#/settings/nothing-like-it'), { view: 'settings' });
  assert.equal(settingsPage('Models'), 'models', 'the name is not case sensitive');
  // B-078: the Voice page joined Models – older links open Models
  assert.equal(settingsPage('Voice'), 'models');
  assert.deepEqual(parseRoute('#/settings/speech'), { view: 'settings', section: 'models' });
  assert.ok(!(SETTINGS_PAGES as readonly string[]).includes('voice'));
  assert.equal(settingsPage(undefined), undefined);
});

test('every new route survives a round trip', () => {
  const routes: Route[] = [
    { view: 'home' }, { view: 'tasks' }, { view: 'tasks', date: '2027-01-01' },
    { view: 'tasks', task: TASK }, { view: 'tasks', task: TASK, date: '2027-01-01', owner: 'a b&c' },
    { view: 'team', personId: 'per_x y' }, { view: 'team', agentId: 'ag_1' }, { view: 'team', agentId: 'ag_1', splitId: 'sp_1' },
  ];
  for (const route of routes) assert.deepEqual(parseRoute(formatRoute(route)), route, formatRoute(route));
});
