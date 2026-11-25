import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PcKeepAwake, shouldKeepAwake } from '../../../src/main/keep-awake.ts';

function rig(battery: boolean, switchOn = true) {
  const state = { battery, started: [] as string[], stopped: [] as number[], listener: undefined as undefined | (() => void), next: 1 };
  const awake = new PcKeepAwake(
    { start: type => { state.started.push(type); return state.next++; }, stop: id => { state.stopped.push(id); } },
    { onBattery: () => state.battery, onChange: l => { state.listener = l; return () => { state.listener = undefined; }; } },
    switchOn,
  );
  const plug = (onBattery: boolean) => { state.battery = onBattery; state.listener?.(); };
  return { state, awake, plug };
}

test('the rule: switch on and not on battery', () => {
  assert.equal(shouldKeepAwake(true, false), true);
  assert.equal(shouldKeepAwake(true, true), false);
  assert.equal(shouldKeepAwake(false, false), false);
  assert.equal(shouldKeepAwake(false, true), false);
});

test('mains + switch on holds app suspension only (never the display)', () => {
  const { state, awake } = rig(false);
  assert.deepEqual(state.started, ['prevent-app-suspension']);
  assert.equal(awake.holding, true);
});

test('battery or switch off holds nothing', () => {
  assert.equal(rig(true).awake.holding, false);
  assert.equal(rig(false, false).awake.holding, false);
});

test('unplugging releases, plugging in holds again, once each', () => {
  const { state, awake, plug } = rig(false);
  plug(true);
  assert.equal(awake.holding, false);
  assert.deepEqual(state.stopped, [1]);
  plug(true); // no change: nothing more
  plug(false);
  assert.equal(awake.holding, true);
  assert.equal(state.started.length, 2);
  plug(false);
  assert.equal(state.started.length, 2);
});

test('the switch turns the hold on and off live, also on battery stays off', () => {
  const { state, awake } = rig(false);
  awake.setSwitch(false);
  assert.equal(awake.holding, false);
  state.battery = true;
  awake.setSwitch(true);
  assert.equal(awake.holding, false);
  state.battery = false;
  awake.setSwitch(false);
  awake.setSwitch(true);
  assert.equal(awake.holding, true);
});

test('dispose releases and stops listening', () => {
  const { state, awake } = rig(false);
  awake.dispose();
  assert.equal(awake.holding, false);
  assert.deepEqual(state.stopped, [1]);
  assert.equal(state.listener, undefined);
});
