// "Set up with AI" request texts (src/ui/team/set-up-with-ai.ts): what the Manager's composer gets for importing a
// team, duplicating an agent, changing who an agent reports to and connecting a calendar – and that a draft the person already typed stays.
// Owns: these assertions only. Never: the chat, rpc or the DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectCalendarRequest, duplicateRequest, teamSetupRequest, reportsToRequest, withRequest } from '../../../src/ui/team/set-up-with-ai.ts';

test('the requests name the thing and end where the person adds the missing detail', () => {
  assert.equal(teamSetupRequest(), 'Help me set up an agent or import a team. I want to: ');
  assert.equal(duplicateRequest({ name: 'Pia' }), 'Duplicate Pia');
  assert.equal(reportsToRequest({ name: 'Pia' }), 'Change who Pia reports to. New manager: ');
  assert.match(connectCalendarRequest(), /^Connect a calendar to my Tasks page .*: $/);
});

test('a request goes under what was already typed, never over it', () => {
  assert.equal(withRequest('', 'Do this: '), 'Do this: ');
  assert.equal(withRequest('   ', 'Do this: '), 'Do this: ');
  assert.equal(withRequest('Remember the offsite.  ', 'Do this: '), 'Remember the offsite.\nDo this: ');
});
