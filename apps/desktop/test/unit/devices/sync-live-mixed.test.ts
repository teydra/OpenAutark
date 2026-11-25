// Mixed versions on the live exchange (src/runtime/devices/sync/live.ts, live-wire.ts, link-quality.ts, stamps.ts; 0.3.18
// against a PC on 0.3.16/0.3.17, review 23.11.2026): the new PC keeps the live bar of an old PC and keeps its own line
// true on it. The old PC here is the real 0.3.16 receiver (6b6414b live.ts `receive`), not the session build the earlier
// tests simulate: it answers `{ ok: true }` – no `v`, no `runs` – takes `params.runs` (a missing one is an empty list),
// never repeats its state and never expires the other PC's line by itself (only an empty list or its link going ends it).
// Covers: the first message to an old PC is the whole state {runs, s} and it gets no pulse; an old PC's line does not
// blank after the new PC's expiry; a lost last empty message to an old PC is sent again until it lands; a link swap to
// an old PC takes the short form back; a PC without caps.version keeps a stable version pair; a ping without `at` gives
// a round trip and no offset (no NaN).
// Owns: these assertions only. Never: network, Electron, engines.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { AgentActivity, RunItem } from '../../../src/shared/model/runs.ts';
import { chatLiveOf, type LiveShare } from '../../../src/runtime/chat/live.ts';
import { LIVE_METHOD, LiveSync } from '../../../src/runtime/devices/sync/live.ts';
import { shareOf } from '../../../src/runtime/devices/sync/live-wire.ts';
import { linkQuality, pingLink } from '../../../src/runtime/devices/link-quality.ts';
import { Stamps } from '../../../src/runtime/devices/sync/stamps.ts';
import { agent } from '../chat/harness.ts';
import { Net, link, makePc, settle, type Pc } from './sync-net.ts';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tom = (chatId: string, extra: Partial<AgentActivity> = {}): AgentActivity => ({ agentId: 'ag_tom', runId: 'run_tom', conversationId: chatId, note: 'bash', startedAt: 100, modelName: 'Opus 5.5', effort: 'high', toolCalls: 2, ...extra });
const call = (runId: string, file: string): RunItem => ({ id: 'ri_1', runId, seq: 1, kind: 'tool_call', name: 'Read', data: { callId: 'c1', args: { file_path: file } }, createdAt: 1 });

/**
 * The receiver of 0.3.16 (6b6414b sync/live.ts `receive`), with the trace of what reached it: the runs of the message
 * (none when it has no `runs`: a command or a pulse reads as an empty state there), an empty one ends that PC's line, and
 * the answer is `{ ok: true }` – what the real PC says, not `{ ok: true, runs }`. `seen`: the PCs whose state it holds.
 */
function oldPeer(pc: Pc, seen: string[] = []) {
  const peers = new Set<string>(seen);
  const got: Array<Record<string, unknown>> = [];
  const handler = async (params: unknown, from: string): Promise<{ ok: true }> => {
    got.push(params as Record<string, unknown>);
    const list = params && typeof params === 'object' && Array.isArray((params as { runs?: unknown }).runs) ? (params as { runs: unknown[] }).runs : [];
    const runs = list.slice(0, 100).map(shareOf).filter((share): share is LiveShare => Boolean(share));
    if (runs.length) peers.add(from);
    else if (!peers.has(from)) return { ok: true };
    else peers.delete(from);
    chatLiveOf(pc.h.bus)!.setRemote(from, runs);
    pc.h.bus.emit('agent.activity', { active: pc.h.services.dispatcher.activity() });
    return { ok: true };
  };
  pc.handlers.set(LIVE_METHOD, handler);
  return { got, peers };
}

/** A (this build) and B (0.3.16 receiver); `pulseMs`/`ttlMs`: A's pulse and the expiry it applies to others. */
function setup(pulseMs = 60_000, ttlMs = 60_000) {
  const net = new Net();
  const a = makePc(net, 'pc_a');
  const b = makePc(net, 'pc_b');
  link(a, b);
  for (const pc of [a, b]) pc.h.org.add(agent('ag_tom', 'Tom'));
  const liveA = new LiveSync(a.h.services, chatLiveOf(a.h.bus)!, async () => undefined, 0, pulseMs, ttlMs);
  a.handlers.set(LIVE_METHOD, async (params, from) => liveA.receive(params, from));
  after(liveA.attach());
  const old = oldPeer(b);
  const sent = () => net.calls.filter((entry) => entry.method === LIVE_METHOD && entry.from === 'pc_a').map((entry) => entry.params as Record<string, unknown>);
  return { net, a, b, liveA, old, sent };
}

test('new → old: the first message is the whole state {runs, s}; every later one too, and an old PC gets no pulse and no command', async () => {
  const { a, b, old, sent } = setup(30);
  const chat = a.h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  await settle();
  a.h.bus.emit('agent.activity', { active: [tom(chat.id)] });
  await settle();
  assert.ok(Array.isArray(sent()[0]?.runs) && typeof sent()[0]?.s === 'number', 'first the whole state, with A\'s number');
  assert.deepEqual(b.h.chats.summary(chat.id).live?.map((run) => [run.runId, run.deviceId]), [['run_tom', 'pc_a']], 'the old PC shows the run');
  a.h.bus.emit('run.item', call('run_tom', 'C:/data/q3.pdf'));
  await wait(200); // several pulse periods
  a.h.bus.emit('run.item', call('run_tom', 'C:/data/q4.pdf'));
  await wait(200);
  assert.ok(sent().length >= 3, `changes went (${sent().length})`);
  assert.ok(sent().every((params) => Array.isArray(params.runs) && !('c' in params) && !('h' in params)), `no command, no pulse: ${JSON.stringify(sent().map((params) => Object.keys(params)))}`);
  assert.equal(old.got.length, sent().length, 'every message reached the old PC as sent');
  assert.match(b.h.chats.summary(chat.id).live?.[0].step ?? '', /q4\.pdf/, 'and its bar shows the newest step');
});

test('old → new: an old PC\'s line does not expire or blank while it works long without a message; its empty state ends it', async () => {
  const { a, liveA } = setup(30, 60); // A expires a silent new PC after 60 ms
  const chat = a.h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  await settle();
  const receive = a.handlers.get(LIVE_METHOD)!;
  const theirs = { activity: { ...tom(chat.id), runId: 'run_old', startedAt: 50, toolCalls: undefined }, chats: [chat.id] }; // what a 0.3.16 PC sends: {runs}, no `s`
  const answer = await receive({ runs: [theirs] }, 'pc_b') as { ok?: unknown; v?: unknown };
  assert.equal(answer.v, undefined, 'answered the old way, no `v`');
  assert.equal(answer.ok, true);
  assert.deepEqual(a.h.chats.summary(chat.id).live?.map((run) => [run.runId, run.deviceId]), [['run_old', 'pc_b']]);
  await wait(250); // a long tool run on B: B sends nothing, A's expiry (60 ms here, 15 s in the product) passes several times
  assert.deepEqual(a.h.chats.summary(chat.id).live?.map((run) => run.runId), ['run_old'], 'the line stays');
  await receive({ runs: [] }, 'pc_b'); // its end
  assert.equal(a.h.chats.summary(chat.id).live, undefined, 'the end of its state ends the line');
  void liveA;
});

test('new → old: the last, empty message that is lost is sent again with the pulse rounds until the old PC has it', async () => {
  const { a, b, old } = setup(40);
  const chat = a.h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  await settle();
  a.h.bus.emit('agent.activity', { active: [tom(chat.id)] });
  await settle();
  assert.equal(b.h.chats.summary(chat.id).live?.length, 1, 'B shows the run');
  const receive = b.handlers.get(LIVE_METHOD)!;
  let losing = true; // lost until released – the count of lost tries does not depend on how long settle() takes (flaky on main under load, 25.11.2026)
  let lost = 0;
  b.handlers.set(LIVE_METHOD, async (params, from) => {
    if ((params as { runs?: unknown[] }).runs?.length === 0 && losing) { lost++; throw new WorkforceError('timeout', 'The linked device did not answer in time.'); }
    return receive(params, from);
  });
  const before = old.got.length;
  a.h.bus.emit('agent.activity', { active: [] }); // the run ends: the empty state goes, and is lost twice
  await settle();
  assert.equal(b.h.chats.summary(chat.id).live?.length, 1, 'a ghost line stays while it is lost');
  await wait(200); // with nothing running on A, only the owed whole state keeps the rounds going – and it is lost again
  assert.ok(lost >= 2, `it was lost at least twice first (${lost})`);
  assert.equal(b.h.chats.summary(chat.id).live?.length, 1, 'the ghost line stays while the pulse rounds keep losing it');
  losing = false;
  await wait(400);
  assert.equal(b.h.chats.summary(chat.id).live, undefined, 'the empty state landed');
  assert.deepEqual(old.got.slice(before).map((params) => (params.runs as unknown[]).length), [0], 'once it landed – nothing more');
  const landed = old.got.length;
  await wait(200);
  assert.equal(old.got.length, landed, 'and no more rounds after the old PC took it');
});

test('a link swap to an old PC (no link-up): the first command is answered without `v`, fresh is reset and the whole state follows; no command or pulse after', async () => {
  const { a, b, sent } = setup(40);
  const chat = a.h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const liveB = new LiveSync(b.h.services, chatLiveOf(b.h.bus)!, async () => undefined, 0, 60_000, 60_000);
  b.handlers.set(LIVE_METHOD, async (params, from) => liveB.receive(params, from)); // B on this version first ...
  after(liveB.attach());
  await settle();
  a.h.bus.emit('agent.activity', { active: [tom(chat.id)] });
  await settle();
  a.h.bus.emit('run.item', call('run_tom', 'C:/data/new-form.pdf'));
  await settle();
  assert.ok(sent().some((params) => Array.isArray(params.c)), 'A speaks the short form to B now (fresh)');
  assert.equal(b.h.chats.summary(chat.id).live?.[0].runId, 'run_tom');

  const old = oldPeer(b, ['pc_a']); // ... then the line swaps to a PC of 0.3.16 behind the same id; A is not told
  const before = sent().length;
  a.h.bus.emit('run.item', call('run_tom', 'C:/data/after-swap.pdf'));
  await settle();
  const first = sent().slice(before);
  // A pulse round (40 ms here) can fall between the swap and the command: the old PC answers it without `v` just the same, and the whole state follows
  assert.ok(Array.isArray(first[0].c) || 'h' in first[0], 'the first message after the swap is still a command (or the pulse that was due)');
  assert.ok(Array.isArray(first[1]?.runs) && typeof first[1].s === 'number', 'the answer without `v` brought the whole state at once');
  assert.match(b.h.chats.summary(chat.id).live?.[0].step ?? '', /after-swap\.pdf/, 'the old PC\'s line is whole again');
  const afterWhole = sent().length;
  a.h.bus.emit('run.item', call('run_tom', 'C:/data/later.pdf'));
  await wait(250); // and several pulse periods
  const later = sent().slice(afterWhole);
  assert.ok(later.length >= 1 && later.every((params) => Array.isArray(params.runs)), `only whole states: ${JSON.stringify(later.map((params) => Object.keys(params)))}`);
  assert.match(b.h.chats.summary(chat.id).live?.[0].step ?? '', /later\.pdf/);
  assert.equal(old.got.filter((params) => !Array.isArray(params.runs)).length, 1, 'the old PC read exactly one command (an empty state there) and no pulse');
});

test('a PC without caps.version (older than 0.3.6): the version pair and the cursor stay stable, nothing is NaN or undefined', () => {
  const net = new Net();
  const a = makePc(net, 'pc_a');
  const b = makePc(net, 'pc_b');
  link(a, b); // record() gives caps: {}
  const stamps = new Stamps(a.h.db, a.h.clock, '0.3.18');
  assert.equal(stamps.pair('pc_b'), '0.3.18>');
  assert.equal(stamps.pair('pc_b'), '0.3.18>', 'the same again');
  assert.equal(stamps.cursor('pc_b'), undefined, 'the first time: from zero');
  stamps.setCursor('pc_b', 700);
  stamps.setCursor('pc_b', 710, 'files');
  assert.equal(stamps.cursor('pc_b'), 700, 'the cursor holds');
  assert.equal(stamps.cursor('pc_b', 'files'), 710);
  a.repo.patch('pc_b', { caps: { version: 7 as unknown as string } }); // a version that is no string reads as none
  assert.equal(stamps.pair('pc_b'), '0.3.18>');
  assert.equal(stamps.cursor('pc_b'), 700, 'still the same cursor');
  assert.equal(stamps.pair('pc_unknown'), '0.3.18>', 'a PC not known at all');
  a.repo.patch('pc_b', { caps: { version: '0.3.17' } });
  assert.equal(stamps.cursor('pc_b'), undefined, 'when its version arrives, one full run (once)');
});

test('a ping answered without `at` (or with a bad one) gives a round trip and no clock offset; no NaN', async () => {
  const net = new Net();
  const a = makePc(net, 'pc_a');
  const b = makePc(net, 'pc_ping_old');
  link(a, b);
  const devices = a.h.services.devices;
  let t = 1_000;
  const now = () => (t += 25);
  for (const reply of [{ ok: true }, { ok: true, at: 'x' }, { ok: true, at: null }, { ok: true, at: Number.NaN }]) { // NaN travels as null in JSON
    b.handlers.set('ping', async () => reply);
    await pingLink(devices, 'pc_ping_old', { now });
  }
  const quality = linkQuality('pc_ping_old', t);
  assert.ok(quality, 'a round trip was measured');
  assert.ok(Number.isFinite(quality.rttMs) && quality.rttMs >= 0);
  assert.equal('offsetMs' in quality, false, 'no offset without a usable `at`');
  assert.ok(Object.values(quality).every((value) => value === undefined || value === true || (typeof value === 'number' && !Number.isNaN(value))), 'nothing is NaN');
  b.handlers.set('ping', async () => ({ ok: true, at: 10_000 })); // the real 0.3.16 ping has `at`: then there is an offset
  await pingLink(devices, 'pc_ping_old', { now });
  assert.equal(typeof linkQuality('pc_ping_old', t)?.offsetMs, 'number');
});
