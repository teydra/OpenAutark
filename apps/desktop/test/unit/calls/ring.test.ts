// An agent's call (src/runtime/calls/ring.ts with call-log.ts and the real chat service): the row is born ringing and
// rings this PC's window once; nobody picking up ends it missed after RING_MS (written by its PC) and wakes the agent
// once and goes out once as a 'notify' event of kind 'call'; wherever the ring ends, the same notify goes out once more
// with its time up (the app phone's notice); a decline – here or arriving by sync – wakes only on the PC that holds the row; a device that takes the ring
// answers it (no wake, the opening line as the agent's live voice, a line of the call); the live list (ringing and
// running calls) and current() (chat.call) drop a running call whose PC is offline; an employee's seat PC neither rings nor lists; at start the
// calls that did not end are read again without an alert.
// Owns: these assertions only. Never: a real push service or a second PC.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { HUMAN_ID, SYSTEM_ID } from '../../../src/shared/ids.ts';
import { RING_MS, callRecord, callState, type CallRecord } from '../../../src/shared/model/call.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { CallLog, writeCallRow } from '../../../src/runtime/calls/call-log.ts';
import { Rings } from '../../../src/runtime/calls/ring.ts';
import { DevicesRepo, type DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import type { PushFetch } from '../../../src/runtime/pwa/push.ts';
import { decryptPayload } from '../../../src/runtime/pwa/webpush-crypto.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { agent, harness } from '../chat/harness.ts';

class ManualTimers {
  pending: Array<{ id: number; fn: () => void; ms: number }> = [];
  private seq = 0;
  set(fn: () => void, ms: number) { const id = ++this.seq; this.pending.push({ id, fn, ms }); return id; }
  clear(handle: unknown) { this.pending = this.pending.filter((timer) => timer.id !== handle); }
  fireAll() { const due = this.pending.splice(0); for (const timer of due) timer.fn(); }
}

const device = (id: string, name: string, extra: Partial<DeviceRecord> = {}): DeviceRecord => ({ id, name, kind: 'pc', role: 'home', fingerprint: `fp_${id}`, addresses: [], caps: {}, status: 'online', self: false, ...extra });

function setup(options: { seat?: boolean; fetch?: PushFetch } = {}) {
  const h = harness();
  h.org.add(agent('ag_ava', 'Ava'));
  h.org.add(agent('ag_ben', 'Ben'));
  const repo = new DevicesRepo(h.db);
  repo.upsert(device('dev_book', 'Office PC', { self: true }));
  repo.upsert(device('dev_server', 'Server PC'));
  if (options.seat) repo.upsert(device('dev_boss', 'Boss PC', { joinedAs: 'employee' }));
  const chat = h.chats.create({ agentIds: ['ag_ava', 'ag_ben'], createdBy: HUMAN_ID, lead: 'ag_ava' });
  const alerts: Array<{ title: string; body: string }> = [];
  const online = new Set<string>();
  Object.assign(h.services, {
    settings: { get: () => ({ profile: { name: 'Gerd' } }) },
    secrets: { redact: (text: string) => text },
    host: { ...h.services.host, notify: async (input: { title: string; body: string }) => { alerts.push(input); return true; } },
    devices: { online: (id: string) => online.has(id) },
  });
  const services = h.services as RuntimeServices;
  const timers = new ManualTimers();
  const log = new CallLog(() => services);
  const rings = new Rings({ services: () => services, log, timers, fetch: options.fetch });
  const row = (callId: string) => h.chats.messages(chat.id, { limit: 50 }).find((message) => callRecord(message)?.id === callId)!;
  const record = (callId: string): CallRecord => callRecord(row(callId))!;
  const lives = () => h.of('calls.live').map((event) => event.calls);
  return { ...h, services, chat, alerts, online, timers, log, rings, row, record, lives };
}

test('ring: the row is born ringing as the caller\'s, rings this window once and lists it; an echo of the row rings no second time', async () => {
  const h = setup();
  const rung = await h.rings.ring({ conversationId: h.chat.id, agentId: 'ag_ava', why: 'Logo decision', say: 'Gerd, kurz zum Logo.', agents: ['ag_ben'] });
  const row = h.row(rung.callId);
  assert.deepEqual([row.kind, row.silent, row.authorId, row.body], ['status', true, SYSTEM_ID, 'Ava calls: Logo decision']);
  assert.deepEqual(h.record(rung.callId), {
    id: rung.callId, participant: 'agent:ag_ava', name: 'Ava', pc: 'dev_book', startedAt: h.clock.now(), lines: [],
    ring: { by: 'ag_ava', why: 'Logo decision', say: 'Gerd, kurz zum Logo.', until: h.clock.now() + RING_MS }, agents: ['ag_ava', 'ag_ben'],
  });
  assert.equal(rung.until, h.clock.now() + RING_MS);
  assert.deepEqual(rung.online, { pcs: 1, phones: 0 }, 'this PC; the other PC is not reachable, no phone subscribed');
  assert.deepEqual(h.alerts, [{ title: 'Ava calls', body: 'AI voice (machine-generated)\nLogo decision', tag: `call:${rung.callId}` }], 'Konrad 27.11.2026: the OS notice says the voice is machine-generated, above why');
  assert.deepEqual(h.of('notify'), [{ kind: 'call', title: 'Ava calls', body: 'Logo decision', conversationId: h.chat.id, toast: false, call: { id: rung.callId, until: rung.until } }], 'the ring as a notify of its own kind (the call notice of the Android app)');
  assert.deepEqual(h.timers.pending.map((timer) => timer.ms), [RING_MS]);
  const [live] = h.rings.live();
  assert.deepEqual(live, { callId: rung.callId, rowId: row.id, conversationId: h.chat.id, state: 'ringing', agentName: 'Ava', why: 'Logo decision', until: rung.until });
  assert.deepEqual(h.lives().at(-1), [live], 'calls.live went out');
  assert.deepEqual(h.rings.current(h.chat.id), { callId: rung.callId, state: 'ringing' });
  h.bus.emit('message.updated', row); // the same row again (a sync echo): no second alert
  assert.equal(h.alerts.length, 1);
  assert.equal(h.of('notify').length, 1);
});

test('a call adds one notice beside unread chat messages and its end clears only the call', { timeout: 5000 }, async () => {
  const phone = createECDH('prime256v1'); phone.generateKeys();
  const vapid = createECDH('prime256v1'); vapid.generateKeys();
  const auth = randomBytes(16);
  const sent: Array<Record<string, unknown>> = [];
  const tray = new Map<string, number>();
  let ringArrived = () => {};
  let clearArrived = () => {};
  const rungPush = new Promise<void>((resolve) => { ringArrived = resolve; });
  const clearPush = new Promise<void>((resolve) => { clearArrived = resolve; });
  const h = setup({ fetch: async (_url, init) => {
    const payload = JSON.parse(decryptPayload(init.body, phone.getPrivateKey(), auth).toString()) as Record<string, unknown>;
    sent.push(payload);
    if (typeof payload.clear === 'string') { tray.delete(payload.clear); clearArrived(); }
    else { tray.set(String(payload.tag), 1); ringArrived(); }
    return { ok: true, status: 201 };
  } });
  Object.assign(h.services, { host: { ...h.services.host, decrypt: async (cipher: Uint8Array) => Buffer.from(cipher).toString() } });
  new KvRepo(h.db).set('pwa', 'vapid', {
    publicKey: vapid.getPublicKey().toString('base64url'), privateCipher: Buffer.from(vapid.getPrivateKey().toString('base64url')).toString('base64'),
  }, 1);
  const endpoint = 'https://fcm.googleapis.com/fcm/send/ring-test';
  const subscription = { endpoint, keys: { p256dh: phone.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  h.db.run('INSERT INTO push_subscriptions (id, device_id, endpoint, data, created_at) VALUES (?, NULL, ?, ?, 1)', ['ps_ring', endpoint, JSON.stringify(subscription)]);
  for (const body of ['One', 'Two']) h.chats.send({ conversationId: h.chat.id, authorId: 'ag_ava', authorKind: 'agent', body });
  const chatTag = `chat:${h.chat.id}`;
  tray.set(chatTag, 2);
  const { callId } = await h.rings.ring({ conversationId: h.chat.id, agentId: 'ag_ava', why: 'Decision' });
  await rungPush;
  assert.equal(sent[0].tag, `call:${callId}`);
  assert.equal(sent[0].body, 'AI voice (machine-generated)\nDecision', 'the phones\' ring push says the voice is machine-generated');
  assert.equal(sent[0].url, `/#/chat/${h.chat.id}`, 'the separate call notice still opens its chat');
  assert.equal([...tray.values()].reduce((a, b) => a + b), 3, 'two chat messages plus the call');
  h.rings.decline(callId, { key: 'phone', name: 'Phone' });
  await clearPush;
  assert.equal(sent[1].clear, `call:${callId}`);
  assert.equal(sent[1].tag, `call:${callId}`, 'older workers receive the same call tag and id');
  assert.equal(sent[1].id, callId);
  assert.deepEqual([...tray], [[chatTag, 2]], 'the call ending preserves both unread chat notifications');
  assert.equal(h.chats.list().find((chat) => chat.id === h.chat.id)?.unread, 2);
  h.rings.stop();
});

test('nobody picks up: its PC writes the end at the deadline, the agent is woken once with a first-person note', async () => {
  const h = setup();
  const { callId } = await h.rings.ring({ conversationId: h.chat.id, agentId: 'ag_ava', why: 'The "server" bill' });
  h.clock.advance(RING_MS);
  h.timers.fireAll();
  assert.equal(h.record(callId).endedAt, h.clock.now());
  assert.equal(callState(h.record(callId), h.clock.now()), 'missed');
  const wakes = h.wakeRows();
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].agent_id, 'ag_ava');
  assert.equal(wakes[0].note, 'Nobody picked up my call about "The \'server\' bill". I write what I wanted in this chat, or call again later when it still matters.');
  assert.deepEqual(h.rings.live(), []);
  assert.deepEqual(h.lives().at(-1), []);
  h.bus.emit('message.updated', h.row(callId));
  assert.equal(h.wakeRows().length, 1, 'once');
  assert.equal(h.rings.current(h.chat.id), undefined);
});

test('decline: written here or arriving by sync, it wakes the agent only on the PC that holds the row', async () => {
  const h = setup();
  const own = await h.rings.ring({ conversationId: h.chat.id, agentId: 'ag_ava', why: 'Contract' });
  h.clock.advance(5000);
  // Another PC wrote the decline; the synced row arrives on the bus.
  writeCallRow(h.services, h.row(own.callId).id, (record) => ({ ...record, endedAt: h.clock.now(), ring: { ...record.ring!, declined: { at: h.clock.now(), name: 'Pixel' } } }));
  assert.equal(callState(h.record(own.callId), h.clock.now()), 'declined');
  assert.equal(h.wakeRows()[0]?.note, 'The person declined my call about "Contract" on Pixel. I write what I wanted in this chat, or call again later when it still matters.');
  assert.equal(h.timers.pending.length, 0, 'the deadline timer went with the ring');

  // A ring written by the other PC: it rings here too; declining here writes the row, the wake is that PC's.
  const far: CallRecord = { id: 'call_far', participant: 'agent:ag_ben', name: 'Ben', pc: 'dev_server', startedAt: h.clock.now(), lines: [], ring: { by: 'ag_ben', why: 'Deploy', until: h.clock.now() + RING_MS } };
  h.chats.send({ conversationId: h.chat.id, body: 'Ben calls: Deploy', kind: 'status', silent: true, authorId: SYSTEM_ID, authorKind: 'system', mentions: [], meta: { status: { type: 'note', text: 'Ben calls: Deploy' }, call: far } });
  assert.equal(h.alerts.at(-1)?.title, 'Ben calls');
  h.rings.decline('call_far', { key: 'pc', name: 'Office PC' });
  assert.deepEqual(h.record('call_far').ring?.declined, { at: h.clock.now(), name: 'Office PC' });
  assert.equal(h.wakeRows().length, 1, 'no wake here for the other PC\'s ring');
  assert.throws(() => h.rings.decline('call_far', { key: 'pc', name: 'Office PC' }), /no longer rings/);
});

test('answer: a device takes the ring – no wake, the opening line as the agent\'s live voice joins the call; then it is listed running', async () => {
  const h = setup();
  const { callId } = await h.rings.ring({ conversationId: h.chat.id, agentId: 'ag_ava', why: 'Logo', say: 'Hallo Gerd!' });
  h.clock.advance(3000);
  const taken = h.log.take(h.chat.id, callId, { key: 'pc', name: 'Office PC' });
  assert.equal(taken.answered, true);
  assert.equal(taken.holder, 'dev_book/device:pc');
  assert.deepEqual(h.rings.answered(h.chat.id, callId), { say: 'Hallo Gerd!', by: 'ag_ava' });
  const record = h.record(callId);
  assert.deepEqual([record.participant, record.name, record.pc, record.ring?.answeredAt, record.endedAt], ['device:pc', 'Office PC', 'dev_book', h.clock.now(), undefined]);
  const opening = h.chats.messages(h.chat.id, { limit: 50 }).find((message) => message.body === 'Hallo Gerd!')!;
  assert.deepEqual([opening.authorId, opening.silent, opening.meta.call?.voice, opening.meta.call?.participant], ['ag_ava', false, 'talker', 'agent:ag_ava']);
  assert.deepEqual(record.lines.map((line) => [line.from, line.text]), [['agent:ag_ava', 'Hallo Gerd!']]);
  assert.equal(h.timers.pending.length, 0);
  assert.equal(h.wakeRows().length, 0);
  assert.deepEqual(h.rings.live().map((live) => [live.state, live.device, live.last?.text]), [['running', 'Office PC', 'Hallo Gerd!']]);
  h.clock.advance(RING_MS);
  assert.equal(h.rings.current(h.chat.id)?.state, 'running', 'an answered call does not expire');
});

test('the live list and current(): a running call held by an offline PC drops out (a new ring is free) and comes back when it is reachable', async () => {
  const h = setup();
  const synced: CallRecord = { id: 'call_srv', participant: 'device:pc', name: 'Server PC', pc: 'dev_server', startedAt: h.clock.now(), lines: [{ at: 1, from: 'agent:ag_ava', name: 'Ava', text: 'Bin dran.' }] };
  h.chats.send({ conversationId: h.chat.id, body: 'Call from Server PC', kind: 'status', silent: true, authorId: SYSTEM_ID, authorKind: 'system', mentions: [], meta: { status: { type: 'note', text: 'Call from Server PC' }, call: synced } });
  assert.deepEqual(h.rings.live(), [], 'its PC is offline');
  assert.equal(h.rings.current(h.chat.id), undefined, 'a stale row of an offline PC blocks no new ring');
  h.online.add('dev_server');
  h.bus.emit('device.upserted', { id: 'dev_server' } as never);
  assert.deepEqual(h.lives().at(-1)?.map((live) => [live.callId, live.state, live.device, live.holder, live.last?.name]), [['call_srv', 'running', 'Server PC', 'dev_server/device:pc', 'Ava']]);
  assert.deepEqual(h.rings.current(h.chat.id), { callId: 'call_srv', state: 'running' });
});

// KI-Runde 17.11.2026, fix after the review: the app phone kept ringing for the rest of the ring when the call was
// answered or declined somewhere else, because only the web-push notices were cleared.
test('the ring\'s end goes out as the same notify with its time up – for this PC\'s ring and for another PC\'s', async () => {
  const h = setup();
  const { callId } = await h.rings.ring({ conversationId: h.chat.id, agentId: 'ag_ava', why: 'Logo' });
  const ends = () => h.of('notify').filter((event) => event.call !== undefined && event.call.until <= h.clock.now());
  assert.equal(ends().length, 0, 'the ring itself rings on');
  h.clock.advance(3000);
  h.rings.decline(callId, { key: 'pc', name: 'Office PC' });
  assert.deepEqual(ends(), [{ kind: 'call', title: 'Ava calls', body: 'Logo', conversationId: h.chat.id, toast: false, call: { id: callId, until: 0 } }], 'until 0: past on every clock, so a phone whose clock is behind the PC\'s stops too (review r2-1 finding 5)');
  h.bus.emit('message.updated', h.row(callId));
  assert.equal(ends().length, 1, 'once per ring');

  // A ring the other PC wrote and answered: this PC holds no row, and its phone still has to stop ringing.
  const far: CallRecord = { id: 'call_far', participant: 'agent:ag_ben', name: 'Ben', pc: 'dev_server', startedAt: h.clock.now(), lines: [], ring: { by: 'ag_ben', why: 'Deploy', until: h.clock.now() + RING_MS } };
  const sent = h.chats.send({ conversationId: h.chat.id, body: 'Ben calls: Deploy', kind: 'status', silent: true, authorId: SYSTEM_ID, authorKind: 'system', mentions: [], meta: { status: { type: 'note', text: 'Ben calls: Deploy' }, call: far } });
  assert.equal(ends().length, 1);
  writeCallRow(h.services, sent.id, (record) => ({ ...record, participant: 'device:pc', name: 'Pixel', pc: 'dev_server', ring: { ...record.ring!, answeredAt: h.clock.now() } }));
  assert.deepEqual(ends().map((event) => [event.call?.id, event.toast]), [[callId, false], ['call_far', false]]);
  assert.equal(h.wakeRows().length, 1, 'the other PC\'s ring wakes nobody here');
});

test('an employee\'s seat PC neither rings nor lists the owner\'s calls; at start the rows that did not end are read again without an alert', async () => {
  const seat = setup({ seat: true });
  await seat.rings.ring({ conversationId: seat.chat.id, agentId: 'ag_ava', why: 'Hi' });
  assert.deepEqual(seat.alerts, []);
  assert.deepEqual(seat.rings.live(), []);

  const h = setup();
  const { callId } = await h.rings.ring({ conversationId: h.chat.id, agentId: 'ag_ava', why: 'Still ringing' });
  h.rings.stop();
  const again = new Rings({ services: () => h.services, log: h.log, timers: h.timers });
  assert.deepEqual(again.live().map((live) => live.callId), [callId]);
  assert.equal(h.alerts.length, 1, 'no second alert for a ring read at start');
  again.stop();
});
