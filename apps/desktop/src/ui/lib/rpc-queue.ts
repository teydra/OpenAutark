// The calls made while the connection is not open (lib/rpc.ts): they wait here in order and go out when it opens – but
// each only up to QUEUE_LIMIT_MS (Sicher-Runde 19.11.2026, D6: with the PC out of reach a busy button spun until the PC
// came back, and repeated taps queued repeated writes that all replayed then). A call that waited that long leaves the
// queue and its caller hears `expired` – nothing of it was sent. (The desktop window's calls before its runtime ever
// answered wait without a limit: a cold start may take longer, and the status line says "starting".)
// Owns: the waiting requests and their one timer each. Never: sends, decides the error text or retries (callers decide).

import type { RpcRequest } from '../../shared/api/protocol.ts';

/** How long a call made while not connected waits for the connection (a socket gets OPEN_LIMIT_MS to open, and the next attempt goes out at once). */
export const QUEUE_LIMIT_MS = 8_000;

/** The timers the queue uses (the window's in the app, a fake in unit tests). */
export interface QueueTimers { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }

const WINDOW_TIMERS: QueueTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class CallQueue {
  private readonly items: Array<{ request: RpcRequest; timer: unknown }> = [];
  private readonly limitMs: number;
  private readonly timers: QueueTimers;

  constructor(limitMs = QUEUE_LIMIT_MS, timers: QueueTimers = WINDOW_TIMERS) {
    this.limitMs = limitMs;
    this.timers = timers;
  }

  get size(): number {
    return this.items.length;
  }

  /** Waits `request`; after the limit it leaves the queue and `expired` runs (without `expired` it waits for the connection). */
  add(request: RpcRequest, expired?: () => void): void {
    const item = { request, timer: undefined as unknown };
    if (expired) item.timer = this.timers.set(() => {
      const index = this.items.indexOf(item);
      if (index === -1) return;
      this.items.splice(index, 1);
      expired();
    }, this.limitMs);
    this.items.push(item);
  }

  /** Every waiting request, oldest first; the queue is empty afterwards and no timer is left. */
  take(): RpcRequest[] {
    const taken = this.items.splice(0);
    for (const item of taken) if (item.timer !== undefined) this.timers.clear(item.timer);
    return taken.map((item) => item.request);
  }
}
