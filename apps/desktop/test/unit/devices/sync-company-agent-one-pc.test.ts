// Konrad 24.11.2026 (ORENDA, #854 point 1): a company agent may run on an employee's PC, but on one PC at a time – the
// PC that takes it holds it, the other gives it up. Two simulated PCs: the company's (CEO) PC and Lena's (employee) PC.
// Before: an agent moved to Lena's PC ran there (her PC stores its own id as NULL, "here") and on the company PC too
// (a home on an employee's link counted as "runs here"). Now: only one, and a move there and back hands it over.
// Owns: these assertions only. Never: a real mesh or engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { AgentRepo } from '../../../src/runtime/store/agents.ts';
import { firesHere, homeElsewhere } from '../../../src/runtime/devices/sync/home.ts';
import { startMoves } from '../../../src/runtime/agents/move.ts';
import { takeRepairNotes } from '../../../src/runtime/agents/turn-finish.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import { link, makePc, Net, settle, type Pc } from './sync-net.ts';

const LENA = 'per_lena000001';
const MIRA = 'ag_mira';

/** The PC's org reads the agents table, as the real one does (a synced row changes what it says). */
function dbOrg(pc: Pc): void {
  const repo = new AgentRepo(pc.h.db);
  Object.assign(pc.h.org, {
    get: (id: string) => repo.get(id),
    require: (id: string) => { const found = repo.get(id); if (!found) throw new Error(`missing ${id}`); return found; },
    list: () => repo.list(),
    add: (one: Agent) => { repo.save(one); return one; },
  });
}

/** The company's PC dev_a with Mira (home `deviceId`, none: dev_a itself) and Lena's PC dev_e joined as her employee PC. */
async function company(deviceId?: string) {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const e = makePc(net, 'dev_e');
  dbOrg(a);
  dbOrg(e);
  a.h.db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES (?, 'Lena', 'active', 0, 0)`, [LENA]);
  a.h.org.add(agent(MIRA, 'Mira', { instructions: 'Private setup of the company.', createdAt: a.h.clock.now() - 20_000, ...(deviceId ? { deviceId } : {}) }));
  link(a, e, LENA);
  assert.ok(await a.sync.catchUp('dev_e', undefined));
  await settle();
  return { net, a, e };
}

const runsOn = (pc: Pc) => !homeElsewhere(pc.h.services, MIRA);
const deviceRow = (pc: Pc) => pc.h.db.get<{ device_id: string | null }>('SELECT device_id FROM agents WHERE id = ?', [MIRA])?.device_id;

/** The company PC changes Mira's PC (agents.update device or the app): her row changes and goes out. */
async function moveTo(a: Pc, deviceId: string | undefined): Promise<void> {
  const { deviceId: _old, ...rest } = a.h.org.require(MIRA) as Agent;
  const next = { ...rest, ...(deviceId ? { deviceId } : {}), updatedAt: a.h.clock.now() + 1 } as Agent;
  a.h.org.add(next);
  a.h.bus.emit('agent.upserted', next);
  await settle();
}

test('a company agent on an employee\'s PC runs there only – the company PC does not run it too', async () => {
  const { a, e } = await company('dev_e'); // moved to Lena's PC
  assert.equal(deviceRow(e), null, 'her PC stores its own id as "here"');
  assert.equal(runsOn(e), true, 'it runs on her PC, which took it');
  assert.equal(runsOn(a), false, 'the company PC gave it up (before 24.11.: it ran there too)');
  assert.equal([a, e].filter(runsOn).length, 1, 'one PC at a time');
  assert.equal(firesHere(a.h.services, MIRA), false, 'its schedules do not fire on the company PC either');
});

test('a company agent at home on the company PC runs there only', async () => {
  const { a, e } = await company();
  assert.equal(deviceRow(e), 'dev_a');
  assert.equal(runsOn(a), true);
  assert.equal(runsOn(e), false, 'never on her PC while the company holds it');
});

test('a move to her PC takes the agent there and the company PC gives it up; a move back hands it back', async () => {
  const { a, e } = await company();
  const left: Record<string, string[]> = { dev_a: [], dev_e: [] };
  for (const pc of [a, e]) {
    Object.assign(pc.h.services.dispatcher, { leave: async (id: string) => { left[pc.id]!.push(id); return true; } });
    startMoves(pc.h.services);
  }

  await moveTo(a, 'dev_e');
  assert.equal(deviceRow(e), null, 'the row reached her PC naming it');
  assert.equal(runsOn(e), true, 'her PC holds it now');
  assert.equal(runsOn(a), false, 'the company PC gave it up');
  assert.deepEqual(left.dev_a, [MIRA], 'its work on the company PC stopped');
  const arrival = takeRepairNotes(e.h.services, MIRA, 'main').join('\n');
  assert.match(arrival, /moved from dev_a; my record did not come with me/, 'it reads where it runs, not that a PC went away');

  a.h.services.wakes.wake({ agentId: MIRA, reason: 'message', conversationId: 'cnv_x' });
  a.sync.resume();
  assert.equal(a.h.wakeRows().filter((wake) => wake.agent_id === MIRA).length, 0, 'a wake for it on the company PC is void – no turn there, none piling up');

  await moveTo(a, undefined); // back home
  assert.equal(deviceRow(e), 'dev_a');
  assert.equal(runsOn(a), true, 'the company PC holds it again');
  assert.equal(runsOn(e), false, 'her PC gave it up');
  assert.deepEqual(left.dev_e, [MIRA], 'its work on her PC stopped');
  assert.match(takeRepairNotes(a.h.services, MIRA, 'main').join('\n'), /moved from dev_e; my record did not come with me – what I did on dev_e stays there/);
});
