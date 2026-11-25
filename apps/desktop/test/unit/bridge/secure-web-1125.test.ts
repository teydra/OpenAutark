// Bridge secure-web-1125 (Konrad's decision 1, 25.11.2026): a Secure mode with the web on 'yes' becomes 'chosen' once per
// company; whoever sets it back to 'yes' afterwards keeps it; Trust AI mode and a fresh company stay as they are; a
// failure leaves no mark, so the next start tries again.
// Owns: these assertions only, on a temporary database built here. Never: a company's data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { runSecureWeb1125 } from '../../../src/runtime/bridge/secure-web-1125.ts';
import { securityDefaults, type SecuritySettings } from '../../../src/shared/model/security-settings.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';

function company(security: SecuritySettings | undefined, fail = false) {
  const db = new Db(':memory:');
  migrate(db);
  let stored = security ? { ...security } : undefined;
  const patches: unknown[] = [];
  const warned: string[] = [];
  const s = {
    db,
    clock: { now: () => 1 },
    log: { info() {}, warn: (line: string) => { warned.push(line); } },
    settings: {
      get: () => ({ security: stored }),
      update: (patch: { security?: Partial<SecuritySettings> }) => {
        if (fail) throw new Error('settings.json is locked');
        patches.push(patch);
        stored = { ...stored!, ...patch.security };
        return { security: stored };
      },
    },
  } as unknown as Pick<RuntimeServices, 'db' | 'settings' | 'clock' | 'log'>;
  return { s, patches, warned, web: () => stored?.web, set: (next: Partial<SecuritySettings>) => { stored = { ...stored!, ...next }; } };
}

test('secure-web-1125: Secure mode with the web open everywhere switches to chosen sites once, the rest of the section untouched', () => {
  const c = company({ ...securityDefaults('secure'), web: 'yes', webDomains: ['example.com'] });
  assert.equal(runSecureWeb1125(c.s), 'switched');
  assert.equal(c.web(), 'chosen');
  assert.deepEqual(c.patches, [{ security: { web: 'chosen' } }], 'only the web switch');
  c.set({ web: 'yes' }); // the person sets it back afterwards
  assert.equal(runSecureWeb1125(c.s), 'done');
  assert.equal(c.web(), 'yes', 'the next start never undoes their choice');
  assert.equal(c.patches.length, 1);
});

test('secure-web-1125: Trust AI mode, a Secure mode already asking and a fresh company only get the mark', () => {
  for (const security of [securityDefaults('trust'), { ...securityDefaults('secure'), web: 'ask' as const }, undefined]) {
    const c = company(security);
    assert.equal(runSecureWeb1125(c.s), 'done');
    assert.deepEqual(c.patches, []);
    assert.equal(c.web(), security?.web);
    c.set({ mode: 'secure', web: 'yes' }); // a later switch to Secure with the web open is the person's own
    assert.equal(runSecureWeb1125(c.s), 'done');
    assert.equal(c.web(), 'yes');
  }
});

test('secure-web-1125: a failed update leaves no mark – the next start tries again', () => {
  const security = { ...securityDefaults('secure'), web: 'yes' as const };
  const broken = company(security, true);
  assert.equal(runSecureWeb1125(broken.s), 'failed');
  assert.equal(broken.warned.length, 1);
  assert.equal(broken.web(), 'yes');
  const again = { ...broken, s: { ...broken.s, settings: company(security).s.settings } };
  assert.equal(runSecureWeb1125(again.s), 'switched', 'the same database, no mark');
});
