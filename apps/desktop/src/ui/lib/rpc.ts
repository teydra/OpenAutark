// Typed RPC client for the runtime. Two transports, one API:
//   desktop     – MessagePort posted by the preload after `window.workforce.connect()`, owner scope
//   PWA/web     – WebSocket to `/ws`, first frame is a Hello with the device token (inside the iPhone web app the
//                 shell's tunnel socket, window.autarkHosted – pwa/hosted.ts)
// Re-subscribes topics, rejects pending calls on disconnect. A socket the
// runtime closes on purpose (4401: token refused, this device is no longer paired, 4403: this device
// was removed) is remembered in `refused` until the runtime answers again, so the app can say so
// instead of showing "offline"; a later 4401 for a token the runtime revoked stays 4403, also
// after a reload (lib/refusal.ts). A PC that does not know this phone's token at all closes with 4404 (runtime/http/ws.ts),
// kept in `refused` like 4401.
// Reconnecting (owner 27.11.2026: "when the link drops for a moment it simply reconnects fast by itself"): after a close
// the first attempt goes out at once, then short steps (retryDelay: 250 ms doubling to 2 s while the page is in front,
// to 10 s while it is hidden or the PC refuses this device); any frame from the runtime starts the steps over. On desktop
// also as soon as the bridge reports the runtime 'up' again after a restart. A socket gets OPEN_LIMIT_MS to open (a dead
// phone tunnel would leave it 'connecting' for minutes). When the phone/browser page comes back (visible, pageshow,
// online, a push, the Android app's `resume`, the iPhone shell's new channel – autarkResume), checkAlive connects a
// socket that is not open at once (replacing an attempt older than OPEN_LIMIT_MS, whose timer a sleeping phone froze)
// and gives an open one 3 s to answer `session.info`, else replaces it as half-open. refresh() (pull-down) does the same
// and reloads everything once a live socket answers. A call made while not open waits up to 8 s for the connection
// (rpc-queue.ts; the desktop window's before its runtime first answered: until it does), then rejects 'unavailable' with
// NOT_SENT – none of it went out (D6, 19.11.).
// Liveness of an open socket (browser, Android, iPhone): the PC sends it a frame at least every 15 s (its beat,
// runtime/http/keepalive.ts – a page cannot see pings). A call that heard nothing back for ANSWER_QUIET_MS – no frame of
// any kind since it went out – sends the one probe (3 s for `session.info`), so a half-open socket under a waiting call
// is replaced within seconds, never minutes; an idle socket that hears nothing for SILENT_MS (shared/api/protocol.ts) is
// replaced too; while a file's bytes are on the way (MOVING) neither cuts before MOVING_LIMIT silent minutes. The new
// socket reloads everything (rpc.open). The desktop port reports its own end.
// The PC's version (owner 27.11.2026: the phone app carries its own interface): a socket's first ask, right behind the
// Hello, is system.info, and the socket counts as open only once its PC names a version this interface works with
// (lib/pc-floor.ts) – queued calls, subscriptions and loads wait for that. An older PC gets nothing more: its name stays in
// `outdated` (the quiet state says "Update Autark on <PC>"), the socket closes and it is asked again every
// OUTDATED_RETRY_MS. `turnedAway` counts the sockets that opened and were sent off – refused by their PC (4401/4403/4404)
// or found too old – so the phone app can move the page to the company's next PC (pwa/native.ts reportRefusals).
// Owns: framing, request ids, the event fan-out, connection status, the reconnect steps and the socket's liveness checks.
// Never: holds app state (see store.ts) or retries calls itself (callers decide; effects
// must never be blindly repeated).

import { signal } from '@preact/signals';
import type { EventMap, EventName } from '../../shared/api/events.ts';
import type { MethodName, ParamsOf, ResultOf } from '../../shared/api/methods.ts';
import { OPEN_LIMIT_MS, PROTOCOL_VERSION, SILENT_MS, isEvent, isResponse } from '../../shared/api/protocol.ts';
import type { Hello, RpcRequest, Topic } from '../../shared/api/protocol.ts';
import type { SystemInfo } from '../../shared/model/system.ts';
import { hostedShell } from '../pwa/hosted.ts';
import { onNative } from '../pwa/native-port.ts';
import { pcFits } from './pc-floor.ts';
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
/** The name of the PC whose socket said a version older than this interface works with; null once a fitting PC answered. */
const outdated = signal<string | null>(null);
/** How many sockets opened and were sent off (refused or too old); the phone app moves on at each. */
const turnedAway = signal(0);
/** How often a PC that is too old is asked again (it may be updated meanwhile). */
const OUTDATED_RETRY_MS = 10_000;
const pending = new Map<number, Pending>();
const queue = new CallQueue(); // requests issued while not connected
const listeners = new Map<string, Set<(data: unknown) => void>>();
const topics = new Set<Topic>();
let transport: Transport | null = null;
let nextId = 1;
let failures = 0; // reconnect attempts since the runtime last answered
let frames = 0; // frames heard in this page life (a waiting call compares)
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let connecting = false; // one connect attempt at a time
let attempt = 0; // the current attempt; one that was given up and settles late changes nothing
let attemptAt = 0;
let giveUp: (() => void) | null = null; // ends the current socket attempt now
let probing = false; // one liveness probe at a time
let reloadOnAnswer = false; // refresh(): the probe's answer reloads everything
let everOpen = false; // the connection was open once in this page life
const OPEN_LIMIT = OPEN_LIMIT_MS;
/** A call that heard no frame at all for this long since it went out probes the socket (probe: 3 s more for the answer). */
export const ANSWER_QUIET_MS = 4_000;
const PROBE_MS = 3_000;
/**
 * Calls that carry a file's bytes in one frame (lib/files.ts: a preview up to 8 MB, an upload chunk of 4 MB): on a slow
 * link that frame takes longer than a probe, and every frame behind it – the probe's answer and the beats – waits too.
 * While one is out the socket gets up to MOVING_LIMIT silent minutes and is not probed (review 27.11.2026: cutting under it
 * would reload, ask again and cut again).
 */
const MOVING = new Set<string>(['files.read', 'files.upload', 'files.uploadChunk']);
const MOVING_LIMIT = 5;
const moving = (): boolean => [...pending.values()].some((call) => MOVING.has(call.method));
/** A pending call's error when the connection went away under it (the status line says the rest, never as a line of its own). */
export const LOST_TEXT = LOST;
/** A queued call's error after QUEUE_LIMIT_MS without a connection (also never a line of its own: rpc-error.ts connectionFailure). */
export const NOT_SENT = platform === 'desktop' ? NOT_SENT_DESKTOP : NOT_SENT_PHONE;
const epochs = new RuntimeEpochs();

function handleFrame(raw: unknown): void {
  failures = 0; // the runtime answered: this connection was accepted
  frames += 1;
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
  for (const request of queue.take()) { next.send(request); watchAnswer(request.id); }
  emitLocal('rpc.open');
}

/** A sent call: when no frame at all came in for ANSWER_QUIET_MS while it waits, the socket is probed (phone/browser). */
function watchAnswer(id: number): void {
  if (bridge) return;
  const seen = frames;
  setTimeout(() => { if (pending.has(id) && frames === seen && status.peek() === 'open' && !probing && !moving()) probe(); }, ANSWER_QUIET_MS);
}

function onClosed(): void {
  if (!transport && status.value === 'closed') return;
  transport = null;
  status.value = 'closed';
  const error = new RpcError({ code: 'unavailable', message: LOST_TEXT });
  for (const [id, entry] of pending) { pending.delete(id); entry.reject(error); }
  scheduleReconnect();
}

/** The wait before the next attempt: none after a close, then 250 ms doubling to 2 s – to 10 s while hidden or refused. */
export function retryDelay(failed: number, slow: boolean): number {
  if (failed <= 0) return 0;
  return slow ? Math.min(500 * 2 ** (failed - 1), 10_000) : Math.min(250 * 2 ** (failed - 1), 2_000);
}

function scheduleReconnect(): void {
  if (retryTimer) return;
  const slow = refused.peek() !== null || (typeof document !== 'undefined' && document.visibilityState === 'hidden');
  const wait = outdated.peek() !== null ? OUTDATED_RETRY_MS : retryDelay(failures++, slow);
  retryTimer = setTimeout(() => { retryTimer = null; void connect(); }, wait);
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
    let waits = 0; // silent minutes in a row a file's bytes were given (MOVING)
    /** SILENT_MS without a frame replaces the socket – unless a file's bytes are on the way: up to MOVING_LIMIT minutes. */
    const quiet = () => {
      if (transport !== next) return;
      if (moving() && ++waits < MOVING_LIMIT) silent = setTimeout(quiet, SILENT_MS);
      else reconnectNow();
    };
    /** Heard from the PC (or just opened): the silence wait starts over. */
    const heard = () => {
      waits = 0;
      clearTimeout(silent);
      silent = setTimeout(quiet, SILENT_MS);
    };
    const next: Transport = { send: (frame) => socket.send(JSON.stringify(frame)), close: () => { clearTimeout(silent); socket.onmessage = null; socket.close(); } };
    let opened = false; // the socket opened (its Hello went out)
    let admitted = false; // its PC named a version this interface works with: the connection is open
    let token = '';
    let ask = 0; // the version ask's request id
    const end = (why = 'socket did not open') => {
      clearTimeout(limit);
      clearTimeout(silent);
      pending.delete(ask);
      socket.onopen = socket.onmessage = socket.onclose = null;
      try { socket.close(); } catch { /* never opened */ }
      reject(new Error(why));
    };
    let limit = setTimeout(end, OPEN_LIMIT); // event-armed; open restarts it for the version ask, admission or a close clears it
    giveUp = end;
    /** The version ask's answer: a fitting PC opens the connection, an older one is sent off (an error answer cannot tell: open). */
    const answered = (info: SystemInfo | null) => {
      if (info && !pcFits(info.version)) {
        outdated.value = (typeof info.deviceName === 'string' ? info.deviceName.trim().slice(0, 40) : '') || 'your PC';
        turnedAway.value += 1;
        end('PC too old');
        return;
      }
      clearTimeout(limit);
      admitted = true;
      outdated.value = null;
      onOpen(next);
      resolve();
    };
    socket.onopen = () => {
      clearTimeout(limit);
      opened = true;
      token = readToken();
      const hello: Hello = { protocol: PROTOCOL_VERSION, token, client: 'pwa', deviceName: navigator.userAgent.slice(0, 80) };
      socket.send(JSON.stringify(hello));
      heard();
      limit = setTimeout(end, PROBE_MS); // a PC that never says its version is as dead as one that never opens
      ask = nextId++;
      pending.set(ask, { method: 'system.info', resolve: (info) => answered(info as SystemInfo), reject: () => answered(null) });
      socket.send(JSON.stringify({ id: ask, method: 'system.info' }));
    };
    socket.onmessage = (event) => {
      heard();
      handleFrame(event.data);
    };
    socket.onclose = (event) => {
      clearTimeout(limit);
      clearTimeout(silent);
      const refusal = refusals.closed(event.code, token);
      if (refusal !== null) { refused.value = refusal; outdated.value = null; } // the newest PC's word stands
      if (opened && refusal !== null) turnedAway.value += 1;
      if (!admitted) { pending.delete(ask); reject(new Error('socket closed')); }
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
  failures = 0;
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
 * (a connect attempt older than OPEN_LIMIT_MS is replaced); an open one answers `session.info` within 3 s, or
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
  const dead = setTimeout(reconnectNow, PROBE_MS); // every close rejects the probe first, which clears this
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
      try { transport.send(request); watchAnswer(id); } catch (error) { pending.delete(id); reject(error); }
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

export const rpc = { call, on, subscribe, unsubscribe, onOpen: onOpenEvent, start, status, refused, outdated, turnedAway, refresh };
