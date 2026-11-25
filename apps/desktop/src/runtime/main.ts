// The runtime composition root: builds all services (compose/services.ts) and the client-
// facing network (compose/network.ts), runs crash/restart reconciliation, starts the event-
// driven parts (scheduler timer, account monitor, peer listener, sync and mesh, catalog, chat bridges, the owner's default
// 1:1 with every agent – chat/direct.ts keepOwnerDirects – and, B-080, last of all the dispatcher, right before 'ready')
// and shuts everything down in order. A staged restore is applied before the database opens. Used by the Electron utility process (entry-electron.ts) and the
// headless CLI (cli.ts) alike. The restore call and the stop steps live in compose/lifecycle.ts.
// Owns: the start order, what a host power event restarts (afterPower) and when the stop runs. Never: business logic; never polls.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ClientScope } from '../shared/api/protocol.ts';
import type { PowerEvent } from '../shared/api/host-bridge.ts';
import type { RuntimeServices } from './contracts.ts';
import type { Host } from './host.ts';
import type { RpcConnection } from './rpc/connection.ts';
import { createPaths, ensurePaths } from './system/paths.ts';
import { FileLogger } from './system/log.ts';
import { systemClock } from './system/clock.ts';
import { createCore, type Core } from './compose/services.ts';
import { createNetwork, type Network } from './compose/network.ts';
import { restoreAtStart, runStopSteps, stopSteps } from './compose/lifecycle.ts';
import { keepOwnerDirects } from './chat/direct.ts';
import { recordStart } from './tasks/recover-notes.ts';
import { sendUpdateNote } from './system/update-note.ts';
import { AgentRepo } from './store/agents.ts'; // B-059 #21
import { recoveryRuns } from './splits/reconcile.ts'; // B-057
import { reviewPromptOverrides } from './context/prompt-updates.ts';
import { startStandards } from './org/standard.ts';
import { runCost1117 } from './bridge/cost-1117.ts';
import { runSicher1119, runSicher1119Files } from './bridge/sicher-1119.ts';
import { runQuestsWake } from './bridge/quests-wake.ts';
import { runGeneral1121 } from './bridge/general-1121.ts';
import { runEineId1122 } from './bridge/eine-id-1122.ts';
import { runSecureWeb1125 } from './bridge/secure-web-1125.ts';
import { loginsFolder } from './root/companies.ts';
import { startSync } from './devices/sync/service.ts';
import { wakeWhenBack } from './devices/back-wake.ts';
import { startMoves } from './agents/move.ts'; // Umzug 21.11.2026
import { endCallsLeftOpen } from './calls/wiring.ts';
import { ensurePwsh } from './accounts/install.ts'; // B-080 wave 3
import { keepClisCurrent } from './engines/cli-update.ts'; // a provider's new model comes with a new Claude Code or Codex
import { planFrom } from './devices/sync/employee.ts'; // 22.11.2026: a plan that came from the company this PC works for

export interface RuntimeOptions {
  host: Host;
  dataDir: string;
  resourcesDir: string; // shipped resources (agents, modes, skills, prompts, model priors)
  staticDir: string; // built UI (app/ui) served to the PWA/phone
  workspaceDir?: string;
  launchToken: string;
  /** FX1 19.11.2026: owner scope marked `person` (http/types.ts) – memory only, never in runtime.json. */
  personToken?: string;
  version: string;
  fakeEngine?: boolean;
  port?: number;
  consoleLog?: boolean;
  /** Peer listener mode for this process (CLI `--peer lan|tailscale|off`); default settings.devices.peer. */
  peer?: 'lan' | 'tailscale' | 'off';
}

export interface Runtime {
  services: RuntimeServices;
  core: Core;
  network: Network;
  port: number;
  /** Serves owner-scope (or device-scope) RPC on a connection (MessagePort, test pipe …). */
  attach(connection: RpcConnection, scope?: ClientScope): () => void;
  shutdown(reason: 'quit' | 'update' | 'signal'): Promise<void>;
}

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const startedAt = Date.now();
  // The plans' homes: this PC's one logins folder beside its companies, shared by all of them (16.11.2026).
  const paths = ensurePaths(createPaths({ data: options.dataDir, resources: options.resourcesDir, workspace: options.workspaceDir, accounts: loginsFolder(options.host.app) }));
  const log = new FileLogger({ dir: paths.logs, clock: systemClock, console: options.consoleLog ?? false });
  log.info('runtime starting', { version: options.version, host: options.host.kind });
  // A restore staged by system.restore replaces the data now – before createCore opens the
  // database; a v2 backup's skills go back into the workspace (MM8).
  await restoreAtStart(paths, log, options.host);
  // 19.11.2026: profile.pcAccess/forEveryAgent → section security and its topic files, before the settings store reads the file (deleted with the bridge)
  runSicher1119Files(paths.data, paths.resources, log);

  let port = 0;
  const core = await createCore({ host: options.host, paths, log, version: options.version, fakeEngine: options.fakeEngine, baseUrl: () => `http://127.0.0.1:${port}` });
  const s = core.services;
  runEineId1122(s); // 22.11.2026: a seat's own code becomes its My ID, before the network opens the IDs (deleted with the bridge)
  const network = createNetwork({ core, staticDir: options.staticDir, launchToken: options.launchToken, personToken: options.personToken, startedAt, port: options.port, peer: options.peer });

  // Linked PCs share chats, tasks, agents, settings, files and secrets (devices/sync) – idle while no PC is linked. Its
  // listeners come first, so what the reconciliation changes (a run's row stopped or removed) travels like any change;
  // the link-ups follow the mesh below.
  const watcher = s.rootWatcher;
  const sync = startSync({ s, mesh: core.mesh, tap: watcher ? (listener) => watcher.tap(listener) : undefined });
  const offBackWake = wakeWhenBack(s); // B-080: an agent that could not reach a linked PC is woken once when it is back
  const offMoves = startMoves(s, { mesh: core.mesh }); // Umzug 21.11.2026: an agent's PC changed – what it runs and its record follow (agents/move.ts)

  // ---- reconciliation after a crash, update or power loss (before anything runs)
  const stopped = s.chats.reconcileStreaming();
  const calls = endCallsLeftOpen(s); // B-075: a call left open at a stop or crash ends at its last line, and that travels
  const runs = s.runs.reconcile();
  const wakes = s.wakes.reconcile();
  // B-059 #21: no turn runs yet – a 'working'/'waiting' status and step note left from before are stale.
  let idled = 0;
  try { idled = new AgentRepo(s.db).resetBusy(s.clock.now()); } catch (error) { log.warn('agent statuses not reset', { error: String(error) }); }
  log.info('reconciled', { streaming: stopped, calls, interruptedRuns: runs.interrupted, unknownEffects: runs.unknownEffects, wakes, idled });
  // C3: human/external messages a crash left without a wake (e.g. during the responder decision) are delivered once more.
  try { log.info('redelivered unanswered messages', { messages: s.delivery.recover?.() ?? 0 }); } catch (error) { log.warn('message redelivery failed', { error: String(error) }); }
  // First run: the Manager. B-050 K1 (Nachtrag Runde 4): the owner's default 1:1 with every active agent – the Manager's
  // is the first chat (untitled: named after the agent), so the person can start talking right away – is made now for
  // those without one (one transaction; empty, unread nothing, wakes nobody), and for a hire as the org announces it.
  // F14 / Eine-ID 22.11.2026: a company started to connect with an ID ('join') gets its agents with the link – no Manager
  // of its own (a later start without the flag still seeds an empty company).
  if (options.host.app.start !== 'join') s.org.ensureSeed();
  const offDirects = keepOwnerDirects(s);
  runSicher1119(s); // 19.11.2026: the old whole/careful PC line in each SYSTEM.md becomes today's (deleted with the bridge)
  runCost1117(s); // runs priced before 17.11.2026 get their notional cost from their own tokens, once (deleted with the bridge)
  runQuestsWake(s); // 20.11.2026: each agent with open work sorts it into quests once (deleted with the bridge)
  runSecureWeb1125(s); // 25.11.2026: Secure mode's web 'yes' becomes 'chosen' once (deleted with the bridge)
  runGeneral1121(s); // 21.11.2026: the 19.11. general text the sicher bridge copied into general.md goes; the person's lines stay (deleted with the bridge)
  reviewPromptOverrides(s); // an own prompt file follows the release while untouched; an edited one gets one review
  s.prompts?.invalidate();
  const offStandards = startStandards(s); // every SYSTEM.md keeps the team's standard as its last comment (owner 14.11.2026)
  // Demo/test mode: one account served by the deterministic fake engine, so the app works offline.
  if (options.fakeEngine && !s.accounts.list().some((account) => account.provider === 'compatible')) {
    await s.accounts.add({ provider: 'compatible', label: 'Demo engine', baseUrl: 'http://127.0.0.1:9/v1', demoEngine: true });
  }
  // B-057: a split's cut run is its part's (put back by splits/reconcile.ts) – no recovery note wakes its main self.
  const continued = s.ownership.recover({ interruptedRuns: recoveryRuns(s.runs, runs.runIds) });
  sendUpdateNote(s, options.version); // before recordStart advances the version marker
  // RC1: one notice after an update or a crash ("Updated to X · N tasks continued"), read by system.info.
  try { recordStart(s, { version: options.version, interrupted: runs.interrupted, continued }); } catch (error) { log.warn('start notice not stored', { error: String(error) }); }

  // ---- serve
  const listening = await network.http.listen();
  port = listening.port;
  writeRuntimeInfo(paths.data, port, options.launchToken);

  // ---- start the event-driven parts
  core.scheduler.start();
  core.accountMonitor.start(); // initial read, provider pushes and bounded automatic refreshes
  // The peer listener opens when a PC is linked or this PC accepts connect requests (a bind error shows in Settings › Devices).
  await network.peer.start();
  core.mesh.start(); // dials every linked PC; a newly connected PC is stored and dialled by the mesh itself
  // The peer listener (re)opened: linked PCs may reach this PC again – dial them now.
  const offPeerOpened = network.peer.onOpened(() => core.mesh.reconnect());
  core.catalog.start();
  network.bridges.start(); // chat bridges resume once the HTTP server listens
  void network.announceCaps().catch((error: unknown) => log.warn('device caps not announced', { error: String(error) }));
  // Detection runs CLI status commands – in the background, then the model catalog follows.
  // Adopted logins are checked by the monitor; after detection the monitor reads any plan that is due.
  void core.refreshDetection().then(() => { core.accountMonitor.activity(); return core.catalog.refresh(); }).catch((error) => log.warn('initial catalog refresh failed', { error: String(error) }));

  // Claude Code and Codex learn new models with new versions: each updates shortly after start and every 6 h, then the catalog lists again.
  const offCliUpdate = keepClisCurrent({
    supervisor: core.supervisor, finder: core.finder, log, demo: options.fakeEngine, cwd: paths.temp,
    // A plan row that came from the company this PC's person works for (employee PC) is no use of the person's own CLI here: that
    // install is theirs and their terminals share it. Only the person's own plans, or this company's own, keep it current.
    accounts: () => s.accounts.list().filter((account) => planFrom(s.db, account.id) === undefined),
    onUpdated: () => void core.catalog.refresh({ force: true }).catch(() => undefined),
  });

  const powerOff = options.host.onPower((event) => afterPower(event, {
    scheduler: s.scheduler, mesh: core.mesh, monitor: core.accountMonitor, refreshPeer: () => void network.peer.refresh(),
  }));

  let closing: Promise<void> | undefined;
  const runtime: Runtime = {
    services: s,
    core,
    network,
    port,
    attach: (connection, scope = { kind: 'owner' }) => network.rpc.attach(connection, scope),
    shutdown: (reason) => (closing ??= (async () => {
      log.info('runtime stopping', { reason });
      powerOff();
      offCliUpdate();
      offDirects();
      offStandards();
      offPeerOpened();
      sync.stop();
      offBackWake();
      offMoves();
      await runStopSteps(stopSteps(core, network), log);
      log.info('runtime stopped', { reason });
    })()),
  };
  // B-080: turns start only now, right before 'ready' – the host's boot watchdog (main/runtime-host.ts) never cuts one it
  // started during the slower start steps above (the peer listener took up to 11 s); start() pumps every due agent.
  core.dispatcher.start();
  log.info('runtime ready', { port, ms: Date.now() - startedAt });
  // B-080 wave 3: PowerShell 7 for the engines' shells where none is found (accounts/install.ts ensurePwsh) – in the
  // background, nothing waits for it; the engines started from now on find it on their PATH (engines/wf-shim.ts).
  if (process.platform === 'win32') {
    void ensurePwsh({ supervisor: core.supervisor, demo: options.fakeEngine })
      .then((installed) => { if (installed) log.info('PowerShell 7 installed for the engines\' shells'); })
      .catch((error: unknown) => log.warn('PowerShell 7 not installed', { error: String(error) }));
  }
  return runtime;
}

/**
 * What a host power event restarts: resume/unlock (the person is back) – the scheduler's timer, the links to
 * linked PCs, the peer listener and the plan readings; B-044 'online' (the app window's network came back) –
 * the links and the plan readings. Suspend and lock change nothing here.
 */
export function afterPower(event: PowerEvent, parts: {
  scheduler: Pick<RuntimeServices['scheduler'], 'arm'>; mesh: Pick<Core['mesh'], 'reconnect'>; monitor: Pick<Core['accountMonitor'], 'resume'>; refreshPeer(): void;
}): void {
  if (event === 'resume' || event === 'unlock') { parts.scheduler.arm(); parts.mesh.reconnect(); parts.refreshPeer(); parts.monitor.resume(); }
  if (event === 'online') { parts.mesh.reconnect(); parts.monitor.resume(); }
}

/** Local discovery for the CLI/tests (owner token, loopback port). 0600, inside the data dir. */
function writeRuntimeInfo(dataDir: string, port: number, token: string): void {
  try {
    writeFileSync(path.join(dataDir, 'runtime.json'), JSON.stringify({ port, token, pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 });
  } catch { /* discovery is optional */ }
}
