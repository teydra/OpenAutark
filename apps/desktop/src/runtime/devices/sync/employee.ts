// What an employee's PC and the CEO's PC say to each other beyond the person's scope (tables.ts `employee`).
// Ids: the CEO's PC speaks to that PC in the person's terms, like the person's phone (people/perspective.ts):
// there 'human' is the person and the CEO is 'owner'; a task of the person has no assignee id there (it is
// "mine"). What comes back is mapped to this PC's ids before anything is checked. A message's secret handles
// (meta.secrets) belong to the owner's vault and are dropped in both directions, as in people/perspective.ts.
// Back: the employee's PC sends only what its person did in what came from that PC – their own lines in those
// chats and their changes of the tasks assigned to them (origin marks, kv ns 'sync.origin'). The CEO's PC takes
// only those rows, checked on its own data like a line from the person's phone (a finished text line of theirs, a
// chat they are in that is not archived, an edit only of their own text line; the task assigned to the person
// here and in the row); anything else is left out quietly, so nothing answers it and nothing repeats.
// Konrad 26.11.2026 (company move, point 2): an agent the company moved to that PC runs there with its setup (SETUP goes
// along for it alone), and its finished text lines in the company's chats come back like the person's – the CEO's PC takes
// them only from the PC its row names. A CEO's PC of an older release strips the setup and drops such lines quietly.
// 21.11.2026 (owner: "natürlich sieht man alle anderen Agenten"): every agent of the company reaches that PC without its
// setup, and a chat the person starts there with company agents goes to the company once (startedWith), so those agents
// answer it; then it is the company's like one that came from it.
// B-078 (D20): on a PC that is only the person's seat there (seatAt), their own open to-dos ("Only me" ones too – it hides nothing) travel to
// the company too, as tasks assigned to them there,
// and a status change of their task runs the task service's path on the CEO's PC (heldStatus, moveStatus), as from
// their phone: the follow-ups and wakes happen there.
// Owns: the id mapping on this link, the way back and its checks. Never: writes synced rows or sends.

import { HUMAN_ID } from '../../../shared/ids.ts';
import { OWNER_ALIAS } from '../../../shared/model/people.ts';
import type { RuntimeServices } from '../../contracts.ts';
import type { Db } from '../../db/database.ts';
import { membership } from '../../people/access.ts';
import { realId, viewId } from '../../people/perspective.ts';
import { KvRepo } from '../../store/kv.ts';
import { DevicesRepo } from '../repo.ts';
import type { Wire } from './tables.ts';

/** A row as it travels (rows.ts Item). */
interface Unit { t: string; id: string; row?: Wire; gone?: true }

const ORIGIN = 'sync.origin';
/** The person's own to-dos that went to their company once (task key → that PC). */
const OWN = 'sync.own';
/** Per employer link: whether this PC is only the person's seat there (seatAt). */
const SEAT = 'sync.seat';
/** Columns that hold a member id, per table. */
const IDS: Readonly<Record<string, readonly string[]>> = {
  conversations: ['created_by'],
  messages: ['author_id'],
  tasks: ['created_by', 'assigned_by'],
  agents: ['created_by', 'person_manager_id'], // 21.11.2026: on the person's PC their own personal manager is theirs ('human')
};

/**
 * 21.11.2026: what an agent runs with – it stays on the company's PCs; the person's PC only names the agent. Konrad
 * 26.11.2026 (company move, point 2): an agent the company moved to that very PC (its row names it) takes it along.
 */
const SETUP = ['instructions', 'model_policy', 'permissions', 'budget'];

/** A JSON column with `change` applied; the same text when nothing changed. */
function mapJson(value: unknown, change: (parsed: unknown) => unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    const next = change(parsed);
    return JSON.stringify(next) === JSON.stringify(parsed) ? value : JSON.stringify(next);
  } catch { return value; }
}

/** The unit in the person's terms (`toPerson`, on the way to their PC `peer`) or back in this PC's terms. */
export function asPerson<T extends Unit>(item: T, personId: string, toPerson: boolean, peer?: string): T {
  if (!item.row) return item;
  const map = (id: unknown) => (typeof id !== 'string' ? id : toPerson ? viewId(personId, id) : realId(personId, id));
  const row: Wire = { ...item.row };
  for (const column of IDS[item.t] ?? []) if (column in row) row[column] = map(row[column]);
  if (item.t === 'conversations') {
    // The owner's read cursor (B-078) is for my own devices only.
    if (Array.isArray(row.members)) row.members = (row.members as Wire[]).map(({ read_id: _read, ...member }) => ({ ...member, member_id: map(member.member_id) }));
    row.settings = mapJson(row.settings, (settings) => {
      const pair = (settings as { directPair?: unknown } | null)?.directPair;
      return Array.isArray(pair) ? { ...(settings as object), directPair: pair.map(map) } : settings;
    });
  }
  if (item.t === 'agents' && toPerson && !(peer && row.device_id === peer)) for (const column of SETUP) delete row[column];
  if (item.t === 'messages') {
    row.mentions = mapJson(row.mentions, (list) => (Array.isArray(list) ? list.map(map) : list));
    row.meta = mapJson(row.meta, (meta) => {
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return meta;
      const { secrets: _secrets, ...rest } = meta as Record<string, unknown>;
      return rest;
    });
  }
  if (item.t === 'tasks') {
    // A human task without an id is the owner's: on the person's PC the person's own, here the CEO's.
    if (row.assignee_kind === 'human') {
      const id = row.assignee_id ?? null;
      row.assignee_id = toPerson ? (id === personId ? null : id === null || id === HUMAN_ID ? OWNER_ALIAS : id)
        : id === null || id === HUMAN_ID ? personId : id === OWNER_ALIAS ? null : id;
    }
    row.waiting_on = mapJson(row.waiting_on, (waiting) => {
      const on = waiting as { id?: unknown } | null;
      return on && typeof on.id === 'string' ? { ...on, id: map(on.id) } : waiting;
    });
  }
  return { ...item, row };
}

/** On an employee's PC: a chat, task or (21.11.2026) agent that came from `peer` (marked when it arrives, unmarked when it goes). */
export function markOrigin(db: Db, item: Unit, peer: string, now: number): void {
  if (item.t !== 'conversations' && item.t !== 'tasks' && item.t !== 'agents' && item.t !== 'accounts') return; // 22.11.2026: a plan's too (plan-peers.ts)
  const kv = new KvRepo(db);
  const key = `${item.t}/${item.id}`;
  if (item.gone) kv.delete(ORIGIN, key);
  else if (kv.get<string>(ORIGIN, key) !== peer) kv.set(ORIGIN, key, peer, now);
}

const cameFrom = (db: Db, key: string) => new KvRepo(db).get<string>(ORIGIN, key);

/** 22.11.2026: the PC of the company a plan here came from (on an employee's PC and their other PCs); undefined for a plan of this company's own. */
export function planFrom(db: Db, accountId: string): string | undefined {
  try { return cameFrom(db, `accounts/${accountId}`); } catch { return undefined; }
}

/** A plan row on its way to my own PCs with the company it came from (as when it goes on live), so they share it the same way (plan-peers.ts). */
export function withPlanOrigin<T extends Unit>(db: Db, item: T): T {
  const company = item.t === 'accounts' && item.row ? planFrom(db, item.id) : undefined;
  return company ? { ...item, origin: company } : item;
}

/**
 * 21.11.2026: on an employee's PC (and their other PCs), an agent of the company they work for: it came from there. It
 * runs only on the company's PCs – never here, and a wake for it here is void (the company delivers the person's line).
 */
export function fromEmployer(db: Db, agentId: string): boolean {
  try { return cameFrom(db, `agents/${agentId}`) !== undefined; } catch { return false; }
}

/** A to-do of the person's own on their PC that their company sees too: open (an "Only me" one too). */
const ownOpen = (row: Wire) => !['done', 'dropped', 'cancelled'].includes(String(row.status));

/**
 * Whether this PC's company is only the person's seat at `peer` (started for it, "+" › Join a company as employee): no
 * agent and no task here is older than that link. A company that held the person's own life or business before it
 * joined keeps its own to-dos to itself. Decided once per link (kv ns 'sync.seat').
 */
export function seatAt(db: Db, peer: string, now = Date.now()): boolean {
  const kv = new KvRepo(db);
  const known = kv.get<boolean>(SEAT, peer);
  if (typeof known === 'boolean') return known;
  const pairedAt = new DevicesRepo(db).get(peer)?.pairedAt;
  if (!pairedAt) return false;
  const older = db.get(`SELECT 1 AS hit FROM agents WHERE created_at < ? UNION ALL SELECT 1 AS hit FROM tasks WHERE created_at < ? LIMIT 1`, [pairedAt, pairedAt]);
  const seat = older === undefined;
  kv.set(SEAT, peer, seat, now);
  return seat;
}

/** On an employee's seat PC: the person's own open to-dos (assigned to them, "Only me" ones too), for the first link-up. */
export function ownTodos(db: Db, peer: string): string[] {
  if (!seatAt(db, peer)) return [];
  return db.all<{ id: string }>("SELECT id FROM tasks WHERE assignee_kind = 'human' AND assignee_id IS NULL AND status NOT IN ('done', 'dropped', 'cancelled')").map((row) => String(row.id));
}

/**
 * On an employee's PC: whether a changed row goes back to `peer` – this person's own line in a chat from there, their
 * change of a task from there that is theirs, or (D20, seat PCs only) a to-do of their own, open ("Only me" too): once
 * it went there, its later changes (done) follow it.
 */
export function goesBack(item: Unit, peer: string, db: Db, now = Date.now()): boolean {
  const row = item.row;
  if (!row || item.gone) return false;
  if (item.t === 'messages') {
    const chat = String(row.conversation_id);
    if (cameFrom(db, `conversations/${chat}`) !== peer) return false;
    if (row.author_kind === 'human') return row.author_id === HUMAN_ID && Boolean(membership(db, HUMAN_ID, chat));
    // Konrad 26.11.2026 (company move, point 2): the finished lines of a company agent the company moved here go back too.
    const author = String(row.author_id);
    return row.author_kind === 'agent' && row.kind === 'text' && row.state === 'final' && Boolean(membership(db, author, chat))
      && fromEmployer(db, author) && Boolean(db.get('SELECT 1 FROM agents WHERE id = ? AND device_id IS NULL AND archived_at IS NULL', [author]));
  }
  if (item.t === 'conversations') {
    // 21.11.2026: a chat the person started here with agents of that company goes there once (its agents answer there);
    // from then on it is that company's like one that came from it – its lines go back, its later changes stay here.
    if (cameFrom(db, `conversations/${item.id}`) !== undefined || !startedWith(row, HUMAN_ID, (id) => companyAgent(db, id))) return false;
    new KvRepo(db).set(ORIGIN, `conversations/${item.id}`, peer, now);
    return true;
  }
  if (item.t !== 'tasks' || row.assignee_kind !== 'human' || (row.assignee_id ?? null) !== null) return false;
  const origin = cameFrom(db, `tasks/${item.id}`);
  if (origin) return origin === peer;
  // Their own to-do (only from a seat PC): open, or done after it went there once.
  if (!seatAt(db, peer, now)) return false;
  const kv = new KvRepo(db);
  const sent = kv.get<string>(OWN, `tasks/${item.id}`);
  if (sent !== peer && !ownOpen(row)) return false;
  if (sent !== peer) kv.set(OWN, `tasks/${item.id}`, peer, now);
  return true;
}

/** 21.11.2026: on an employee's PC, an active agent of the company (fromEmployer). */
function companyAgent(db: Db, agentId: string): boolean {
  return fromEmployer(db, agentId) && Boolean(db.get('SELECT 1 FROM agents WHERE id = ? AND archived_at IS NULL', [agentId]));
}

/**
 * 21.11.2026: a chat `person` started with agents only (`isAgent` true for each): made by them, they the only human in it,
 * at least one agent, nobody left.
 */
function startedWith(row: Wire, person: string, isAgent: (id: string) => boolean): boolean {
  const members = Array.isArray(row.members) ? (row.members as Wire[]) : [];
  if (row.created_by !== person || row.archived_at || !members.some((member) => member.kind === 'agent')) return false;
  return members.every((member) => member.left_at == null && (member.kind === 'agent' ? isAgent(String(member.member_id)) : member.member_id === person));
}

/** On the CEO's PC: tables an employee's PC gets whole once, though its link has a cursor (21.11.2026: agents went to none before). */
const ONCE = 'sync.once';
const WHOLE_ONCE: ReadonlySet<string> = new Set(['agents', 'accounts']); // 22.11.2026: plans went to none before (plan-peers.ts)

/** Whether `peer` (an employee's PC) still is owed every row of `table` once. */
export function owedOnce(db: Db, peer: string, table: string): boolean {
  return WHOLE_ONCE.has(table) && new KvRepo(db).get<boolean>(ONCE, `${peer}/${table}`) === undefined;
}

/** Every row of `table` reached `peer`. */
export function paidOnce(db: Db, peer: string, table: string, now: number): void {
  new KvRepo(db).set(ONCE, `${peer}/${table}`, true, now);
}

/** A person's task status that changed on their PC: written through the task service here (moveStatus), not as a row. */
export interface StatusMove { id: string; status: string; result?: unknown }

/** On the CEO's PC: the task statuses that reached each person's PC (task status by `<peer>/<task id>`). */
const SENT = 'sync.sent';

/** On the CEO's PC: rows that reached the PC of a person (`peer`): the status of each task is remembered. */
export function noteSent(db: Db, peer: string, items: readonly Unit[], now: number): void {
  const kv = new KvRepo(db);
  for (const item of items) {
    if (item.t !== 'tasks' || !item.row) continue;
    const key = `${peer}/${item.id}`;
    if (kv.get<string>(SENT, key) !== String(item.row.status)) kv.set(SENT, key, String(item.row.status), now);
  }
}

/**
 * On the CEO's PC: a person's task row from `peer` keeps the status here. Only a status the person set – one that
 * differs from the last status that reached their PC (without a record: from the one here) – goes to `moves`; a row
 * that carries an old status (an offline edit of the title) changes no status.
 */
export function heldStatus<T extends Unit>(db: Db, item: T, moves: StatusMove[], peer: string): T {
  if (item.t !== 'tasks' || !item.row) return item;
  const here = db.get<Wire>('SELECT status, completed_at, result, waiting_on FROM tasks WHERE id = ?', [item.id]);
  if (!here || here.status === item.row.status) return item;
  const sent = new KvRepo(db).get<string>(SENT, `${peer}/${item.id}`);
  if (String(item.row.status) !== (sent ?? String(here.status))) {
    let result: unknown;
    try { result = typeof item.row.result === 'string' ? JSON.parse(item.row.result) : undefined; } catch { result = undefined; }
    moves.push({ id: item.id, status: String(item.row.status), result });
  }
  return { ...item, row: { ...item.row, status: here.status, completed_at: here.completed_at, result: here.result, waiting_on: here.waiting_on } };
}

/** Runs a held status change as the person (their phone's path: the follow-ups, the creator's wake). */
export function moveStatus(s: Pick<RuntimeServices, 'tasks' | 'log'>, move: StatusMove, personId: string): void {
  try {
    if (move.status === 'done') {
      const summary = (move.result as { summary?: unknown } | undefined)?.summary;
      s.tasks.finish(move.id, { status: 'done', summary: typeof summary === 'string' && summary.trim() ? summary : 'Done' }, personId);
    } else if (move.status === 'dropped' || move.status === 'cancelled') {
      const summary = (move.result as { summary?: unknown } | undefined)?.summary;
      s.tasks.finish(move.id, { status: 'dropped', summary: typeof summary === 'string' && summary.trim() ? summary : 'Dropped' }, personId);
    } else if (move.status === 'open') {
      s.tasks.update(move.id, { status: 'open' }, personId);
    }
  } catch (error) {
    s.log.warn('synced task status not applied', { taskId: move.id, error: String((error as Error)?.message ?? error) });
  }
}

/**
 * On the CEO's PC: whether a row from the PC of `personId` (`from`; already in this PC's ids) is that person's to change –
 * or (Konrad 26.11.2026, company move point 2) a finished line of an agent of this company that runs on that very PC.
 */
export function takenFrom(item: Unit, personId: string, db: Db, from?: string): boolean {
  const row = item.row;
  if (!row || item.gone) return false;
  if (item.t === 'conversations') {
    // 21.11.2026: a new chat they started on their PC with agents of this company (active ones); a change of one stays there.
    return !db.get('SELECT 1 FROM conversations WHERE id = ?', [item.id]) && startedWith(row, personId, (id) => Boolean(db.get('SELECT 1 FROM agents WHERE id = ? AND archived_at IS NULL', [id])));
  }
  if (item.t === 'messages') {
    const chat = String(row.conversation_id);
    const here = db.get<{ author_id: string; conversation_id: string; kind: string }>('SELECT author_id, conversation_id, kind FROM messages WHERE id = ?', [item.id]);
    const author = String(row.author_id);
    const theirs = row.author_kind === 'human' ? author === personId
      : row.author_kind === 'agent' && from !== undefined && Boolean(db.get('SELECT 1 FROM agents WHERE id = ? AND device_id = ? AND archived_at IS NULL', [author, from]));
    return theirs && row.kind === 'text' && row.state === 'final'
      && Boolean(membership(db, author, chat)) && !db.get('SELECT 1 FROM conversations WHERE id = ? AND archived_at IS NOT NULL', [chat])
      && (!here || (here.author_id === author && here.conversation_id === chat && here.kind === 'text'));
  }
  // A task stays theirs on both sides; an update never moves its chat, parent or maker (TaskRepo.save). A new one is a
  // to-do of their own, open ("Only me" too, D20) – whoever made it on their PC (mostly an agent there, theirMaker).
  const theirs = (task: Wire | undefined) => task?.assignee_kind === 'human' && task.assignee_id === personId;
  if (item.t !== 'tasks' || !theirs(row)) return false;
  const here = db.get<Wire>('SELECT assignee_kind, assignee_id FROM tasks WHERE id = ?', [item.id]);
  return here ? theirs(here) : ownOpen(row);
}

/**
 * On the CEO's PC: a new to-do from the person's PC whose maker this PC does not know (an agent of their PC) is theirs
 * here – the person stands in as its maker, so its follow-ups and wakes reach someone who is here.
 */
export function theirMaker<T extends Unit>(db: Db, item: T, personId: string): T {
  if (item.t !== 'tasks' || !item.row || db.get('SELECT 1 FROM tasks WHERE id = ?', [item.id])) return item;
  const known = (id: string) => id === HUMAN_ID || id === personId || Boolean(db.get('SELECT 1 FROM agents WHERE id = ?', [id]) ?? db.get('SELECT 1 FROM people WHERE id = ?', [id]));
  const row: Wire = { ...item.row };
  for (const column of ['created_by', 'assigned_by']) if (typeof row[column] === 'string' && !known(row[column] as string)) row[column] = personId;
  return { ...item, row };
}
