// The agent's record (context_items, §5.5) between the CEO's own PCs (Umzug 21.11.2026: an agent runs on one PC at a
// time, its record goes with it). Mesh method 'sync.ledger', 'ceo' links only, never passed on. The PC an agent runs on
// (home.ts homeElsewhere undefined) writes its record; every other CEO PC keeps a mirror. What goes to a PC: the rows of
// the agents I run whose `changed` (migration 113, from the one-row counter context_seq, so it never goes back) is past
// that PC's cursor (kv 'sync.ledger', the highest it acknowledged; the first time everything), in pages with their
// originals (ledger-wire.ts) – at its link-up (after the rows, before the wakes) and then live, gathered for GATHER_MS,
// one push in flight per PC (a failed one again after RETRY_MS). Besides the cursor, a PC can be owed one agent's rows
// from a point on (kv 'sync.ledger.owed'): its whole record once when I became its writer (becameWriter – a mirror may
// lack rows I held from its old writer; review R1 H4), or the rows that PC refused (M6), which wait there and go again
// after RETRY_MS while the other agents' rows go on. A page that arrives is written with `pc` = its sender; a row that is
// here as it is gets no write, so nothing echoes (H2); a row already here as the same item is updated (marks). A row that
// collides with a different local one is a conflict: where I am the agent's writer, or the sender is not, that agent's
// rows are refused (the sender learns better from the agents row); else my own unacknowledged rows go to the writer
// first as a branch (ledger-branch.ts) and the writer's rows replace mine. Before a push, the Forgets owed to that PC go
// (ledger-forget.ts, H5), then my own unacknowledged rows of an agent that now runs on that PC as a branch; each branch
// names when this PC's record sync first started (kv 'sync.ledger.start'), so the writer appends my rows from before it
// hidden. Op 'fetch' (ledger-fetch.ts): originals of named run items, for a PC that just became an agent's PC
// (fetchOriginals; their blobs through blobs.ts needBlob) or a restore there. Part 2: ops 'busy', 'settled' and 'resettle'
// (ledger-settled.ts) – each PC an agent is at home on knows whether it holds the agent's complete, settled record.
// Konrad 26.11.2026 (company move, point 2): an employee's PC gets the record of an agent this company moved there (its row
// names that PC) and no other – at the move (flushLedger) and at its link-up, from where it last went there (kv
// 'sync.ledger.moved'); that PC takes op 'rows' from its employer only, and only rows of the company's own agents. Nothing
// goes back on that link: what the agent learns there stays there.
// Owns: the cursors and owed rows, the pushes, receiving, flushLedger, becameWriter and fetchOriginals. Never: logs item
// text, sends a hidden row's original, sends an employee's PC another agent's record or passes a page on.

import type { RuntimeServices } from '../../contracts.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { blobIdsOf } from '../../context/ledger/originals.ts';
import { KvRepo } from '../../store/kv.ts';
import { needBlob } from './blobs.ts';
import { DevicesRepo } from '../repo.ts';
import { fromEmployer } from './employee.ts';
import { homeElsewhere, isCeoPc, linkOf, links, onEmployeePc } from './home.ts';
import { appendBranch, branchNote, branchRows, dropSessionsAfterTurn, settleBranch, type Appended, type BranchPage } from './ledger-branch.ts';
import { LEDGER_METHOD, onlinePeers, pullItems, serveFetch } from './ledger-fetch.ts';
import { noMethod } from './no-method.ts';
import { dropForgets, forgetHere, owedForgets } from './ledger-forget.ts';
import { Settled } from './ledger-settled.ts';
import { collisions, originalsIn, pagesOf, putOriginals, putRow, rerouted, SELECT, validRow, type LocalRow } from './ledger-wire.ts';

/** How long live changes gather before a push. */
export const GATHER_MS = 1000;
export const RETRY_MS = 30_000;
const FLUSH_WAIT_MS = 10_000;
const ROWS = 400;
const NS = 'sync.ledger';
const OWED_NS = 'sync.ledger.owed';
/** kv: when this PC's record sync first started – my own rows created before it are my older record (ledger-branch.ts). */
const STARTED_NS = 'sync.ledger.start';
/** kv: per `<employee's PC>/<agent>`, how far the record of an agent moved there went (sendMoved). */
const MOVED_NS = 'sync.ledger.moved';

const errorText = (error: unknown) => String((error as Error)?.message ?? error);
const keys = (value: unknown) => new Set(Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []);
/** The sync of each runtime, by its database (flushLedger finds it there). */
const running = new WeakMap<object, LedgerSync>();

/** The line an agent reads at its next turn (service.ts passes agents/move.ts noteMove; tests record it). */
type Note = (s: RuntimeServices, agentId: string, text: string) => void;

export class LedgerSync {
  private readonly s: RuntimeServices;
  private readonly kv: KvRepo;
  private readonly gatherMs: number;
  private readonly note: Note;
  private readonly pushing = new Map<string, Promise<boolean>>();
  private readonly failed = new Map<string, number>();
  /** Per `peer/agent`: when that PC last refused the agent's rows. */
  private readonly refused = new Map<string, number>();
  /** PCs whose link-up got to the record since their link came up. */
  private readonly ready = new Set<string>();
  private readonly branching = new Map<string, Promise<void>>();
  /** Per `from/agent`: a branch being appended – kept until its last page is in, so a resent page is not counted twice (L2). */
  private readonly appended = new Map<string, Appended>();
  /** When this PC's record sync first started (kv STARTED_NS). */
  private readonly started: number;
  private readonly settled: Settled;

  constructor(s: RuntimeServices, note: Note, gatherMs = GATHER_MS) {
    this.s = s;
    this.kv = new KvRepo(s.db);
    this.note = note;
    this.gatherMs = gatherMs;
    const started = this.kv.get<number>(STARTED_NS, 'at');
    this.started = started ?? s.clock.now();
    if (started === undefined) this.kv.set(STARTED_NS, 'at', this.started, this.started);
    running.set(s.db, this);
    this.settled = new Settled(s, { acked: (peer, agentId) => this.since(peer, agentId), ready: (peer) => this.ready.has(peer) && !this.pushing.has(peer) });
  }

  /** Live pushes while a PC is linked; returns the off switch. */
  attach(): () => void {
    const timer = setInterval(() => this.tick(), this.gatherMs);
    (timer as { unref?: () => void }).unref?.();
    const off = this.s.bus.on('device.upserted', (device) => { if (device.status !== 'online') this.ready.delete(device.id); });
    const offSettled = this.settled.attach();
    return () => { clearInterval(timer); off(); offSettled(); };
  }

  /**
   * Pushes to every online CEO PC whose link-up got to the record (its agents rows are settled) and that is owed
   * something – none while one is in flight, a failed one after RETRY_MS.
   */
  tick(): void {
    const top = this.top();
    for (const peer of this.peers()) {
      if (!this.ready.has(peer) || this.pushing.has(peer) || this.s.clock.now() - (this.failed.get(peer) ?? -RETRY_MS) < RETRY_MS) continue;
      if (top > this.cursor(peer) || [...this.owed(peer).keys()].some((agentId) => !this.waits(peer, agentId))) void this.push(peer);
    }
    this.settled.tick(this.mine());
  }

  /** The link-up step: everything owed to `peer`, then live pushes; false when not all of it went. */
  catchUp(peer: string): Promise<boolean> {
    this.failed.delete(peer);
    for (const key of [...this.refused.keys()]) if (key.startsWith(`${peer}/`)) this.refused.delete(key);
    this.ready.add(peer);
    this.settled.linkUp(peer);
    return this.push(peer);
  }

  /** One push to `peer` after the one in flight; `also`: an agent whose rows go too (it just left this PC). */
  push(peer: string, also?: string): Promise<boolean> {
    const before = this.pushing.get(peer) ?? Promise.resolve(true);
    const next = before.then(() => this.send(peer, also));
    this.pushing.set(peer, next);
    void next.finally(() => { if (this.pushing.get(peer) === next) this.pushing.delete(peer); });
    return next;
  }

  /** A removed PC: its cursor, owed rows and Forgets go. */
  dropCursor(peer: string): void {
    this.kv.delete(NS, peer);
    this.kv.deletePrefix(OWED_NS, `${peer}/`);
    this.kv.deletePrefix(MOVED_NS, `${peer}/`);
    dropForgets(this.s, peer);
    this.settled.drop(peer);
  }

  private cursor(peer: string): number { return this.kv.get<number>(NS, peer) ?? -1; }
  private setCursor(peer: string, at: number): void { this.kv.set(NS, peer, at, this.s.clock.now()); }
  private top(): number { return Number(this.s.db.get<{ n: number }>('SELECT n FROM context_seq')?.n ?? 0); }
  private peers(): string[] { return onlinePeers(this.s); }
  private owed(peer: string): Map<string, number> {
    return new Map(this.kv.list<number>(OWED_NS, `${peer}/`).map(({ key, value }) => [key.slice(peer.length + 1), Number(value)]));
  }
  private waits(peer: string, agentId: string): boolean { return this.s.clock.now() - (this.refused.get(`${peer}/${agentId}`) ?? -RETRY_MS) < RETRY_MS; }

  /** The agents whose record this PC writes. */
  private mine(): string[] {
    let agents: string[] = [];
    try { agents = this.s.org.list({ includeArchived: true }).map((agent) => agent.id); } catch { agents = []; }
    return agents.filter((id) => !homeElsewhere(this.s, id));
  }

  private async send(peer: string, also?: string): Promise<boolean> {
    if (onEmployeePc(this.s.db, peer)) return this.sendMoved(peer);
    if (!isCeoPc(this.s.db, peer) || !this.s.devices.online(peer)) return false;
    try {
      if (!(await owedForgets(this.s, peer))) throw new Error('a Forget did not go');
      const top = this.top();
      await this.branchesFor(peer, also);
      const mine = new Set([...this.mine(), ...(also ? [also] : [])]);
      const owed = this.owed(peer);
      for (const [agentId, after] of owed) {
        if (!mine.has(agentId)) {
          // Not mine (any more): my own rows of it go as a branch when that PC writes it (branchesFor), else that writer owes them.
          if (homeElsewhere(this.s, agentId) !== peer) this.kv.delete(OWED_NS, `${peer}/${agentId}`);
          continue;
        }
        if (this.waits(peer, agentId)) continue;
        if (await this.sendRows(peer, [agentId], after, top, false)) this.kv.delete(OWED_NS, `${peer}/${agentId}`);
      }
      await this.sendRows(peer, [...mine].filter((agentId) => !owed.has(agentId)), this.cursor(peer), top, true);
      if (top > this.cursor(peer)) this.setCursor(peer, top); // everything up to it went, waits as owed rows, or is not for that PC
      this.failed.delete(peer);
      return true;
    } catch (error) {
      if (noMethod(error)) { // that PC's version has no record sync: nothing is owed to it until its next link-up (catchUp)
        this.ready.delete(peer);
        this.failed.delete(peer);
        this.s.log.info('record not sent: that PC has no record sync', { peer });
        return false;
      }
      this.failed.set(peer, this.s.clock.now());
      this.s.log.info('record not sent', { peer, error: errorText(error) });
      return false;
    }
  }

  /** To an employee's PC: the record of each agent this company moved there, past where it last went there (MOVED_NS). */
  private async sendMoved(peer: string): Promise<boolean> {
    if (!this.s.devices.online(peer)) return false;
    try {
      const top = this.top();
      let all = true;
      for (const { id } of this.s.org.list()) {
        if (homeElsewhere(this.s, id) !== peer) continue;
        const key = `${peer}/${id}`;
        if (await this.sendRows(peer, [id], this.kv.get<number>(MOVED_NS, key) ?? -1, top, false)) this.kv.set(MOVED_NS, key, top, this.s.clock.now());
        else all = false; // that PC refused it (it wrote the agent's record itself): again at its next link-up
      }
      return all;
    } catch (error) {
      this.s.log.info('record not sent to the employee\'s PC', { peer, error: errorText(error) }); // an older release there takes none
      return false;
    }
  }

  /** `peer` is owed `agentId`'s rows past `after` (the lower of what it was owed already). */
  private owe(peer: string, agentId: string, after: number): void {
    const key = `${peer}/${agentId}`;
    this.kv.set(OWED_NS, key, Math.min(this.kv.get<number>(OWED_NS, key) ?? Number.MAX_SAFE_INTEGER, after), this.s.clock.now());
  }

  /** Where `peer`'s acknowledgement of `agentId`'s rows ends: its cursor, or lower where rows of it are owed. */
  private since(peer: string, agentId: string): number {
    return Math.min(this.cursor(peer), this.kv.get<number>(OWED_NS, `${peer}/${agentId}`) ?? Number.MAX_SAFE_INTEGER);
  }

  /**
   * Sends the rows of `agents` with `changed` in (after, top], page by page (`cursor`: moving the PC's cursor along). An
   * agent that PC refuses is owed from its first refused row on and left out of the pages after; false when one was refused.
   */
  private async sendRows(peer: string, agents: string[], after: number, top: number, cursor: boolean): Promise<boolean> {
    const left = new Set(agents);
    while (left.size) {
      const rows = this.s.db.all<LocalRow>(
        `SELECT ${SELECT} FROM context_items WHERE changed > ? AND changed <= ? AND agent_id IN (${[...left].map(() => '?').join(', ')}) ORDER BY changed LIMIT ?`,
        [after, top, ...left, ROWS]);
      if (!rows.length) break;
      after = Number(rows[rows.length - 1].changed);
      for (const page of pagesOf(this.s.db, rows.filter((row) => left.has(String(row.agent_id))))) {
        if (!this.s.devices.online(peer)) throw new Error('link gone');
        const answer = await this.s.devices.call(peer, LEDGER_METHOD, { op: 'rows', rows: page.rows, runs: page.runs, items: page.items }) as { refused?: unknown };
        for (const agentId of keys(answer?.refused)) {
          const ids = new Set(page.rows.filter((row) => row.agent_id === agentId).map((row) => `${row.conversation_id}/${row.item_id}`));
          const low = Math.min(...rows.filter((row) => row.agent_id === agentId && ids.has(`${row.conversation_id}/${row.item_id}`)).map((row) => Number(row.changed)));
          this.owe(peer, agentId, low - 1);
          this.refused.set(`${peer}/${agentId}`, this.s.clock.now());
          left.delete(agentId);
        }
        if (cursor) this.setCursor(peer, page.top);
      }
    }
    return left.size === agents.length;
  }

  /**
   * My own unacknowledged rows of the agents that now run on `peer` go there as branches first; one that does not go (that PC
   * refused it, or it waits after a refusal) stays owed and leaves the others alone (review M6).
   */
  private async branchesFor(peer: string, also?: string): Promise<void> {
    const owedFrom = Math.min(this.cursor(peer), ...this.owed(peer).values());
    const agents = this.s.db.all<{ id: string }>('SELECT DISTINCT agent_id AS id FROM context_items WHERE changed > ? AND pc IS NULL', [owedFrom]).map((row) => row.id);
    for (const agentId of agents) {
      if (agentId === also || !this.s.org.get(agentId) || homeElsewhere(this.s, agentId) !== peer || this.waits(peer, agentId)) continue;
      const since = this.since(peer, agentId);
      const low = Number(this.s.db.get<{ n: number | null }>('SELECT MIN(changed) AS n FROM context_items WHERE agent_id = ? AND pc IS NULL AND changed > ?', [agentId, since])?.n ?? 0);
      if (!low) continue;
      try {
        await this.branch(peer, agentId);
      } catch (error) {
        this.owe(peer, agentId, low - 1); // they stay unacknowledged while the cursor moves on with the other agents
        this.refused.set(`${peer}/${agentId}`, this.s.clock.now());
        this.s.log.info('record branch not handed over', { agentId, peer, error: errorText(error) });
      }
    }
  }

  /** Sends my own unacknowledged rows of `agentId` to its writer `peer` (one at a time per agent and PC). */
  private branch(peer: string, agentId: string): Promise<void> {
    const key = `${peer}/${agentId}`;
    let run = this.branching.get(key);
    if (!run) {
      run = (async () => {
        const pages = pagesOf(this.s.db, branchRows(this.s.db, agentId, this.since(peer, agentId)));
        for (const [index, page] of pages.entries()) {
          const message: BranchPage = { agentId, rows: page.rows, runs: page.runs, items: page.items, first: index === 0, last: index === pages.length - 1, before: this.started };
          const answer = await this.s.devices.call(peer, LEDGER_METHOD, { op: 'branch', ...message }) as { taken?: unknown; kept?: unknown };
          settleBranch(this.s.db, page.rows, { taken: keys(answer?.taken), kept: keys(answer?.kept) }, peer);
        }
        this.kv.delete(OWED_NS, key); // all of it is with the writer now
        if (pages.length) this.s.log.info('record branch handed to the writer', { agentId, peer, rows: pages.reduce((n, page) => n + page.rows.length, 0) });
      })().finally(() => this.branching.delete(key));
      this.branching.set(key, run);
    }
    return run;
  }

  // ---------------------------------------------------------------- receiving

  /** 'sync.ledger' from one of my PCs – or, op 'rows' only, the records of its own agents from the company this PC works for. */
  async receive(params: unknown, from: string): Promise<unknown> {
    const message = (params ?? {}) as Record<string, unknown>;
    if (!isCeoPc(this.s.db, from)) {
      if (linkOf(new DevicesRepo(this.s.db).get(from))?.kind !== 'employer' || message.op !== 'rows') throw new WorkforceError('forbidden', 'This PC takes no record from that PC.');
      return this.take(this.companyOwn(message), from);
    }
    if (message.op === 'rows') return this.take(message, from);
    if (message.op === 'branch') return this.append(message, from);
    if (message.op === 'fetch') return serveFetch(this.s, message.agentId, message.ids);
    if (message.op === 'forget') return forgetHere(this.s, message.print);
    if (message.op === 'busy' || message.op === 'settled' || message.op === 'resettle') return this.settled.receive(message, from);
    throw new WorkforceError('bad_request', 'Unknown record sync request.');
  }

  /** A page of rows: every agent's rows are taken but those of an agent whose record I cannot take from that PC now (`refused`). */
  private async take(message: Record<string, unknown>, from: string): Promise<{ ok: true; rows: number; refused: string[] }> {
    const rows = (Array.isArray(message.rows) ? message.rows : []).filter(validRow);
    const originals = originalsIn(message);
    const refused = new Set<string>();
    for (const agentId of new Set(rows.map((row) => String(row.agent_id)))) {
      const clash = (own: boolean) => rows.some((row) => row.agent_id === agentId && collisions(this.s.db, row).some((local) => !own || this.unacked(local, from)));
      if (!clash(false)) continue;
      const writer = this.s.org.get(agentId) ? homeElsewhere(this.s, agentId) : from;
      if (writer !== from) { refused.add(agentId); continue; } // I write it, or another PC does: the sender learns it from the agents row
      if (clash(true)) await this.branch(from, agentId).catch(() => undefined); // my own work goes to the writer first
      if (clash(true)) refused.add(agentId);
    }
    const written = new Set<string>();
    this.s.db.tx(() => {
      const moved = putOriginals(this.s.db, originals, from);
      for (const row of rows) if (!refused.has(String(row.agent_id)) && putRow(this.s.db, rerouted(row, moved), from)) written.add(String(row.agent_id));
    });
    for (const agentId of written) this.settled.rows(from, agentId);
    // My record changed under my native sessions (the record of an agent that just came here): rebuilt after the turn running now.
    for (const agentId of written) if (this.s.org.get(agentId) && !homeElsewhere(this.s, agentId)) dropSessionsAfterTurn(this.s, agentId);
    return { ok: true, rows: rows.filter((row) => !refused.has(String(row.agent_id))).length, refused: [...refused] };
  }

  /** A page from my employer with only its own agents' rows and runs (employee.ts fromEmployer) and those runs' items. */
  private companyOwn(message: Record<string, unknown>): Record<string, unknown> {
    const own = (agentId: unknown) => typeof agentId === 'string' && fromEmployer(this.s.db, agentId);
    const list = (value: unknown) => (Array.isArray(value) ? value as Array<Record<string, unknown>> : []);
    const runs = list(message.runs).filter((run) => own(run?.agent_id));
    const ids = new Set(runs.map((run) => run.id));
    return { op: 'rows', rows: list(message.rows).filter((row) => own(row?.agent_id)), runs, items: list(message.items).filter((item) => ids.has(item?.run_id)) };
  }

  /** A row I wrote that `peer` has not acknowledged. */
  private unacked(row: LocalRow, peer: string): boolean {
    return row.pc === null && Number(row.changed) > this.since(peer, String(row.agent_id));
  }

  private async append(message: Record<string, unknown>, from: string): Promise<{ ok: true; taken: string[]; kept: string[] }> {
    const agentId = typeof message.agentId === 'string' ? message.agentId : '';
    if (!this.s.org.get(agentId) || homeElsewhere(this.s, agentId)) throw new WorkforceError('conflict', 'That agent does not run on this PC.');
    const page: BranchPage = { agentId, rows: (Array.isArray(message.rows) ? message.rows : []).filter(validRow).filter((row) => row.agent_id === agentId),
      ...originalsIn(message), first: message.first === true, last: message.last === true, ...(typeof message.before === 'number' ? { before: message.before } : {}) };
    const key = `${from}/${agentId}`;
    let acc = this.appended.get(key);
    if (!acc) {
      const none = !this.s.db.get('SELECT 1 AS hit FROM context_items WHERE agent_id = ? LIMIT 1', [agentId]);
      acc = { asIs: none, n: 0, from: Number.MAX_SAFE_INTEGER, to: 0, old: { n: 0 } };
      this.appended.set(key, acc);
    }
    const answer = appendBranch(this.s.db, page, from, acc, this.s.clock.now());
    if (page.last) {
      this.appended.delete(key); // a resent last page finds every row had: no second note
      if (acc.n || acc.old.n) {
        dropSessionsAfterTurn(this.s, agentId);
        try { this.note(this.s, agentId, branchNote(this.s, from, acc)); } catch (error) { this.s.log.warn('record branch not noted', { agentId, error: errorText(error) }); }
        this.s.log.info('record branch appended', { agentId, from, items: acc.n, older: acc.old.n });
      }
      void fetchOriginals(this.s, agentId);
    }
    return { ok: true, ...answer };
  }
}

/**
 * Sends what is owed of `agentId`'s record to every online CEO PC now – and to the employee's PC it moved to (Konrad
 * 26.11.2026); resolves when they acknowledged (at most 10 s). Never throws.
 */
export async function flushLedger(s: RuntimeServices, agentId: string): Promise<void> {
  const sync = running.get(s.db);
  if (!sync) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<void>((resolve) => { timer = setTimeout(resolve, FLUSH_WAIT_MS); });
  try {
    const home = homeElsewhere(s, agentId);
    const moved = home && onEmployeePc(s.db, home) && s.devices.online(home) ? [home] : [];
    await Promise.race([Promise.all([...onlinePeers(s), ...moved].map((peer) => sync.push(peer, agentId))), wait]);
  } catch { /* never throws */ } finally { clearTimeout(timer); }
}

/**
 * This PC just became `agentId`'s writer (it arrived here, or I took it over): every one of my CEO PCs is owed its whole
 * record once – sent regardless of the cursor, rows they hold as they are skipped there (review R1 H4). Never throws.
 */
export function becameWriter(s: RuntimeServices, agentId: string): void {
  try {
    const kv = new KvRepo(s.db);
    for (const { record, link } of links(s.db)) if (link.kind === 'ceo') kv.set(OWED_NS, `${record.id}/${agentId}`, -1, s.clock.now());
    running.get(s.db)?.tick();
  } catch (error) {
    s.log.warn('record not owed to my PCs', { agentId, error: errorText(error) });
  }
}

/** After this PC became `agentId`'s PC: pulls the originals of its kept and condensed rows that are missing here (any online CEO PC), then their blobs. Best effort. */
export async function fetchOriginals(s: RuntimeServices, agentId: string): Promise<void> {
  try {
    const missing = s.db.all<{ id: string }>(
      `SELECT DISTINCT substr(c.ref, 6) AS id FROM context_items c WHERE c.agent_id = ? AND c.state <> 'hidden' AND c.ref LIKE 'item:%'
         AND NOT EXISTS (SELECT 1 FROM run_items r WHERE r.id = substr(c.ref, 6))`, [agentId]).map((row) => row.id);
    await pullItems(s, agentId, missing, onlinePeers(s));
    if (!s.files || !s.paths) return;
    const held = s.db.all<{ data: string }>(
      `SELECT r.data FROM context_items c JOIN run_items r ON r.id = substr(c.ref, 6) WHERE c.agent_id = ? AND c.state <> 'hidden' AND c.ref LIKE 'item:%'`, [agentId]);
    for (const { data } of held) {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
      for (const blob of blobIdsOf(parsed)) await needBlob(s, blob);
    }
  } catch (error) {
    s.log.info('record originals not fetched', { agentId, error: errorText(error) });
  }
}
