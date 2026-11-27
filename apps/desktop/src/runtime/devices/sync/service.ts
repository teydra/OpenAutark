// The sync between linked PCs, put together once by the runtime's composition root (main.ts): the mesh methods
// sync.rows (rows.ts; from an employee's PC it takes only that person's own lines and task changes, employee.ts),
// sync.secret (secrets.ts), sync.file (files.ts with the settings and stored files' bytes), sync.login (logins.ts) and
// sync.reading (readings.ts) – both open to every PC that shares a plan, employees' PCs too (plan-peers.ts) –,
// sync.tabs (tabs.ts), files.path (paths.ts: a file tab of another PC reads there) and tabs.position (positions.ts) –
// none of them open methods, so an employee's PC cannot call them –, sync.roster and device.sibling (roster.ts),
// sync.live and sync.live.cancel (live.ts), sync.ledger (ledger.ts) and sync.share (share.ts), the last three on 'ceo'
// links only (sync.ledger also from an employer: the record of an agent it moved here); and the listeners, attached only while a PC is linked (nothing runs without a link). <data>/side-tabs.json
// gets its owner on the data folder watcher here: every change is told to this PC's window and phones (tabs.changed).
// State, not messages: what travels is the whole current state of a small unit, and it comes again on its own. A link
// that comes up (device.upserted 'online') runs its catch-up (linkUps), and while it stays up the same catch-up runs
// again every REFRESH_MS (`rhythm`: one timer, armed while a PC is online; each round is announced as 'sync.round' with
// the PC, so other modules follow the rhythm without a timer of their own) – so a link that stays up for days still
// converges within minutes, and nothing is repaired by retry code of its own. The steps: the roster first, then the side
// pane (small, so a PC that just joined shows the other's pane at once), the rows and secrets owed since that PC's
// 'rows' cursor (stamps.ts), the agents' records (ledger.ts, at link-up; its own tick keeps them in rhythm), every
// plan's login, the homes an agent shares (share.ts), then the wakes that wait for that PC (a woken turn finds its login
// and key there; another PC's catch-up leaves them), and last the settings and the files owed since the 'files' cursor
// – the full file rescan at link-up and in the round after one whose files did not all arrive (that part's cursor moves
// only up to the first page that did not, so a file that keeps failing never brings the whole backlog again).
// Each part whose steps all arrived moves its cursor to the run's start; after
// either PC changed version the cursors start from zero once (stamps.ts). A repeat with nothing owed sends nothing and
// logs nothing. One catch-up per PC at a time – an 'online' during a run (a link swap cut its calls) ends it before its
// next step and runs it again at once – and a run whose link is gone ends before its next step (no step or page dials
// for it). Removing a PC drops its cursors, so a new link begins with everything again. A link that comes up or goes
// re-places the schedules' due times (one PC fires each). At link-up and each round one mesh ping measures the link's
// round trip and clock offset (devices/link-quality.ts – Settings › Devices and devices.list show it).
// Owns: this wiring, the catch-up order and its rhythm. Never: decides what a link carries (home.ts) or logs content.

import type { RuntimeServices } from '../../contracts.ts';
import { ROOT_SIDE_TABS } from '../../root/layout.ts';
import { PATH_OPS } from '../../rpc/handlers/files-path.ts';
import type { PeerHandler } from '../rpc-peer.ts';
import { FileSync, type WatcherTap } from './files.ts';
import { links } from './home.ts';
import { LoginSync } from './logins.ts';
import { READING_METHOD, ReadingSync } from './readings.ts';
import { RemotePaths } from './paths.ts';
import { tabPositions } from './positions.ts';
import { RowSync } from './rows.ts';
import { SecretSync } from './secrets.ts';
import { Stamps } from './stamps.ts';
import { RosterSync, type RosterMesh } from './roster.ts';
import { placeSchedules } from './tables.ts';
import { EVERY_LINK, PROBE_MS, type LinkKind } from '../mesh.ts';
import { pingLink } from '../link-quality.ts'; // Fest 22.11.2026 G: a PC link's round trip and clock offset
import { announcePane, TabSync } from './tabs.ts';
import { CANCEL_METHOD, LIVE_METHOD, LiveSync, bindLiveSync } from './live.ts';
import { chatLiveOf } from '../../chat/live.ts';
import { cancelRunHere } from '../../rpc/handlers/org.ts';
import { UPDATE_METHOD, serveUpdate } from './update.ts';
import { LedgerSync } from './ledger.ts';
import { LEDGER_METHOD } from './ledger-fetch.ts';
import { noteMove } from '../../agents/move.ts';
import { SHARE_METHOD, ShareSync } from './share.ts';

/** How often a link that stays up runs its catch-up again. */
export const REFRESH_MS = 2 * 60_000;

declare module '../../../shared/api/events.ts' {
  interface EventMap {
    /** 22.11.2026: a round of the rhythm for one linked PC (every REFRESH_MS while its link stays up) – a module that follows the rhythm listens here instead of a timer of its own. Topic: system. */
    'sync.round': { peer: string };
  }
}

export interface SyncInput {
  s: RuntimeServices;
  /** Where peer methods are registered (the mesh); with add/revoke/selfInfo the roster runs too (roster.ts). */
  mesh: { register(method: string, handler: PeerHandler, kinds?: readonly LinkKind[]): void } & Partial<Omit<RosterMesh, 'register'>>;
  /** The data folder watcher's tap, when it has one (live file changes; else the owners' events and link-ups). */
  tap?: WatcherTap;
}

export interface Sync { stop(): void }

const errorText = (error: unknown) => String((error as Error)?.message ?? error);

/** What a catch-up runs (startSync's syncs; a test stands them in). `again`: a run of a link that stays up. */
export interface LinkUpParts {
  roster?: Pick<RosterSync, 'linkUp'>;
  tabs: Pick<TabSync, 'catchUp'>;
  rows: Pick<RowSync, 'catchUp' | 'resume'>;
  /** The agents' records (their own cursor and tick: at link-up only). */
  ledger?: Pick<LedgerSync, 'catchUp'>;
  secrets: Pick<SecretSync, 'catchUp'>;
  logins: Pick<LoginSync, 'catchUp'>;
  /** A plan's limit readings (22.11.2026: every PC shows the newest one). */
  readings?: Pick<ReadingSync, 'catchUp'>;
  /** What an agent's home PCs keep the same (browser sign-ins awaited, home projects in the background). */
  share?: Pick<ShareSync, 'catchUp'>;
  files: Pick<FileSync, 'catchUp'>;
}

/**
 * The catch-ups, one per PC at a time: `run(peer)` at link-up, `run(peer, true)` again in rhythm (skipped while a run
 * of that PC is on its way). An 'online' that comes while that PC's run is on its way (a link swap cut the calls in
 * flight) ends that run before its next step and runs it once more at once – from the cursors a complete part moved.
 * `linked`: whether the PC's link is still up; a run whose link is gone ends before its next step.
 */
export function linkUps(s: Pick<RuntimeServices, 'clock' | 'log'>, stamps: Pick<Stamps, 'pair' | 'cursor' | 'setCursor'>, parts: LinkUpParts, linked: (peer: string) => boolean): (peer: string, again?: boolean) => void {
  const running = new Map<string, boolean>(); // peer → an 'online' came while its run was on its way
  const woke = new Set<string>(); // peers whose running catch-up already released its waiting wakes (its last step)
  const rescan = new Set<string>(); // peers whose last files part did not complete: their next round looks at every root again
  const linkUp = async (peer: string, again: boolean) => {
    const pair = stamps.pair(peer);
    const since = stamps.cursor(peer, 'rows', pair);
    const filesSince = stamps.cursor(peer, 'files', pair);
    const started = s.clock.now();
    let rows = true;
    let files = true;
    let filesAt: number | undefined; // where the 'files' cursor moves: the start when all arrived, else up to the first page that did not
    const catchUpFiles = async () => {
      const done = await parts.files.catchUp(peer, filesSince, { scan: !again || rescan.has(peer) });
      files = done === true;
      filesAt = done === true ? started : typeof done === 'number' && done > (filesSince ?? -Infinity) ? done : undefined;
      if (files) rescan.delete(peer); else rescan.add(peer);
    };
    const steps: Array<() => Promise<unknown>> = [
      async () => parts.roster?.linkUp(peer, again).catch((error: unknown) => s.log.warn('roster not exchanged', { peer, error: errorText(error) })), // small, first: my devices know each other at once
      () => parts.tabs.catchUp(peer), // every space, every time: small, and a PC that joined has the pane at once
      async () => { rows = (await parts.rows.catchUp(peer, since)) && rows; },
      async () => { if (!again) await parts.ledger?.catchUp(peer); }, // after the agents rows (they name each record's writer), before the wakes
      async () => { rows = (await parts.secrets.catchUp(peer, since)) && rows; }, // small, before the wakes: an API key travels as a secret
      () => parts.logins.catchUp(peer, again), // before the wakes, which may need it
      async () => parts.readings?.catchUp(peer, again), // small: the plans' newest numbers
      async () => parts.share?.catchUp(peer, again).catch((error: unknown) => s.log.warn('homes not shared', { peer, error: errorText(error) })), // before the wakes: a woken turn may open a page
      async () => { woke.add(peer); parts.rows.resume(peer); await catchUpFiles(); }, // the wakes before the files
    ];
    for (const step of steps) {
      if (!linked(peer)) { s.log.info('link-up ended, link gone', { peer }); return; } // no dial per step; the cursors stay
      if (running.get(peer)) { s.log.info('link-up again after a link swap', { peer }); return; } // the rerun starts at once
      await step();
    }
    if (rows) stamps.setCursor(peer, started, 'rows', pair);
    if (filesAt !== undefined) stamps.setCursor(peer, filesAt, 'files', pair);
    if (!again || !rows || !files) s.log.info('linked PC caught up', { peer, first: since === undefined, complete: rows && files, ...(again ? { again } : {}) });
  };
  const run = (peer: string, again = false): void => {
    if (running.has(peer)) {
      if (again) return; // the run on its way brings the same
      running.set(peer, true);
      // A swap during the last step (the files) may have cut the wakes' hand-over: release them again on the new link
      // right after the cut call has settled, not only after the files and the rerun.
      if (woke.delete(peer)) setTimeout(() => { if (linked(peer)) parts.rows.resume(peer); }, 0); // once per run
      return;
    }
    running.set(peer, false);
    void linkUp(peer, again)
      .catch((error: unknown) => s.log.warn('linked PC not caught up', { peer, error: errorText(error) }))
      .finally(() => {
        const swapped = running.get(peer);
        running.delete(peer);
        woke.delete(peer);
        if (swapped && linked(peer)) run(peer);
      });
  };
  return run;
}

/** `each` runs for every PC `peers` names, every `everyMs` – one unref'd timer, armed only while there is one (`check` after each change). */
export function rhythm(peers: () => readonly string[], each: (peer: string) => void, everyMs = REFRESH_MS): { check(): void; stop(): void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => { if (timer) clearInterval(timer); timer = undefined; };
  return {
    check: () => {
      if (!peers().length) { stop(); return; }
      if (timer) return;
      timer = setInterval(() => { for (const peer of peers()) each(peer); }, everyMs);
      (timer as { unref?: () => void }).unref?.();
    },
    stop,
  };
}

/** One round of the rhythm for a PC: its catch-up again, then 'sync.round' on the bus. */
export function round(s: Pick<RuntimeServices, 'bus' | 'log'>, run: (peer: string, again?: boolean) => void): (peer: string) => void {
  return (peer) => {
    run(peer, true);
    try { s.bus.emit('sync.round', { peer }); } catch (error) { s.log.warn('sync round not announced', { peer, error: errorText(error) }); }
  };
}

export function startSync(input: SyncInput): Sync {
  const { s, mesh } = input;
  const stamps = new Stamps(s.db, s.clock, s.host?.app?.version);
  const rows = new RowSync(s, stamps);
  const ledger = new LedgerSync(s, noteMove);
  const share = new ShareSync(s);
  const secrets = new SecretSync(s, stamps);
  const files = new FileSync(s, stamps);
  const logins = new LoginSync(s);
  const readings = new ReadingSync(s);
  const tabs = new TabSync(s, stamps);
  const paths = new RemotePaths(s, rows, PATH_OPS);
  const { add, revoke, selfInfo } = mesh;
  const roster = add && revoke && selfInfo ? new RosterSync(s, { register: mesh.register.bind(mesh), add: add.bind(mesh), revoke: revoke.bind(mesh), selfInfo: selfInfo.bind(mesh) }) : undefined;
  mesh.register('sync.rows', (params, from) => rows.receive(params, from), EVERY_LINK); // from an employee's PC only its person's own part (employee.ts)
  mesh.register(LEDGER_METHOD, (params, from) => ledger.receive(params, from), ['ceo', 'employer']); // Konrad 26.11.2026: from my employer only its moved agents' records (ledger.ts)
  mesh.register(SHARE_METHOD, (params, from) => share.receive(params, from), ['ceo']);
  mesh.register('sync.secret', (params, from) => secrets.receive(params, from));
  mesh.register('sync.file', (params, from) => files.receive(params, from));
  mesh.register('sync.login', (params, from) => logins.receive(params, from), EVERY_LINK); // only plans that PC shares (plan-peers.ts)
  mesh.register(READING_METHOD, (params, from) => readings.receive(params, from), EVERY_LINK);
  mesh.register('sync.tabs', (params, from) => tabs.receive(params, from));
  mesh.register('files.path', (params, from) => paths.serve(params, from), EVERY_LINK); // other people's PCs get only what is shared with them (paths.ts)
  mesh.register(UPDATE_METHOD, (_params, from) => serveUpdate(s, from), ['ceo']); // Update pressed on another own PC
  mesh.register('tabs.position', (params, from) => tabPositions(s).receive(params, from));
  const chatLive = chatLiveOf(s.bus);
  const live = chatLive ? new LiveSync(s, chatLive, (runId) => cancelRunHere(s, runId)) : undefined;
  if (live) {
    mesh.register(LIVE_METHOD, async (params, from) => live.receive(params, from), ['ceo']);
    mesh.register(CANCEL_METHOD, (params, from) => live.cancel(params, from), ['ceo']);
    bindLiveSync(s, live);
  }
  const unwatch = s.rootWatcher?.register(ROOT_SIDE_TABS, () => { announcePane(s); tabs.changed(); });

  let detach: (() => void) | undefined;
  const online = new Set<string>();
  const refresh = () => {
    const linked = links(s.db).length > 0;
    if (linked && !detach) {
      const offs = [rows.attach(), ledger.attach(), share.attach(), secrets.attach(), files.attach(input.tap), logins.attach(), readings.attach(), tabs.attach(), ...(roster ? [roster.attach()] : []), ...(live ? [live.attach()] : [])];
      detach = () => { for (const off of offs) off(); };
    } else if (!linked && detach) {
      detach();
      detach = undefined;
    }
  };
  const run = linkUps(s, stamps, { roster, tabs, rows, ledger, secrets, logins, readings, share, files }, (peer) => online.has(peer));
  const measure = (peer: string) => { void pingLink(s.devices, peer, { timeoutMs: PROBE_MS }).catch(() => undefined); }; // one mesh ping (link-quality.ts)
  const each = round(s, run);
  const beat = rhythm(() => [...online], (peer) => { measure(peer); each(peer); });
  // Which PC fires a schedule follows the links (tables.ts placeSchedules).
  const place = () => { try { placeSchedules(s); } catch (error) { s.log.warn('schedules not placed', { error: errorText(error) }); } };
  const off = s.bus.on('device.upserted', (device) => {
    if (device.kind !== 'pc' || device.self) return;
    refresh();
    if (device.status !== 'online') {
      online.delete(device.id);
      beat.check();
      live?.linkDown(device.id);
      if (device.status === 'revoked') { stamps.dropCursor(device.id); ledger.dropCursor(device.id); place(); }
      return;
    }
    if (online.has(device.id)) return;
    online.add(device.id);
    beat.check();
    place();
    live?.linkUp(device.id);
    run(device.id);
    measure(device.id);
  });
  const offRemoved = s.bus.on('device.removed', ({ id }) => live?.linkDown(id));
  refresh();
  return { stop: () => { off(); offRemoved(); online.clear(); beat.stop(); unwatch?.(); detach?.(); detach = undefined; bindLiveSync(s, undefined); } }; // a run still on its way ends at its next step
}
