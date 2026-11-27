// The connection's quiet state (src/ui/shell/connection-line.ts, Sicher-Runde 19.11.2026 D3–D5, owner 27.11.2026): one
// calm line while the PC is away – the same through the retries' connecting/closed flips, after a short grace –, "as of"
// the time the shown data is from, with no button at all (the page reconnects by itself; every online PC is linked, there
// is nothing to pick); in an open chat the chat header's sub line says it instead, so nothing lies over the chat. A PC
// that does not know (4404) or no longer accepts (4401) this phone is a line with Pair again in the phone apps, never a
// pairing screen and never Forget; the desktop names its engine.
// Owns: these assertions only. Never: a real socket, window or phone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signal } from '@preact/signals';
import { DOWN_GRACE_MS, awayText, connectionLine, down, downSince, watchConnection } from '../../../src/ui/shell/connection-line.ts';
import type { ConnectionFacts } from '../../../src/ui/shell/connection-line.ts';
import type { ConnectionStatus } from '../../../src/ui/lib/rpc.ts';
import { time } from '../../../src/ui/lib/format.ts';

const NOW = new Date(2026, 10, 19, 14, 30).getTime();
const AT = new Date(2026, 10, 19, 14, 2).getTime();
const LOST = 'Connection to the runtime was lost.';

const facts = (extra: Partial<ConnectionFacts> = {}): ConnectionFacts => ({
  status: 'closed', loaded: true, loadError: null, refused: null, down: true, downSince: AT, cachedAt: null, pc: 'Office-PC', outdated: null,
  desktop: false, phoneApp: false, chatOpen: false, lostText: LOST, now: NOW, ...extra,
});
const act = { pairAgain: () => 'pair' };
const labels = (extra: Partial<ConnectionFacts>) => connectionLine(facts(extra), act)?.actions?.map((action) => action.label);
const text = (extra: Partial<ConnectionFacts>) => connectionLine(facts(extra), act)?.text;

test('the PC away: one calm line, the same while connecting and closed, with the time of the shown data', () => {
  assert.equal(text({}), `Office-PC not reachable · reconnecting by itself · as of ${time(AT)}`);
  assert.equal(text({ status: 'connecting' }), text({ status: 'closed' }), 'a retry does not change the line');
  assert.equal(connectionLine(facts({ status: 'connecting' }), act)?.tone, 'info');
  assert.equal(connectionLine(facts({ status: 'closed' }), act)?.tone, 'info');
  assert.equal(text({ cachedAt: AT - 3_600_000, downSince: NOW }), `Office-PC not reachable · reconnecting by itself · as of ${time(AT - 3_600_000)}`, 'the saved copy\'s time first');
  assert.equal(text({ loaded: false, cachedAt: null }), 'Office-PC not reachable · reconnecting by itself', 'no data shown: no "as of"');
  assert.equal(text({ pc: '' }), `Your PC not reachable · reconnecting by itself · as of ${time(AT)}`);
  assert.equal(connectionLine(facts({ down: false }), act), null, 'within the grace nothing shows');
});

test('the PC away: no button at all – no Try now, no Choose PC – in every app', () => {
  for (const extra of [{}, { phoneApp: true }, { desktop: true }, { desktop: true, loaded: false }, { status: 'connecting' as const }]) {
    assert.deepEqual(labels(extra), [], `no button (${JSON.stringify(extra)})`);
  }
});

test('an open chat: its header says the away state (awayText), nothing lies over the chat; it is gone once open', () => {
  assert.equal(connectionLine(facts({ chatOpen: true }), act), null, 'no status line over the chat');
  assert.equal(awayText(facts({ chatOpen: true })), `Office-PC not reachable · reconnecting by itself · as of ${time(AT)}`);
  assert.equal(awayText(facts({ down: false })), null, 'a short drop shows nothing');
  assert.equal(awayText(facts({ status: 'open', down: false, downSince: null })), null, 'gone the moment the link is back');
  assert.equal(awayText(facts({ status: 'open' })), null, 'open wins even before the down flag is reset');
  assert.equal(awayText(facts({ desktop: true, chatOpen: true })), 'Autark’s engine is not answering · reconnecting by itself');
});

test('a PC that does not know this phone (4404) or no longer accepts it (4401): a line, at once, with Pair again in the phone apps', () => {
  assert.equal(text({ refused: 4404, down: false }), 'Office-PC doesn\'t know this phone yet');
  assert.equal(text({ refused: 4401, down: false, status: 'connecting' }), 'Office-PC no longer accepts this phone');
  assert.equal(text({ refused: 4401, chatOpen: true }), 'Office-PC no longer accepts this phone', 'it needs the person: shown in a chat too');
  assert.equal(awayText(facts({ refused: 4404, chatOpen: true })), null, 'the header never says "reconnecting by itself" for a refusal');
  assert.deepEqual(labels({ refused: 4404, phoneApp: true }), ['Pair again']);
  assert.deepEqual(labels({ refused: 4401, phoneApp: true }), ['Pair again']);
  assert.deepEqual(labels({ refused: 4404 }), [], 'a plain browser');
  assert.deepEqual(connectionLine(facts({ refused: 4401, phoneApp: true }), act)!.actions!.map((action) => action.run()), ['pair']);
  for (const extra of [{}, { refused: 4401 as const }, { refused: 4404 as const, phoneApp: true }]) {
    assert.ok(!labels(extra)?.some((label) => /forget/i.test(label)), `no Forget on this path (${JSON.stringify(extra)})`);
  }
});

test('a PC older than this interface works with: "Update Autark on <its name>" at once, quiet, no button, in a chat too', () => {
  assert.equal(text({ outdated: 'Laptop', down: false, status: 'connecting' }), 'Update Autark on Laptop', 'no grace: a fact, not a blip');
  assert.equal(connectionLine(facts({ outdated: 'Laptop' }), act)?.tone, 'info');
  assert.deepEqual(labels({ outdated: 'Laptop', phoneApp: true }), []);
  assert.equal(awayText(facts({ outdated: 'Laptop', chatOpen: true })), 'Update Autark on Laptop', 'the chat header says it');
  assert.equal(awayText(facts({ outdated: 'Laptop', status: 'open' })), null, 'a fitting PC answered: gone');
  assert.equal(text({ outdated: 'Laptop', desktop: true }), 'Autark’s engine is not answering · reconnecting by itself', 'the window ships with its engine');
});

test('open: nothing, or the load error as words – never the lost connection\'s text as a line of its own', () => {
  assert.equal(connectionLine(facts({ status: 'open', down: false, downSince: null }), act), null);
  assert.equal(connectionLine(facts({ status: 'open', loadError: LOST }), act), null);
  const error = connectionLine(facts({ status: 'open', loadError: 'Something went wrong. It was logged.' }), act)!;
  assert.equal(error.tone, 'error');
  assert.deepEqual(error.actions, [], 'the page loads again by itself (lib/store.ts loadAll)');
});

test('the desktop names Autark\'s engine: starting before the first load, not answering after', () => {
  assert.equal(text({ desktop: true, loaded: false }), 'Autark’s engine is starting…');
  assert.deepEqual(labels({ desktop: true, loaded: false }), []);
  assert.equal(text({ desktop: true }), 'Autark’s engine is not answering · reconnecting by itself');
  assert.equal(text({ desktop: true, refused: 4401 }), 'Autark’s engine is not answering · reconnecting by itself', 'refusals are a phone matter');
});

test('watchConnection: the first moment not open stays through the flips; down after the grace; open resets it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 1_000;
  const status = signal<ConnectionStatus>('open');
  const stop = watchConnection(status, () => now);
  try {
    assert.equal(downSince.value, null);
    status.value = 'closed';
    assert.equal(downSince.value, 1_000);
    now = 1_500;
    status.value = 'connecting';
    status.value = 'closed';
    assert.equal(downSince.value, 1_000, 'the retries do not move it');
    t.mock.timers.tick(DOWN_GRACE_MS - 1);
    assert.equal(down.value, false);
    t.mock.timers.tick(1);
    assert.equal(down.value, true);
    status.value = 'open';
    assert.equal(down.value, false);
    assert.equal(downSince.value, null);
    status.value = 'connecting';
    status.value = 'open'; // a resume's quick new socket
    t.mock.timers.tick(DOWN_GRACE_MS);
    assert.equal(down.value, false, 'a short drop never shows the line');
  } finally {
    stop();
    downSince.value = null;
    down.value = false;
  }
});
