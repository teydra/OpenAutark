// Composition root of the Electron main process (started by index.ts once the app is ready):
// runtime utility process + main's RpcClient, protocols, session guards, IPC, window, tray,
// updates, power events, "Keep agents running" (launcher-tasks.ts registers it; after a
// deliberate quit launcher-windows.ts writes the next due work's start; quit marks in run-state.json,
// the system's session end via session-end.ts), close-to-tray (closing the window keeps agents running; the tray's Quit
// ends them), the emergency stop of all agent work (tray entry, shortcut while agents work, notice afterwards;
// work-stop.ts), the hidden video-keyframe windows (hidden-windows.ts) and graceful quit. Speech runs in the
// page and the runtime: main only opens the microphone (security.ts MediaArm). B-072: another company (companies.ts)
// keeps its workspace and downloads in its own folder, has its own launcher task, names itself in the window title
// and tray tooltip ("Autark – <label>"), and – F25, 16.11.2026 – updates itself like the first (the relaunch helper starts it
// again; a linked own PC on a newer version asks for a check, a start whose install did not land keeps that version from
// installing by itself again: siblingUpdates); the emergency stop reaches them all; a company taken off this PC goes to
// the recycle bin once it has ended (company-remove.ts, 16.11.2026).
// B-080: the host op app.install reaches the updater wiring (installFile), and a start with a window sets up the desktop
// broker where it is missing (broker-setup.ts). B-081: the side tabs' Pin picker and the AI cursor over the screen (screen-cursor.ts).
// 18.11.2026: the floating to-do button (float-bar*.ts; the first company; 19.11.: tray Show/Hide, its call in the hidden page).
// Owns: constructing and connecting the main-side modules. Never: business logic (runtime),
// UI decisions (renderer), long work on the main thread.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BaseWindow, BrowserWindow, Menu, MessageChannelMain, Notification, Tray, app, autoUpdater as nativeUpdater, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage, powerMonitor,
  powerSaveBlocker, protocol, safeStorage, screen, session, shell, utilityProcess,
} from 'electron';
import type { MessagePortMain } from 'electron';
import { IPC } from '../shared/api/desktop.ts';
import { appInfo, appPaths } from './app-paths.ts';
import { Capture, windowLayers } from './capture.ts';
import { callCompany, companyArgs, openCompany, spawnApp, startFlag, stopOtherCompanies } from './companies.ts';
import { removeCompany, sweepRemoved } from './company-remove.ts';
import { desktopIpcDeps } from './desktop-ipc.ts';
import { hiddenWindows } from './hidden-windows.ts';
import { HostServices } from './host-services.ts';
import { registerIpc } from './ipc.ts';
import { applyLauncher, launcherDeps } from './launcher-tasks.ts';
import { pcKeepAwakeFor } from './keep-awake.ts';
import { setupBroker } from './broker-setup.ts'; // B-080
import { armDueStart } from './launcher-windows.ts';
import { RunStateMarks } from './launcher.ts';
import { guardMainErrors } from './crash-guard.ts'; // 17.11.2026: an uncaught error is a main.log line, never Electron's dialog
import { openMainLog } from './main-log.ts';
import { ProtocolHandlers, registerProtocolHandlers } from './protocols/handlers.ts';
import { RendererLink } from './renderer-link.ts';
import { RuntimeHost } from './runtime-host.ts';
import type { RuntimeChild } from './runtime-host.ts';
import { personTokenOf, RuntimeLink, runtimeEnv } from './runtime-link.ts';
import { MediaArm } from './security.ts';
import { sessionEnded, watchSessionEnd } from './session-end.ts';
import { guardAllContents, installSessionGuards } from './session-guards.ts';
import { SettingsView, changedPreferences } from './settings-view.ts';
import { beforeDesktopQuit } from './shutdown.ts'; import { quitWake, sleeperScript } from './sleeper.ts'; // 19.11.2026: goodbye + wake helper
import { applyWaker } from './waker.ts'; // 0.3.19: the broker's waker registration
import { AppTray } from './tray.ts';
import { DesktopUpdates, inactiveUpdater, loadUpdater, settleAfterStart, siblingUpdates, updateFromElsewhere } from './updates-wiring.ts';
import { MainWindow } from './window.ts';
import { WorkspaceBrowser } from './workspace-browser.ts';
import { setFillRpc } from './workspace-fill.ts';
import { SideDriver } from './side-driver/driver.ts'; // B-055 F1
import { SideCaster } from './side-driver/caster.ts'; // B-076
import { OWNER_ALIAS } from '../shared/model/people.ts';
import { companyLabel } from '../shared/model/companies.ts';
import type { AppInfo } from '../shared/api/host-bridge.ts';
import { personalDownloads } from './workspace-downloads.ts';
import { WorkStopControl, type WorkStopRpc } from './work-stop.ts';
import { ScreenCursor, electronCursorOverlays } from './screen-cursor.ts'; // B-081
import { loadWindowState, saveWindowState } from './window-state.ts';
import { startFloatBar } from './float-bar-window.ts'; // owner 18.11.2026: the floating to-do button

export interface DesktopOptions {
  background: boolean; // started at sign-in or by the launcher: tray + runtime, no window
  testData: string | null; // WORKFORCE_TEST_DATA: isolated profile, no network updater
  company: string | null; // B-072: another company's id (--company=<id>); null = the first company
  companies: AppInfo['companies'] | null; // B-072: where the companies live; null in a test profile
}

export interface Desktop {
  show(): void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'error';
}

export async function startDesktop(options: DesktopOptions): Promise<Desktop> {
  const testMode = options.testData !== null;
  const platform = process.platform;
  const productName = app.getName();
  if (platform === 'win32') app.setAppUserModelId('com.teydralab.workforce');
  if (platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  guardAllContents(app);

  const paths = appPaths({ appPath: app.getAppPath(), userData: app.getPath('userData') });
  const log = openMainLog(paths.logs, !app.isPackaged);
  guardMainErrors(process, line => log.line(line));
  const runMarks = new RunStateMarks(paths.data, line => log.line(line)); // B-044: every deliberate quit is marked (launcher.ts)
  log.line(`starting ${app.getVersion()}${app.isPackaged ? '' : ' (development)'}${testMode ? ' (test data)' : ''}`);

  const media = new MediaArm();
  const link = new RuntimeLink<MessagePortMain>();
  setFillRpc(link.rpc); // B-078 D20: "Fill login" reaches secrets.fillLogin over main's own link
  const settings = new SettingsView(link.rpc);
  const company = options.company;
  const companies = options.companies ?? undefined;
  const start = testMode ? undefined : startFlag(process.argv); // B-078: the "+" menu's --start=join (none in a test profile)
  const title = () => (company ? `${productName} – ${companyLabel(settings.current?.profile, company)}` : productName);
  let updates: DesktopUpdates | null = null;
  const renderer = new RendererLink({
    onReadyChange: () => updates?.reevaluate(),
    onLoaded: () => {
      renderer.send(IPC.runtimeStatus, link.status);
      if (updates) renderer.send(IPC.updateState, updates.state());
      retitle(); startFloat(); // the page's <title> replaced the window's; 18.11.: the float bar after the main page (it is the first window)
    },
  });

  // ---------------------------------------------------------------- capture
  let appWindow: MainWindow | null = null;
  // MM4 video keyframes run in a hidden window – never the person's window.
  const hidden = hiddenWindows({ blobsDir: paths.blobs, previewDir: paths.previews, previewScript: () => readFileSync(paths.previewPage, 'utf8') });
  const capture = new Capture({
    screen,
    getSources: sourceOptions => desktopCapturer.getSources(sourceOptions),
    appContents: () => appWindow?.browserWindow?.webContents ?? null,
    // B-055: the feedback shot includes the side browser's native view (capture.ts windowLayers)
    appLayers: () => windowLayers(appWindow?.browserWindow ?? null),
    fromBitmap: (data, size) => nativeImage.createFromBitmap(Buffer.from(data.buffer, data.byteOffset, data.byteLength), size),
  });

  // ---------------------------------------------------------------- tray, host services, runtime
  const tray = new AppTray({
    electron: { Tray, Menu, nativeImage },
    iconPath: paths.icon,
    get name() { return title(); }, // read at each tooltip update: a company's label follows its profile
    platform,
    onOpen: () => appWindow?.show(),
    onQuit: () => app.quit(),
    onStopWork: () => { void workStop.stop(); },
    onResumeWork: () => { void workStop.resume(); }, onBubble: show => { floatBar?.bar.setHidden(!show); }, // 19.11.2026: Show/Hide bubble
  });
  let badge = 0;
  /** B-072: another company names itself in the window title and the tray tooltip ("Autark – <label>"). */
  const retitle = () => {
    if (!company) return;
    appWindow?.browserWindow?.setTitle(title());
    tray.setBadge(badge); // the tooltip reads the name again
  };
  const workNotices: object[] = []; // the last stop notice (host-services.ts keeps its own the same way)
  // B-072: "Stop all agent work" stops every company on this PC – one of them holds the global shortcut (companies.ts)
  const workRpc: WorkStopRpc = {
    call: (method, params, timeoutMs) => {
      if (method === 'work.stop' && companies) void stopOtherCompanies(companies, paths.data);
      return link.rpc.call(method, params, timeoutMs);
    },
    on: (event, listener) => link.rpc.on(event, listener),
    subscribe: topic => link.rpc.subscribe(topic),
  };
  const workStop = new WorkStopControl({
    rpc: workRpc,
    shortcut: globalShortcut,
    tray,
    notify: (title, body) => {
      if (!Notification.isSupported()) return;
      const notice = new Notification({ title, body, ...(platform === 'darwin' ? {} : { icon: paths.icon }) });
      notice.on('click', () => appWindow?.show());
      workNotices.splice(0, workNotices.length, notice); // kept until the next one: a collected Notification loses its click handler
      notice.show();
    },
    log: line => log.line(line),
  });
  // 16.11.2026: a removed company's folder goes to the recycle bin once it has ended (company-remove.ts) – at this start,
  // after a removal asked here, and at a second start (a removed company's window handed over to this one)
  const companyNotices: object[] = [];
  const sweepCompanies = () => (companies ? sweepRemoved({
    companies, now: Date.now, trash: folder => shell.trashItem(folder), log: line => log.line(line),
    unregister: (id, dir) => applyLauncher(false, launcherDeps(app, { platform, testMode, name: productName, company: id, dataDir: dir, log: line => log.line(line) })),
    notify: (title, body) => {
      if (!Notification.isSupported()) return;
      const notice = new Notification({ title, body, ...(platform === 'darwin' ? {} : { icon: paths.icon }) });
      companyNotices.splice(0, companyNotices.length, notice); // kept until the next one, like the stop notice
      notice.show();
    },
  }) : Promise.resolve([]));
  if (companies) app.on('second-instance', () => { void sweepCompanies(); });
  // B-081: the AI cursor over this PC's screen while an agent moves the real pointer (computer use; Windows)
  const screenCursor = new ScreenCursor({
    rpc: link.rpc, platform, displays: () => screen.getAllDisplays(), toDip: point => screen.screenToDipPoint(point), open: electronCursorOverlays({ BrowserWindow, log: line => log.line(line) }),
  });
  let workspaceBrowser: WorkspaceBrowser | null = null; // B-055 F1: agents in the person's side browser (main/side-driver)
  const sideDriver = new SideDriver({
    browser: () => workspaceBrowser,
    pointer: point => link.pointer(point), // host bridge 'pointer' → the runtime's pointer hub
    person: () => ({ kind: 'person', id: OWNER_ALIAS, name: settings.current?.profile?.name?.trim() || 'Owner' }),
  });
  // B-076: a side tab watched from another PC or a phone – its picture goes to the runtime, its input comes back
  const caster = new SideCaster({
    tab: id => sideDriver.side(id), keep: id => workspaceBrowser?.sideKeep(id), release: id => workspaceBrowser?.sideRelease(id), send: update => link.sideView(update),
    size: (id, box) => workspaceBrowser?.sideSize(id, box) ?? false, // B-081: the watched page takes the watcher's box
  });
  const host = new HostServices({
    safeStorage,
    shell,
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    powerSaveBlocker,
    createNotification: notification => (Notification.isSupported() ? new Notification({ ...notification, ...(platform === 'darwin' ? {} : { icon: paths.icon }) }) : null),
    setBadgeCount: count => app.setBadgeCount(count),
    capture,
    media: {
      analyze: (request) => hidden.mediaAnalyzer.analyze(request), audio: (request) => hidden.mediaAnalyzer.audio(request),
      image: (request) => hidden.mediaAnalyzer.image(request), preview: (request) => hidden.mediaPreview.preview(request), // 17.11.2026
    },
    sideBrowser: call => sideDriver.call(call), // B-055 F1: checks every field itself
    sideView: { cast: args => caster.cast(args), input: args => caster.input(args), nav: args => caster.nav(args) }, // B-076
    window: {
      focused: () => appWindow?.focused ?? false,
      show: () => appWindow?.show(),
      navigate: request => renderer.sendWhenLoaded(IPC.navigate, request),
    },
    onBadge: count => { badge = count; tray.setBadge(count); },
    // B-072: switching companies (companies.ts): that company's window opens, this one goes to the tray
    openCompany: companies ? args => openCompany(args, { dir: companies.dir, current: company, spawn: spawnApp, show: () => appWindow?.show(), hide: () => appWindow?.browserWindow?.hide() }) : undefined,
    // 16.11.2026: taking a company off this PC (company-remove.ts); this one quits after the answer where it goes itself
    removeCompany: companies ? args => removeCompany(args, {
      companies, current: company, now: Date.now, visible: () => appWindow?.browserWindow?.isVisible() ?? false, spawn: spawnApp, quit: () => app.quit(),
      call: (dir, id) => callCompany(dir, 'companies.remove', { id }), sweep: () => { void sweepCompanies(); },
    }) : undefined,
    update: () => updateFromElsewhere(updates, line => log.line(line)), // 19.11.2026: app.update / system.update {device}
    // B-080: app.install / system.install – a build installed the way an update installs (updates-wiring.ts installFile)
    install: async installer => {
      try {
        if (!updates) throw new Error('the updater wiring is not ready');
        await updates.installFile(installer);
      } catch (error) {
        log.line(`install from a file failed: ${errorText(error)}`);
        // installFile's own refusals told the runtime already (cancelInstall); without the wiring this does.
        if (!updates) void link.rpc.call('system.prepareRestart', { cancel: true }).catch(() => undefined);
      }
    },
  });
  const runtimeHost = new RuntimeHost<MessagePortMain>({
    // UtilityProcess.stdout is typed as NodeJS.ReadableStream; it is a stream.Readable at runtime.
    fork: (modulePath, args, forkOptions) => utilityProcess.fork(modulePath, args, forkOptions) as unknown as RuntimeChild,
    createChannel: () => new MessageChannelMain(),
    modulePath: paths.runtime,
    env: runtimeEnv(process.env, paths.data, app.getPreferredSystemLanguages()[0]), // F07: the display language, not the regional format
    token: randomBytes(32).toString('hex'), personToken: personTokenOf(process.env), // FX1: a test profile's only
    app: { ...appInfo({ version: app.getVersion(), packaged: app.isPackaged, paths, executable: process.execPath, companies }), ...(start ? { start } : {}), pid: process.pid }, // B-080: pid – install records
    handle: request => host.handle(request),
    onStatus: status => link.handleStatus(status),
    log: log.sink,
    logLine: line => log.line(line),
  });
  link.bind(runtimeHost);
  link.onChange(status => {
    renderer.send(IPC.runtimeStatus, status);
    if (status.state === 'up') void settings.start().catch(error => log.line(`settings not loaded: ${errorText(error)}`));
    if (status.state === 'up') void workStop.start().catch(error => log.line(`agent work stop state not loaded: ${errorText(error)}`));
    if (status.state === 'up') void screenCursor.start().catch(error => log.line(`screen cursor not started: ${errorText(error)}`)); // B-081
    if (status.state === 'restarting' || status.state === 'stopped') { host.releaseAll(); workStop.reset(); caster.stopAll(); }
  });

  // ---------------------------------------------------------------- updates
  let updateQuitLine: string | undefined;
  const quitForHelper = (launch: { quitReadyLine?: string }): void => {
    // before-quit runs inside app.quit(). Do not leave the attempt attached to a later ordinary quit.
    updateQuitLine = launch.quitReadyLine;
    try { app.quit(); } finally { updateQuitLine = undefined; }
  };
  let updater = inactiveUpdater();
  let updaterLoaded = false;
  if (app.isPackaged && !testMode) { // F25: every company has its updater (one install for all; the helper starts the one that pressed Update again)
    try {
      updater = await loadUpdater(quitForHelper, line => log.line(line), companyArgs(company));
      updaterLoaded = true;
    } catch (error) {
      log.line(`updater not available: ${errorText(error)}`); // the app still starts, without updates
    }
  }
  const desktopUpdates = new DesktopUpdates({
    updater,
    packaged: app.isPackaged,
    enabled: updaterLoaded,
    platform,
    arch: process.arch,
    version: app.getVersion(),
    autoDownload: () => settings.preferences().autoDownloadUpdates,
    renderer,
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    runtime: {
      readiness: () => link.rpc.call('system.restartReadiness'),
      prepareRestart: async (cancel, to) => { await link.rpc.call('system.prepareRestart', cancel ? { cancel: true } : to ? { to } : {}, 30_000); },
      stop: reason => link.stop(reason), bye: (reason) => link.rpc.call('devices.bye', { reason }), // 19.11.2026: linked PCs hear "Updating…"
      start: () => link.start(),
    },
    install: { pid: process.pid, exe: process.execPath, appImage: process.env.APPIMAGE, logs: paths.logs, quit: quitForHelper, args: companyArgs(company) }, // B-080: installFile
    publish: state => {
      renderer.send(IPC.updateState, state);
      link.event('update.state', state);
    },
    openExternal: url => shell.openExternal(url), // the manual download (https only: updates-wiring.ts)
    log: line => log.line(line),
  });
  updates = desktopUpdates;
  const updatesHearRuntime = siblingUpdates(link.rpc, desktopUpdates); // F25: a linked own PC's version, a not-landed install
  link.onChange(status => { if (status.state === 'up') updatesHearRuntime(); });
  if (link.isUp) updatesHearRuntime(); // it came up while the updater loaded

  // ---------------------------------------------------------------- settings reactions
  const launcher = launcherDeps(app, { platform, testMode, name: productName, company, dataDir: paths.data, log: line => log.line(line) });
  // B-080: where the desktop broker is still missing, a start with a window asks Windows once for it (broker-setup.ts)
  setupBroker({ platform, packaged: app.isPackaged, testMode, background: options.background, root: paths.root, exe: process.execPath, log: line => log.line(line), report: setup => link.event('broker.setup', setup) }); // F03: how it ended, for the computer tools
  const waker = { platform, packaged: app.isPackaged, testMode, localAppData: process.env.LOCALAPPDATA, exe: process.execPath, script: sleeperScript(path.dirname(paths.runtime)), dataDir: paths.data, args: companyArgs(company), log: (line: string) => log.line(line) };
  const pcAwake = pcKeepAwakeFor({ powerSaveBlocker, powerMonitor }, settings.preferences().keepPcAwake, line => log.line(line)); // 0.3.20: no standby on mains power (keep-awake.ts)
  settings.onChange((next, previous) => {
    const changed = changedPreferences(next, previous), prefs = settings.preferences();
    pcAwake.setSwitch(prefs.keepPcAwake);
    if (next.profile?.company !== previous?.profile?.company || next.profile?.name !== previous?.profile?.name) retitle();
    if (changed.includes('theme')) appWindow?.applyTheme(prefs.theme);
    if (changed.includes('openAtLogin')) void applyLauncher(prefs.openAtLogin, launcher); // B-044: "Keep agents running"
    if (changed.includes('autoDownloadUpdates')) desktopUpdates.autoDownloadChanged();
    const wakeHelper = next.devices?.wakeHelper !== false; // 0.3.19: "Wake while closed" – the broker's waker registration (waker.ts)
    if (!previous || wakeHelper !== (previous.devices?.wakeHelper !== false)) void applyWaker(wakeHelper, waker);
  });

  // ---------------------------------------------------------------- window
  const mainWindow = new MainWindow({
    paths,
    title: title(),
    platform,
    devTools: !app.isPackaged,
    renderer,
    state: await loadWindowState(paths.windowState),
    saveState: state => { void saveWindowState(paths.windowState, state); },
    onClosed: () => {
      media.disarm();
      // Close ≠ quit: the tray and the runtime (agents) keep running; the tray's Quit ends them (20.11.2026: no toggle for it).
    },
    onVisibilityChange: visible => desktopUpdates.setVisible(visible),
    onFocus: () => desktopUpdates.checkIfDue(),
    log: line => log.line(line),
  });
  appWindow = mainWindow;
  workspaceBrowser = new WorkspaceBrowser(() => mainWindow.browserWindow, { // tabs and panels survive restarts
    onTab: (id, contents) => sideDriver.tab(id, contents), guard: sideDriver.guardHooks(), // B-055 F1; 25.11.2026: Secure mode's guard (workspace-guard.ts)
    keep: id => caster.watched(id), // B-076: a page watched from another PC or a phone stays loaded
    pick: (id, on) => void sideDriver.pick(id, on), // B-081: the Pin button – the tab's element picker (side-driver/pick-script.ts)
    tabsFile: path.join(paths.data, 'side-tabs.json'),
    oldTabsFile: path.join(paths.data, 'workspace-tabs.json'),
    historyFile: path.join(paths.data, 'browser-history.json'),
    zoomFile: path.join(paths.data, 'workspace-zoom.json'),
    // B-044: the person's downloads go to the runtime's workspace (runtime/system/paths.ts: <home>/Workforce; a test profile's
    // and another company's own: <data>/workspace, runtime/root/companies.ts)
    downloadsDir: personalDownloads(options.testData || company ? path.join(paths.data, 'workspace') : path.join(os.homedir(), 'Workforce')),
  });

  // ---------------------------------------------------------------- protocols, guards, IPC
  registerProtocolHandlers(protocol, new ProtocolHandlers({
    uiDir: paths.ui,
    sandboxLibDir: paths.sandboxLib,
    blobsDir: paths.blobs,
    appHtml: async (messageId, blockIndex) => {
      await link.rpc.ready(15_000);
      return (await link.rpc.call('blocks.appHtml', { messageId, blockIndex })).html;
    },
    pageHtml: async (name) => {
      await link.rpc.ready(15_000);
      return (await link.rpc.call('pages.read', { name })).html;
    },
  }));
  installSessionGuards(session.defaultSession, {
    media,
    appContentsId: () => mainWindow.contentsId,
    appMainFrame: () => mainWindow.mainFrame,
    screenSources: () => desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }),
    primaryDisplayId: () => screen.getPrimaryDisplay().id,
    platform,
    log: line => log.line(line),
  });
  registerIpc(ipcMain, desktopIpcDeps({
    windowContentsId: () => mainWindow.contentsId,
    link,
    updates: desktopUpdates,
    renderer,
    media,
    capture,
    showOpenDialog: dialogOptions => {
      const parent = mainWindow.browserWindow;
      return parent ? dialog.showOpenDialog(parent, dialogOptions) : dialog.showOpenDialog(dialogOptions);
    },
    clipboardWrite: text => clipboard.writeText(text),
    openExternal: url => shell.openExternal(url),
    titleBarLayout: layout => mainWindow.setTitleBarLayout(layout),
    titleBarDim: dim => mainWindow.setTitleBarDim(dim), voiceLive: on => mainWindow.setVoiceLive(on), bubbleCall: call => floatBar?.bar.setCall(call), bubbleHandle: step => floatBar?.bar.handle(step), bubbleState: () => ({ available: !!floatBar, out: !!floatBar?.bar.shown }), // 19.11.2026; 0.3.20: the rail icon
    log: line => log.line(line),
  }));

  // ---------------------------------------------------------------- power events
  powerMonitor.on('suspend', () => link.power('suspend')); powerMonitor.on('resume', () => { link.power('resume'); desktopUpdates.checkIfDue(); });
  powerMonitor.on('lock-screen', () => link.power('lock')); powerMonitor.on('unlock-screen', () => link.power('unlock'));
  // B-044: the system ends the session (also with the window closed to the tray) – not an unexpected close.
  watchSessionEnd({ platform, app, powerMonitor, BaseWindow }, sessionEnded(runMarks, log), line => log.line(line)); // B-080 wave 3: and one main.log line at once

  // ---------------------------------------------------------------- graceful quit
  app.on('before-quit', beforeDesktopQuit({
    blockFailedUpdateQuit: () => desktopUpdates.blockFailedUpdateQuit(),
    begin: () => { mainWindow.letGo(); runMarks.quit(desktopUpdates.draining ? 'update' : 'person'); },
    cleanup: [() => workStop.dispose(), () => screenCursor.dispose(), () => floatBar?.close(), () => hidden.dispose(), () => workspaceBrowser?.dispose()],
    commitDrainedQuit: () => desktopUpdates.commitDrainedQuit(),
    quitReadyLine: () => updateQuitLine,
    actions: () => ({
      flushDrafts: () => renderer.prepareRestart(3000),
      disposeUpdates: () => desktopUpdates.dispose(),
      stopRuntime: () => link.stop('quit'),
      releasePower: () => { pcAwake.dispose(); return host.releaseAll(); }, destroyTray: () => tray.destroy(),
      ...quitWake({ by: runMarks.by, call: (method, params) => link.rpc.call(method, params), start: { exe: process.execPath, script: sleeperScript(path.dirname(paths.runtime)), dataDir: paths.data, args: companyArgs(company), log: line => log.line(line) } }),
    }),
    armDueStart: () => armDueStart(settings.preferences().openAtLogin, runMarks.by, launcher), // B-044: next-due.json is settled once the runtime stops
    quit: () => app.quit(), exit: () => app.exit(0), log,
  }));

  nativeUpdater.on('before-quit-for-update', () => { desktopUpdates.markUpdateQuit(); mainWindow.letGo(); }); // an update closes windows first

  let floatBar: ReturnType<typeof startFloatBar> | null = null; // one per PC: the first company's (not in a test profile: its global shortcut, one window); after the main page (background: at once)
  function startFloat(): void { if (!company && !testMode && !floatBar) floatBar = startFloatBar({ BrowserWindow, session, screen, globalShortcut, nativeImage, Menu }, { rpc: link.rpc, capture, file: path.join(paths.data, 'float-bar.json'), window: mainWindow, renderer, tray, log: line => log.line(line) }); } if (options.background) startFloat();
  // ---------------------------------------------------------------- go
  runtimeHost.start();
  tray.create();
  void sweepCompanies(); // a company removed before this start
  desktopUpdates.setVisible(!options.background); // tray only: the rarer check interval
  desktopUpdates.start();
  if (!company) settleAfterStart({ dataDir: paths.data, version: app.getVersion(), launcher, log: line => log.line(line) }); // a Mac self-update's leftovers
  if (!options.background) mainWindow.show();
  return { show: () => mainWindow.show() };
}
