import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { agent } from '../chat/harness.ts';
import { flush, setup } from '../dispatcher/fakes.ts';
import { DispatcherImpl } from '../../../src/runtime/agents/dispatcher.ts';
import type { SplitService } from '../../../src/runtime/contracts.ts';
import { MAX_MEMORY_WAIT_MS, START_HEADROOM, TurnMemoryGate, availableMemory, cachedMac, forgetMacReading, parseVmStat } from '../../../src/runtime/agents/dispatch-memory.ts';

function fixture(free = START_HEADROOM) {
  let now = 0;
  const sleeps: number[] = [];
  const reports: Array<[string, number, number]> = [];
  let onSleep = () => {};
  const gate = new TurnMemoryGate({
    free: () => free,
    now: () => now,
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      now += ms;
      onSleep();
      signal.throwIfAborted();
    },
  });
  const stop = new AbortController();
  return {
    run: () => gate.wait(stop.signal, (phase, note) => reports.push([phase, note.waitedMs, note.reservedMiB])),
    makeFree: (value: number) => { free = value; },
    afterSleep: (fn: () => void) => { onSleep = fn; },
    cancel: () => stop.abort(),
    sleeps, reports,
  };
}

test('enough free RAM starts immediately; a burst cannot spend the same headroom twice', async () => {
  const f = fixture();
  const first = f.run();
  assert.deepEqual(f.sleeps, []);
  await Promise.all([first, f.run()]);
  assert.deepEqual(f.reports, [['waiting', 0, 300]]);
  assert.equal(f.sleeps.reduce((total, ms) => total + ms, 0), 5000);
});

test('can start at the next check when memory is available', async () => {
  const f = fixture(0);
  f.afterSleep(() => f.makeFree(START_HEADROOM));
  await f.run();
  assert.deepEqual(f.sleeps, [1000]);
  assert.deepEqual(f.reports, [['waiting', 0, 0]]);
});

test('logs persistent pressure once and lets the run start after at most 30 seconds', async () => {
  const f = fixture(0);
  await f.run();
  assert.deepEqual(f.reports, [['waiting', 0, 0], ['timeout', MAX_MEMORY_WAIT_MS, 0]]);
  assert.equal(f.sleeps.reduce((total, ms) => total + ms, 0), MAX_MEMORY_WAIT_MS);
});

test('an abort ends the wait without issuing a timeout or starting anything', async () => {
  const f = fixture(0);
  f.afterSleep(f.cancel);
  await f.run();
  await f.run();
  assert.deepEqual(f.sleeps, [1000]);
  assert.deepEqual(f.reports, [['waiting', 0, 0]]);
});

test('the dispatcher delays main and split executors; stopping a waiting split starts no work', async () => {
  const h = setup();
  h.org.add(agent('ag_tom', 'Tom'));
  const waits: AbortSignal[] = [];
  const ended: string[] = [];
  const release = Promise.withResolvers<void>();
  h.services.splits = {
    turnFor: () => ({ splitId: 'sp_1', groupId: 'sg_1', idx: 1, of: 1, title: 'Part', parentRunId: 'run_parent', parentThread: 'ch_x', context: 'brief', firstTurn: true }),
    inputFor: () => [],
    get: () => undefined,
    afterParentTurn: () => {},
    onSplitRunEnd: (_id, end) => { ended.push(end.status); },
  } as Partial<SplitService> as SplitService;
  const dispatcher = new DispatcherImpl({
    services: () => h.services, executor: h.executor,
    memoryGate: { wait: (signal) => { waits.push(signal); return release.promise; } },
  });
  h.services.dispatcher = dispatcher;
  dispatcher.start();
  h.wakes.wake({ agentId: 'ag_tom', reason: 'manual' });
  assert.equal(dispatcher.startSplit({ agentId: 'ag_tom', splitId: 'sp_1' }), 'started');
  await flush();
  assert.equal(waits.length, 2);
  assert.equal(h.executor.calls.length, 0);
  assert.equal(dispatcher.stopSplit('sp_1', 'human'), true);
  assert.equal(waits.filter((signal) => signal.aborted).length, 1);
  release.resolve();
  await flush();
  assert.equal(h.executor.calls.length, 1);
  assert.equal(h.executor.calls[0]?.request.split, undefined);
  assert.deepEqual(ended, ['stopped']);
  h.executor.calls[0]?.finish();
  await flush();
  await dispatcher.stop();
});

// A Mac with 8 GB and nothing running: only 237 MiB are never-used pages, the rest is cache (the GitHub macOS runner, 26.11.2026).
const VM_STAT = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                               15168.',
  'Pages active:                            112340.',
  'Pages inactive:                          101500.',
  'Pages speculative:                         3000.',
  'Pages throttled:                              0.',
  'Pages wired down:                         70000.',
].join('\n');

test('macOS: free, inactive and speculative pages count as available memory, not only the free ones', () => {
  const available = parseVmStat(VM_STAT);
  assert.equal(available, (15168 + 101500 + 3000) * 16384);
  assert.ok(available! >= START_HEADROOM, 'a Mac with ~1.8 GiB reclaimable memory starts its turn at once');
  assert.ok(15168 * 16384 < START_HEADROOM, 'the free pages alone were below the target');
});

test('vm_stat output in another format is not trusted', () => {
  assert.equal(parseVmStat(''), undefined);
  assert.equal(parseVmStat('Pages free: lots'), undefined);
});

test('the default memory reading is a positive number on this host', () => {
  assert.ok(availableMemory() > 0);
});

test('the vm_stat reading is shared for three seconds, then taken again', () => {
  forgetMacReading();
  let reads = 0;
  const read = () => { reads++; return reads * 1000; };
  assert.equal(cachedMac(10_000, read), 1000);
  assert.equal(cachedMac(11_000, read), 1000);
  assert.equal(cachedMac(12_999, read), 1000);
  assert.equal(cachedMac(13_000, read), 2000);
  assert.equal(reads, 2);
  forgetMacReading();
});
