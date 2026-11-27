// B-081 (owner 08.11.2026: "dass die KI den User auch noch anrufen kann … auf den ganzen Geräten … wie bei WhatsApp"):
// an agent rings the person (tool chat.call). The ring is the call row itself, born ringing: a quiet status row in the
// chat whose meta.call has participant 'agent:<id>' and ring {by, why, say, until} (shared/model/call.ts), written on
// the PC the agent's turn runs on. That PC pushes once, urgent, to every phone of the person it holds (its own
// subscriptions and those of the other PCs, devices/sync/held-push.ts) – whatever the chat's notification level says,
// the call is the agent's own decision. Every PC follows call rows on its bus (also synced ones): a newly ringing row
// rings this PC's window once (host.notify; the window's notice and ring tone come from calls.live,
// ui/chat/call/call-notices.ts) and goes out once as a 'notify' event of kind 'call' (the Android app, which has no web push,
// shows it as an incoming call notice with Accept and Decline: apps/android CallNotice), and the list of ringing and running calls goes out as 'calls.live' when it changes (a
// running call only while the PC holding it is this one or reachable – a stopped PC's row would stay "running"; chat.call's
// current() reads it the same way, so such a row rings anew).
// The device that accepts takes the row (call-log.ts take); then answered() posts the agent's opening line. A ring
// nobody takes is missed after RING_MS: its writer writes the end. Any device may decline (any PC writes it; last
// writer wins). Wherever the ring ends, each PC that saw it sends the 'notify' of kind 'call' once more with its time
// up (until 0, past on any clock), so the app phone's notice stops ringing. The PC that holds the row closes the phones'
// ring notices (pwa/read-clear.ts clearNotice, its own call tag) and, for a decline or a missed ring, wakes the agent once with a
// first-person note. Konrad 27.11.2026: the PC's notice and the phones' push say "AI voice (machine-generated)" above why
// (shared/model/call.ts ringBody); the Android app's notice says it in its header (CallVoiceNote).
// An employee's seat PC ('employer' link) does not ring for the owner's agents; Team-Call 21.11.2026: it lists the running
// calls of the chats it shares, and a call another person's PC holds is listed with `others` (Join, never Take over).
// Owns: rings, the live list, the ring alerts and the decline. Never: holds a device's call (call-log.ts) or audio.

import { WorkforceError } from '../../shared/errors.ts';
import { SYSTEM_ID, newId } from '../../shared/ids.ts';
import { RING_MS, ringBody, callDeviceNames, callHolder, callRecord, callState, type CallDevice, type CallRecord, type CallState, type LiveCall } from '../../shared/model/call.ts';
import type { Message } from '../../shared/model/chat.ts';
import type { RuntimeServices } from '../contracts.ts';
import { chatWakeKey } from '../chat/delivery.ts';
import { heldSubs, localSubs, ownerHeld, ownKey, pushTo, type HeldSub } from '../devices/sync/held-push.ts';
import type { PushFetch } from '../pwa/push.ts';
import { links } from '../devices/sync/home.ts';
import { pushTarget } from '../pwa/push.ts';
import { clearNotice } from '../pwa/read-clear.ts';
import type { CallLog } from './call-log.ts';
import { otherPerson } from './call-peer.ts';
import { thisPc, writeCallRow } from './call-row.ts';
import type { CallTimers } from './realtime/session.ts';

export { RING_MS };

/** Call rows newer than this are read again at start (a ring or call that still runs). */
const SEED_MS = 2 * 60 * 60_000;
/** A ring that ended longer ago than this wakes nobody (a line edit rewrites old call rows). */
const FRESH_MS = 5 * 60_000;
const LAST_TEXT = 140;
const WHY_MAX = 200;
const SAY_MAX = 600;

export interface RingRequest { conversationId: string; agentId: string; why: string; say?: string; agents?: string[] }
/** What a ring gave: the call, until when it rings, and how many of the person's PCs and phones it reaches now. */
export interface Rung { callId: string; rowId: string; until: number; online: { pcs: number; phones: number } }

export interface RingsDeps {
  services: () => RuntimeServices;
  log: CallLog;
  timers: CallTimers;
  /** Tests: the push service's fetch. */
  fetch?: PushFetch;
}

interface Entry { rowId: string; conversationId: string; record: CallRecord; timer?: unknown }

const quiet = <T>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };
const flat = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().slice(0, max);

export class Rings {
  private readonly deps: RingsDeps;
  private readonly entries = new Map<string, Entry>(); // ringing and running calls by id
  private done: string[] = []; // rings whose end this PC handled (bounded)
  private shown = '[]';
  private readonly off: Array<() => void>;

  constructor(deps: RingsDeps) {
    this.deps = deps;
    const bus = this.s.bus;
    this.off = [
      bus.on('message.created', (message) => this.seen(message)),
      bus.on('message.updated', (message) => this.seen(message)),
      bus.on('device.upserted', () => this.emit()), // a PC went offline: its running call leaves the list
    ];
    this.seed();
  }

  private get s(): RuntimeServices { return this.deps.services(); }

  /** Rings the person in a chat: the row born ringing, one push to each of their phones. */
  async ring(request: RingRequest): Promise<Rung> {
    const s = this.s;
    const now = s.clock.now();
    const id = newId('call', now);
    const name = this.nameOf(request.agentId);
    const why = flat(request.why, WHY_MAX);
    const say = request.say ? flat(request.say, SAY_MAX) : '';
    const until = now + RING_MS;
    const pc = thisPc(s);
    const text = `${name} calls: ${why}`;
    const record: CallRecord = {
      id, participant: `agent:${request.agentId}`, name, ...(pc ? { pc } : {}), startedAt: now, lines: [],
      ring: { by: request.agentId, why, ...(say ? { say } : {}), until },
      agents: [request.agentId, ...(request.agents ?? []).filter((agentId) => agentId !== request.agentId)],
    };
    const row = s.chats.send({ conversationId: request.conversationId, body: text, kind: 'status', silent: true, authorId: SYSTEM_ID, authorKind: 'system', mentions: [], meta: { status: { type: 'note', text }, call: record } });
    this.deps.log.keep(row.id, true); // a stop while it rings: the next start ends it (missed)
    const phones = await this.phones().catch(() => [] as HeldSub[]);
    const { url } = pushTarget({ kind: 'important', conversationId: request.conversationId });
    const tag = `call:${id}`;
    const payload = { kind: 'important', title: `${name} calls`, body: ringBody(why), url, tag, id, conversationId: request.conversationId, ring: true };
    void pushTo(s, phones, payload, { urgent: true, ttl: RING_MS / 1000, fetch: this.deps.fetch }).catch((error: unknown) => s.log.debug('ring push failed', { error: String(error) }));
    const pcs = 1 + quiet(() => links(s.db).filter(({ record: peer, link }) => link.kind === 'ceo' && s.devices.online(peer.id)).length, 0);
    return { callId: id, rowId: row.id, until, online: { pcs, phones: phones.length } };
  }

  /** The ringing or running call of a chat (running: its PC reachable, as in live()), else undefined (chat.call rings once per chat). */
  current(conversationId: string): { callId: string; state: 'ringing' | 'running' } | undefined {
    const now = this.s.clock.now();
    const pc = thisPc(this.s);
    for (const [callId, entry] of this.entries) {
      const state = callState(entry.record, now);
      if (entry.conversationId === conversationId && this.goesOn(entry.record, state, pc)) return { callId, state };
    }
    return undefined;
  }

  /** The person says no on `device`: the row ends declined (any PC writes it; the holding PC wakes the agent). */
  decline(callId: string, device: CallDevice): void {
    const entry = this.entries.get(callId);
    const now = this.s.clock.now();
    let declined = false;
    if (entry) {
      writeCallRow(this.s, entry.rowId, (record) => {
        if (callState(record, now) !== 'ringing' || !record.ring) return record;
        declined = true;
        return { ...record, endedAt: now, ring: { ...record.ring, declined: { at: now, name: device.name } } };
      });
    }
    if (!declined) throw new WorkforceError('conflict', 'This call no longer rings.', { details: { callId } });
  }

  /** A device took the ring (calls.start): the agent's opening line in the chat, as its live voice; returns it and who said it. */
  answered(conversationId: string, callId: string): { say: string; by: string } | undefined {
    const s = this.s;
    const ring = this.deps.log.record(conversationId, callId)?.ring;
    if (!ring) return undefined;
    const say = ring.say || ring.why;
    try {
      s.chats.send({
        conversationId, body: quiet(() => s.secrets.redact(say), say), authorId: ring.by, authorKind: 'agent', mentions: [],
        meta: { via: 'voice', call: { id: callId, participant: `agent:${ring.by}`, name: this.nameOf(ring.by), voice: 'talker' } },
      });
    } catch (error) {
      s.log.warn('call opening line not stored', { conversationId, error: String(error) });
    }
    return { say, by: ring.by };
  }

  /** The ringing and running calls (an employee's seat PC: the running ones only). */
  live(): LiveCall[] {
    const s = this.s;
    const seat = this.seat();
    const now = s.clock.now();
    const pc = thisPc(s);
    const out: LiveCall[] = [];
    for (const [callId, { rowId, conversationId, record }] of this.entries) {
      const state = callState(record, now);
      if (!this.goesOn(record, state, pc) || (seat && state !== 'running')) continue;
      const last = record.lines.at(-1);
      out.push({
        callId, rowId, conversationId, state,
        ...(record.ring ? { agentName: this.nameOf(record.ring.by), why: record.ring.why, until: record.ring.until } : {}),
        ...(state === 'running' ? { device: callDeviceNames(record), holder: callHolder(record) } : {}), // owner 19.11.2026: with the devices joined beside it
        ...(last ? { last: { name: last.name, text: flat(last.text, LAST_TEXT) } } : {}),
        ...(state === 'running' && record.pc && record.pc !== pc && otherPerson(s, record.pc) ? { others: true as const } : {}),
      });
    }
    return out;
  }

  stop(): void {
    for (const off of this.off.splice(0)) off();
    for (const entry of this.entries.values()) if (entry.timer !== undefined) this.deps.timers.clear(entry.timer);
    this.entries.clear();
  }

  // ------------------------------------------------------------------ internals

  /** A call row on the bus (written here or synced): the list, the alert, the deadline and the end. */
  private seen(message: Message, alert = true): void {
    const record = callRecord(message);
    if (!record) return;
    const s = this.s;
    const now = s.clock.now();
    const state = callState(record, now);
    const pc = thisPc(s);
    const before = this.entries.get(record.id);
    if (state === 'missed' && record.endedAt === undefined && record.pc === pc) {
      writeCallRow(s, message.id, (current) => (callState(current, now) === 'missed' && current.endedAt === undefined ? { ...current, endedAt: current.ring?.until ?? now } : current));
      return; // the written end comes back here through the bus
    }
    if (state === 'ringing' || state === 'running') {
      const entry: Entry = { rowId: message.id, conversationId: message.conversationId, record, timer: before?.timer };
      this.entries.set(record.id, entry);
      if (state === 'ringing' && entry.timer === undefined) {
        entry.timer = this.deps.timers.set(() => this.expire(record.id), Math.max(0, record.ring!.until - now));
        if (alert && !before && !this.seat()) {
          const title = `${this.nameOf(record.ring!.by)} calls`;
          quiet(() => void s.host.notify({ title, body: ringBody(record.ring!.why), tag: `call:${record.id}` }).catch(() => false), undefined);
          // the 'notify' event of its own kind (never a toast: the window has its call notice; the ring pushed already)
          quiet(() => s.bus.emit('notify', { kind: 'call', title, body: record.ring!.why, conversationId: message.conversationId, toast: false, call: { id: record.id, until: record.ring!.until } }), undefined);
        }
      }
      if (state === 'running' && entry.timer !== undefined) { this.deps.timers.clear(entry.timer); entry.timer = undefined; }
      if (state === 'running' && before?.record.ring && before.record.ring.answeredAt === undefined && record.pc !== pc) this.deps.log.keep(message.id, false); // another PC took the ring
    } else if (before) {
      if (before.timer !== undefined) this.deps.timers.clear(before.timer);
      this.entries.delete(record.id);
    }
    if (record.ring && state !== 'ringing') this.ended(message, record, state, pc, now);
    this.emit();
  }

  /** The ring's time is over: the row is read again (its writer writes the end; elsewhere it leaves the list). */
  private expire(callId: string): void {
    const entry = this.entries.get(callId);
    if (!entry) return;
    entry.timer = undefined;
    const row = quiet(() => this.s.chats.message(entry.rowId), undefined);
    if (row) this.seen(row); else this.entries.delete(callId);
    this.emit();
  }

  /** Once per ring: every device hears that the ring is over (the app phone's notice); on the PC holding the row the phones' ring notices close and a decline or a missed ring wakes the agent. */
  private ended(message: Message, record: CallRecord, state: string, pc: string | undefined, now: number): void {
    const ring = record.ring!;
    const at = ring.answeredAt ?? ring.declined?.at ?? record.endedAt ?? ring.until;
    if (this.done.includes(record.id) || now - at > FRESH_MS) return;
    this.done = [...this.done, record.id].slice(-100);
    const s = this.s;
    // the ring's own kind once more with its time up: the app phone's call notice goes, wherever the ring was answered or declined
    quiet(() => s.bus.emit('notify', { kind: 'call', title: `${this.nameOf(ring.by)} calls`, body: ring.why, conversationId: message.conversationId, toast: false, call: { id: record.id, until: 0 } }), undefined); // 0 is past on every clock: a phone whose clock is behind stops too
    if (record.pc !== pc) return; // the rest is the holding PC's: the web-push notices and the agent's wake
    const { url } = pushTarget({ kind: 'important', conversationId: message.conversationId });
    void clearNotice(s, `call:${record.id}`, this.deps.fetch, { id: record.id, title: `${this.nameOf(ring.by)} calls`, body: ring.why, url })
      .catch((error: unknown) => s.log.debug('ring notices not cleared', { error: String(error) }));
    if (state === 'running' || state === 'ended') return; // answered
    const about = ring.why.replace(/"/g, "'");
    const note = state === 'declined'
      ? `The person declined my call about "${about}" on ${ring.declined?.name ?? 'a device'}. I write what I wanted in this chat, or call again later when it still matters.`
      : `Nobody picked up my call about "${about}". I write what I wanted in this chat, or call again later when it still matters.`;
    quiet(() => s.wakes.wake({ agentId: ring.by, reason: 'message', conversationId: message.conversationId, coalesceKey: chatWakeKey(message.conversationId), note }), undefined);
  }

  private emit(): void {
    const calls = this.live();
    const text = JSON.stringify(calls);
    if (text === this.shown) return;
    this.shown = text;
    this.s.bus.emit('calls.live', { calls });
  }

  /** Start: the call rows of the last hours that have not ended (no alert again). */
  private seed(): void {
    const s = this.s;
    const rows = quiet(() => s.db.all<{ id: string }>(
      `SELECT id FROM messages WHERE kind = 'status' AND created_at > ? AND json_extract(meta, '$.call.lines') IS NOT NULL AND json_extract(meta, '$.call.endedAt') IS NULL`,
      [s.clock.now() - SEED_MS]), []);
    for (const { id } of rows) {
      const row = quiet(() => s.chats.message(id), undefined);
      if (row) this.seen(row, false);
    }
  }

  /** Every phone of the person this PC pushes to: its own owner subscriptions and those held for the other PCs. */
  private async phones(): Promise<HeldSub[]> {
    const s = this.s;
    const now = s.clock.now();
    const own = await ownKey(s);
    return [...(own ? localSubs(s.db, own.pub, now) : []).filter((sub) => !sub.person), ...ownerHeld(s.db, heldSubs(s.db), now)];
  }

  /** A ringing call, or a running one whose PC is this one or reachable (a stopped PC's row would stay "running"). */
  private goesOn(record: CallRecord, state: CallState, pc: string | undefined): state is 'ringing' | 'running' {
    if (state === 'ringing') return true;
    return state === 'running' && (!record.pc || record.pc === pc || quiet(() => this.s.devices.online(record.pc!), false));
  }

  /** This PC is an employee's seat (it joined another PC as an employee): the owner's calls do not ring here. */
  private seat(): boolean {
    return quiet(() => links(this.s.db).some(({ link }) => link.kind === 'employer'), false);
  }

  private nameOf(agentId: string): string {
    return quiet(() => this.s.org.get(agentId)?.name, undefined) ?? 'Agent';
  }
}
