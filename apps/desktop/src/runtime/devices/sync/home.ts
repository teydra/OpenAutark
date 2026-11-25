// What a link between two PCs carries (owner 31.10. and 04.11.2026: the CEO's PCs share everything, an
// employee's PC sees its person's chats and tasks) and where an agent runs: on its home PC ("jeder hat halt was
// zu Hause"). An agent without a home (device_id NULL) lives on the PC that made it; a row leaving that PC carries
// its id (tables.ts), so the other PCs never run it too.
// Link kinds: 'ceo' – one of the CEO's own PCs (full sync both ways, turns follow the home); 'employee' – the other
// PC joined this one as an employee (it gets that person's chats and tasks; only the person's own lines and task
// changes come back, employee.ts); 'employer' – this PC joined the other one as an employee (it receives those and
// sends back only its person's own part). An agent homed on a PC linked here that
// is no 'ceo' link (an employee's PC, a removed PC) keeps its turns here, only its device tools go there; one homed
// on a PC this PC never linked runs on the CEO PC that knows it. A schedule fires on one PC only (firesHere).
// Umzug 21.11.2026: goesOn / standIn – which PC goes on with an agent whose PC is gone (takeover.ts acts on it; firesHere
// arms the agent's schedules there): only one of the PCs the agent is at home on (Agent.homes), and this PC only when it
// held the agent's complete, settled record when the contact broke (settledHere – kv 'sync.settled', kept by
// ledger-settled.ts from what the agent's PC announced). Review R3 H3: a kept "settled" counts only for the link it came
// on and while this runtime stayed awake since – linkMark names this runtime and the link to a PC (a counter raised each
// time that link comes up), awake() is the record sync's heartbeat; a start or a jump of the clock (sleep) voids all of
// them. M1: and only while this PC's own chats, tasks and files of the agent are the ones that PC named (settled-state.ts).
// Owns: these reads. Never: writes, dials or decides wakes (the dispatcher's gate, rows.ts hands them over).

import type { RuntimeServices } from '../../contracts.ts';
import type { Device } from '../../../shared/model/devices.ts';
import { KvRepo } from '../../store/kv.ts';
import { randomUUID } from 'node:crypto';
import { DevicesRepo, type DeviceRecord } from '../repo.ts';
import { standing } from './settled-state.ts';
import { fromEmployer } from './employee.ts';

export type Link = { kind: 'ceo' } | { kind: 'employee'; personId: string } | { kind: 'employer' };

/** What the link to `record` carries; undefined for this PC, a phone, a removed or half-paired PC. */
export function linkOf(record: Device | undefined): Link | undefined {
  if (!record || record.kind !== 'pc' || record.self || record.revokedAt || record.status === 'revoked' || record.status === 'pairing') return undefined;
  if (record.personId) return { kind: 'employee', personId: record.personId };
  return record.joinedAs === 'employee' ? { kind: 'employer' } : { kind: 'ceo' };
}

/** Whether `id` is one of the CEO's own PCs linked here (the one CEO check). */
export function isCeoPc(db: RuntimeServices['db'], id: string): boolean {
  return linkOf(new DevicesRepo(db).get(id))?.kind === 'ceo';
}

/** Every linked PC with what its link carries. */
export function links(db: RuntimeServices['db']): Array<{ record: DeviceRecord; link: Link }> {
  const out: Array<{ record: DeviceRecord; link: Link }> = [];
  for (const record of new DevicesRepo(db).list({ kinds: ['pc'] })) {
    const link = linkOf(record);
    if (link) out.push({ record, link });
  }
  return out;
}

/** This PC's device id (the devices row marked self). */
export function selfId(db: RuntimeServices['db']): string {
  return new DevicesRepo(db).self()?.id ?? '';
}

/**
 * The home of an agent whose turns do not run here, else undefined. They run here without a home, with this PC as
 * home, or with a home linked here that is no 'ceo' link (an employee's PC, a removed PC). A home this PC never
 * linked is another CEO PC's link (its turns run there) – unless this PC has no CEO link at all. 21.11.2026: an agent of
 * the company this PC is an employee of (employee.ts fromEmployer) never runs here.
 */
export function homeElsewhere(services: Pick<RuntimeServices, 'db' | 'org'>, agentId: string): string | undefined {
  let home: string | undefined;
  try { home = services.org.get(agentId)?.deviceId; } catch { return undefined; }
  if (!home) return undefined;
  if (fromEmployer(services.db, agentId)) return home; // 21.11.2026: my employer's agent runs on the company's PCs only
  const record = new DevicesRepo(services.db).get(home);
  if (record) return linkOf(record)?.kind === 'ceo' ? home : undefined;
  return links(services.db).some(({ link }) => link.kind === 'ceo') ? home : undefined;
}

/**
 * Whether a wake from another PC (its `origin.source`) says that PC compared the agent's SYSTEM.md standard ('standard') or
 * a prompt ('system-prompt:…') with its own release: the agent's home PC keeps both itself and wakes nobody for them
 * (org/standard.ts, context/prompt-updates.ts), so it is never news there. 25.11.2026 (ORENDA 16:31–16:42): a 0.3.9 PC
 * re-sent "New standard SYSTEM.md" at every link-up; the guard for prompts was lost with 0.3.18 and never covered 'standard'.
 */
export const ownWake = (source: string | undefined): boolean => source === 'standard' || (source?.startsWith('system-prompt') ?? false);

/** Umzug 21.11.2026: how long an agent's PC is out of reach here before another PC goes on with it (standIn). */
export const TAKEOVER_MS = 120_000;
/** Since when this runtime watches its links for a takeover (takeover.ts attach), by database. */
const watching = new WeakMap<object, number>();

/** The takeover watches from `at` on: a PC out of reach since before counts from then (a start before the links are up takes nobody). */
export function watchAwayFrom(db: RuntimeServices['db'], at: number): void {
  watching.set(db, at);
}

/** kv: per `<pc>/<agentId>` the last "settled" that PC announced for an agent it runs (ledger-settled.ts writes and clears it). */
export const SETTLED_NS = 'sync.settled';

/**
 * What is kept of a "settled": the record's head and the agent's state there (settled-state.ts), the link it came on, and –
 * once that link went – whether this PC's own state of the agent was the same at that moment (`held`; what is written here
 * afterwards, the person's next line, is this PC's own and changes nothing).
 */
export interface KeptSettled { head: number; state: string; mark: string; held?: boolean }
/** A heartbeat older than this is a runtime that was not awake (the PC slept): what it kept before is void. */
export const ASLEEP_MS = 30_000;
/** Per runtime (by database): its own mark, per PC the link's counter and whether it is up, and the last heartbeat. */
const awakeness = new WeakMap<object, { run: string; links: Map<string, { n: number; up: boolean }>; beat: number }>();
const awakeOf = (db: RuntimeServices['db'], now: number) => {
  let state = awakeness.get(db);
  if (!state) awakeness.set(db, (state = { run: randomUUID(), links: new Map(), beat: now }));
  return state;
};

/** The record sync's heartbeat (each tick). False when the clock jumped past ASLEEP_MS since the last one: every mark is new. */
export function awake(db: RuntimeServices['db'], now: number): boolean {
  const state = awakeOf(db, now);
  const slept = now - state.beat > ASLEEP_MS || now < state.beat;
  if (slept) state.run = randomUUID();
  state.beat = now;
  return !slept;
}

/** The link to `pc` came up or went (device.upserted): a link that comes up after it was down is a new one. */
export function linkNow(db: RuntimeServices['db'], pc: string, up: boolean, now: number): void {
  const { links: known } = awakeOf(db, now);
  const link = known.get(pc) ?? { n: 0, up: false };
  known.set(pc, { n: up && !link.up ? link.n + 1 : link.n, up });
}

/** This runtime and its current link to `pc`: what a "settled" from that PC is kept with. */
export function linkMark(db: RuntimeServices['db'], pc: string, now: number): string {
  const state = awakeOf(db, now);
  return `${state.run}/${state.links.get(pc)?.n ?? 0}`;
}

/**
 * Whether this PC holds `agentId`'s complete, settled state as its PC `pc` last announced it: no run there and every row of
 * the record here (ledger-settled.ts), said on the link that was up until the contact broke, this runtime awake ever since,
 * and this PC's chats, tasks and files of the agent the ones that PC named when the contact broke.
 */
export function settledHere(services: Pick<RuntimeServices, 'db' | 'clock'>, pc: string, agentId: string): boolean {
  const kept = new KvRepo(services.db).get<Partial<KeptSettled>>(SETTLED_NS, `${pc}/${agentId}`);
  const state = awakeness.get(services.db);
  const now = services.clock.now();
  if (!kept || !state || now - state.beat > ASLEEP_MS || kept.mark !== linkMark(services.db, pc, now)) return false;
  return kept.held ?? kept.state === standing(services.db, agentId); // the link is still up: as it stands now
}

/** `homes`, each once, without the PCs this PC knows as removed or as no PC of mine (one it never linked stays: another of my PCs knows it). */
export function liveHomes(db: RuntimeServices['db'], homes: readonly string[]): string[] {
  const self = selfId(db);
  const repo = new DevicesRepo(db);
  return [...new Set(homes)].filter((id) => { const record = id === self ? undefined : repo.get(id); return !record || linkOf(record)?.kind === 'ceo'; });
}

/**
 * Umzug 21.11.2026: who goes on with an agent whose own PC is gone, as this PC sees it. `to`: that PC – the agent's PC is
 * one of my PCs linked here, out of reach for TAKEOVER_MS (from the later of its last-seen time and the start of the
 * watch), and `to` is the online PC with the smallest id among those it is at home on (Agent.homes; this PC included) –
 * this PC only when it held the complete, settled record when the contact broke; `unsettled`: this PC would be it but the
 * agent was at work there or rows were still owed – it waits for its PC; `soon`: its PC is not away long enough yet.
 * Nothing of these: it waits (no homes, none of them online, its PC there or unknown).
 */
export function goesOn(services: Pick<RuntimeServices, 'db' | 'org' | 'clock' | 'devices'>, agentId: string): { to?: string; unsettled?: boolean; soon?: boolean } {
  try {
    const since = watching.get(services.db);
    const agent = services.org.get(agentId);
    const homes = agent && !agent.archivedAt ? agent.homes ?? [] : [];
    const home = homes.length && since !== undefined ? homeElsewhere(services, agentId) : undefined;
    if (!home || !isCeoPc(services.db, home) || services.devices.online(home)) return {};
    const self = selfId(services.db);
    const online = links(services.db).filter(({ record: pc, link }) => link.kind === 'ceo' && pc.id !== home && services.devices.online(pc.id)).map(({ record: pc }) => pc.id);
    const to = [self, ...online].filter((id) => id && homes.includes(id)).sort()[0];
    if (!to) return {};
    const record = new DevicesRepo(services.db).get(home)!;
    if (services.clock.now() - Math.max(record.lastSeenAt ?? 0, since!) < TAKEOVER_MS) return { soon: true };
    return to === self && !settledHere(services, home, agentId) ? { unsettled: true } : { to };
  } catch {
    return {};
  }
}

/** The PC that goes on with an agent whose own PC is gone (goesOn), else undefined: it waits. */
export function standIn(services: Pick<RuntimeServices, 'db' | 'org' | 'clock' | 'devices'>, agentId: string): string | undefined {
  return goesOn(services, agentId).to;
}

/**
 * 24.11.2026 (0.3.20, no main PC): whether `record` – one of my PCs linked here – is out of the person's schedules and
 * rings: out of reach for TAKEOVER_MS (from the later of its last-seen time and the start of the watch, as for an agent's
 * PC). Without that watch (takeover.ts attach: no links yet) or without the online view, every PC counts, as before.
 */
function gone(services: Partial<Pick<RuntimeServices, 'db' | 'clock' | 'devices'>>, record: DeviceRecord): boolean {
  const since = services.db ? watching.get(services.db) : undefined;
  if (since === undefined || !services.clock || !services.devices || services.devices.online(record.id)) return false;
  return services.clock.now() - Math.max(record.lastSeenAt ?? 0, since) >= TAKEOVER_MS;
}

/**
 * Whether this PC fires a schedule: an agent's where the agent runs – or, Umzug 21.11.2026, where it would go on while its
 * PC is gone (standIn), so a schedule alone makes it go on there –, the person's on the CEO PC with the smallest id among
 * those that are not gone (24.11.2026: a fallback while the smaller PC is out, no fixed main PC; the one that fired is
 * stamped in the synced record – the post's meta.plannedAt, the to-do's ledger.ringedAt – so a PC coming back does not fire it twice).
 */
export function firesHere(services: Pick<RuntimeServices, 'db' | 'org'> & Partial<Pick<RuntimeServices, 'clock' | 'devices'>>, ownerId: string): boolean {
  let agent = false;
  try { agent = Boolean(services.org.get(ownerId)); } catch { agent = false; }
  if (agent) return !homeElsewhere(services, ownerId) || (services.clock !== undefined && services.devices !== undefined && standIn(services as Parameters<typeof standIn>[0], ownerId) === selfId(services.db));
  const self = selfId(services.db);
  return links(services.db).every(({ record, link }) => link.kind !== 'ceo' || record.id > self || gone(services, record));
}
