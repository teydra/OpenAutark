// Umzug 21.11.2026 (owner: an agent lives on one PC at a time and its record goes with it): what this PC does when an
// agent's PC changes – whoever changed it (agents.update device, the person in the app, a synced agents row, a takeover
// here – devices/sync/takeover.ts, attached by startMoves).
// - It left this PC: its work here stops at once like the person's Stop – the main-lane turn and its call in flight are
//   cut (review M5), except the agent's own agents.update device call, whose turn ends right after it returns – with a
//   continue-wake, and its parts stop (dispatcher.leave); then its record goes to my other PCs (devices/sync/ledger.ts
//   flushLedger), and only then its wakes go to its new PC – rows.ts handOver holds them while the agent is `leaving`.
//   Part 2: an agent that is at home on several PCs (Agent.homes) keeps this PC as one of them (stayHome), and its
//   browser sign-ins and home-project changes still waiting here go to its other homes (devices/sync/share.ts shareNow).
// - It came here: its native sessions here are stale (the next turn rebuilds them from the record), the record sync
//   learns that this PC writes it now (becameWriter), and it reads one line – the move line, or, when the PC it came from
//   is out of reach (a takeover), the takeover line only (review L5). When the PC it came from is one of mine and online,
//   this PC asks it once for the hand-over (peer method agents.handover, 'ceo' links only): that PC answers when its leave
//   is done – the turn ended, the parts stopped, the record flushed – and hands over the notes that still waited for the
//   agent there (review L4), so the first turn here starts on the whole record. Meanwhile the agent is `arriving` (the
//   dispatcher starts nothing for it, its wakes wait); no answer within HANDOVER_MS or a dropped link: it goes on with what
//   is here (one info line; a late tail comes as a branch, ledger-branch.ts). Then the originals its record names come
//   (fetchOriginals) and the wakes that waited here run.
// - noteMove: the one line an agent reads at the start of its next turn here about where it runs – a repair note of its
//   main thread, read by that turn whatever woke it; a newer line replaces the older one of its kind (arrival, back,
//   branch – different kinds stand together); never a wake of its own.
// - moveRefused: the one reason a move is refused (the tool and the app): that PC of mine cannot be reached now.
// Owns: these reactions, the hand-over request and answer, and the move line. Never: decides where an agent runs (its
// row does), dials a PC that is not online or logs record text.

import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import { MAIN_THREAD } from '../../shared/model/origin.ts';
import { KvRepo } from '../store/kv.ts';
import { clockText, profileZone } from '../context/time.ts';
import { DevicesRepo } from '../devices/repo.ts';
import type { PeerHandler } from '../devices/rpc-peer.ts';
import type { LinkKind } from '../devices/mesh.ts';
import { homeElsewhere, isCeoPc, linkOf, liveHomes, selfId } from '../devices/sync/home.ts';
import { becameWriter, fetchOriginals, flushLedger } from '../devices/sync/ledger.ts';
import { dropSessions } from '../devices/sync/ledger-branch.ts';
import { shareNow } from '../devices/sync/share.ts';
import { announceWakes, goneLine, Takeover, type TakeoverDeps } from '../devices/sync/takeover.ts';
import { saveRepairNotes, takeRepairNotes } from './turn-finish.ts';

declare module '../contracts.ts' {
  interface Dispatcher {
    /**
     * Umzug 21.11.2026: the agent runs on another PC now – what it runs here stops at once (agents/dispatcher.ts); `ownRun`: the
     * run whose own call moved it, which ends right after that call. False when nothing ran.
     */
    leave?(agentId: string, note: string, ownRun?: string): Promise<boolean>;
  }
}

const NOTE_NS = 'move.note';
/** How long a move waits for the stopped work to end (it was cut; a turn that ignores its abort is released by the dispatcher). */
export const LEAVE_WAIT_MS = 30_000;
/** The peer method a PC that just became an agent's PC asks the one it came from (answered when that PC's leave is done). */
export const HANDOVER_METHOD = 'agents.handover';
/** How long the new PC waits for the hand-over's answer before it goes on with what is here (a dead link). */
export const HANDOVER_MS = 60_000;
/** The continue-wake's note of a turn a move stopped. */
export const CUT_NOTE = 'My last turn was stopped when I moved to another PC – a call in flight may have been cut; I check what it did and go on.';
/** At most this many waiting notes travel in a hand-over answer, each at most NOTE_CHARS long. */
const NOTES = 6;
const NOTE_CHARS = 4_000;

/** Per runtime: agents whose record is still on its way from here, those waiting for a hand-over, the leaves running, own moves. */
const state = new WeakMap<object, { leaving: Set<string>; arriving: Set<string>; leaves: Map<string, Promise<void>>; own: Map<string, string> }>();
const stateOf = (s: RuntimeServices) => {
  let value = state.get(s);
  if (!value) state.set(s, (value = { leaving: new Set(), arriving: new Set(), leaves: new Map(), own: new Map() }));
  return value;
};

/** Whether `agentId`'s record is still on its way from this PC (its wakes wait – takeover.ts handOverTargets). */
export function isLeaving(s: RuntimeServices, agentId: string): boolean {
  return state.get(s)?.leaving.has(agentId) ?? false;
}

/** Whether `agentId` just came here and waits for the PC it came from to hand over (the dispatcher starts nothing for it). */
export function isArriving(s: RuntimeServices, agentId: string): boolean {
  return state.get(s)?.arriving.has(agentId) ?? false;
}

/** The agent's own call of run `runId` is moving it (agents.update device): that turn ends right after the call. Returns the end of that mark. */
export function movingMyself(s: RuntimeServices, agentId: string, runId: string): () => void {
  const { own } = stateOf(s);
  own.set(agentId, runId);
  return () => { if (own.get(agentId) === runId) own.delete(agentId); };
}

/**
 * The kinds of move line: an arrival here (moved, or gone on after a takeover), the old PC being back, and the record sync's
 * line about another PC's work appended to the record (ledger.ts, a branch). A newer line replaces the older of its kind;
 * lines of different kinds stand together.
 */
export type MoveLine = 'arrival' | 'back' | 'branch';

/** The move lines still waiting for `agentId` here, by kind (kv). */
const linesOf = (kv: KvRepo, agentId: string): Partial<Record<MoveLine, string>> => {
  const value = kv.get<unknown>(NOTE_NS, agentId);
  return value && typeof value === 'object' ? value as Partial<Record<MoveLine, string>> : {};
};

/**
 * The line `agentId` reads at the start of its next turn here; replaces the line of the same `kind` still waiting there.
 * `kind` defaults to 'branch' – the one caller outside this module is the record sync (ledger.ts).
 */
export function noteMove(s: RuntimeServices, agentId: string, text: string, kind: MoveLine = 'branch'): void {
  try {
    const kv = new KvRepo(s.db);
    const lines = linesOf(kv, agentId);
    const old = lines[kind];
    const waiting = takeRepairNotes(s, agentId, MAIN_THREAD).filter((note) => note !== old);
    saveRepairNotes(s, agentId, MAIN_THREAD, [...waiting, text]);
    kv.set(NOTE_NS, agentId, { ...lines, [kind]: text }, s.clock.now());
  } catch (error) {
    s.log.warn('move line not kept', { agentId, error: String(error) });
  }
}

const pcName = (s: RuntimeServices, id: string) => new DevicesRepo(s.db).get(id)?.name ?? id;

/** Why `agentId` cannot move to `deviceId` now – one of my PCs that cannot be reached, so its record cannot go –, else undefined. */
export function moveRefused(s: RuntimeServices, agentId: string, deviceId: string | undefined): string | undefined {
  try {
    if (!deviceId || deviceId === selfId(s.db) || deviceId === homeElsewhere(s, agentId) || !isCeoPc(s.db, deviceId) || s.devices.online(deviceId)) return undefined;
    return `${pcName(s, deviceId)} cannot be reached right now, so the record cannot go there – nothing changed.`;
  } catch {
    return undefined;
  }
}

const within = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> => new Promise<T>((resolve) => {
  const timer = setTimeout(() => resolve(fallback), ms);
  (timer as { unref?: () => void }).unref?.();
  promise.then(resolve, () => resolve(fallback)).finally(() => clearTimeout(timer));
});

/** An agent with homes that left this PC keeps it as one of them: the set of PCs it is at home on stays the same. */
function stayHome(s: RuntimeServices, agentId: string): void {
  try {
    const agent = s.org.get(agentId);
    const self = selfId(s.db);
    if (!agent?.homes?.length || !self || agent.homes.includes(self) || !homeElsewhere(s, agentId)) return;
    s.org.update(agentId, { homes: liveHomes(s.db, [...agent.homes, self]) }, { by: 'system', reason: 'move' }); // a removed PC goes from the list on the way
  } catch (error) {
    s.log.warn('home not kept', { agentId, error: String(error) });
  }
}

/** The agent now runs on `to`: what it runs here stops, its record goes, then its wakes. */
export function leaveHere(s: RuntimeServices, agentId: string, to: string): Promise<void> {
  const { leaving, leaves, own } = stateOf(s);
  leaving.add(agentId);
  const ownRun = own.get(agentId);
  const done = (async () => {
    try {
      const stopped = s.dispatcher.leave ? await within(s.dispatcher.leave(agentId, CUT_NOTE, ownRun), LEAVE_WAIT_MS, true) : false;
      stayHome(s, agentId);
      await flushLedger(s, agentId);
      await shareNow(s, agentId);
      s.log.info('agent moved away', { agentId, to, stopped });
    } catch (error) {
      s.log.warn('move away incomplete', { agentId, to, error: String(error) });
    } finally {
      leaving.delete(agentId);
      announceWakes(s, agentId);
    }
  })();
  leaves.set(agentId, done);
  void done.finally(() => { if (leaves.get(agentId) === done) leaves.delete(agentId); });
  return done;
}

/** The notes of a hand-over answer that may be kept: strings, at most NOTES of NOTE_CHARS each. */
const notesIn = (answer: unknown): string[] => {
  const notes = (answer as { notes?: unknown } | undefined)?.notes;
  return Array.isArray(notes) ? notes.filter((note): note is string => typeof note === 'string' && note.length > 0).slice(-NOTES).map((note) => note.slice(0, NOTE_CHARS)) : [];
};

/** The agent now runs here (it ran on `from`): fresh sessions, the writer's record, one line, the hand-over from `from`, then its originals and wakes. */
export async function arriveHere(s: RuntimeServices, agentId: string, from: string): Promise<void> {
  const { arriving } = stateOf(s);
  try {
    dropSessions(s.db, agentId);
    becameWriter(s, agentId);
    const ceo = isCeoPc(s.db, from);
    const reachable = ceo && s.devices.online(from);
    const since = `Since ${clockText(s.clock.now(), profileZone(s))} I run on ${pcName(s, selfId(s.db))}, moved from ${pcName(s, from)}`;
    // Konrad 24.11.2026: a company agent may move between the company's PC and an employee's PC – no record travels on that link.
    const linked = !ceo && Boolean(linkOf(new DevicesRepo(s.db).get(from)));
    noteMove(s, agentId, reachable ? `${since}; my record came with me.`
      : linked ? `${since}; my record did not come with me – what I did on ${pcName(s, from)} stays there.`
      : goneLine(s, from), 'arrival');
    s.log.info('agent moved here', { agentId, from });
    if (reachable) {
      arriving.add(agentId);
      const answer = await within(s.devices.call(from, HANDOVER_METHOD, { agentId }, undefined, HANDOVER_MS), HANDOVER_MS, undefined);
      if (answer === undefined) s.log.info('hand-over not answered, going on with the record here', { agentId, from });
      const notes = notesIn(answer);
      if (notes.length) saveRepairNotes(s, agentId, MAIN_THREAD, notes);
    }
  } catch (error) {
    s.log.warn('move here incomplete', { agentId, from, error: String(error) });
  } finally {
    arriving.delete(agentId);
    announceWakes(s, agentId);
  }
  await fetchOriginals(s, agentId).catch(() => undefined);
}

/** Resolves once `agentId`'s row here says it runs elsewhere (the watcher has started its leave then), or after `ms`. */
function rowLeft(s: RuntimeServices, agentId: string, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); off(); resolve(); };
    const off = s.bus.on('agent.upserted', (agent) => { if (agent.id === agentId && homeElsewhere(s, agentId)) queueMicrotask(finish); });
    const timer = setTimeout(finish, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

/**
 * agents.handover from the PC the agent went to: answered when this PC's leave of it is done (its row may still be on its
 * way), with the notes that still waited for the agent here – they leave this PC with the answer (review L4).
 */
export async function serveHandover(s: RuntimeServices, params: unknown): Promise<{ ok: boolean; notes?: string[] }> {
  const agentId = (params as { agentId?: unknown } | undefined)?.agentId;
  if (typeof agentId !== 'string' || !s.org.get(agentId)) return { ok: false };
  if (!homeElsewhere(s, agentId) && !state.get(s)?.leaves.has(agentId)) await rowLeft(s, agentId, HANDOVER_MS);
  await state.get(s)?.leaves.get(agentId);
  if (!homeElsewhere(s, agentId)) return { ok: true }; // it runs here after all: its notes stay
  const kv = new KvRepo(s.db);
  const lines = new Set(Object.values(linesOf(kv, agentId))); // this PC's own move lines are about this PC: they stay out
  kv.delete(NOTE_NS, agentId);
  const notes = takeRepairNotes(s, agentId, MAIN_THREAD).filter((note) => !lines.has(note)).slice(-NOTES);
  return { ok: true, ...(notes.length ? { notes } : {}) };
}

/**
 * Watches every agent's PC (agent.upserted – a tool, the app, a synced row, a takeover) and reacts when it left this PC or
 * came here; answers agents.handover on `mesh` (my own PCs only) and attaches the takeover. Returns the off switch.
 * `timers`: the takeover's re-check timer (tests).
 */
export function startMoves(s: RuntimeServices, options: { mesh?: { register(method: string, handler: PeerHandler, kinds?: readonly LinkKind[]): void }; timers?: TakeoverDeps['timers'] } = {}): () => void {
  const seen = new Map<string, { device: string; here: boolean }>();
  const look = (agent: Agent) => {
    const self = selfId(s.db);
    return { device: agent.deviceId && agent.deviceId !== self ? agent.deviceId : '', here: !homeElsewhere(s, agent.id) };
  };
  try { for (const agent of s.org.list()) seen.set(agent.id, look(agent)); } catch (error) { s.log.warn('agents\' PCs not read', { error: String(error) }); }
  const off = s.bus.on('agent.upserted', (agent) => {
    const before = seen.get(agent.id);
    const now = look(agent);
    seen.set(agent.id, now);
    if (!before || before.device === now.device) return; // new, or its PC is the same
    if (!before.here && !now.here) announceWakes(s, agent.id); // from one other PC to another: its waiting wakes go to the new one
    else if (before.here === now.here) return;
    else if (before.here) void leaveHere(s, agent.id, now.device);
    else void arriveHere(s, agent.id, before.device);
  });
  options.mesh?.register(HANDOVER_METHOD, (params) => serveHandover(s, params), ['ceo']);
  const takeover = new Takeover(s, { note: (id, text) => noteMove(s, id, text, 'back'), leaving: (id) => isLeaving(s, id), ...(options.timers ? { timers: options.timers } : {}) });
  const offTakeover = takeover.attach();
  return () => { off(); offTakeover(); };
}
