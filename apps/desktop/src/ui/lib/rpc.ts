// Typed RPC client for the runtime. Two transports, one API:
//   desktop     – MessagePort posted by the preload after `window.workforce.connect()`, owner scope
//   PWA/web     – WebSocket to `/ws`, first frame is a Hello with the device token (inside the iPhone web app the
//                 shell's tunnel socket, window.autarkHosted – pwa/hosted.ts)
// Auto-reconnects with backoff (on desktop also as soon as the bridge reports the runtime 'up'
// again after a restart), re-subscribes topics, rejects pending calls on disconnect. A socket the
// runtime closes on purpose (4401: token refused, this device is no longer paired, 4403: this device
// was removed) is remembered in `refused` until the runtime answers again, so the app can say so
// instead of showing "offline"; a later 4401 for a token the runtime revoked stays 4403, also
// after a reload (lib/refusal.ts). Reconnecting goes on with backoff, which only an answer from
// the runtime resets (a refused socket opens, then closes). A socket gets 8 s to open (a dead phone
// tunnel would leave it 'connecting' for minutes). When the phone/browser page comes back (visible,
// pageshow, online, a push, the Android app's `resume`, the iPhone shell's new channel – autarkResume),
// checkAlive connects a socket that is not open at once (replacing an attempt older than 8 s, whose timer a sleeping phone froze)
// and gives an open one 3 s to answer `session.info`, else replaces it as half-open. refresh()
// (pull-down) does the same and reloads everything once a live socket answers. A call made while not open waits up to
// 8 s for the connection (rpc-queue.ts; the desktop window's before its runtime first answered: until it does), then
// rejects 'unavailable' with NOT_SENT – none of it went out (D6, 19.11.).
// A PC that does not know this phone's token at all closes with 4404 (runtime/http/ws.ts), kept in `refused` like 4401.
// Fest round 22.11.2026 – one silence rule for every socket (browser, Android, iPhone): the PC sends a page's socket a
// frame at least every 15 s (its beat, runtime/http/keepalive.ts – a page cannot see pings), so an open socket that hears
// nothing for SILENT_MS (shared/api/protocol.ts) lost its way without an end: it is replaced like a probe without an
// answer, and the new one reloads everything (rpc.open). One timer, started again by every frame. While a call of this
// page waits for its answer the wait stretches to WAIT_LIMIT silent minutes: a page cannot see a large answer arriving on
// a slow link (the beats queue behind it), and cutting under it would reload, ask again and cut again – but a page that
// always has a call out (a file tab's look every 2 s, a pull) on a dead socket still ends it (review 22.11.2026; a long
// poll answers within its own wait, so it never holds the stretch). The desktop port reports its own end.
// Owns: framing, request ids, the event fan-out, connection status, the socket's liveness check and silence wait.
// Never: holds app state (see store.ts) or retries calls itself (callers decide; effects
// must never be blindly repeated).

import { signal } from '@preact/signals';
import type { EventMap, EventName } from '../../shared/api/events.ts';
import type { MethodName, ParamsOf, ResultOf } from '../../shared/api/methods.ts';
import { PROTOCOL_VERSION, SILENT_MS, isEvent, isResponse } from '../../shared/api/protocol.ts';
import type { Hello, RpcRequest, Topic } from '../../shared/api/protocol.ts';
import { hostedShell } from '../pwa/hosted.ts';
import { onNative } from '../pwa/native-port.ts';
import { bridge, platform } from './platform.ts';
import { RefusalMemory } from './refusal.ts';
import type { Refusal } from './refusal.ts';
import { CallQueue } from './rpc-queue.ts';
import { LOST_TEXT as LOST, NOT_SENT_DESKTOP, NOT_SENT_PHONE, RpcError } from './rpc-error.ts';
import { readToken } from './rpc-token.ts';
import { RuntimeEpochs, requestPort } from './runtime-port.ts';

export { RpcError, connectionFailure, errorText } from './rpc-error.ts';
export type ConnectionStatus = 'connecting' | 'open' | 'closed';

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  method: string;
}

interface Transport {
  send(frame: unknown): void;
  close(): void;
}

const status = signal<ConnectionStatus>('connecting');
/** Close code of the last socket the runtime refused (4401), revoked (4403) or did not know (4404); null once it answers. */
const refused = signal<Refusal | null>(null);
const refusals = new RefusalMemory();
const pending = new Map<number, Pending>();
const queue = new CallQueue(); // requests issued while not connected
const listeners = new Map<string, Set<(data: unknown) => void>>();
const topics = new Set<Topic>();
let transport: Transport | null = null;
let nextId = 1;
let retryDelay = 500;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let connecting = false; // one connect attempt at a time
let attempt = 0; // the current attempt; one that was given up and settles late changes nothing
let attemptAt = 0;
let giveUp: (() => void) | null = null; // ends the current socket attempt now
let probing = false; // one liveness probe at a time
let reloadOnAnswer = false; // refresh(): the probe's answer reloads everything
let everOpen = false; // the connection was open once in this page life
const OPEN_LIMIT = 8_000;
/** Silent minutes a waiting call gets before the socket counts as dead: a large answer on a slow link has five minutes. */
const WAIT_LIMIT = 5;
/** A pending call's error when the connection went away under it (the status line says the rest, never as a line of its own). */
export const LOST_TEXT = LOST;
/** A queued call's error after QUEUE_LIMIT_MS without a connection (also never a line of its own: rpc-error.ts connectionFailure). */
export const NOT_SENT = platform === 'desktop' ? NOT_SENT_DESKTOP : NOT_SENT_PHONE;
const epochs = new RuntimeEpochs();

function handleFrame(raw: unknown): void {
  retryDelay = 500; // the runtime answered: this connection was accepted
  if (refused.peek() !== null) { refused.value = null; refusals.answered(); }
  let frame = raw;
  if (typeof raw === 'string') {
    try { frame = JSON.parse(raw); } catch { return; }
  }
  if (isEvent(frame)) {
    const set = listeners.get(frame.event);
    if (set) for (const fn of [...set]) {
      try { fn(frame.data); } catch (error) { console.error(`[rpc] listener for ${frame.event} failed`, error); }
    }
    return;
  }
  if (isResponse(frame)) {
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    if (frame.error) entry.reject(new RpcError(frame.error));
    else entry.resolve(frame.result);
  }
}

function onOpen(next: Transport): void {
  transport = next;
  status.value = 'open';
  everOpen = true;
  if (topics.size) next.send({ id: nextId++, method: 'events.subscribe', params: { topics: [...topics] } });
  for (const request of queue.take()) next.send(request);
  emitLocal('rpc.open');
}

function onClosed(): void {
  if (!transport && status.value === 'closed') return;
  transport = null;
  status.value = 'closed';
  const error = new RpcError({ code: 'unavailable', message: LOST_TEXT });
  for (const [id, entry] of pending) { pending.delete(id); entry.reject(error); }
  scheduleReconnect();
}

function scheduleReconnect(): void {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; void connect(); }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 10_000);
}

async function connectPort(): Promise<void> {
  const port = await requestPort();
  port.onmessage = (event) => handleFrame(event.data);
  port.start();
  const next: Transport = { send: (frame) => port.postMessage(frame), close: () => port.close() };
  // Chromium fires 'close' on a port whose other end went away (the runtime process exited).
  port.addEventListener('close', () => { if (transport === next) onClosed(); });
  epochs.opened();
  onOpen(next);
}

function connectSocket(): Promise<void> {
  return new Promise((resolve, reject) => {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    // Inside the iPhone web app the socket is a tunnel stream to the PC (pwa/hosted.ts); elsewhere the page's own host.
    const hosted = hostedShell();
    const socket = hosted ? (hosted.socket('/ws') as unknown as WebSocket) : new WebSocket(`${scheme}://${location.host}/ws`);
    let silent: ReturnType<typeof setTimeout> | undefined;
    let waits = 0; // silent minutes in a row a waiting call was given
    let beatSupported = false; // legacy PCs send no application heartbeat
    /** SILENT_MS without a frame: replaced – unless a call waits for its answer, which may be arriving slowly: up to WAIT_LIMIT silent minutes. */
    const quiet = () => {
      if (transport !== next) return;
      if (pending.size && ++waits < WAIT_LIMIT) silent = setTimeout(quiet, SILENT_MS);
      else reconnectNow();
    };
    /** Heard from the PC (or just opened): the silence wait starts over. */
    const heard = () => {
      waits = 0;
      clearTimeout(silent);
      silent = setTimeout(quiet, SILENT_MS);
    };
    const next: Transport = { send: (frame) => socket.send(JSON.stringify(frame)), close: () => { clearTimeout(silent); socket.onmessage = null; socket.close(); } };
    let opened = false;
    let token = '';
    const end = () => {
      clearTimeout(limit);
      socket.onopen = socket.onmessage = socket.onclose = null;
      try { socket.close(); } catch { /* never opened */ }
      reject(new Error('socket did not open'));
    };
    const limit = setTimeout(end, OPEN_LIMIT); // event-armed once; open or close clears it
    giveUp = end;
    socket.onopen = () => {
      clearTimeout(limit);
      opened = true;
      token = readToken();
      const hello: Hello = { protocol: PROTOCOL_VERSION, token, client: 'pwa', deviceName: navigator.userAgent.slice(0, 80) };
      socket.send(JSON.stringify(hello));
      onOpen(next);
      resolve();
    };
    socket.onmessage = (event) => {
      if (event.data === '{}') beatSupported = true;
      if (beatSupported) heard();
      handleFrame(event.data);
    };
    socket.onclose = (event) => {
      clearTimeout(limit);
      clearTimeout(silent);
      const refusal = refusals.closed(event.code, token);
      if (refusal !== null) refused.value = refusal;
      if (!opened) reject(new Error('socket closed'));
      else if (transport === next) onClosed();
    };
  });
}

async function connect(): Promise<void> {
  if (connecting) return;
  const mine = ++attempt;
  connecting = true;
  attemptAt = Date.now();
  status.value = 'connecting';
  try {
    if (platform === 'desktop' && bridge) await connectPort();
    else await connectSocket();
  } catch {
    if (mine !== attempt) return;
    status.value = 'closed';
    scheduleReconnect();
  } finally {
    if (mine === attempt) { connecting = false; giveUp = null; }
  }
}

/** Drops the current transport (its pending calls reject, status 'closed') and connects again right away. */
function reconnectNow(): void {
  if (connecting) { // only a socket attempt can be given up (the desktop port reports its own end)
    if (!giveUp) return;
    giveUp();
    connecting = false;
  }
  const stale = transport;
  if (stale) {
    onClosed();
    try { stale.close(); } catch { /* already closed */ }
  }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  retryDelay = 500;
  void connect();
}

/** Desktop: a restarted runtime closed the old port – drop it and connect again right away. */
function watchRuntime(): void {
  if (platform !== 'desktop' || !bridge) return;
  bridge.onRuntime((runtime) => {
    if (epochs.status(runtime, transport !== null) && !connecting) reconnectNow();
  });
}

/**
 * Phone/browser (the desktop port reports its own end): a socket that is not open connects now
 * (a connect attempt older than 8 s is replaced); an open one answers `session.info` within 3 s, or
 * it is half-open (events stopped, calls hang) and is replaced at once. Runs on visible, pageshow,
 * online, a push (pwa/install.ts), the Android app's `resume` and the iPhone shell's new channel (autarkResume).
 */
export function checkAlive(): void {
  if (bridge || !started || probing) return;
  if (connecting && Date.now() - attemptAt < OPEN_LIMIT) return;
  if (status.peek() !== 'open') { reconnectNow(); return; }
  probe();
}

function probe(): void {
  probing = true;
  const dead = setTimeout(reconnectNow, 3_000); // every close rejects the probe first, which clears this
  void call('session.info').then(() => { if (reloadOnAnswer) emitLocal('rpc.open'); }, () => undefined)
    .finally(() => { clearTimeout(dead); probing = false; reloadOnAnswer = false; });
}

/** Pull-down: a socket that is not open connects now; an open one is probed and its answer reloads everything (rpc.open). */
export function refresh(): void {
  if (!started) return start();
  if (status.peek() !== 'open') { reconnectNow(); return; }
  if (bridge) { emitLocal('rpc.open'); return; }
  reloadOnAnswer = true;
  if (!probing) probe();
}

function emitLocal(name: string): void {
  const set = listeners.get(name);
  if (set) for (const fn of [...set]) fn(undefined);
}

function call<M extends MethodName>(method: M, params?: ParamsOf<M>): Promise<ResultOf<M>> {
  start();
  const id = nextId++;
  const request: RpcRequest = params === undefined ? { id, method } : { id, method, params };
  return new Promise<ResultOf<M>>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, method });
    if (transport && status.value === 'open') {
      try { transport.send(request); } catch (error) { pending.delete(id); reject(error); }
    } else {
      const expired = () => { if (pending.delete(id)) reject(new RpcError({ code: 'unavailable', message: NOT_SENT })); };
      queue.add(request, platform !== 'desktop' || everOpen ? expired : undefined); // a desktop cold start waits
    }
  });
}

function on<E extends EventName>(event: E, fn: (data: EventMap[E]) => void): () => void {
  let set = listeners.get(event);
  if (!set) { set = new Set(); listeners.set(event, set); }
  const wrapped = fn as (data: unknown) => void;
  set.add(wrapped);
  return () => { set.delete(wrapped); };
}

/** Called after every (re)connect – used by the store to reload snapshots. */
function onOpenEvent(fn: () => void): () => void {
  let set = listeners.get('rpc.open');
  if (!set) { set = new Set(); listeners.set('rpc.open', set); }
  set.add(fn);
  return () => { set.delete(fn); };
}

function subscribe(next: Topic[]): void {
  const fresh = next.filter((topic) => !topics.has(topic));
  if (!fresh.length) return;
  for (const topic of fresh) topics.add(topic);
  if (transport && status.value === 'open') void call('events.subscribe', { topics: fresh }).catch(() => undefined);
}

function unsubscribe(next: Topic[]): void {
  const known = next.filter((topic) => topics.has(topic));
  if (!known.length) return;
  for (const topic of known) topics.delete(topic);
  if (transport && status.value === 'open') void call('events.unsubscribe', { topics: known }).catch(() => undefined);
}

/** Starts the connection once (idempotent). Reconnects when the network or the page comes back. */
function start(): void {
  if (started) return;
  started = true;
  watchRuntime();
  void connect();
  window.addEventListener('online', () => { if (!bridge) checkAlive(); else if (status.value !== 'open' && retryTimer) reconnectNow(); });
  window.addEventListener('pageshow', checkAlive);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkAlive(); });
  (window as { autarkResume?: () => void }).autarkResume = checkAlive; // the iPhone shell after a new channel (hosted/shell.ts)
  onNative('resume', checkAlive);
}

export const rpc = { call, on, subscribe, unsubscribe, onOpen: onOpenEvent, start, status, refused, refresh };
