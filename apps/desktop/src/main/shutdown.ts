// Graceful quit: ordered steps (renderer drafts, updater timers, runtime drain), each
// bounded by a timeout so a hung part can never keep the app alive. Sicher-Runde 19.11.2026: before the runtime stops it
// says goodbye to the linked PCs (devices.bye – "App closed · 14:02" there instead of "Not reachable"), and after it
// stopped the wake helper starts when the person quit and the runtime wrote its file (main/sleeper.ts).
// Owns: the desktop quit request, step order and deadlines. Never imports Electron (the actions are injected).

import type { QuitBy } from '../shared/model/launch.ts';
import { sleeperAtQuit } from './sleeper.ts';

/** A normally exiting process needs no extra time; only a drained quit may be ended hard. */
export const QUIT_MS = 10_000;

export function armQuitWatchdog(
  drained: boolean,
  logNow: (line: string) => void,
  exit: () => void,
  setTimer: (fn: () => void, ms: number) => { unref(): unknown } = setTimeout,
): void {
  if (!drained) return;
  setTimer(() => {
    logNow('drained quit did not end the app; forcing exit');
    exit();
  }, QUIT_MS).unref();
}

export interface ShutdownStep {
  name: string;
  run(): unknown;
  timeoutMs?: number; // default 5 s
}

export interface ShutdownOptions {
  log?(line: string): void;
  totalMs?: number; // overall cap, default 20 s
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

function bounded(promise: Promise<unknown>, ms: number, options: ShutdownOptions): Promise<'done' | 'timeout'> {
  return new Promise((resolve, reject) => {
    const set = options.setTimer ?? ((fn: () => void, delay: number) => setTimeout(fn, delay));
    const clear = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const timer = set(() => resolve('timeout'), ms);
    promise.then(() => { clear(timer); resolve('done'); }, error => { clear(timer); reject(error); });
  });
}

/** Runs the steps in order; failures and timeouts are logged and skipped. */
export async function runShutdown(steps: readonly ShutdownStep[], options: ShutdownOptions = {}): Promise<void> {
  const all = (async () => {
    for (const step of steps) {
      try {
        const outcome = await bounded(Promise.resolve().then(() => step.run()), step.timeoutMs ?? 5000, options);
        if (outcome === 'timeout') options.log?.(`shutdown step "${step.name}" timed out`);
      } catch (error) {
        options.log?.(`shutdown step "${step.name}" failed: ${(error as Error)?.message ?? 'error'}`);
      }
    }
  })();
  const outcome = await bounded(all, options.totalMs ?? 20_000, options);
  if (outcome === 'timeout') options.log?.('shutdown did not finish in time; quitting anyway');
}

export interface QuitActions {
  /** An update install already drained renderer and runtime. */
  drained: boolean;
  flushDrafts(): unknown;
  disposeUpdates(): unknown;
  stopRuntime(): unknown;
  releasePower(): unknown;
  destroyTray(): unknown;
  /** Who quit (launcher.ts RunStateMarks): the person's quit may leave the wake helper running. */
  by?: QuitBy;
  /** devices.bye over main's link ('quit', or 'session-end' when Windows ends the session); its answer says whether the helper starts. */
  bye?(): Promise<{ sleeper?: boolean } | undefined>;
  /** Starts the wake helper (main/sleeper.ts startSleeper) – after the runtime stopped. */
  startSleeper?(): unknown;
}

/** The goodbye waits this long at most (the runtime's own wait is shorter, runtime/devices/away.ts BYE_MS). */
export const BYE_STEP_MS = 3_000;

/** Quit order: drafts → updater timers → runtime drain → leftovers. */
export function quitSteps(actions: QuitActions): ShutdownStep[] {
  const final: ShutdownStep[] = [
    { name: 'power', run: actions.releasePower },
    { name: 'tray', run: actions.destroyTray },
  ];
  if (actions.drained) return [{ name: 'updates', run: actions.disposeUpdates }, ...final];
  let bye: { sleeper?: boolean } | undefined;
  const { bye: sayBye, startSleeper } = actions;
  return [
    { name: 'drafts', run: actions.flushDrafts, timeoutMs: 4000 },
    { name: 'updates', run: actions.disposeUpdates },
    ...(sayBye ? [{ name: 'bye', run: async () => { bye = await sayBye(); }, timeoutMs: BYE_STEP_MS }] : []),
    { name: 'runtime', run: actions.stopRuntime, timeoutMs: 10_000 },
    ...(startSleeper ? [{ name: 'wake helper', run: () => (sleeperAtQuit(actions.by, bye) ? startSleeper() : undefined) }] : []),
    ...final,
  ];
}

interface DesktopQuit {
  blockFailedUpdateQuit(): boolean;
  begin(): void;
  cleanup: readonly (() => void)[];
  commitDrainedQuit(): boolean;
  quitReadyLine(): string | undefined;
  actions(): Omit<QuitActions, 'drained' | 'flushDrafts' | 'stopRuntime'> & {
    flushDrafts(): Promise<boolean>;
    stopRuntime(): Promise<void>;
  };
  armDueStart(): Promise<void>;
  quit(): void;
  exit(): void;
  setTimer?: Parameters<typeof armQuitWatchdog>[3];
  log: { line(message: string): void; lineNow(message: string): void; close(): void };
}

/** The first before-quit drains; the final app.quit is allowed through. */
export function beforeDesktopQuit(deps: DesktopQuit): (event: { preventDefault(): void }) => void {
  let quitting = false;
  let quitDone = false;
  const { log } = deps;
  const armWatchdog = (safe: boolean) => armQuitWatchdog(safe, line => log.lineNow(line), deps.exit, deps.setTimer);
  return (event) => {
    if (deps.blockFailedUpdateQuit()) {
      event.preventDefault();
      log.line('update quit cancelled: installer did not start');
      return;
    }
    if (quitDone) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    deps.begin();
    for (const step of deps.cleanup) {
      try { step(); } catch (error) { log.line('quit step failed: ' + (error as Error).message); }
    }
    log.line('quitting');
    const drained = deps.commitDrainedQuit();
    if (drained) {
      // The helper can read this even if the main thread hangs in native teardown.
      const readyLine = deps.quitReadyLine();
      if (readyLine) log.lineNow(readyLine);
      armWatchdog(true);
    }
    let draftsSaved = false;
    let runtimeStopped = false;
    const actions = deps.actions();
    const steps = quitSteps({
      ...actions,
      drained,
      flushDrafts: async () => { draftsSaved = await actions.flushDrafts(); },
      stopRuntime: async () => { await actions.stopRuntime(); runtimeStopped = true; },
    });
    void runShutdown(steps, { log: line => log.line(line) }).then(deps.armDueStart).finally(() => {
      quitDone = true;
      if (!drained) armWatchdog(draftsSaved && runtimeStopped);
      log.close();
      deps.quit();
    });
  };
}
