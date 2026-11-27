// B-044 "Keep agents running": the two small files beside the data that the OS launcher start of
// the app reads before anything else runs (main/launcher.ts) – <data>/next-due.json, written by the
// runtime's scheduler whenever it re-arms (runtime/schedules/next-due.ts), and <data>/run-state.json,
// written by main at start and on every deliberate quit.
// Owns: the file names and shapes. Never: reads or writes them (runtime and main do).

export const NEXT_DUE_FILE = 'next-due.json';
export const RUN_STATE_FILE = 'run-state.json';

/** When the earliest schedule or wake is due (epoch ms); null when nothing is. */
export interface NextDue {
  at: number | null;
}

/** Why the app was quit on purpose: the person (tray, menu, window), an update install, the system ending the session, the launcher's crash-loop cap. */
export type QuitBy = 'person' | 'update' | 'system' | 'launcher';

export interface RunState {
  state: 'running' | 'quit';
  at: number; // when this state was written
  pid?: number; // 'running': the main process
  by?: QuitBy; // 'quit'
  ends?: number[]; // unexpected ends noticed at later starts (last 30 min, at most 3)
  capped?: number; // the launcher stopped restarting at this time (until the person starts the app; Windows: a task start 30 minutes later)
}

/**
 * 0.3.19 (23.11.2026, owner: Wake did nothing after Autark was ended in Task Manager): the wake helper's own mark,
 * <data>/sleeper.json – written by a running helper (runtime/devices/sleeper-main.ts) and removed at its clean end, so
 * a killed helper leaves its pid behind. The broker service (resources/broker/Waker.cs) reads it to know a helper runs.
 */
export const SLEEPER_FILE = 'sleeper.json';

export interface SleeperMark {
  pid: number;
  at: number;
}

/**
 * The waker registration (Windows): <the person's Local AppData>\AutarkDesktopBroker\wakers\<key>.json, one per data
 * folder, written by main while "Wake helper while closed" is on (main/waker.ts) and deleted when it is off. The broker
 * service starts the helper from it – as the person, in their session – whenever neither the app nor a helper runs.
 */
export const WAKER_DIR = ['AutarkDesktopBroker', 'wakers'] as const;

export interface WakerRegistration {
  v: 1;
  exe: string; // Autark.exe
  script: string; // app.asar.unpacked\app\sleeper.mjs
  data: string; // the data folder (wake.json, run-state.json, sleeper.json)
  args: string[]; // the app's own start arguments (another company's --company=<id>)
  /** 0.3.22: the slim native wake helper (app.asar.unpacked\resources\broker\AutarkWakeHelper.exe); the broker uses it when it is there, else the Node helper. */
  helper?: string;
}
