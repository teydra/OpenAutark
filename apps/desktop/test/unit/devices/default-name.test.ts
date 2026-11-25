// A PC nobody renamed shows the name its person knows: on a Mac the ComputerName, else the host name without ".local".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPcName } from '../../../src/runtime/devices/identity.ts';

test('darwin takes scutil ComputerName', () => {
  assert.equal(defaultPcName({ platform: 'darwin', hostname: () => 'Stanislaus-MacBook-Pro.local', scutil: () => "Stanislaus' MacBook Pro\n" }), "Stanislaus' MacBook Pro");
});

test('darwin falls back to the host name without .local when scutil fails or answers nothing', () => {
  const fail = () => { throw new Error('timeout'); };
  assert.equal(defaultPcName({ platform: 'darwin', hostname: () => 'Stanislaus-MacBook-Pro.local', scutil: fail }), 'Stanislaus-MacBook-Pro');
  assert.equal(defaultPcName({ platform: 'darwin', hostname: () => 'Mac.local', scutil: () => '  \n' }), 'Mac');
});

test('win32 and linux keep os.hostname and never call scutil', () => {
  const never = () => { throw new Error('called'); };
  assert.equal(defaultPcName({ platform: 'win32', hostname: () => 'TEYDRA-SERVER', scutil: never }), 'TEYDRA-SERVER');
  assert.equal(defaultPcName({ platform: 'linux', hostname: () => 'box.local', scutil: never }), 'box.local');
});
