// macOS signing configuration (scripts/mac-signing-config.cjs): the ad-hoc test build gets its own entitlements with
// disable-library-validation (no Team ID, so library validation would refuse Electron Framework and the sherpa-onnx addons),
// and a Developer ID build never does. Both set entitlements and entitlementsInherit, so every helper gets the same file.
// Owns: these assertions. Never: signs anything or reads a certificate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const configPath = path.join(desktop, 'scripts', 'mac-signing-config.cjs');
const LIBRARY_VALIDATION = 'com.apple.security.cs.disable-library-validation';
const KEYS = ['AUTARK_MAC_SIGNING', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'CSC_IDENTITY_AUTO_DISCOVERY'];

function load(env: Record<string, string>) {
  const saved = KEYS.map((key) => process.env[key]);
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, env);
  delete require.cache[configPath];
  try { return require(configPath); } finally {
    KEYS.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    delete require.cache[configPath];
  }
}
const keysOf = (file: string) => [...readFileSync(file, 'utf8').matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]).sort();

test('ad hoc: identity "-", hardened runtime, the ad-hoc entitlements for the app and every helper, no notarization', () => {
  const config = load({ AUTARK_MAC_SIGNING: 'adhoc' });
  assert.equal(config.mac.identity, '-');
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.mac.notarize, false);
  assert.equal(config.forceCodeSigning, true);
  assert.equal(path.basename(config.mac.entitlements), 'entitlements.mac.adhoc.plist');
  assert.equal(config.mac.entitlementsInherit, config.mac.entitlements, 'the helpers get the same file as the app');
  assert.ok(readFileSync(config.mac.entitlements, 'utf8').includes(LIBRARY_VALIDATION));
});

test('Developer ID: the normal entitlements without disable-library-validation, notarization on', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'autark-mac-config-'));
  try {
    const key = path.join(dir, 'AuthKey.p8'); writeFileSync(key, 'not a key');
    const config = load({ AUTARK_MAC_SIGNING: 'developer-id', APPLE_API_KEY: key, APPLE_API_KEY_ID: 'KEYID', APPLE_API_ISSUER: 'ISSUER' });
    assert.equal(config.mac.notarize, true);
    assert.equal(config.mac.hardenedRuntime, true);
    assert.equal(config.mac.identity, undefined, 'the certificate is found in the keychain, not named here');
    assert.equal(path.basename(config.mac.entitlements), 'entitlements.mac.plist');
    assert.equal(config.mac.entitlementsInherit, config.mac.entitlements);
    assert.ok(!readFileSync(config.mac.entitlements, 'utf8').includes(LIBRARY_VALIDATION), 'a Developer ID build keeps library validation');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the ad-hoc file is the Developer ID file plus disable-library-validation, nothing else', () => {
  const assets = path.join(desktop, 'assets');
  const normal = keysOf(path.join(assets, 'entitlements.mac.plist'));
  const adhoc = keysOf(path.join(assets, 'entitlements.mac.adhoc.plist'));
  assert.deepEqual(adhoc, [...normal, LIBRARY_VALIDATION].sort());
  for (const key of ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory', 'com.apple.security.device.audio-input', 'com.apple.security.device.camera', 'com.apple.security.automation.apple-events']) {
    assert.ok(normal.includes(key), key);
  }
});

test('a build without a mode, or with an unknown one, stops instead of falling back to unsigned', () => {
  assert.throws(() => load({}), /AUTARK_MAC_SIGNING must be/);
  assert.throws(() => load({ AUTARK_MAC_SIGNING: 'unsigned' }), /AUTARK_MAC_SIGNING must be/);
});
