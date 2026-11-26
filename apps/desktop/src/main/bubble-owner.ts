// One floating bubble per person on this PC (task_zbnv2b3h, 26.11.2026). Every company runs its own app process with
// its own data folder, so Electron's single-instance lock holds one company only; the bubble (float-bar-window.ts) and
// its global shortcut belong to just one of them: the first that is ready and gets this lock. The lock is a local
// socket that the operating system frees when its process ends, however it ends: a named pipe on Windows, an abstract
// socket on Linux, a socket file in the person's own temp folder on macOS (a file a crash left behind is removed once
// nobody answers on it). A company that finds the lock held connects to it and waits; that connection closing – the
// holder quit or died – is its turn to try again, and a slow retry covers anything else. The holder keeps the bubble
// until its process ends: there is no hand-over on a click (that comes with the app rebuild).
// A 0.3.20 or older first company opens its bubble without this lock: while such a process still runs beside a newer
// one (only until the update has restarted it), two bubbles can show.
// Owns: the lock's address and the wait for it. Never: opens the bubble itself or reads a company's data.

import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** The slow retry while another company holds the lock (the closing connection is the fast way). */
export const BUBBLE_RETRY_MS = 15_000;
const SOON_MS = 150; // after the holder went away: listen is atomic, so several waiters at once are fine

export interface BubbleLockScope {
  platform: NodeJS.Platform;
  /** The person's home folder: one lock per person (named pipes are seen by every user of the PC). */
  home: string;
  /** os.tmpdir(): on macOS the person's own temp folder, where the socket file lives. */
  tmp: string;
  /** The product's name; a development run gets a lock of its own, so it never takes the installed app's bubble. */
  product: string;
  packaged: boolean;
}

/** The lock's address for this person and product: the same for every company, different for anyone else. */
export function bubbleLockAddress(scope: BubbleLockScope): string {
  const who = scope.platform === 'win32' ? scope.home.toLowerCase() : scope.home;
  const hash = createHash('sha256').update(`${scope.product}\n${scope.packaged ? 'app' : 'dev'}\n${who}`).digest('hex').slice(0, 20);
  const name = `autark-bubble-${hash}`;
  if (scope.platform === 'win32') return `\\\\.\\pipe\\${name}`;
  if (scope.platform === 'linux') return `\0${name}`; // abstract: no file, gone with the process
  return path.posix.join(scope.tmp, `${name}.sock`);
}

export interface BubbleLock {
  /** This process holds the bubble. */
  readonly owned: boolean;
  /** Lets the lock go (the app quits): the next company waiting takes it over; a waiter stops waiting. */
  dispose(): void;
}

export interface BubbleLockOptions {
  address: string;
  /** Decides the macOS cleanup of a socket file nobody answers on. */
  platform: NodeJS.Platform;
  /** Called once, when this process got the lock: open the bubble now. */
  onOwn(): void;
  log(line: string): void;
  retryMs?: number;
}

/** Tries to take the lock now and, while another company holds it, waits for its turn. */
export function holdBubbleLock(options: BubbleLockOptions): BubbleLock {
  const { address, platform, log } = options;
  const retryMs = options.retryMs ?? BUBBLE_RETRY_MS;
  let disposed = false;
  let owned = false;
  let server: net.Server | null = null;
  let probe: net.Socket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const waiters = new Set<net.Socket>();

  const later = (ms: number) => {
    if (disposed || owned) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; tryHold(); }, ms);
  };

  const tryHold = () => {
    if (disposed || owned || server || probe) return;
    const candidate = net.createServer((socket) => {
      // a company waiting for its turn: it hears nothing, only the close when this process ends
      waiters.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => waiters.delete(socket));
    });
    server = candidate;
    candidate.on('error', (error: NodeJS.ErrnoException) => {
      if (owned) { log(`bubble lock: ${error.code ?? error.message}`); return; }
      server = null;
      candidate.close();
      if (disposed) return;
      if (error.code === 'EADDRINUSE') wait();
      else { log(`bubble lock not taken: ${error.code ?? error.message}`); later(retryMs); }
    });
    candidate.listen(address, () => {
      if (disposed) { candidate.close(); return; }
      owned = true;
      if (timer) { clearTimeout(timer); timer = null; }
      log('bubble lock held: this company shows the bubble');
      try { options.onOwn(); } catch (error) { log(`bubble not opened: ${error instanceof Error ? error.message : 'error'}`); }
    });
  };

  /** Another company holds it: stay connected until that connection closes. */
  const wait = () => {
    let connected = false;
    let refused = false;
    const socket = net.connect(address);
    probe = socket;
    socket.on('connect', () => { connected = true; log('bubble lock held by another company: waiting'); });
    socket.on('data', () => undefined);
    socket.on('error', (error: NodeJS.ErrnoException) => { refused = !connected && (error.code === 'ECONNREFUSED' || error.code === 'ENOENT'); });
    socket.on('close', () => {
      if (probe === socket) probe = null;
      if (disposed || owned) return;
      if (connected) { later(SOON_MS); return; } // the holder quit or died
      if (refused && platform === 'darwin') {
        // a socket file nobody listens on: a crashed holder's – it goes, then try again
        try { unlinkSync(address); } catch { /* gone already */ }
        later(SOON_MS);
        return;
      }
      later(refused ? SOON_MS * 4 : retryMs); // the holder is just going or the pipe is busy: once more soon
    });
  };

  tryHold();
  return {
    get owned() { return owned; },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      probe?.destroy();
      probe = null;
      for (const socket of waiters) socket.destroy(); // the waiting companies hear it at once
      waiters.clear();
      server?.close();
      server = null;
      owned = false;
    },
  };
}
