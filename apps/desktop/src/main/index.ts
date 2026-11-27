// Entry of the Electron main process (bundled to app/main.cjs). Everything that must happen
// before `ready`: test-data profile, another company's data folder (`--company=<id>`, B-072: companies.ts), the keyring
// name of a folder from the old product name (keyring-name.ts), no application menu, privileged schemes, single instance (per
// company: the lock lives in its folder), the run state (B-044 "Keep agents running", launcher.ts). A `--launcher` start decides cheaply – the
// single-instance lock and the two small state files, before the composition root (desktop.ts and all
// it loads) is even imported – and quits at once when the app runs or is not needed; the crash-loop cap
// says so once. A Windows task start that goes on hands over to a detached ordinary background start
// (`--restarted` carries the notice) and ends, so the app never runs as the task's instance. Then hands
// over to desktop.ts; a restart after an unexpected close shows one quiet notice. The start after an update install of
// the company that pressed Update (F25: any company) wakes the other companies the install ended (companies.ts wakeCompanies).
// 16.11.2026: a company taken off this PC never starts again, and with the first one gone a plain start opens the next.
// Owns: process-level lifecycle hooks. Never: business logic or long synchronous work.

import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { Menu, Notification, app, dialog, protocol } from 'electron';
import { launchFlags } from './app-paths.ts';
import { companiesDir, companyArgs, companyDir, companyFlag, spawnApp, startingCompany, wakeCompanies } from './companies.ts';
import type { Desktop } from './desktop.ts';
import { applyKeyringName } from './keyring-name.ts';
import { BACKGROUND_FLAG, NOTICES, RESTARTED_FLAG, beginLaunch, launchSource, readRunState, type LaunchNotice } from './launcher.ts';
import { LAUNCHER_PEER_FLAG, launchWindowsCompanies } from './launcher-companies.ts';
import { PRIVILEGED_SCHEMES } from './protocols/handlers.ts';
import { WAKE_FILE, sleeperAtLaunch, sleeperScript, startSleeper, wakeHelperExe } from './sleeper.ts';

const testData = process.env.WORKFORCE_TEST_DATA ? path.resolve(process.env.WORKFORCE_TEST_DATA) : null;
if (testData) app.setPath('userData', testData); // isolated profile; also disables the network updater
const firstData = app.getPath('userData');
// B-072: another company's folder, before the keyring name and the lock. 16.11.2026: a removed first company hands a plain
// start to the next company; undefined – a removed company's own start (its sign-in task, say) – ends at once below.
const picked = testData ? null : startingCompany(companyFlag(process.argv), { first: firstData, dir: companiesDir(firstData) });
const company = picked ?? null;
if (company) app.setPath('userData', companyDir(firstData, company));
applyKeyringName(app); // before anything reads safeStorage
const companies = testData ? null : { first: company ? firstData : app.getPath('userData'), dir: companiesDir(firstData) };

if (process.platform !== 'darwin') Menu.setApplicationMenu(null); // macOS gets a minimal Edit menu after ready
protocol.registerSchemesAsPrivileged(PRIVILEGED_SCHEMES);

const flags = launchFlags(process.argv);
const now = Date.now();
const bootAt = now - os.uptime() * 1000;
const windowsTask = flags.launcher && process.platform === 'win32' && app.isPackaged;
let notice: Notification | null = null; // kept until the next one: a collected Notification loses its click handler

/** One quiet system notice of the launcher (no sound; a click opens the window when there is one). */
function launchNotice(kind: LaunchNotice, onClick?: () => void): void {
  if (!Notification.isSupported()) return;
  notice = new Notification({ ...NOTICES[kind], silent: true });
  if (onClick) notice.on('click', onClick);
  notice.show();
}

/** The Windows task's start goes on as a detached ordinary background start (it decides again and writes the state). */
function handOff(kind: LaunchNotice | undefined): void {
  app.releaseSingleInstanceLock(); // the detached start takes it (a start by the person in between wins)
  try {
    spawnApp([...companyArgs(company), BACKGROUND_FLAG, ...(kind === 'restarted' ? [RESTARTED_FLAG] : [])]);
  } catch {
    // nothing to report to before the app runs; the next sign-in or crash event tries again
  }
  app.quit();
}

// B-072: the update install ended every company; F25: its relaunch is the company that pressed Update – any company,
// told by its own run-state (read before beginLaunch writes the state). On Windows the install helper
// always passes --updated; a later launcher handoff must not also wake companies that did not opt into login.
const updated = companies !== null && (process.platform !== 'win32' || process.argv.includes('--updated')) &&
  readRunState(app.getPath('userData'))?.by === 'update';
const allowLauncher = !flags.launcher || (windowsTask
  ? launchWindowsCompanies({ companies, current: picked, dataDir: app.getPath('userData'), bootAt, peer: process.argv.includes(LAUNCHER_PEER_FLAG) })
  : !testData);
const launch = allowLauncher && picked !== undefined && app.requestSingleInstanceLock()
  ? beginLaunch({ dataDir: app.getPath('userData'), source: launchSource(process.platform, flags.launcher), now, bootAt, pid: process.pid })
  : null;

if (!launch) {
  app.quit(); // the app is running: a second launch shows it (unless --background), see 'second-instance'
} else if (launch.handoff) {
  handOff(launch.notice);
} else if (!launch.start) {
  // A launcher start with nothing to do quits at once; the crash-loop cap says so once first. The lock
  // goes now: a start by the person while this one ends (or the notice shows) goes on as usual.
  app.releaseSingleInstanceLock();
  if (launch.notice) {
    void app.whenReady().then(() => {
      if (process.platform === 'win32') app.setAppUserModelId('com.teydralab.workforce');
      launchNotice(launch.notice!);
      setTimeout(() => app.quit(), 5000);
    });
  } else {
    // 19.11.2026: the person had quit – the wake helper waits at the meeting server so an own PC or phone can start it (main/sleeper.ts)
    if (sleeperAtLaunch(launch, launchSource(process.platform, flags.launcher), existsSync(path.join(app.getPath('userData'), WAKE_FILE)))) {
      startSleeper({ exe: process.execPath, script: sleeperScript(path.join(app.getAppPath(), 'app')), helper: wakeHelperExe(app.getAppPath()), dataDir: app.getPath('userData'), args: companyArgs(company) });
    }
    app.quit();
  }
} else {
  const composition = import('./desktop.ts'); // loaded only for a start that goes on (resolves before 'ready')
  composition.catch(() => {}); // a failed load is reported below, once ready
  const restarted = launch.notice ?? (flags.restarted ? 'restarted' : undefined);
  let desktop: Desktop | null = null;
  let showWhenStarted = false; // a second launch arrived while this one was still starting
  const show = () => { if (desktop) desktop.show(); else showWhenStarted = true; };

  app.on('second-instance', (_event, argv) => {
    if (!launchFlags(argv).background) show();
  });
  // The tray keeps the app – and the agents in the runtime – alive without a window.
  app.on('window-all-closed', () => {});
  app.on('activate', show);

  app.whenReady()
    .then(async () => {
      const { startDesktop } = await composition;
      desktop = await startDesktop({ background: flags.background, testData, company, companies });
      if (updated && companies) wakeCompanies(companies, company);
      if (showWhenStarted) desktop.show();
      if (restarted) launchNotice(restarted, show);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Unknown error.';
      console.error('Could not start:', message);
      dialog.showErrorBox('Could not start', message);
      app.exit(1);
    });
}
