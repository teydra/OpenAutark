// Wires UpdateService (src/main/updates) to the desktop: restart-gate facts, the drain before
// quitAndInstall and its undo, the auto-download preference, the browser opener for the manual
// download (macOS) and state publication. macOS wraps the updater with mac-self-update.ts where that can work; from
// B-078 on, Windows and Linux install through their own relaunch helper (updates/install-helper.ts); a while after a
// start settleAfterStart tidies up after a Mac self-update.
// Drain order: renderer saves drafts (prepareRestart ack) → runtime pauses wakes and checkpoints
// (system.prepareRestart, B-080: with the version it installs) → runtime exits ('update').
// B-080: installFile – a build from a file (app.install / system.install through main's host op) installs the same way:
// the same drain, then the relaunch helper with that installer, then quit.
// F25 (16.11.2026): every company has its updater; the helper starts the company that installed again (its `args`, on a
// Mac too), and
// siblingVersion / installFailed pass a linked PC's version and a not-landed install on to the service.
// 19.11.2026 (E4/E5): the Update pressed on another own PC (updateNow) answers what the updater said after its fresh check
// and only then, ANSWER_FIRST_MS later, downloads and installs – the answer is out before the drain stops this app.
// Owns: that order and the "drained" flag, binding electron to the updater wrapper. Never: talks to
// electron-updater's download or install directly (the Updater is injected) or relaunches without the drain.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Device, UpdateAnswer } from '../shared/model/devices.ts';
import type { SystemInfo, UpdateState } from '../shared/model/system.ts';
import { WorkforceError } from '../shared/errors.ts';
import { runCommand, type LauncherDeps } from './launcher-tasks.ts';
import { appBundleOf, macSelfUpdater, settleMacUpdate, type FeedFile } from './updates/mac-self-update.ts';
import { UpdateService } from './updates/update-service.ts';
import type { Updater } from './updates/update-service.ts';
import { allowInstallerRetry } from './updates/install-retry.ts';
import { HELPER_LOG, installWithHelper, linuxHelper, spawnHelper, windowsHelper, type HelperLaunch } from './updates/install-helper.ts';

export interface DesktopUpdatesDeps {
  updater: Updater;
  packaged: boolean;
  enabled: boolean; // false in test mode: never contacts GitHub
  platform: string;
  arch: string;
  version: string;
  autoDownload(): boolean;
  renderer: { readonly rendererReady: boolean; prepareRestart(timeoutMs: number): Promise<boolean> };
  idleSeconds(): number;
  runtime: {
    readiness(): Promise<{ ready: boolean }>;
    /** system.prepareRestart; B-080: `to` – the version being installed. */
    prepareRestart(cancel: boolean, to?: string): Promise<void>;
    stop(reason: 'update'): Promise<void>;
    start(): void;
    /** 19.11.2026: devices.bye {reason: 'update'} – my other PCs show "Updating…" instead of "Not reachable". */
    bye?(reason: 'update'): Promise<unknown>;
  };
  /** B-080 (installFile): this app's process, executable, AppImage (Linux) and logs folder, and its quit; absent: no install from a file. */
  install?: { pid: number; exe: string; appImage?: string; logs: string; quit(launch: HelperLaunch): void; spawn?: typeof spawnHelper; exists?(file: string): boolean; args?: readonly string[] }; // F25: args – this company's start arguments
  publish(state: UpdateState): void;
  /** The system browser for the manual download (desktop.ts passes electron's shell; default: loaded on first use). Only https reaches it. */
  openExternal?(url: string): Promise<void>;
  log?(line: string): void;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export const DRAFT_FLUSH_TIMEOUT_MS = 8000;
/** installFile: how long after its quit request a still-running app waits before it takes its work back: after the install helper's own wait (install-helper.ts WAIT_SECONDS, 45 s), under the 60 s asked for on 18.11.2026. */
export const INSTALL_FILE_WATCHDOG_MS = 50_000;
/** updateNow: the longest the caller waits for the check's verdict (under the host bridge's 15 s), and the pause after it before an install drains this app. */
export const ANSWER_WAIT_MS = 10_000;
export const ANSWER_FIRST_MS = 3_000;

/**
 * electron-updater's autoUpdater (loaded only for packaged builds). Its export is a getter that
 * Node's CJS export detection misses, so read it from the namespace or the default export.
 */
export async function loadUpdater(quit: (launch: HelperLaunch) => void, log?: (line: string) => void, args: readonly string[] = []): Promise<Updater> {
  const loaded = await import('electron-updater') as unknown as { autoUpdater?: Updater; default?: { autoUpdater?: Updater } };
  const updater = loaded.autoUpdater ?? loaded.default?.autoUpdater;
  if (!updater) throw new Error('The updater is not available.');
  if (process.platform === 'win32') allowInstallerRetry(updater);
  if (process.platform === 'darwin') return selfUpdatingMac(updater, log, args);
  if (process.platform === 'win32' || process.platform === 'linux') await relaunchingHelper(updater, quit, log, args);
  return updater;
}

/** Windows and Linux: quitAndInstall starts the relaunch helper and quits; without it the library's own way runs. F25: `args` – this company's (it starts again). */
async function relaunchingHelper(updater: Updater, quit: (launch: HelperLaunch) => void, log: ((line: string) => void) | undefined, args: readonly string[]): Promise<void> {
  const { app } = await electronMain();
  const logs = path.join(app.getPath('userData'), 'logs');
  installWithHelper(updater, {
    platform: process.platform,
    pid: process.pid,
    args,
    exe: process.execPath,
    appImage: process.env.APPIMAGE,
    logFile: path.join(logs, HELPER_LOG),
    spawn: (launch, events) => spawnHelper(launch, logs, events),
    quit,
    log,
  });
}

/** What this needs of electron's main module (its exports sit on the namespace or the default export, as for shell below). */
interface ElectronMain {
  app: { getVersion(): string; getPath(name: 'userData'): string; quit(): void };
  net: { fetch(url: string): Promise<Response> };
  shell: { trashItem(target: string): Promise<void> };
}

async function electronMain(): Promise<ElectronMain> {
  const loaded = await import('electron') as unknown as Partial<ElectronMain> & { default?: Partial<ElectronMain> };
  return (loaded.app ? loaded : loaded.default) as ElectronMain;
}

/** The feed's file as a full address, as MacUpdater gets it: the library's provider knows the repository and the tag. */
export function feedFileUrl(updater: Updater, file: FeedFile, info: unknown): string {
  const { provider } = (updater as unknown as { updateInfoAndProvider?: { provider?: { resolveFiles(info: unknown): Array<{ url: URL; info: FeedFile }> } } }).updateInfoAndProvider ?? {};
  const match = provider?.resolveFiles(info).find(item => item.info.url === file.url);
  if (!match) throw new Error('The update address is not known.');
  return match.url.href;
}

const macCacheDir = () => path.join(os.homedir(), 'Library', 'Caches', 'workforce-self-update');

/** macOS: the zip swap of mac-self-update.ts. F25: `args` – this company's (the swap starts it again). */
async function selfUpdatingMac(updater: Updater, log: ((line: string) => void) | undefined, args: readonly string[]): Promise<Updater> {
  const bundle = appBundleOf(process.execPath);
  if (!bundle) return updater;
  const { app, net } = await electronMain();
  return macSelfUpdater(updater, {
    bundle,
    version: app.getVersion(),
    pid: process.pid,
    arch: process.arch,
    cacheDir: macCacheDir(),
    resolveUrl: (file, info) => feedFileUrl(updater, file, info),
    fetch: url => net.fetch(url),
    run: runCommand,
    spawnHelper: (args, onError) => {
      const child = spawn('/bin/sh', args, { detached: true, stdio: 'ignore', cwd: path.dirname(bundle) });
      child.on('error', onError);
      child.unref();
    },
    quit: () => app.quit(),
    log,
    args,
  }) ?? updater;
}

export const SETTLE_AFTER_START_MS = 90_000; // after the runtime's STABLE_MS (repair/journal.ts) and the installer's own end

/** macOS: tidies up what a self-update left behind (the previous bundle), once this start proved itself. */
export function settleAfterStart(deps: { dataDir: string; version: string; launcher: LauncherDeps; log(line: string): void }): void {
  const { platform, packaged, testMode } = deps.launcher;
  if (!packaged || testMode || platform !== 'darwin') return;
  setTimeout(() => {
    const settle = async () => {
      const { shell } = await electronMain();
      await settleMacUpdate({
        bundle: appBundleOf(process.execPath),
        version: deps.version,
        dataDir: deps.dataDir,
        cacheDir: macCacheDir(),
        trash: target => shell.trashItem(target),
        log: deps.log,
      });
    };
    void settle().catch((error: unknown) => deps.log(`settling after start failed: ${(error as Error)?.message ?? 'error'}`));
  }, SETTLE_AFTER_START_MS).unref();
}

/** Opens an https address with `open` – the manual download is never anything else, whatever opener is injected. */
export async function openHttps(url: string, open: (url: string) => Promise<void> = shellOpenExternal): Promise<void> {
  if (!/^https:\/\//i.test(url)) throw new Error('Only https download links are opened.');
  await open(url);
}

/** Opens an address in the system browser through electron's shell (loaded on first use; openHttps checks it). */
async function shellOpenExternal(url: string): Promise<void> {
  const loaded = await import('electron') as unknown as { shell?: { openExternal(url: string): Promise<void> }; default?: { shell?: { openExternal(url: string): Promise<void> } } };
  const shell = loaded.shell ?? loaded.default?.shell;
  if (!shell) throw new Error('The browser could not be opened.');
  await shell.openExternal(url);
}

/** What siblingUpdates reads from the runtime over main's own link. */
export interface SiblingRpc {
  on(event: 'device.upserted', listener: (device: Device) => void): () => void;
  subscribe(topic: 'system'): Promise<() => void>;
  call(method: 'system.info'): Promise<SystemInfo>;
}

/**
 * F25 (16.11.2026): a linked own PC's version (device.upserted carries its caps; my own PCs only – no employee's PC,
 * none this PC joined as an employee) reaches the updater, and at each runtime start this start's notice – an install
 * that did not land names its version (SystemInfo.notice `to`). Returns what to call when the runtime is up.
 */
export function siblingUpdates(rpc: SiblingRpc, updates: Pick<DesktopUpdates, 'siblingVersion' | 'installFailed'>): () => void {
  rpc.on('device.upserted', (device) => {
    const own = device.kind === 'pc' && !device.self && !device.personId && device.joinedAs !== 'employee' && device.status === 'online';
    if (own && typeof device.caps?.version === 'string') updates.siblingVersion(device.caps.version);
  });
  void rpc.subscribe('system');
  return () => {
    void rpc.call('system.info').then((info) => { if (info.notice?.failed && info.notice.to) updates.installFailed(info.notice.to); }, () => {});
  };
}

/** A stand-in for electron-updater in development and test mode (UpdateService never calls it). */
export function inactiveUpdater(): Updater {
  return {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: false,
    logger: null,
    on: () => undefined,
    checkForUpdates: () => Promise.resolve(null),
    downloadUpdate: () => Promise.resolve(null),
    quitAndInstall: () => undefined,
  };
}

export class DesktopUpdates {
  readonly service: UpdateService;
  private readonly deps: DesktopUpdatesDeps;
  private quitCommitted = false; // before-quit reached with a drained runtime; do not resume work
  private drained = false; // runtime already stopped for the installer
  private paused = false; // runtime paused by system.prepareRestart
  private updateQuitPending = false; // native before-quit-for-update precedes the library's queued app.quit
  private readonly watchers = new Set<(state: UpdateState) => void>(); // updateNow waits on the states it needs

  constructor(deps: DesktopUpdatesDeps) {
    this.deps = deps;
    this.service = new UpdateService(deps.updater, {
      packaged: deps.packaged,
      enabled: deps.enabled,
      platform: deps.platform,
      arch: deps.arch,
      version: deps.version,
      autoDownload: deps.autoDownload,
      facts: () => this.facts(),
      prepareInstall: (to) => this.prepareInstall(to),
      cancelInstall: () => this.cancelInstall(),
      openExternal: url => openHttps(url, deps.openExternal),
      changed: state => { for (const watch of [...this.watchers]) watch(state); deps.publish(state); },
      log: deps.log,
      now: deps.now,
      setTimer: deps.setTimer,
      clearTimer: deps.clearTimer,
    });
  }

  /** True between the drain and the installer taking over (quit must not drain again). */
  get draining(): boolean { return this.drained; }

  /** A helper may be allowed to force this quit now. The runtime must stay stopped from here on. */
  commitDrainedQuit(): boolean {
    if (!this.drained) return false;
    this.quitCommitted = true;
    this.dispose(); // clears the self-update recovery timer
    return true;
  }

  markUpdateQuit(): void { this.updateQuitPending = true; }

  /** Block only the updater's queued quit after a failed spawn; a later ordinary Quit still works. */
  blockFailedUpdateQuit(): boolean {
    const pending = this.updateQuitPending;
    this.updateQuitPending = false;
    const state = this.service.state;
    return pending && state.status === 'downloaded' && state.failure === 'restart';
  }

  state(): UpdateState { return this.service.state; }
  apply(): Promise<UpdateState> { return this.service.apply(); }
  /**
   * 19.11.2026 (host op app.update): the Update button pressed from another own PC. Answers with the first state after a fresh
   * check that says what happens (at most ANSWER_WAIT_MS); after the check, and ANSWER_FIRST_MS later, it downloads and
   * installs what it found (a manual-only update stays offered here).
   */
  async updateNow(): Promise<UpdateState> {
    const checked = this.service.check();
    const verdict = this.until((state) => state.status !== 'idle' && state.status !== 'checking');
    const late = new Promise<UpdateState>((resolve) => this.timer(() => resolve(this.service.state), ANSWER_WAIT_MS));
    const answer = await Promise.race([verdict.state, checked, late]).finally(verdict.stop);
    void checked.then(() => new Promise((resolve) => this.timer(() => resolve(undefined), ANSWER_FIRST_MS)))
      .then(() => this.until((state) => state.status !== 'checking' && state.status !== 'downloading').state)
      .then((state) => (state.status === 'downloaded' || (state.status === 'available' && state.automaticInstall) ? this.service.apply() : state))
      .catch((error: unknown) => this.deps.log?.(`update from another PC did not go on: ${(error as Error)?.message ?? 'error'}`));
    return answer;
  }

  /** The current state when it is `done`, else the next published one that is (`stop` gives up the wait). */
  private until(done: (state: UpdateState) => boolean): { state: Promise<UpdateState>; stop(): void } {
    let watch: ((state: UpdateState) => void) | undefined;
    const now = this.service.state;
    const state = done(now) ? Promise.resolve(now) : new Promise<UpdateState>((resolve) => {
      watch = (next) => { if (done(next)) { this.watchers.delete(watch!); resolve(next); } };
      this.watchers.add(watch);
    });
    return { state, stop: () => { if (watch) this.watchers.delete(watch); } };
  }

  private timer(fn: () => void, ms: number): void {
    if (this.deps.setTimer) this.deps.setTimer(fn, ms);
    else setTimeout(fn, ms).unref?.();
  }
  defer(): UpdateState { return this.service.defer(); }
  start(): void { this.service.start(); }
  dispose(): void { this.service.dispose(); }
  setVisible(visible: boolean): void { this.service.setVisible(visible); }
  checkIfDue(): void { void this.service.checkIfDue().catch(() => {}); }
  /** F25: a linked own PC runs `version` (a newer one asks for one check now). */
  siblingVersion(version: string): void { this.service.siblingVersion(version); }
  /** F25: this start's notice says the install of `version` did not land here. */
  installFailed(version: string): void { this.service.installFailed(version); }

  /** The preference changed elsewhere (settings page) or the UI readiness changed. */
  reevaluate(): void { void this.service.evaluateRestart().catch(() => {}); }
  autoDownloadChanged(): void { this.service.autoDownloadChanged(); }

  private async facts(): Promise<{ rendererReady: boolean; idleSeconds: number; runtimeReady: boolean }> {
    const base = {
      rendererReady: this.deps.renderer.rendererReady,
      idleSeconds: this.deps.idleSeconds(),
    };
    // After the drain the runtime is intentionally gone: its work is checkpointed, so it is ready.
    if (this.drained) return { ...base, runtimeReady: true };
    return { ...base, runtimeReady: (await this.deps.runtime.readiness()).ready };
  }

  /**
   * B-080 (host op app.install – app.install / system.install): a build from a file installs the way an update does – the
   * file must exist, then the same drain, then the relaunch helper with this installer (Windows: its Setup .exe; Linux:
   * the AppImage moved over $APPIMAGE) and quit. macOS refuses. A helper that cannot start resumes the app; any refusal
   * before it tells the runtime (system.prepareRestart {cancel}), which answers the install record it kept (tasks/recover-notes.ts).
   */
  async installFile(installer: string): Promise<void> {
    const own = this.deps.install;
    try {
      if (!own || this.deps.platform === 'darwin') throw new WorkforceError('unavailable', 'This app cannot install a build from a file here.');
      if (!(own.exists ?? existsSync)(installer)) throw new WorkforceError('not_found', 'The installer file does not exist.');
      const logFile = path.join(own.logs, HELPER_LOG);
      const launch = this.deps.platform === 'win32' ? windowsHelper({ pid: own.pid, installer, exe: own.exe, logFile, args: own.args })
        : own.appImage ? linuxHelper({ pid: own.pid, downloaded: installer, appImage: own.appImage, logFile, args: own.args }) : undefined;
      if (!launch) throw new WorkforceError('unavailable', 'This app was not started from an AppImage, so it cannot replace itself.');
      await this.prepareInstall();
      this.deps.log?.('installing a build from a file');
      (own.spawn ?? spawnHelper)(launch, own.logs, {
        // Recover if the quit request never reaches before-quit.
        started: () => { this.watchInstall(); own.quit(launch); },
        failed: () => { this.deps.log?.('install helper did not start; resuming'); this.cancelInstall(); },
        ended: () => {},
      });
    } catch (error) {
      const held = this.drained || this.paused; // cancelInstall tells such a runtime itself
      this.cancelInstall();
      if (!held) void this.deps.runtime.prepareRestart(true).catch(() => {}); // B-080: it answers the install record it kept
      throw error;
    }
  }

  /**
   * An app that was asked to quit for an install and is still running when the helper has given up did not quit (18.11.2026:
   * an exception in the quit left it up with the runtime stopped from 13:06 to 22:35 – nobody worked and nobody noticed). It takes
   * its work back after INSTALL_FILE_WATCHDOG_MS and says so; a quit that works ends this process before the timer fires.
   */
  private watchInstall(): void {
    const fire = (): void => {
      if (this.quitCommitted || (!this.drained && !this.paused)) return;
      this.deps.log?.(`INSTALL FAILED: the app did not end within ${INSTALL_FILE_WATCHDOG_MS / 1000} s; the runtime resumes`);
      this.cancelInstall();
    };
    if (this.deps.setTimer) this.deps.setTimer(fire, INSTALL_FILE_WATCHDOG_MS);
    else setTimeout(fire, INSTALL_FILE_WATCHDOG_MS).unref?.();
  }

  private async prepareInstall(to?: string): Promise<void> {
    if (this.quitCommitted) throw new Error('The app is already quitting for an install.');
    if (!(await this.deps.renderer.prepareRestart(DRAFT_FLUSH_TIMEOUT_MS))) {
      throw new Error('The window did not confirm that its drafts are saved.');
    }
    try {
      await this.deps.runtime.prepareRestart(false, to);
      this.paused = true;
    } catch (error) {
      // A runtime that is not running has nothing to pause; anything else aborts the update.
      if (!(error instanceof WorkforceError && error.code === 'unavailable')) throw error;
    }
    await this.deps.runtime.bye?.('update').catch(() => undefined);
    await this.deps.runtime.stop('update');
    this.drained = true;
    this.paused = false;
    this.deps.log?.('drained for update install');
  }

  /**
   * The restart did not happen after all: bring everything back. B-080: a paused runtime hears the cancel and answers the
   * install record it kept; a drained one starts again and answers it at its start (the same app process: no install).
   */
  private cancelInstall(): void {
    if (this.quitCommitted) return;
    if (this.drained) {
      this.drained = false;
      this.deps.runtime.start();
    } else if (this.paused) {
      void this.deps.runtime.prepareRestart(true).catch(() => {});
    }
    this.paused = false;
    this.deps.log?.('update install cancelled; resumed');
  }
}

/** 19.11.2026 (host op app.update – system.update {device}): this PC's Update button, pressed from another of the owner's PCs; E4: what its updater said. */
export async function updateFromElsewhere(updates: DesktopUpdates | null | undefined, log: (line: string) => void): Promise<UpdateAnswer> {
  if (!updates) throw new WorkforceError('unavailable', 'The updater on this PC is not ready yet.');
  const { status, version, availableVersion, message, automaticInstall } = await updates.updateNow();
  log(`update from another PC: ${status}${availableVersion ? ` ${availableVersion}` : ''}`);
  return { ok: true, status, version, automaticInstall, ...(availableVersion ? { availableVersion } : {}), ...(message ? { message } : {}) };
}
