// B-078 (D6): phone use through the Autark Android app – no ADB, no cable. The app's own use socket attaches
// (phoneUse.attach, rpc/handlers/phone-use.ts) and hears `phoneUse.request` for its device only; this driver sends one
// request per step on the bus, with the run (`job`) and the agent's name (`by`), and waits for its phoneUse.reply (20 s,
// a question APP_PHONE_ASK_TIMEOUT_MS, or the run's cancel). The serial of an app phone is its device id. On the phone
// an AccessibilityService reads nothing until a request asks, and a bubble names the agent while it acts (feedback
// 16.11.2026 F16, apps/android phoneuse/*): the person's Pause holds until Continue, their ✕ ends it for the job; their
// own taps and typing change nothing (owner 20.11.2026) – my next look shows the screen as it is. `say` puts the AI's
// line or question (✓ / ✕) in the bubble. `open` with `app` opens an app by the name under its icon (Konrad 19.11.2026
// guessed SimplySign's package twice); an app before that answers bad_request, which becomes OLD_APP_OPEN.
// `say` with buttons (owner 19.11.2026) puts the AI's own labels there. When a run that used a phone is over
// (run.upserted with its end), that phone hears 'done' and its bubble goes at once instead of lingering (owner 19.11.:
// "sehe ich immer noch, dass sie gerade mein Handy verwendet, obwohl sie schon längst aufgehört hat").
// The phone's refusals reach the AI in its own words; an app older than 0.3.15 that does not know `say` gets OLD_APP_SAY.
// A type step brings back what the field reads afterwards (`text`, chat sweep 16.11.: extra words in a field show at once).
// useOf tells the rest of the runtime (RuntimeServices.phones) whether an app phone is attached and its phone use on.
// Owns: the attached phones, the request/answer pairing, the runs that used each phone, and turning answers into
// PhoneDriver values.
// Never: reaches a phone that is not attached, or keeps a request beyond its timeout.

import { randomBytes } from 'node:crypto';
import type { Bus } from '../bus.ts';
import type { Device } from '../../shared/model/devices.ts';
import { PHONE_BUTTON_MAX, PHONE_SAY_BUTTONS_MAX, PHONE_SAY_MAX, type PhoneUseAttach, type PhoneUseOp, type PhoneUseReply } from '../../shared/api/methods-phone.ts';
import { WorkforceError, type ErrorCode } from '../../shared/errors.ts';
import type { PhoneDriver, PhoneOpenTarget, PhoneSaid, PhoneShot, PhoneStepOptions, PhoneTree } from './driver.ts';
import { renderDump, screenOf, type PhoneDevice, type PhoneNode } from './uiautomator.ts';

export const APP_PHONE_TIMEOUT_MS = 20_000;
/** A question in the bubble: the phone waits 60 s for ✓ or ✕, plus the way there and back. */
export const APP_PHONE_ASK_TIMEOUT_MS = 75_000;
/** The most of a field's text a type step brings back (the app cuts it to this too). */
export const FIELD_MAX = 300;

/** What I read when the phone's app does not know `say` yet. */
export const OLD_APP_SAY = 'The Autark app on this phone is older than 0.3.15; it updates itself in the app. Until then my phone steps work without a line or question in the bubble.';

/** What I read when the phone's app does not open apps by name yet. */
export const OLD_APP_OPEN = 'The Autark app on this phone opens apps by package only until its next update (it updates itself in the app). Until then I open the app with its package, or tap its icon in the app list.';

/** What the phone says when phone use is not on yet (it shows the enable notification itself). */
export const PHONE_USE_OFF = 'Phone use is off on this phone. The app showed the person a notification "Let the AI use this phone"; one tap opens Android\'s Accessibility settings (an app from outside the Play Store first needs Settings › Apps › Autark › ⋮ › Allow restricted settings). I try again once it is on.';

/** How many running jobs the driver remembers per phone use (a run that never reports its end drops out first). */
const JOBS_KEPT = 64;
const ENDED: ReadonlySet<string> = new Set(['done', 'failed', 'interrupted']);

export interface AppPhonesDeps {
  bus: Pick<Bus, 'on' | 'emit'>;
  /** The device list (names of phones). */
  devices(): Device[];
  timeoutMs?: number;
  idleMs?: number;
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
}

interface Attached { model?: string; screen?: { width: number; height: number }; ready: boolean; sockets: number }
interface Pending { deviceId: string; job?: string; resolve(value: unknown): void; reject(error: Error): void; timer: unknown; off?: () => void }

/** Without a phone step of its run for this long (and none waiting), the phone hears 'done' – the AI is thinking or finished (owner 24.11.2026). */
export const PHONE_IDLE_MS = 15_000;

const realTimers = {
  set: (fn: () => void, ms: number) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer as unknown; },
  clear: (handle: unknown) => { if (handle) clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

const KNOWN: ReadonlySet<string> = new Set(['bad_request', 'not_found', 'forbidden', 'conflict', 'unavailable', 'timeout', 'cancelled']);

export class AppPhones implements PhoneDriver {
  private readonly deps: AppPhonesDeps;
  private readonly attached = new Map<string, Attached>();
  private readonly pending = new Map<string, Pending>();
  /** Runs that sent a step, and the phones they used: each hears 'done' when its run ends. */
  private readonly jobs = new Map<string, Set<string>>();
  private readonly idle = new Map<string, unknown>();
  private readonly offs: Array<() => void>;

  constructor(deps: AppPhonesDeps) {
    this.deps = deps;
    this.offs = [
      deps.bus.on('phoneUse.attached', (event) => this.attach(event)),
      deps.bus.on('phoneUse.reply', (reply) => this.answer(reply)),
      deps.bus.on('run.upserted', (run) => { if (ENDED.has(run?.status)) this.finished(run.id); }),
    ];
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    for (const [id, entry] of [...this.pending]) this.settle(id, entry, new WorkforceError('unavailable', 'Autark is shutting down.'));
    for (const job of [...this.idle.keys()]) this.unidle(job);
  }

  /** True when an app phone with this serial (device id) is attached. */
  has(serial: string | undefined): boolean { return Boolean(serial && this.attached.has(serial)); }

  /** The attached app phones' serials. */
  serials(): string[] { return [...this.attached.keys()]; }

  async available(): Promise<boolean> { return this.attached.size > 0; }

  /** Phone use on an app phone now (RuntimeServices.phones, contracts/phones.ts): on, off, or undefined while it is not attached. */
  useOf(deviceId: string): 'on' | 'off' | undefined {
    const entry = this.attached.get(deviceId);
    return entry ? (entry.ready ? 'on' : 'off') : undefined;
  }

  async devices(): Promise<PhoneDevice[]> {
    const names = new Map(this.deps.devices().map((device) => [device.id, device.name]));
    return [...this.attached].map(([serial, entry]) => ({
      serial, state: entry.ready ? 'device' : 'phone use off', model: entry.model ?? names.get(serial), transport: 'autark-app',
    }));
  }

  async screenshot(serial?: string, step?: PhoneStepOptions): Promise<PhoneShot> {
    const device = this.pick(serial);
    const shot = await this.ask(device, 'screenshot', {}, step) as { data?: unknown; mime?: unknown; width?: unknown; height?: unknown; screen?: { width?: unknown; height?: unknown } };
    if (typeof shot?.data !== 'string') throw new WorkforceError('unavailable', 'The phone sent no screenshot (it needs Android 11 or newer).');
    const width = num(shot.width);
    const screen = { width: num(shot.screen?.width) || width, height: num(shot.screen?.height) || num(shot.height) };
    return {
      serial: device, data: Buffer.from(shot.data, 'base64'), mime: typeof shot.mime === 'string' ? shot.mime : 'image/jpeg',
      width, height: num(shot.height), scale: width ? screen.width / width : 1, screen,
    };
  }

  async uiTree(serial?: string, step?: PhoneStepOptions): Promise<PhoneTree> {
    const device = this.pick(serial);
    const tree = await this.ask(device, 'ui_tree', {}, step) as { nodes?: unknown; screen?: { width?: unknown; height?: unknown } };
    const nodes = Array.isArray(tree?.nodes) ? tree.nodes.slice(0, 3000).map(safeNode) : [];
    const rendered = renderDump(nodes);
    const screen = tree?.screen && num(tree.screen.width) ? { width: num(tree.screen.width), height: num(tree.screen.height) } : screenOf(nodes);
    return { serial: device, text: rendered.text, count: rendered.count, truncated: rendered.truncated, nodes, ...(screen ? { screen } : {}) };
  }

  async tap(serial: string | undefined, x: number, y: number, step?: PhoneStepOptions): Promise<void> {
    await this.ask(this.pick(serial), 'tap', { x: Math.round(x), y: Math.round(y) }, step);
  }

  async swipe(serial: string | undefined, from: { x: number; y: number }, to: { x: number; y: number }, durationMs = 400, step?: PhoneStepOptions): Promise<void> {
    await this.ask(this.pick(serial), 'swipe', { x1: Math.round(from.x), y1: Math.round(from.y), x2: Math.round(to.x), y2: Math.round(to.y), durationMs }, step);
  }

  /** What the field reads after typing (`text`, cut on the phone) when the app tells it; an app before 0.3.15 does not. */
  async type(serial: string | undefined, value: string, step?: PhoneStepOptions): Promise<string | undefined> {
    const result = await this.ask(this.pick(serial), 'type', { text: value }, step) as { text?: unknown } | undefined;
    return typeof result?.text === 'string' ? result.text.slice(0, FIELD_MAX) : undefined;
  }

  async key(serial: string | undefined, name: string, step?: PhoneStepOptions): Promise<string> {
    const result = await this.ask(this.pick(serial), 'key', { key: name }, step) as { key?: unknown } | undefined;
    return typeof result?.key === 'string' ? result.key : name;
  }

  async open(serial: string | undefined, target: PhoneOpenTarget, step?: PhoneStepOptions): Promise<string> {
    const args = { ...(target.url ? { url: target.url } : {}), ...(target.package ? { package: target.package } : {}), ...(target.app ? { app: target.app } : {}) };
    const byName = Boolean(target.app && !target.url && !target.package);
    const result = await this.ask(this.pick(serial), 'open', args, step)
      .catch((error: unknown) => { throw byName && oldOpen(error) ? new WorkforceError('unavailable', OLD_APP_OPEN) : error; }) as { opened?: unknown } | undefined;
    return typeof result?.opened === 'string' ? result.opened : (target.url ?? target.package ?? target.app ?? '');
  }

  /** My line in the bubble (until the next one or the job's end); with `buttons` a question – the tapped label ('yes'
   *  for ✓, 'no' for ✕), 'none' after the phone's 60 s. `ask` goes along, so an app before buttons shows ✓ and ✕. */
  async say(serial: string | undefined, value: string, buttons: string[] | undefined, step?: PhoneStepOptions): Promise<PhoneSaid> {
    const line = sayLine(value);
    if (!line) throw new WorkforceError('bad_request', 'phone.say needs a text.');
    const device = this.pick(serial);
    const labels = buttons === undefined ? undefined : sayButtons(buttons);
    const asks = labels !== undefined;
    const own = labels?.length && !(labels.length === 1 && labels[0] === '✓') ? { buttons: labels } : {};
    const result = await this.ask(device, 'say', { text: line, ...(asks ? { ask: true, ...own } : {}) }, step, asks ? APP_PHONE_ASK_TIMEOUT_MS : undefined)
      .catch((error: unknown) => { throw oldApp(error) ? new WorkforceError('unavailable', OLD_APP_SAY) : error; }) as { answer?: unknown } | undefined;
    if (!asks) return { serial: device };
    const answer = typeof result?.answer === 'string' && result.answer ? result.answer.slice(0, PHONE_BUTTON_MAX) : 'none';
    return { serial: device, answer };
  }

  // ---------------------------------------------------------------- internals

  private pick(serial: string | undefined): string {
    if (serial) {
      if (!this.attached.has(serial)) throw new WorkforceError('not_found', `Phone ${serial} is not connected through the Autark app right now.`);
      return serial;
    }
    const all = this.serials();
    if (all.length === 1) return all[0];
    if (all.length > 1) throw new WorkforceError('conflict', `Several phones are connected (${all.join(', ')}); pass serial.`);
    throw new WorkforceError('unavailable', 'No phone is connected through the Autark app right now.');
  }

  /** One step on the phone: the request on the bus, its answer (or the timeout – `limitMs`, else the step limit – / the run's cancel). */
  private ask(deviceId: string, op: PhoneUseOp, args: Record<string, unknown>, step?: PhoneStepOptions, limitMs?: number): Promise<unknown> {
    if (step?.signal?.aborted) return Promise.reject(new WorkforceError('cancelled', 'Cancelled.'));
    const id = `pu_${randomBytes(8).toString('hex')}`;
    const timers = this.deps.timers ?? realTimers;
    const ms = limitMs ?? this.deps.timeoutMs ?? APP_PHONE_TIMEOUT_MS;
    const by = step?.by?.replace(/\s+/g, ' ').trim().slice(0, 60);
    return new Promise((resolve, reject) => {
      const entry: Pending = { deviceId, ...(step?.job ? { job: step.job } : {}), resolve, reject, timer: undefined };
      entry.timer = timers.set(() => this.settle(id, entry, new WorkforceError('timeout', `The phone did not answer within ${Math.round(ms / 1000)} s (the app may be closed by the system, or the screen locked).`)), ms);
      if (step?.signal) {
        const cancel = () => this.settle(id, entry, new WorkforceError('cancelled', 'Cancelled.'));
        step.signal.addEventListener('abort', cancel, { once: true });
        entry.off = () => step.signal?.removeEventListener('abort', cancel);
      }
      this.pending.set(id, entry);
      if (step?.job) { this.used(step.job, deviceId); this.unidle(step.job); }
      this.deps.bus.emit('phoneUse.request', { deviceId, id, op, args, ...(step?.job ? { job: step.job } : {}), ...(by ? { by } : {}) });
    });
  }

  /** A run is over: every phone it used hears 'done' (no answer awaited – an older app's refusal goes nowhere). */
  private finished(job: string | undefined): void {
    const devices = job ? this.jobs.get(job) : undefined;
    if (!job || !devices) return;
    this.unidle(job);
    this.jobs.delete(job);
    for (const deviceId of devices) {
      if (this.attached.has(deviceId)) this.deps.bus.emit('phoneUse.request', { deviceId, id: `pu_${randomBytes(8).toString('hex')}`, op: 'done', args: {}, job });
    }
  }

  private used(job: string, deviceId: string): void {
    const devices = this.jobs.get(job) ?? new Set<string>();
    devices.add(deviceId);
    this.jobs.delete(job);
    this.jobs.set(job, devices); // newest last: the oldest drops out first
    if (this.jobs.size > JOBS_KEPT) this.jobs.delete(this.jobs.keys().next().value as string);
  }

  private settle(id: string, entry: Pending, error?: Error, value?: unknown): void {
    if (this.pending.get(id) !== entry) return;
    this.pending.delete(id);
    (this.deps.timers ?? realTimers).clear(entry.timer);
    entry.off?.();
    if (entry.job) this.idleSoon(entry.job);
    if (error) entry.reject(error); else entry.resolve(value);
  }

  private unidle(job: string): void {
    const handle = this.idle.get(job);
    if (handle === undefined) return;
    this.idle.delete(job);
    (this.deps.timers ?? realTimers).clear(handle);
  }

  /** A step of this run ended: when no other step of it waits and none follows within PHONE_IDLE_MS, the phone hears 'done'. */
  private idleSoon(job: string): void {
    this.unidle(job);
    for (const other of this.pending.values()) if (other.job === job) return;
    this.idle.set(job, (this.deps.timers ?? realTimers).set(() => { this.idle.delete(job); this.finished(job); }, this.deps.idleMs ?? PHONE_IDLE_MS));
  }

  private answer(reply: PhoneUseReply & { deviceId: string }): void {
    const entry = this.pending.get(reply?.id);
    if (!entry || entry.deviceId !== reply.deviceId) return; // only the phone that was asked answers its request
    if (reply.error) {
      const code = reply.error.code === 'off' ? 'unavailable' : KNOWN.has(reply.error.code) ? reply.error.code : 'conflict';
      // 'off' keeps the phone's own reason (no consent yet, a build without phone use) – only its bare "off" becomes PHONE_USE_OFF.
      const said = typeof reply.error.message === 'string' ? reply.error.message.trim() : '';
      const message = reply.error.code === 'off'
        ? (!said || said.startsWith('Phone use is off') ? PHONE_USE_OFF : said.slice(0, 300))
        : String(reply.error.message ?? 'The phone refused this step.').slice(0, 300);
      this.settle(reply.id, entry, new WorkforceError(code as ErrorCode, message));
      return;
    }
    this.settle(reply.id, entry, undefined, reply.result);
  }

  private attach(event: PhoneUseAttach & { deviceId: string; on: boolean }): void {
    const current = this.attached.get(event.deviceId);
    if (!event.on) {
      if (!current) return;
      current.sockets--;
      if (current.sockets > 0) return;
      this.attached.delete(event.deviceId);
      for (const [id, entry] of [...this.pending]) if (entry.deviceId === event.deviceId) this.settle(id, entry, new WorkforceError('unavailable', 'The phone went offline.'));
      return;
    }
    this.attached.set(event.deviceId, {
      model: event.model ?? current?.model, screen: event.screen ?? current?.screen, ready: event.ready ?? current?.ready ?? false, sockets: (current?.sockets ?? 0) + 1,
    });
  }
}

/** The bubble's one line: whitespace folded, at most PHONE_SAY_MAX characters (cut with an ellipsis). */
export function sayLine(value: string): string {
  const line = String(value ?? '').replace(/\s+/g, ' ').trim();
  return line.length > PHONE_SAY_MAX ? `${line.slice(0, PHONE_SAY_MAX - 1)}…` : line;
}

/** The question's buttons: whitespace folded, cut to PHONE_BUTTON_MAX, distinct, at most PHONE_SAY_BUTTONS_MAX; empty
 *  ones dropped. An empty list still asks (✕ alone; the app adds ✓ for ask). */
export function sayButtons(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    let label = String(value ?? '').replace(/\s+/g, ' ').trim();
    if ([...label].length > PHONE_BUTTON_MAX) label = `${[...label].slice(0, PHONE_BUTTON_MAX - 1).join('')}…`;
    if (label && !out.includes(label) && out.length < PHONE_SAY_BUTTONS_MAX) out.push(label);
  }
  return out;
}

/** An app before `open` by name answers it with bad_request "Give an http(s) link or a package name.". */
function oldOpen(error: unknown): boolean {
  return error instanceof WorkforceError && error.code === 'bad_request' && /link or a package name/i.test(error.message);
}

/** An app before 0.3.15 answers a say with bad_request "Unknown step say.". */
function oldApp(error: unknown): boolean {
  return error instanceof WorkforceError && error.code === 'bad_request' && /unknown step say/i.test(error.message);
}

const str = (value: unknown, max = 300) => (typeof value === 'string' && value ? value.slice(0, max) : undefined);
const flag = (value: unknown) => (typeof value === 'boolean' ? value : undefined);

/** One node of the phone's tree (apps/android phoneuse/ScreenTree) as uiautomator.ts renders it: order and parents checked. */
export function safeNode(value: unknown, index: number): PhoneNode {
  const node = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const parent = Number.isInteger(node.parent) && (node.parent as number) >= 0 && (node.parent as number) < index ? node.parent as number : -1;
  const b = Array.isArray(node.bounds) && node.bounds.length === 4 && node.bounds.every((n) => Number.isFinite(n)) ? node.bounds.map((n) => Math.round(n as number)) : undefined;
  const out: PhoneNode = { index, depth: Number.isInteger(node.depth) ? Math.max(0, node.depth as number) : 0, parent };
  const fields: Array<[keyof PhoneNode, unknown]> = [
    ['text', str(node.text)], ['desc', str(node.desc)], ['id', str(node.id, 200)], ['cls', str(node.cls, 80)], ['pkg', str(node.pkg, 200)],
    ['clickable', flag(node.clickable)], ['scrollable', flag(node.scrollable)], ['checkable', flag(node.checkable)], ['checked', flag(node.checked)],
    ['enabled', flag(node.enabled)], ['focused', flag(node.focused)], ['selected', flag(node.selected)], ['password', flag(node.password)],
  ];
  for (const [key, field] of fields) if (field !== undefined) (out as unknown as Record<string, unknown>)[key] = field;
  if (b && b[2] > b[0] && b[3] > b[1]) out.bounds = [b[0], b[1], b[2], b[3]];
  return out;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}
