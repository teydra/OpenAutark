// 18.11.2026 (owner: the meeting server is only the meeting point): the texts of Settings › Devices › Connection – the
// one line on how devices connect with its privacy link, the meeting server row when its fallback is held (daily limit
// or paused), and the line that starts the meeting server shipped with the app (PowerShell on Windows, sh elsewhere).
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionLine, heldLine, OWN_SERVER_DOCKER, ownServerCommand, PRIVACY_URL, relayLine } from '../../../src/ui/settings/connect-text.ts';

const phone = (via?: 'direct' | 'rtc' | 'relay') => ({ deviceId: 'd', name: 'Phone', ...(via ? { via } : {}), direct: 0, rtc: 0, relay: 0, since: 0 });

// 28.11.2026 (Mac test of 0.3.22): the line said "directly device to device" while remote.relay showed via relay, direct 0, rtc 0.
test('the connection line names the way the links run now: direct only when a direct way is active', () => {
  assert.match(connectionLine({ relayed: [], phones: [phone('direct')] }), /^End-to-end encrypted, directly device to device\. The meeting server only helps your devices find each other/);
  assert.match(connectionLine({ relayed: [], phones: [phone('rtc')] }), /^End-to-end encrypted, directly device to device\./, 'WebRTC is direct too');
  const relayed = connectionLine({ relayed: [], phones: [phone('relay')] });
  assert.match(relayed, /through the meeting server/);
  assert.doesNotMatch(relayed, /directly device to device/);
  assert.match(connectionLine({ relayed: ['pc_a'], phones: [] }), /through the meeting server/, 'a PC link tunnelled there counts too');
  assert.match(connectionLine({ relayed: ['pc_a'], phones: [phone('rtc')] }), /directly device to device where the network allows.*partly through the meeting server/);
});

test('the connection line says "direct or through the meeting server" while no state tells the way', () => {
  for (const relay of [undefined, { relayed: [] }, { relayed: [], phones: [phone()] }]) {
    assert.match(connectionLine(relay), /directly device to device or through the meeting server when no direct way works/);
  }
});

test('the privacy notice links the meeting server section', () => {
  assert.equal(PRIVACY_URL, 'https://openautark.com/privacy/#meeting-server');
});

test('the meeting server row says when its fallback is at today’s limit or paused', () => {
  const base = { status: 'connected' as const, peersOnline: 1, relayed: [] };
  assert.equal(relayLine(base, 'wss://x'), 'Connected · 1 linked PC online there');
  assert.equal(relayLine({ ...base, held: 'quota' }, 'wss://x'), 'Connected · 1 linked PC online there · fallback at today’s limit, direct only');
  assert.equal(relayLine({ ...base, held: 'off' }, 'wss://x'), 'Connected · 1 linked PC online there · fallback paused, direct only');
  assert.equal(heldLine(undefined), '');
});

test('own meeting server: PowerShell on Windows, sh elsewhere, the container from the public source', () => {
  assert.equal(
    ownServerCommand({ program: 'C:\\Program Files\\Autark\\Autark.exe', file: 'C:\\Program Files\\Autark\\resources\\app.asar.unpacked\\app\\meet.mjs' }),
    '$env:ELECTRON_RUN_AS_NODE=1; $env:RELAY_PORT=8787; & "C:\\Program Files\\Autark\\Autark.exe" "C:\\Program Files\\Autark\\resources\\app.asar.unpacked\\app\\meet.mjs"',
  );
  assert.equal(
    ownServerCommand({ program: "/Applications/Autark.app/Contents/MacOS/Autark", file: "/opt/it's/meet.mjs" }),
    "ELECTRON_RUN_AS_NODE=1 RELAY_PORT=8787 '/Applications/Autark.app/Contents/MacOS/Autark' '/opt/it'\\''s/meet.mjs'",
  );
  assert.match(OWN_SERVER_DOCKER, /OpenAutark\.git#main:services\/remote-relay/);
  assert.match(OWN_SERVER_DOCKER, /-p 127\.0\.0\.1:8787:8787/, 'the raw port stays on loopback behind the TLS proxy');
});
