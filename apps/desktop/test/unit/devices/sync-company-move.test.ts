// Konrad 26.11.2026 (company move, ORENDA #854 point 2): a company agent the company moves to an employee's PC takes along
// what it runs with – its setup (SETUP in its row), its record (ledger.ts) and the plans that PC shares (logins.ts) – and
// what it writes there in the company's chats comes back to the company. Two simulated PCs: the company's (CEO) PC dev_a
// and Lena's PC dev_e. Only for the agent moved there; a company PC or an employee's PC of an older release keeps working
// as before (setup stripped, lines dropped quietly, no record, the move goes on).
// Owns: these assertions only. Never: a real mesh, engine or login file outside a temporary folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agent } from '../chat/harness.ts';
import { AgentRepo } from '../../../src/runtime/store/agents.ts';
import { asPerson, takenFrom } from '../../../src/runtime/devices/sync/employee.ts';
import { homeElsewhere } from '../../../src/runtime/devices/sync/home.ts';
import { LedgerSync } from '../../../src/runtime/devices/sync/ledger.ts';
import { LoginSync, loginsTo } from '../../../src/runtime/devices/sync/logins.ts';
import { isArriving, noteMove, startMoves } from '../../../src/runtime/agents/move.ts';
import { takeRepairNotes } from '../../../src/runtime/agents/turn-finish.ts';
import { loginFiles } from '../../../src/runtime/accounts/cli-homes.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Account } from '../../../src/shared/model/providers.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import { memoryDb, recordingBus, silentLog } from './fakes.ts';
import { record as ledgerRecord, row as ledgerRow } from './sync-ledger-rig.ts';
import { link, makePc, Net, record, settle, type Pc } from './sync-net.ts';

const LENA = 'per_lena000001';
const MIRA = 'ag_mira'; // moves to Lena's PC
const TOM = 'ag_tom'; // stays on the company PC
const SETUP = 'Private setup of the company.';

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

type MovePc = Pc & { ledger: LedgerSync };

/** A PC with the record sync and the moves on its mesh (`old`: an older release – no record sync, no hand-over for this link). */
function pcOf(net: Net, id: string, old = false): MovePc {
  const pc = makePc(net, id);
  dbOrg(pc);
  const ledger = new LedgerSync(pc.h.services, noteMove);
  const refuse = async () => { throw new WorkforceError('forbidden', 'This link does not run that method on this PC.'); }; // an older mesh: method for 'ceo' links only
  pc.handlers.set('sync.ledger', old ? refuse : (params, from) => ledger.receive(params, from));
  Object.assign(pc.h.services.dispatcher, { leave: async () => true });
  startMoves(pc.h.services, { mesh: { register: (method, handler) => { pc.handlers.set(method, old ? refuse : (params, from) => handler(params, from, new AbortController().signal)); } } });
  return Object.assign(pc, { ledger });
}

/** The company PC with Mira and Tom, their records, and Lena's PC joined as her employee PC; both linked and caught up. */
async function company(options: { oldCompany?: boolean; oldEmployee?: boolean } = {}) {
  const net = new Net();
  const a = pcOf(net, 'dev_a', options.oldCompany);
  const e = pcOf(net, 'dev_e', options.oldEmployee);
  a.h.db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES (?, 'Lena', 'active', 0, 0)`, [LENA]);
  const at = a.h.clock.now() - 20_000;
  for (const one of [agent(MIRA, 'Mira', { instructions: SETUP, modelPolicy: { pin: 'gpt-company' }, createdAt: at }), agent(TOM, 'Tom', { instructions: 'Tom\'s own setup.', createdAt: at })]) {
    a.h.org.add(one);
    a.h.bus.emit('agent.upserted', one); // hired: the moves know where it runs
  }
  ledgerRow(a, 'message', { agentId: MIRA, ref: 'msg:msg_m1', title: 'Mira one' });
  ledgerRow(a, 'message', { agentId: MIRA, ref: 'msg:msg_m2', title: 'Mira two' });
  ledgerRow(a, 'message', { agentId: TOM, ref: 'msg:msg_t1', title: 'Tom one' });
  link(a, e, LENA);
  assert.ok(await a.sync.catchUp('dev_e', undefined));
  await settle();
  return { net, a, e };
}

const agentRow = (pc: Pc, id: string) => pc.h.db.get<{ instructions: string; model_policy: string; device_id: string | null }>(
  'SELECT instructions, model_policy, device_id FROM agents WHERE id = ?', [id]);

/** Waits until `check` holds (a move's leave, hand-over and record go in steps), at most 2 s. */
async function until(check: () => boolean): Promise<void> {
  for (const end = Date.now() + 2_000; !check() && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** The company PC moves Mira to Lena's PC (agents.update device or the app); returns when her PC holds her. */
async function moveMira(a: Pc, e: Pc): Promise<string> {
  const next = { ...a.h.org.require(MIRA), deviceId: 'dev_e', updatedAt: a.h.clock.now() + 1 } as Agent;
  a.h.org.add(next);
  a.h.bus.emit('agent.upserted', next);
  const arrived = () => Boolean(new KvRepo(e.h.db).get<{ arrival?: string }>('move.note', MIRA)?.arrival); // its arrival line, unread
  await until(() => !homeElsewhere(e.h.services, MIRA) && !isArriving(e.h.services, MIRA) && arrived());
  await settle();
  return takeRepairNotes(e.h.services, MIRA, 'main').join('\n');
}

test('setup: an agent moved to her PC takes its SYSTEM.md and model choice along; every other company agent arrives there without', async () => {
  const { a, e } = await company();
  assert.equal(agentRow(e, MIRA)?.instructions, '', 'before the move: only its name is there');
  await moveMira(a, e);
  assert.equal(agentRow(e, MIRA)?.device_id, null, 'it runs on her PC');
  assert.equal(agentRow(e, MIRA)?.instructions, SETUP, 'its SYSTEM.md came along');
  assert.match(String(agentRow(e, MIRA)?.model_policy), /gpt-company/, 'its model choice came along');
  assert.equal(agentRow(e, TOM)?.instructions, '', 'Tom stays on the company PC: his setup stays there');
  assert.equal(homeElsewhere(a.h.services, MIRA), 'dev_e', 'the company PC gave her up (point 1)');
});

test('record: the moved agent\'s record goes to her PC before its first turn there, no other agent\'s; her PC takes only the company\'s agents', async () => {
  const { net, a, e } = await company();
  const note = await moveMira(a, e);
  assert.deepEqual(ledgerRecord(e, 'main', MIRA).map((item) => item.title), ['Mira one', 'Mira two'], 'her record is on Lena\'s PC');
  assert.ok(ledgerRecord(e, 'main', MIRA).every((item) => item.pc === 'dev_a'), 'written as the company PC wrote it');
  assert.deepEqual(ledgerRecord(e, 'main', TOM), [], 'Tom\'s record never goes there');
  assert.match(note, /moved from dev_a; my record came with me/, 'she reads that her record came');
  const sent = net.calls.filter((call) => call.method === 'sync.ledger' && call.to === 'dev_e');
  assert.ok(sent.length > 0 && sent.every((call) => ((call.params as { rows?: Array<{ agent_id: string }> }).rows ?? []).every((one) => one.agent_id === MIRA)));

  // From the employer: only op 'rows', only rows of the company's own agents.
  const page = sent[0].params as { rows: Array<Record<string, unknown>> };
  e.h.org.add(agent('ag_own', 'Own'));
  await e.ledger.receive({ op: 'rows', rows: page.rows.map((one) => ({ ...one, agent_id: 'ag_own' })) }, 'dev_a');
  assert.deepEqual(ledgerRecord(e, 'main', 'ag_own'), [], 'a row for her own agent from the company is left out');
  await assert.rejects(e.ledger.receive({ op: 'fetch', agentId: MIRA, ids: [] }, 'dev_a'), /takes no record/);
  await assert.rejects(a.ledger.receive({ op: 'rows', rows: [] }, 'dev_e'), /takes no record/, 'nothing comes back from her PC');

  // A later link-up sends nothing again (each agent from where it last went).
  const before = net.calls.length;
  await a.ledger.catchUp('dev_e');
  assert.equal(net.calls.slice(before).filter((call) => call.method === 'sync.ledger').length, 0);
});

test('lines back: what the moved agent writes in a company chat on her PC reaches the company and is delivered there', async () => {
  const { a, e } = await company();
  await moveMira(a, e);
  const chat = a.h.chats.create({ agentIds: [MIRA, TOM], people: [LENA], createdBy: 'human' });
  await settle();
  assert.ok(e.h.chats.get(chat.id), 'the company chat is on her PC');
  const delivered: string[] = [];
  const onMessage = a.h.services.delivery.onMessage.bind(a.h.services.delivery);
  a.h.services.delivery.onMessage = (message) => { delivered.push(message.body); return onMessage(message); };

  const line = e.h.chats.send({ conversationId: chat.id, authorId: MIRA, body: 'Erledigt, Lena.' });
  e.h.chats.send({ conversationId: chat.id, authorId: 'human', body: 'Danke!' });
  await settle();
  assert.equal(a.h.chats.message(line.id)?.body, 'Erledigt, Lena.', 'her line arrived at the company');
  assert.deepEqual(delivered, ['Erledigt, Lena.', 'Danke!'], 'delivered there, the person\'s line as before');

  // Tom does not run on her PC: a line of his written there stays there, and the company takes none from her PC.
  const tom = e.h.chats.send({ conversationId: chat.id, authorId: TOM, body: 'Not from here.' });
  await settle();
  assert.equal(a.h.chats.message(tom.id), undefined, 'her PC never sends it');
  const forged = { t: 'messages', id: tom.id, at: Date.now(), row: { ...e.h.db.get<Record<string, unknown>>('SELECT * FROM messages WHERE id = ?', [tom.id]) } };
  await a.sync.receive({ items: [forged] }, 'dev_e');
  assert.equal(a.h.chats.message(tom.id), undefined, 'the company takes an agent\'s line only from the PC its row names');
});

test('an older company PC: the setup stays stripped and an agent\'s line from her PC is dropped quietly', () => {
  const row = { id: MIRA, device_id: 'dev_e', instructions: SETUP, model_policy: '{}', permissions: '{}', budget: '{}', created_by: 'human' };
  const old = asPerson({ t: 'agents', id: MIRA, row }, LENA, true); // an older release does not pass the PC
  assert.equal(old.row?.instructions, undefined, 'as before 26.11.: no setup to her PC');
  assert.equal(asPerson({ t: 'agents', id: MIRA, row }, LENA, true, 'dev_x').row?.instructions, undefined, 'never to a PC it was not moved to');
  assert.equal(asPerson({ t: 'agents', id: MIRA, row }, LENA, true, 'dev_e').row?.instructions, SETUP);

  const db = memoryDb();
  db.run(`INSERT INTO conversations (id, title, created_by, created_at, updated_at) VALUES ('cnv_1', 'x', 'human', 0, 0)`);
  db.run(`INSERT INTO members (conversation_id, member_id, kind, role, joined_at) VALUES ('cnv_1', ?, 'agent', 'member', 0)`, [MIRA]);
  new AgentRepo(db).save(agent(MIRA, 'Mira', { deviceId: 'dev_e' }));
  const line = { t: 'messages', id: 'msg_1', row: { id: 'msg_1', conversation_id: 'cnv_1', author_kind: 'agent', author_id: MIRA, kind: 'text', state: 'final' } };
  assert.equal(takenFrom(line, LENA, db), false, 'an older release never takes an agent\'s line');
  assert.equal(takenFrom(line, LENA, db, 'dev_e'), true);
  assert.equal(takenFrom(line, LENA, db, 'dev_other'), false);
  assert.equal(takenFrom({ ...line, row: { ...line.row, state: 'streaming' } }, LENA, db, 'dev_e'), false, 'only a finished line');
});

test('an older company PC: the agent still moves to her PC and goes on there, its arrival line says the record did not come', async () => {
  const { a, e } = await company({ oldCompany: true });
  const note = await moveMira(a, e);
  assert.equal(homeElsewhere(e.h.services, MIRA), undefined, 'it runs on her PC');
  assert.equal(isArriving(e.h.services, MIRA), false, 'not left waiting for a hand-over');
  assert.match(note, /my record did not come with me/);
});

test('an older employee\'s PC: the move goes on, the company PC keeps working, nothing is owed in a loop', async () => {
  const { net, a, e } = await company({ oldEmployee: true });
  const next = { ...a.h.org.require(MIRA), deviceId: 'dev_e', updatedAt: a.h.clock.now() + 1 } as Agent;
  a.h.org.add(next);
  a.h.bus.emit('agent.upserted', next);
  await until(() => net.calls.some((call) => call.method === 'sync.ledger' && call.to === 'dev_e'));
  await settle();
  assert.equal(homeElsewhere(a.h.services, MIRA), 'dev_e', 'the company PC gave her up');
  assert.equal(await a.ledger.catchUp('dev_e'), false, 'that PC takes no record: said, not thrown');
  const calls = net.calls.length;
  a.ledger.tick();
  await settle();
  assert.equal(net.calls.slice(calls).length, 0, 'no live pushes to an employee\'s PC');
  assert.equal(agentRow(e, MIRA)?.instructions, SETUP, 'an older employee\'s PC takes the setup like any column');
});

test('login: a plan the company shares goes to her PC when an agent moves there – also after that PC refused it before', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'company-move-'));
  const db = memoryDb();
  const repo = new DevicesRepo(db);
  repo.upsert(record('dev_a', { self: true }));
  repo.upsert(record('dev_e', { personId: LENA }));
  repo.upsert(record('dev_b'));
  const home = path.join(root, 'accounts', 'codex', 'acc_codex');
  await mkdir(home, { recursive: true });
  const at = new Date().toISOString();
  await writeFile(path.join(home, loginFiles('codex', 'win32')[0]), JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: 'id', access_token: 'a', refresh_token: 'r1', account_id: 'org-1' }, last_refresh: at }));
  const plan: Account = { id: 'acc_codex', provider: 'codex', label: 'Codex', auth: 'cli', state: 'ok', priority: 0, enabled: true, detected: false, createdAt: 0, home };
  let refuse = true;
  const sent: string[] = [];
  const s = {
    db, bus: recordingBus().bus, log: silentLog, paths: { accounts: path.join(root, 'accounts') },
    accounts: { list: () => [plan], get: (id: string) => (id === plan.id ? plan : undefined) },
    devices: {
      online: () => true,
      call: async (peer: string, _method: string, params: unknown) => {
        sent.push(`${peer}:${((params as { logins: Array<{ account: string }> }).logins).map((login) => login.account).join(',')}`);
        if (refuse && peer === 'dev_e') throw new WorkforceError('forbidden', 'Logins come only from this company\'s PCs.');
        return { ok: true, applied: 1 };
      },
    },
  } as unknown as RuntimeServices;
  const sync = new LoginSync(s, { platform: 'win32', env: {}, homeDir: path.join(root, 'user') });
  await sync.catchUp('dev_e');
  await sync.catchUp('dev_e', true);
  assert.deepEqual(sent, ['dev_e:acc_codex'], 'refused once, then held (login-refusals.ts)');
  refuse = false;
  await loginsTo(s, 'dev_e');
  assert.deepEqual(sent, ['dev_e:acc_codex', 'dev_e:acc_codex'], 'the move is a reason to try again: the plan went');
  await loginsTo(s, 'dev_b');
  assert.equal(sent.length, 2, 'my own PCs get their logins on their own way');
});
