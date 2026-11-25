// The app's stop lets the subconscious's routing call in flight end (compose/lifecycle.ts, step 'subconscious'), right after the
// dispatcher and before the engines and the database; a runtime without it (fakes) just skips the step.
// Owns: these assertions only. Never: real models or engines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, model } from '../context/fixture.ts';
import { stopSteps } from '../../../src/runtime/compose/lifecycle.ts';
import { SubconsciousImpl } from '../../../src/runtime/subconscious/service.ts';
import type { Core } from '../../../src/runtime/compose/services.ts';
import type { Network } from '../../../src/runtime/compose/network.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';
import { routable } from './routable.ts';

const network = new Proxy({}, { get: () => undefined }) as unknown as Network;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('stop: a routing call in flight ends before the engines and the database stop', { timeout: 10_000 }, async () => {
  const f = fixture();
  routable(f.services, [model('codex:luna', 'small', 'Luna')]);
  const calls: string[] = [];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const runner: StructuredRunner = async () => {
    calls.push('model');
    entered.resolve();
    await release.promise;
    calls.push('answered');
    const structured = { hardest: 'x', fixed: true, shows: true, together: false, model: 'Luna', effort: 'low', why: 'a fact to take note of' };
    return { text: JSON.stringify(structured), structured, by: 'fake' };
  };
  const subconscious = new SubconsciousImpl({ services: () => f.services, runner });
  const turn = subconscious.beforeTurn({ agent: f.vid, thread: 'main', said: 'Mein Steuerberater heißt Jonas Weber.' });
  try {
    // The word search reads files before the runner starts; wait for the runner,
    // regardless of how many turns of the event loop the search takes.
    await Promise.race([
      entered.promise,
      turn.then(() => assert.fail('Routing ended before the model started')),
    ]);
    assert.deepEqual(calls, ['model']);

    const core = {
      services: { subconscious, db: { close: () => calls.push('db.close') } },
      dispatcher: { stop: () => calls.push('dispatcher') },
      engines: { dispose: () => calls.push('engines') },
    } as unknown as Core;
    const steps = stopSteps(core, network);
    const names = steps.map((step) => step.name);
    assert.ok(names.indexOf('dispatcher') < names.indexOf('subconscious') && names.indexOf('subconscious') < names.indexOf('engines') && names.indexOf('engines') < names.indexOf('database'), names.join(', '));

    let stopped = false;
    const stopping = Promise.resolve(steps[names.indexOf('subconscious')].run()).then(() => { stopped = true; });
    await flush();
    assert.equal(stopped, false, 'the step waits for the call');
    assert.deepEqual(calls, ['model']);
    release.resolve();
    await stopping;
    assert.deepEqual(calls, ['model', 'answered']);
  } finally {
    release.resolve(); // Don't leave the runner waiting after an assertion failure.
    await turn;
  }
});

test('stop: services without it (a fake, no subconscious) skip the step', async () => {
  const core = { services: {} } as unknown as Core;
  await stopSteps(core, network).find((candidate) => candidate.name === 'subconscious')!.run();
  const bare = { services: { subconscious: {} } } as unknown as Core;
  await stopSteps(bare, network).find((candidate) => candidate.name === 'subconscious')!.run();
});
