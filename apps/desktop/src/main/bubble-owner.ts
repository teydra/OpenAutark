// One floating bubble per person on this PC (task_zbnv2b3h, 26.11.2026). Every company runs its own app process with
// its own data folder, so Electron's single-instance lock holds one company only; the bubble (float-bar-window.ts) and
// its global shortcut belong to just one of them: the first that is ready and gets this lock. The lock is a local
// socket that the operating system frees when its process ends, however it ends: a named pipe on Windows, an abstract
// socket on Linux. A company that finds the lock held connects to it and waits; that connection closing – the holder
// quit or died – is its turn to try again, and a slow retry covers anything else. The holder keeps the bubble until its
// process ends: there is no hand-over on a click (that comes with the app rebuild). A holder whose bubble fails to open
// lets the lock go again, so a broken company never keeps the bubble from the others.
// macOS (task_0fkwakw9): a socket file there survives a crash, and removing a stale one after a refused connect is a
// race – two companies can both see "refused", one removes the file and listens, the other removes that new file and
// listens too: two bubbles. So macOS takes an flock instead: open(2) with O_EXLOCK|O_NONBLOCK on a fixed file in the
// person's own Library (XNU sys/fcntl.h: O_EXLOCK 0x20; EWOULDBLOCK while another descriptor holds it). The lock sits on
// the open file, the descriptor stays open as long as this company holds the bubble, and the kernel lets go when it is
// closed – a quit, a kill or a crash alike; libuv opens with O_CLOEXEC, so no child process inherits it. The file itself
// is never removed (removing it while held would let the next company lock a new file beside the old lock). There is
// no socket to hear the holder go, so a waiting company tries again every 2 s – one open(2) that fails at once.
// Where the file system has no locks (EOPNOTSUPP, e.g. some network homes), onUnsupported keeps the old rule: the
// first company alone shows the bubble. Any other platform gets no address (null) and keeps that rule too.
// A 0.3.20 or older first company opens its bubble without this lock: while such a process still runs beside a newer
// one (only until the update has restarted it), two bubbles can show.
// Owns: the lock's address and the wait for it. Never: opens the bubble itself, reads a company's data, removes files.

import { createHash } from 'node:crypto';
import { closeSync, constants, mkdirSync, openSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** The slow retry while another company holds the lock (the closing connection is the fast way). */
export const BUBBLE_RETRY_MS = 15_000;
/** macOS: how often a waiting company tries the file lock again (no socket tells it the holder went). */
export const BUBBLE_POLL_MS = 2_000;
const SOON_MS = 150; // after the holder went away: listen is atomic, so several waiters at once are fine
/** XNU sys/fcntl.h: open with an exclusive flock(2) lock, taken atomically with the open. Node names no constant for it. */
export const O_EXLOCK = 0x20;

export interface BubbleLockScope {
  platform: NodeJS.Platform;
  /** The person's home folder: one lock per person (named pipes are seen by every user of the PC). */
  home: string;
  /** The product's name; a development run gets a lock of its own, so it never takes the installed app's bubble. */
  product: string;
  packaged: boolean;
}

/**
 * The lock's address for this person and product: the same for every company, different for anyone else.
 * Windows: a named pipe; Linux: an abstract socket; macOS: an absolute file path in the person's Library for an flock
 * (isLockFile). null on any other platform: there the first company alone shows the bubble, as before.
 */
export function bubbleLockAddress(scope: BubbleLockScope): string | null {
  if (scope.platform !== 'win32' && scope.platform !== 'linux' && scope.platform !== 'darwin') return null;
  const who = scope.platform === 'win32' ? scope.home.toLowerCase() : scope.home;
  const hash = createHash('sha256').update(`${scope.product}\n${scope.packaged ? 'app' : 'dev'}\n${who}`).digest('hex').slice(0, 20);
  const name = `autark-bubble-${hash}`;
  if (scope.platform === 'win32') return `\\\\.\\pipe\\${name}`;
  // macOS: Application Support is the person's own (~/Library is 0700) and never cleaned by the system, unlike $TMPDIR
  // or Caches – a lock file removed under a holder would let a second company lock a new one. Beside the companies'
  // folders, never inside one: a company's backup, restore or removal must not touch it.
  if (scope.platform === 'darwin') return path.posix.join(scope.home, 'Library', 'Application Support', `${scope.product} Bubble`, `${name}.lock`);
  return `\0${name}`; // Linux abstract: no file, gone with the process
}

/** A macOS lock file (an absolute path), not a socket address (a Windows pipe "\\.\pipe\…" or a Linux "\0…"). */
export function isLockFile(address: string): boolean {
  return address.startsWith('/');
}

export interface BubbleLock {
  /** This process holds the bubble. */
  readonly owned: boolean;
  /** Lets the lock go (the app quits): the next company waiting takes it over; a waiter stops waiting. */
  dispose(): void;
}

export interface BubbleLockOptions {
  /** From bubbleLockAddress: a named pipe, an abstract socket or (macOS) a lock file that is never removed. */
  address: string;
  /** Called when this process got the lock: open the bubble now. If it throws, the lock goes back and is tried again later. */
  onOwn(): void;
  /** macOS: the file system takes no lock (EOPNOTSUPP); no more tries – the caller keeps the first-company rule. */
  onUnsupported?(): void;
  log(line: string): void;
  retryMs?: number;
  /** macOS: how often a waiting company tries again (BUBBLE_POLL_MS). */
  pollMs?: number;
}

/** Tries to take the lock now and, while another company holds it, waits for its turn. */
export function holdBubbleLock(options: BubbleLockOptions): BubbleLock {
  if (isLockFile(options.address)) return holdFileLock(options);
  const { address, log } = options;
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

  /** Closes the server and tells every waiting company at once. */
  const release = () => {
    for (const socket of waiters) socket.destroy();
    waiters.clear();
    server?.close();
    server = null;
    owned = false;
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
      if (server !== candidate) return; // released already
      if (owned) { log(`bubble lock: ${error.code ?? error.message}`); return; }
      server = null;
      candidate.close();
      if (disposed) return;
      if (error.code === 'EADDRINUSE') wait();
      else { log(`bubble lock not taken: ${error.code ?? error.message}`); later(retryMs); }
    });
    candidate.listen(address, () => {
      if (disposed || server !== candidate) { candidate.close(); return; }
      owned = true;
      if (timer) { clearTimeout(timer); timer = null; }
      log('bubble lock held: this company shows the bubble');
      try {
        options.onOwn();
      } catch (error) {
        // no bubble here: the lock must not stay with a company that shows none
        log(`bubble not opened, lock let go: ${error instanceof Error ? error.message : 'error'}`);
        release();
        later(retryMs);
      }
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
      if (connected) { later(SOON_MS); return; } // the holder quit, died or let go
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
      release(); // the waiting companies hear it at once
    },
  };
}

/** The open(2) error codes that mean "another descriptor holds the lock" and "this file system takes no lock". */
function lockError(error: unknown): 'held' | 'unsupported' | string {
  const { code, errno } = error as NodeJS.ErrnoException;
  if (code === 'EAGAIN' || code === 'EWOULDBLOCK') return 'held'; // macOS: EWOULDBLOCK == EAGAIN (35)
  if (code === 'ENOTSUP' || code === 'EOPNOTSUPP' || errno === -102) return 'unsupported'; // darwin EOPNOTSUPP 102 has no libuv name
  return code ?? (error instanceof Error ? error.message : 'error');
}

/** macOS: the lock is an flock on a file descriptor this process keeps open while it holds the bubble. */
function holdFileLock(options: BubbleLockOptions): BubbleLock {
  const { address: file, log } = options;
  const retryMs = options.retryMs ?? BUBBLE_RETRY_MS;
  const pollMs = options.pollMs ?? BUBBLE_POLL_MS;
  const flags = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_EXLOCK;
  let disposed = false;
  let fd: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let waiting = false;
  let lastError = '';

  const later = (ms: number) => {
    if (disposed || fd !== null) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; tryHold(); }, ms);
  };
  /** Closing the descriptor is what lets the lock go; the file stays. */
  const release = () => {
    if (fd === null) return;
    const held = fd;
    fd = null;
    try { closeSync(held); } catch { /* closed already */ }
  };

  const tryHold = () => {
    if (disposed || fd !== null) return;
    let opened: number;
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      opened = openSync(file, flags, 0o600);
    } catch (error) {
      const kind = lockError(error);
      if (kind === 'held') {
        if (!waiting) { waiting = true; log('bubble lock held by another company: waiting'); }
        later(pollMs);
      } else if (kind === 'unsupported') {
        log('bubble lock: this file system takes no lock, the first company alone shows the bubble');
        disposed = true;
        options.onUnsupported?.();
      } else {
        if (kind !== lastError) { lastError = kind; log(`bubble lock not taken: ${kind}`); }
        later(retryMs);
      }
      return;
    }
    fd = opened;
    waiting = false;
    lastError = '';
    log('bubble lock held: this company shows the bubble');
    try {
      options.onOwn();
    } catch (error) {
      // no bubble here: the lock must not stay with a company that shows none
      log(`bubble not opened, lock let go: ${error instanceof Error ? error.message : 'error'}`);
      release();
      later(retryMs);
    }
  };

  tryHold();
  return {
    get owned() { return fd !== null; },
    dispose: () => {
      if (disposed && fd === null) return;
      disposed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      release();
    },
  };
}
