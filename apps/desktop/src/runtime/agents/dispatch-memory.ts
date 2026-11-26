// Admission for main turns and splits.
// Owns: deciding when a new dispatched turn may start based on RAM headroom.
// Never: changes which engine is selected or the lifetime of a running turn.
import { execFileSync } from 'node:child_process';
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

/**
 * Memory a new turn can use now, in bytes. os.freemem() is MemAvailable on Linux and the available physical memory on Windows,
 * but on macOS it counts only never-used pages: a Mac with 8 GB and nothing running reports a few hundred MiB "free" because the
 * rest is cache and inactive pages the system hands out on demand. 26.11.2026 (Felix): with that number every turn on a Mac
 * waited the full 30 s (the 0.3.20 Mac release check timed out on its demo chat). On macOS free + inactive + speculative pages
 * from vm_stat are the memory that is available without swapping; any failure falls back to freemem().
 */
export function availableMemory(): number {
  if (process.platform !== 'darwin') return freemem();
  return cachedMac(performance.now(), () => {
    try {
      return parseVmStat(execFileSync('/usr/bin/vm_stat', { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })) ?? freemem();
    } catch { return freemem(); }
  });
}

/** vm_stat is a subprocess: a burst of turns and the 1 s retries of a waiting one share one reading for a few seconds. */
const MAC_READING_MS = 3000;
let macReading: { at: number; bytes: number } | undefined;
export function cachedMac(now: number, read: () => number): number {
  if (!macReading || now - macReading.at >= MAC_READING_MS || now < macReading.at) macReading = { at: now, bytes: read() };
  return macReading.bytes;
}
export function forgetMacReading(): void { macReading = undefined; }

/** Bytes that are free, inactive or speculative in `vm_stat` output; undefined when the output is not in that format. */
export function parseVmStat(text: string): number | undefined {
  const size = /page size of (\d+) bytes/.exec(text)?.[1];
  const pages = (name: string) => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.`, 'm').exec(text)?.[1]);
  const total = pages('free') + pages('inactive') + pages('speculative');
  return size && Number.isFinite(total) ? total * Number(size) : undefined;
}

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
    free: availableMemory,
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
