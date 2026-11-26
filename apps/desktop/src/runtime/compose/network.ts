// Composition root, part 2: everything that serves clients – the devices (phone/browser access + web push,
// connecting PCs, the meeting server, the peer listener, the device tools: devices/connect.ts), the people of the
// organisation, the RPC surface (RpcExtras), the HTTP server, feedback/onboarding, the live screen preview and the
// browser live view, the media library, agent export/backup and chat bridges (telegram.connect).
// Owns: wiring and the small system/restart adapter (B-080: it keeps an update's version for the next start). Never: business logic.

import os from 'node:os';
import type { RuntimeServices } from '../contracts.ts';
import type { ResourceState, RuntimeUsage, SystemInfo } from '../../shared/model/system.ts';
import type { Core } from './services.ts';
import type { RpcExtras } from '../rpc/extras.ts';
import type { PwaService } from '../pwa/service.ts';
import { qrDataUrl } from '../pwa/qr.ts';
import { createDevices } from '../devices/connect.ts';
import { createPeople } from './people.ts';
import { createPolicyApi } from '../routing/policies.ts';
import { RpcServer } from '../rpc/server.ts';
import { HttpServer } from '../http/server.ts';
import { DEFAULT_PORT, bindHostFor } from '../http/listen.ts';
import type { PeerMode, PeerServer } from '../http/peer-server.ts';
import { FeedbackService } from '../feedback/service.ts';
import { Onboarding } from '../onboarding/service.ts';
import { createTeamStart } from './team-start.ts';
import { ComputerService } from '../computer/service.ts';
import { followBrokerSetup, localBroker } from '../computer/broker.ts';
import { RestartSignIn, signInTool } from '../computer/signin.ts';
import { KvRepo } from '../store/kv.ts';
import { BrowserService } from '../browser/service.ts';
import { startBrowserView } from '../browser/view.ts';
import type { NavGuard } from '../browser/nav-guard.ts';
import { PointerHub } from '../pointers/hub.ts'; // B-055
import { registerSideView } from '../devices/side-view.ts'; // B-076
import { registerBrowserView } from '../devices/browser-view.ts'; // 21.11.2026
import { registerPane } from '../pane/mesh.ts'; // 21.11.2026
import '../contracts/pointers.ts'; // RuntimeServices.pointers
import { Portability } from '../portability/service.ts';
import { Bridges } from '../bridges/service.ts';
import { dropInstall, noteUpdate, readStartNotice } from '../tasks/recover-notes.ts';
import { RestartPause } from './restart-pause.ts';

export interface NetworkOptions {
  core: Core;
  staticDir: string;
  launchToken: string;
  /** FX1: the in-memory person token (http/types.ts). */
  personToken?: string;
  startedAt: number;
  /** Fixed port (tests: 0 = ephemeral). Default from settings/47811. */
  port?: number;
  /** Peer listener mode for this process (headless CLI `--peer`); default settings.devices.peer. */
  peer?: PeerMode;
}

export interface Network {
  rpc: RpcServer;
  http: HttpServer;
  pwa: PwaService;
  computer: ComputerService;
  browser: BrowserService;
  /** Agent export/duplicate, backup/restore (R4). */
  portability: Portability;
  /** Chat bridges (R4): started by main.ts after the HTTP server listens, stopped on shutdown. */
  bridges: Bridges;
  /** Dedicated listener linked PCs reach this PC on (started by main.ts, closed on shutdown). */
  peer: PeerServer;
  /** The device connections (meeting server, connect requests, LAN answers): stopped before the peer listener. */
  devices?: { stop(): void };
  /** The updater's restart pause (system.prepareRestart): closed first at shutdown, so its timer never starts agent work again. */
  restartPause?: RestartPause;
  extras: RpcExtras;
  announceCaps(): Promise<void>;
}

/** Secure mode's site check for the agents' own browsers (browser/nav-guard.ts), read from services.security at each step. */
export function navGuardOf(services: () => Pick<RuntimeServices, 'security'>): NavGuard {
  const security = () => { try { return services().security; } catch { return undefined; } };
  return {
    active: () => { const now = security()?.current(); return now?.mode === 'secure' && now.web !== 'yes'; },
    open: (agentId, site) => security()?.check({ agentId, capability: 'web', site, fingerprint: '' }) === 'open',
  };
}

export function createNetwork(options: NetworkOptions): Network {
  const { core } = options;
  const s: RuntimeServices = core.services;
  const services = () => s;
  let port = 0;

  // Hands and eyes for agents: the computer and the browser (the device tools register them, devices/connect.ts).
  s.pointers = new PointerHub({ bus: s.bus, now: () => s.clock.now() }); // B-055: named pointers (browsers, screens)
  const computer = new ComputerService({ host: s.host, supervisor: core.supervisor, resourcesDir: s.paths.resources, log: s.log, services });
  followBrokerSetup(s.bus); // F03: how the desktop broker's setup at the app's start ended (main/broker-setup.ts)
  if (process.platform === 'win32' && s.host.app.packaged && !process.env.WORKFORCE_TEST_DATA) { // 22.11.2026: sign-in after a restart through the desktop broker (computer/signin.ts)
    const signIn = new RestartSignIn({ broker: () => localBroker(), secrets: s.secrets, kv: new KvRepo(s.db), log: s.log, now: () => s.clock.now() });
    s.tools.register(signInTool(signIn));
    void signIn.start();
  }
  const browser = new BrowserService({ paths: s.paths, log: s.log, guard: navGuardOf(services) }); // 25.11.2026: Secure mode's site check (browser/nav-guard.ts)
  startBrowserView(services, browser); // the person's live view of agent browsers (rpc browser.*)
  registerSideView(core.mesh, services); // B-076: this PC's side-browser tabs for the owner's other PCs (mesh side.*)
  registerBrowserView(core.mesh, services); // 21.11.2026: this PC's agents' own browsers for the owner's other PCs (mesh browser.*)
  registerPane(core.mesh, services); // 21.11.2026: the pane between people – put, remove, share, relay (runtime/pane)
  const devices = createDevices({
    s, identity: core.identity, mesh: core.mesh, computer, browser,
    adb: { supervisor: core.supervisor, finder: core.finder }, port: () => port, peerMode: options.peer,
  });
  createPeople(s, devices.pwa, qrDataUrl); // F-52: people of the organisation – invites, person tokens, revocation

  const onboarding = new Onboarding({ services });
  createTeamStart(s, services); // F-51: team patterns
  const feedback = new FeedbackService({ services });
  feedback.start(); // B-055: on the team's PC one inbox fetch shortly after start (no timer after it)
  const portability = new Portability({ services });
  const bridges = new Bridges({ services });
  for (const tool of [...core.media.tools(), ...bridges.tools()]) s.tools.register(tool); // media.* and telegram.connect

  const network = {} as Network;
  const restartPause = new RestartPause({
    stop: () => core.dispatcher.stop(), start: () => core.dispatcher.start(), dropped: () => dropInstall(s),
    log: (message, data) => s.log.info(message, data),
  });
  const cpuMark = { cpuMs: 0, uptimeMs: 0 }; // the previous system.resources read (MM9 runtime usage)
  const extras: RpcExtras = {
    media: core.media,
    portability,
    bridges,
    pwa: devices.pwa,
    mesh: core.mesh,
    feedback,
    onboarding,
    system: {
      info: (): SystemInfo => ({
        version: s.host.app.version, platform: process.platform, arch: process.arch, dataDir: s.paths.data,
        deviceId: core.identity.deviceId, deviceName: core.mesh.self().name, packaged: s.host.app.packaged, startedAt: options.startedAt, peer: devices.peer.state(),
        notice: readStartNotice(s),
      }),
      resources: (): ResourceState => ({
        freeMemoryMb: Math.round(os.freemem() / 1048576), totalMemoryMb: Math.round(os.totalmem() / 1048576),
        cpuCount: os.availableParallelism?.() ?? os.cpus().length, heavySlots: core.dispatcher.capacity(), // B-080: how many of its parts an agent runs at once (no global limit, no RAM slots)
        heavyInUse: core.supervisor.leases().filter((lease) => lease.kind === 'heavy').length, queued: s.wakes.pending(),
        processes: core.supervisor.leases().map((lease) => ({ kind: lease.owner.split(':')[0], pid: lease.pid ?? 0, idleMs: s.clock.now() - lease.lastActiveAt })),
        runtime: runtimeUsage(cpuMark),
      }),
      restartReadiness: () => {
        const working = core.dispatcher.activity();
        // B-057: distinct agents (one entry per turn); their splits' lanes are counted apart, never as more agents.
        const agents = new Set(working.filter((entry) => !entry.split).map((entry) => entry.agentId)).size;
        const splits = working.filter((entry) => entry.split).length;
        const reasons = [...(agents ? [`${agents} agent${agents === 1 ? ' is' : 's are'} working`] : []), ...(splits ? [`${splits} split${splits === 1 ? ' is' : 's are'} running`] : [])];
        return { ready: reasons.length === 0, reasons };
      },
      prepareRestart: async (cancel, to) => {
        // B-080: the update's version is kept for the next start's answer (recover-notes.ts); a cancel answers and drops
        // the install that did not happen (the agent that started one hears it at once). 16.11.: a pause no restart
        // follows ends by itself (restart-pause.ts); only main's own link calls this (rpc/handlers/system.ts), and the
        // shutdown closes the pause first (lifecycle.ts).
        if (cancel) { restartPause.end('cancel'); return; }
        if (to) noteUpdate(s, to);
        await restartPause.pause(); // interrupted turns resume after the restart (ownership loop)
        try { s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (error) { s.log.warn('wal checkpoint failed', { error: String(error) }); }
      },
    },
    computer: { preview: (input) => computer.preview(input) },
    voice: s.stt, // the one speech-to-text service (compose/services.ts), shared with agent hearing
    policies: createPolicyApi(services),
    catalogRefresh: async () => {
      await core.catalog.refresh({ force: true });
      const status = core.catalog.status();
      return { models: status.models, fetchedAt: status.refreshedAt ?? s.clock.now() };
    },
    catalogStatus: () => core.catalog.status(), // RT5: catalog sizes (models, available, last refresh)
    remote: devices.remote, // connecting PCs (Settings › Devices)
    relay: { state: () => devices.meeting.state() }, // the meeting server
  };

  const rpc = new RpcServer({ services, extras: () => extras, log: s.log });
  const http = new HttpServer({
    services, rpc, mcp: core.mcp, pwa: devices.pwa, pairing: devices.http, mesh: core.mesh,
    staticDir: options.staticDir, launchToken: options.launchToken, personToken: options.personToken, log: s.log,
    bind: () => ({ host: bindHostFor(s.settings.get().pwa.bind), port: options.port ?? DEFAULT_PORT }),
    peerMode: () => options.peer ?? s.settings.get().devices.peer,
  });
  const listen = http.listen.bind(http);
  http.listen = async () => { const result = await listen(); port = result.port; core.mesh.updateSelf({ addresses: devices.peer.state().addresses }); return result; };

  return Object.assign(network, {
    rpc, http, pwa: devices.pwa, computer, browser, portability, bridges, extras,
    peer: devices.peer,
    devices: { stop: devices.stop },
    restartPause,
    /** What this PC offers linked PCs (computer use, browser); phones are probed on request only. */
    announceCaps: devices.announceCaps,
  });
}

/** MM9: the runtime process's memory and CPU (cpuPercent of one core since the previous read). There is no vector index any more: `vectors` stays 0 unless a caller passes one. */
export function runtimeUsage(mark: { cpuMs: number; uptimeMs: number }, vectors: { workers: number; bytes: number } = { workers: 0, bytes: 0 }): RuntimeUsage {
  const cpu = process.cpuUsage();
  const cpuMs = (cpu.user + cpu.system) / 1000;
  const uptimeMs = process.uptime() * 1000;
  const cpuPercent = uptimeMs > mark.uptimeMs ? ((cpuMs - mark.cpuMs) / (uptimeMs - mark.uptimeMs)) * 100 : 0;
  Object.assign(mark, { cpuMs, uptimeMs });
  const memory = process.memoryUsage();
  const mb = (bytes: number) => Math.round(bytes / 104857.6) / 10;
  return {
    pid: process.pid, rssMb: mb(memory.rss), heapUsedMb: mb(memory.heapUsed), heapTotalMb: mb(memory.heapTotal), externalMb: mb(memory.external), cpuMs: Math.round(cpuMs), uptimeMs: Math.round(uptimeMs),
    cpuPercent: Math.round(cpuPercent * 10) / 10, vectorWorkers: vectors.workers, vectorIndexMb: mb(vectors.bytes),
  };
}
