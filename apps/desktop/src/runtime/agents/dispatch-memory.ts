// Admission for main turns and splits.
// Owns: deciding when a new dispatched turn may start based on RAM headroom.
// Never: changes which engine is selected or the lifetime of a running turn.
import { freemem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const MIB = 1024 ** 2;
// On 0.3.19: a cold Claude CLI was observed at ~290 MiB. Leave room for it
// and ~730 MiB for the OS, shell work and small memory fluctuations.
export const START_HEADROOM = 1024 * MIB;
const START_COST = 300 * MIB;
const START_WINDOW_MS = 5000;
const RETRY_MS = 1000;
export const MAX_MEMORY_WAIT_MS = 30_000;

interface MemoryDeps {
  free: () => number;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

interface WaitNote {
  freeMiB: number;
  reservedMiB: number;
  targetMiB: number;
  waitedMs: number;
}

/** A small start-window debit stops a burst from all spending the same free-memory sample. */
export class TurnMemoryGate {
  private starts: number[] = [];
  private readonly deps: MemoryDeps;
  constructor(deps: MemoryDeps = {
    free: freemem,
    now: () => performance.now(),
    sleep: (ms, signal) => delay(ms, undefined, { signal, ref: false }),
  }) {
    this.deps = deps;
  }

  async wait(signal: AbortSignal, report: (phase: 'waiting' | 'timeout', note: WaitNote) => void): Promise<void> {
    const began = this.deps.now();
    let reported = false;
    while (!signal.aborted) {
      const now = this.deps.now();
      this.starts = this.starts.filter((until) => until > now);
      const reserved = this.starts.length * START_COST;
      const free = this.deps.free();
      const waitedMs = now - began;
      if (free - reserved >= START_HEADROOM) {
        this.starts.push(now + START_WINDOW_MS);
        return;
      }
      const note = { freeMiB: Math.round(free / MIB), reservedMiB: reserved / MIB, targetMiB: START_HEADROOM / MIB, waitedMs: Math.round(waitedMs) };
      if (waitedMs >= MAX_MEMORY_WAIT_MS) {
        report('timeout', note);
        this.starts.push(now + START_WINDOW_MS);
        return;
      }
      if (!reported) {
        reported = true;
        report('waiting', note);
      }
      try {
        await this.deps.sleep(Math.min(RETRY_MS, MAX_MEMORY_WAIT_MS - waitedMs), signal);
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
  }
}
