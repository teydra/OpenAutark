// 0.3.19 (23.11.2026, owner: "ein Teil im Hintergrund, das nur hört, ob das Ding wieder angeschaltet werden muss – anhand
// von Cron-Job oder Handyweckung"): the wake helper's pure decisions about its own life, used by sleeper-main.ts.
// - appRunning: run-state.json says 'running' AND its process is alive – a Task Manager kill leaves 'running' behind, and
//   the helper (started then by the broker service, resources/broker/Waker.cs) must not take that for a running app.
// - otherHelper: sleeper.json names another live helper – a second one ends at once (one per data folder).
// - dueStartAt: respect deliberate quit's settle period, but don't lose a due time that fell between a forced
//   close and the broker's next tick.
// Owns: those three decisions. Never: reads files, starts anything or touches the clock itself.

import type { RunState, SleeperMark } from '../../shared/model/launch.ts';

/** Keep the existing settle period for deliberate quits (main/launcher.ts QUIT_SETTLE_MS). */
export const DUE_SETTLE_MS = 5 * 60_000;
/** The longest single timer: re-checked then (a sleeping PC delays timers; setTimeout's own limit is ~24.8 days). */
export const DUE_TICK_MS = 15 * 60_000;
/** Bound recovery to the scheduler's normal two-minute catch-up window. */
export const DUE_RECOVERY_MS = 120_000;

export type Alive = (pid: number) => boolean;

/** The app runs: state 'running' with a live pid (no pid at all – an older writer – counts as running). */
export function appRunning(state: Partial<RunState> | undefined, alive: Alive): boolean {
  if (state?.state !== 'running') return false;
  return typeof state.pid !== 'number' || alive(state.pid);
}

/** Another live helper holds this data folder. */
export function otherHelper(mark: Partial<SleeperMark> | undefined, self: number, alive: Alive): boolean {
  return typeof mark?.pid === 'number' && mark.pid !== self && alive(mark.pid);
}

/** When to start for scheduled work; the caller has already established that no app is running. */
export function dueStartAt(at: number | null | undefined, startedAt: number, previous?: Partial<RunState>): number | undefined {
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined;
  const stateAt = previous?.at;
  if (previous && typeof stateAt === 'number' && Number.isFinite(stateAt) && stateAt <= startedAt) {
    // After a Task Manager kill, the old running mark remains. The due file can still hold a job that fell
    // between the kill and the broker's poll. Ignore stale files left before the last app start or far in the past.
    if (previous.state === 'running') {
      return at > stateAt && at >= startedAt - DUE_RECOVERY_MS ? Math.max(at, startedAt) : undefined;
    }
    // A normal quit still closes. A job due after the quit, including before the helper got started, isn't lost.
    if (previous.state === 'quit' && previous.by === 'person') {
      return at > stateAt && at >= startedAt - DUE_RECOVERY_MS ? Math.max(at, stateAt + DUE_SETTLE_MS) : undefined;
    }
  }
  return at > startedAt ? Math.max(at, startedAt + DUE_SETTLE_MS) : undefined;
}

/** The next timer for a due start: never longer than DUE_TICK_MS, never negative. */
export function dueDelay(startAt: number, now: number): number {
  return Math.max(0, Math.min(startAt - now, DUE_TICK_MS));
}

/** A due timer and multiple devices can wake within the same second. Start at most one app. */
export function launchOnce<T>(running: () => boolean, launch: (args: T) => void): (args: T) => void {
  let starting = false;
  return (args) => {
    if (starting || running()) return;
    starting = true;
    launch(args);
  };
}
