// The record between the CEO's own PCs (devices/sync/ledger.ts, ledger-wire.ts): two in-memory PCs (sync-ledger-rig.ts).
// The PC an agent runs on sends its record – a mirror from scratch with the originals of kept and condensed rows only,
// then live changes and marks; a cut link resumes from the cursor; an employee's PC gets nothing and sends nothing; a
// page stays under its limit; flushLedger sends the record of an agent that just left; fetchOriginals pulls the run
// items a record names that are missing here; the link-up sends it after the rows, before the wakes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Db } from '../../../src/runtime/db/database.ts';
import { fetchOriginals, flushLedger } from '../../../src/runtime/devices/sync/ledger.ts';
import { PAGE_BYTES } from '../../../src/runtime/devices/sync/ledger-wire.ts';
import { linkUps, type LinkUpParts } from '../../../src/runtime/devices/sync/service.ts';
import { ManualClock } from './fakes.ts';
import { link, Net, settle } from './sync-net.ts';
import { homeOf, items, journal, ledgerCalls, ledgerPc, MARA, record, row } from './sync-ledger-rig.ts';

const COLUMNS = 'item_id, kind, run_id, "order", created_at, tokens, title, state, condensed, pinned_until, origin_engine, origin_model, ref, applied, marked_by, mark_reason, marked_at, bytes, pruned_at';
const all = (db: Db) => db.all(`SELECT ${COLUMNS} FROM context_items ORDER BY "order"`);

test('a mirror from scratch: every row with its columns, the originals of kept and condensed rows only, a minimal run', async () => {
  const net = new Net();
  const a = ledgerPc(net, 'dev_a', 'dev_a');
  const b = ledgerPc(net, 'dev_b', 'dev_a');
  link(a, b);
  journal(a, 'run_1', 'ri_kept', 40, 'running'); // still going on A: 'unknown' on B
  journal(a, 'run_1', 'ri_cond');
  journal(a, 'run_2', 'ri_hidden', 40, 'running');
  row(a, 'message', { ref: 'msg:msg_1' });
  row(a, 'tool', { ref: 'item:ri_kept', runId: 'run_1' });
  row(a, 'tool', { ref: 'item:ri_cond', runId: 'run_1', state: 'condensed' });
  row(a, 'tool', { ref: 'item:ri_hidden', runId: 'run_2', state: 'hidden' });

  assert.equal(await a.ledger.catchUp('dev_b'), true);
  assert.deepEqual(all(b.h.db), all(a.h.db), 'every column but pc and changed is the same');
  assert.deepEqual(record(b).map((item) => item.pc), ['dev_a', 'dev_a', 'dev_a', 'dev_a'], 'written as dev_a\'s rows');
  assert.deepEqual(items(b), ['ri_cond', 'ri_cond_call', 'ri_kept', 'ri_kept_call'], 'the hidden row\'s original stays on dev_a');
  assert.deepEqual(b.h.db.all('SELECT id, status, device_id FROM runs').map((run) => ({ ...run as object })), [{ id: 'run_1', status: 'unknown', device_id: 'dev_a' }]);
  assert.equal(await b.ledger.catchUp('dev_a'), true);
  assert.deepEqual(ledgerCalls(net).filter((call) => call.from === 'dev_b').map((call) => (call.params as { op: string }).op), ['resettle'], 'the mirror sends no row back (part 2: it asks where the agents stand)');
});

test('live: a new row and a mark change travel at the next tick; a cut link resumes from the cursor', async () => {
  const net = new Net();
  const a = ledgerPc(net, 'dev_a', 'dev_a');
  const b = ledgerPc(net, 'dev_b', 'dev_a');
  link(a, b);
  const first = row(a, 'message', { ref: 'msg:msg_1' });
  a.ledger.tick();
  await settle();
  assert.equal(ledgerCalls(net).length, 0, 'nothing live before that PC\'s link-up got to the record');
  await a.ledger.catchUp('dev_b');
  row(a, 'assistant');
  a.ledger.tick();
  await settle();
  assert.deepEqual(record(b).map((item) => item.item_id), ['m1', 'a1'], 'the new row is there');

  a.h.db.run(`UPDATE context_items SET state = 'hidden', marked_by = 'subconscious' WHERE item_id = ?`, [first.item_id]);
  a.ledger.tick();
  await settle();
  assert.equal(record(b)[0].state, 'hidden', 'the mark travelled');

  net.up = false;
  row(a, 'reasoning');
  a.ledger.tick();
  await settle();
  assert.equal(record(b).length, 2, 'the link is cut');
  net.up = true;
  const before = ledgerCalls(net, 'rows').length;
  assert.equal(await a.ledger.catchUp('dev_b'), true);
  const sent = ledgerCalls(net, 'rows').slice(before).flatMap((call) => (call.params as { rows: Array<{ item_id: string }> }).rows.map((item) => item.item_id));
  assert.deepEqual(sent, ['r2'], 'only what was owed since the cursor');
  assert.deepEqual(record(b).map((item) => item.item_id), ['m1', 'a1', 'r2']);
});

test('an employee\'s PC gets nothing of the record of an agent that does not run there, and its record is refused', async () => {
  const net = new Net();
  const a = ledgerPc(net, 'dev_a', 'dev_a');
  const c = ledgerPc(net, 'dev_c', 'dev_a');
  link(a, c, 'per_lena000001');
  row(a, 'message', { ref: 'msg:msg_1' });
  assert.equal(await a.ledger.catchUp('dev_c'), true, 'nothing is owed there (26.11.2026: only an agent moved there has its record go)');
  a.ledger.tick();
  await settle();
  assert.equal(ledgerCalls(net).length, 0, 'nothing went to the employee\'s PC');
  await assert.rejects(a.ledger.receive({ op: 'rows', rows: [] }, 'dev_c'), /takes no record/);
});

test('a page stays under its limit: a big record goes in several calls', async () => {
  const net = new Net();
  const a = ledgerPc(net, 'dev_a', 'dev_a');
  const b = ledgerPc(net, 'dev_b', 'dev_a');
  link(a, b);
  for (let index = 0; index < 120; index++) {
    journal(a, `run_${index}`, `ri_${index}`, 40_000);
    row(a, 'tool', { ref: `item:ri_${index}`, runId: `run_${index}` });
  }
  assert.equal(await a.ledger.catchUp('dev_b'), true);
  const calls = ledgerCalls(net, 'rows');
  assert.ok(calls.length >= 3, `${calls.length} calls`);
  for (const call of calls) assert.ok(Buffer.byteLength(JSON.stringify(call.params)) <= PAGE_BYTES, 'each page under the limit');
  assert.equal(record(b).length, 120);
  assert.equal(items(b).length, 240, 'every original came along');
});

test('flushLedger: the record of an agent that just left this PC goes to its new PC as it is', async () => {
  const net = new Net();
  const a = ledgerPc(net, 'dev_a', 'dev_a');
  const b = ledgerPc(net, 'dev_b', 'dev_a');
  link(a, b);
  row(a, 'message', { ref: 'msg:msg_1' });
  await a.ledger.catchUp('dev_b');
  row(a, 'assistant');
  for (const pc of [a, b]) homeOf(pc, 'dev_b'); // she moved to B
  await flushLedger(a.h.services, MARA);
  assert.deepEqual(record(b).map((item) => [item.item_id, item.pc]), [['m1', 'dev_a'], ['a1', 'dev_a']], 'ids kept, no branch');
  assert.equal(ledgerCalls(net, 'branch').length, 0);
  row(b, 'reasoning');
  await b.ledger.catchUp('dev_a');
  assert.deepEqual(record(a).map((item) => [item.item_id, item.pc]), [['m1', null], ['a1', null], ['r2', 'dev_b']], 'B writes on; A mirrors');
});

test('fetchOriginals: the run items of kept and condensed rows missing here come from my other PC', async () => {
  const net = new Net();
  const a = ledgerPc(net, 'dev_a', 'dev_a');
  const b = ledgerPc(net, 'dev_b', 'dev_a');
  link(a, b);
  journal(a, 'run_1', 'ri_kept');
  journal(a, 'run_1', 'ri_hidden');
  row(a, 'tool', { ref: 'item:ri_kept', runId: 'run_1' });
  row(a, 'tool', { ref: 'item:ri_hidden', runId: 'run_1', state: 'hidden' });
  await a.ledger.catchUp('dev_b');
  b.h.db.run('DELETE FROM run_items');
  for (const pc of [a, b]) homeOf(pc, 'dev_b');
  await fetchOriginals(b.h.services, MARA);
  assert.deepEqual(items(b), ['ri_kept', 'ri_kept_call'], 'the kept row\'s original and its call; the hidden one stays where it is');
});

test('the link-up sends the record right after the rows and before the waiting wakes; a record left owed keeps the rows\' cursor moving', async () => {
  const steps: string[] = [];
  const cursors = new Map<string, number>();
  const step = (name: string, done = true) => async () => { steps.push(name); return done; };
  const parts: LinkUpParts = {
    tabs: { catchUp: step('tabs') },
    rows: { catchUp: step('rows'), resume: () => { steps.push('wakes'); } },
    ledger: { catchUp: step('ledger', false) },
    secrets: { catchUp: step('secrets') },
    logins: { catchUp: step('logins') },
    files: { catchUp: step('files') },
  };
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  linkUps({ clock: new ManualClock(5), log }, { pair: () => '', cursor: (peer) => cursors.get(peer), setCursor: (peer, at) => { cursors.set(peer, at); } }, parts, () => true)('dev_b');
  await settle();
  assert.deepEqual(steps, ['tabs', 'rows', 'ledger', 'secrets', 'logins', 'wakes', 'files']);
  assert.equal(cursors.get('dev_b'), 5, 'the record has its own cursor');
});
