// 28.11.2026 (agents printed runtime.json with `Get-Content`: the owner token went to the model provider, the run journal and
// the engine transcript): the redactor masks this runtime's launch token, the owner token in every company's runtime.json on
// the PC and the wake key in wake.json – under their own marks, never a secret:// handle.
//  - Redactor.setMarked: raw, base64, URL, hex and grouped spellings; a short value is not learnt; remove forgets it;
//  - RuntimeValues: this company, the first and the other companies of the PC; a restarted company's new token is masked after
//    the next look (at most once per interval, not per call); the old one stays masked; a half-written file is read again;
//  - no false alarm: any other 64-hex string stays as it is; runtime.json / wake.json on disk are never changed.
// Owns: these assertions only. Never: a real token – the values below are synthetic, and a failing assertion names the case,
// never the value.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Redactor } from '../../../src/runtime/secrets/redact.ts';
import { INTERVAL_MS, KEPT, RUNTIME_TOKEN_MARK, RuntimeValues, WAKE_KEY_MARK } from '../../../src/runtime/secrets/runtime-values.ts';
import { ManualClock } from '../fakes.ts';

const hex = (seed: string) => seed.repeat(Math.ceil(64 / seed.length)).slice(0, 64);
const OWN = hex('0123456789abcdef'); // this company's token
const FIRST = hex('1badc0de');
const SIBLING = hex('feedface');
const SIBLING_NEW = hex('cafebabe');
const OTHER = hex('deadbeef'); // looks like a token, belongs to nothing
const WAKE = Buffer.from(hex('5eed')).toString('base64'); // a PKCS#8 text in the file's own shape (base64)

/** `assert.equal` without the values: a failure names the case only. */
function same(actual: string, expected: string, message: string): void {
  assert.ok(actual === expected, message);
}

function layout() {
  const root = mkdtempSync(path.join(tmpdir(), 'runtime-values-'));
  const first = path.join(root, 'first');
  const dir = path.join(root, 'Companies');
  const own = path.join(dir, 'company-2');
  const sibling = path.join(dir, 'company-3');
  for (const folder of [first, own, sibling, path.join(dir, 'logins')]) mkdirSync(folder, { recursive: true });
  // A real restart is seconds after the last write; a test writes within one file-system tick, so each write gets its own mtime.
  let tick = Date.UTC(2026, 10, 28) / 1000;
  const write = (file: string, text: string) => { writeFileSync(file, text); utimesSync(file, ++tick, tick); };
  const runtime = (folder: string, token: string) => write(path.join(folder, 'runtime.json'), JSON.stringify({ port: 4711, token, pid: 1, at: '2026-11-28T00:00:00.000Z' }));
  const wake = (folder: string, pkcs8: string) => write(path.join(folder, 'wake.json'), `${JSON.stringify({ v: 1, relay: 'wss://meet.example', key: { pub: 'pub-key-is-public', pkcs8 }, pins: [] })}\n`);
  const clock = new ManualClock();
  const redactor = new Redactor();
  const values = new RuntimeValues(redactor, { dataDir: own, companies: { first, dir }, now: () => clock.now() });
  return { root, first, dir, own, sibling, runtime, wake, clock, redactor, values, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('Redactor.setMarked masks every spelling under its own mark, never a secret:// handle', () => {
  const redactor = new Redactor();
  redactor.setMarked('runtime:1', OWN, RUNTIME_TOKEN_MARK);
  const spellings = [OWN, Buffer.from(OWN).toString('base64'), Buffer.from(OWN).toString('base64url'), encodeURIComponent(OWN), Buffer.from(OWN).toString('hex'), OWN.replace(/(.{8})/g, '$1 ').trim()];
  for (const spelling of spellings) {
    const out = redactor.redact(`before ${spelling} after`);
    same(out, `before ${RUNTIME_TOKEN_MARK} after`, 'a spelling of the token is masked');
  }
  const json = redactor.redact(JSON.stringify({ port: 1, token: OWN, pid: 2 }));
  same(json, `{"port":1,"token":"${RUNTIME_TOKEN_MARK}","pid":2}`, 'inside the JSON of runtime.json');
  assert.ok(!RUNTIME_TOKEN_MARK.includes('secret://') && !WAKE_KEY_MARK.includes('secret://'), 'no handle that something could try to resolve');
  same(redactor.redact(RUNTIME_TOKEN_MARK), RUNTIME_TOKEN_MARK, 'masking twice changes nothing');
});

test('Redactor.setMarked: a short value is not learnt, remove forgets it, a catalog id keeps its handle', () => {
  const redactor = new Redactor();
  redactor.setMarked('runtime:short', 'abc1234', RUNTIME_TOKEN_MARK);
  same(redactor.redact('the abc1234 word'), 'the abc1234 word', 'under 8 characters would match running text');
  redactor.setMarked('runtime:1', OWN, RUNTIME_TOKEN_MARK);
  redactor.set('sec_1', 'a-catalog-value-12345');
  same(redactor.redact(`${OWN} / a-catalog-value-12345`), `${RUNTIME_TOKEN_MARK} / secret://sec_1`, 'both kinds side by side');
  redactor.remove('runtime:1');
  same(redactor.redact(OWN), OWN, 'removed: no longer masked');
  redactor.setMarked('runtime:1', OWN, RUNTIME_TOKEN_MARK);
  redactor.set('runtime:1', 'another-value-for-the-id-123');
  same(redactor.redact(OWN), OWN, 'set() on the id replaces the value and drops the mark');
});

test('this runtime\'s launch token is masked from the first call on', () => {
  const l = layout();
  try {
    l.values.learnLaunchToken(OWN);
    same(l.redactor.redact(`Authorization: Bearer ${OWN}`), `Authorization: Bearer ${RUNTIME_TOKEN_MARK}`, 'launch token');
    l.values.learnLaunchToken(undefined); // no token (a test host): nothing learnt, nothing thrown
  } finally { l.done(); }
});

test('runtime.json of this company, the first company and a sibling, and every wake.json, are masked; files stay as they are', () => {
  const l = layout();
  try {
    l.runtime(l.own, OWN); l.runtime(l.first, FIRST); l.runtime(l.sibling, SIBLING);
    l.wake(l.own, WAKE); l.wake(l.sibling, hex('abad1dea') + '=');
    const before = ['own', 'first', 'sibling'].map((name) => readFileSync(path.join(name === 'own' ? l.own : name === 'first' ? l.first : l.sibling, 'runtime.json'), 'utf8'));
    l.values.refresh(true);
    for (const [name, value] of [['own', OWN], ['first', FIRST], ['sibling', SIBLING]] as const) {
      same(l.redactor.redact(`token ${value} end`), `token ${RUNTIME_TOKEN_MARK} end`, `${name} runtime.json token`);
    }
    same(l.redactor.redact(`key ${WAKE}`), `key ${WAKE_KEY_MARK}`, 'wake key of this company');
    same(l.redactor.redact(`key ${hex('abad1dea')}=`), `key ${WAKE_KEY_MARK}`, 'wake key of the sibling');
    const file = readFileSync(path.join(l.own, 'runtime.json'), 'utf8');
    same(l.redactor.redact(file).replace(RUNTIME_TOKEN_MARK, ''), '{"port":4711,"token":"","pid":1,"at":"2026-11-28T00:00:00.000Z"}', 'a printed runtime.json keeps port and pid, only the token is hidden');
    same(readFileSync(path.join(l.own, 'runtime.json'), 'utf8'), before[0], 'runtime.json is not changed');
    same(readFileSync(path.join(l.sibling, 'runtime.json'), 'utf8'), before[2], 'the sibling\'s runtime.json is not changed');
    same(l.redactor.redact('pub-key-is-public'), 'pub-key-is-public', 'the public half of the wake key is no secret');
  } finally { l.done(); }
});

test('no false alarm: another 64-hex string, a port and a pid stay as they are', () => {
  const l = layout();
  try {
    l.runtime(l.own, OWN); l.runtime(l.sibling, SIBLING); l.wake(l.own, WAKE);
    l.values.refresh(true);
    const text = `commit ${OTHER}\nsha256:${hex('0f1e2d3c')}\nport 4711 pid 1 ${OWN.slice(0, 32)} ${SIBLING.slice(8)}`;
    same(l.redactor.redact(text), text, 'a different hash or a part of a token');
  } finally { l.done(); }
});

test('a restarted company\'s new token is masked after the next look – not per call – and the old one stays masked', () => {
  const l = layout();
  try {
    l.runtime(l.sibling, SIBLING);
    l.values.refresh(true);
    l.runtime(l.sibling, SIBLING_NEW); // company-3 restarted
    l.values.refresh(); // within the interval: no look yet, no I/O
    same(l.redactor.redact(SIBLING_NEW), SIBLING_NEW, 'inside the interval the file is not read again');
    l.clock.advance(INTERVAL_MS);
    l.values.refresh();
    same(l.redactor.redact(`${SIBLING_NEW} ${SIBLING}`), `${RUNTIME_TOKEN_MARK} ${RUNTIME_TOKEN_MARK}`, 'new and old token');
    // after more restarts than KEPT the oldest is forgotten, the newest KEPT stay
    const tokens = [hex('11111111'), hex('22222222'), hex('33333333'), hex('44444444')];
    for (const token of tokens) { l.runtime(l.sibling, token); l.clock.advance(INTERVAL_MS); l.values.refresh(); }
    same(l.redactor.redact(tokens[tokens.length - 1]), RUNTIME_TOKEN_MARK, 'the newest');
    same(l.redactor.redact(tokens[tokens.length - KEPT]), RUNTIME_TOKEN_MARK, 'the oldest still kept');
    same(l.redactor.redact(SIBLING), SIBLING, 'beyond KEPT restarts the oldest is forgotten (bounded memory)');
  } finally { l.done(); }
});

test('a file that appears later (a company starts after us) and a half-written file are picked up', () => {
  const l = layout();
  try {
    l.values.refresh(true); // no runtime.json anywhere yet
    writeFileSync(path.join(l.sibling, 'runtime.json'), '{"port":4711,"tok'); // being written right now
    l.clock.advance(INTERVAL_MS);
    l.values.refresh();
    same(l.redactor.redact(SIBLING), SIBLING, 'unreadable: nothing learnt yet');
    l.runtime(l.sibling, SIBLING);
    l.clock.advance(INTERVAL_MS);
    l.values.refresh();
    same(l.redactor.redact(SIBLING), RUNTIME_TOKEN_MARK, 'complete now: masked');
    // a company folder that is removed or whose file is gone keeps the value masked
    rmSync(path.join(l.sibling, 'runtime.json'));
    l.clock.advance(INTERVAL_MS);
    l.values.refresh();
    same(l.redactor.redact(SIBLING), RUNTIME_TOKEN_MARK, 'a stopped company\'s last token stays masked');
  } finally { l.done(); }
});

test('without AppInfo.companies only this company\'s folder is watched; a missing folder or odd JSON never throws', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'runtime-values-'));
  try {
    const redactor = new Redactor();
    const clock = new ManualClock();
    const missing = new RuntimeValues(redactor, { dataDir: path.join(root, 'nothing-here'), now: () => clock.now() });
    missing.refresh(true);
    writeFileSync(path.join(root, 'runtime.json'), '[1,2,3]');
    writeFileSync(path.join(root, 'wake.json'), '{"key":{"pkcs8":42}}');
    const own = new RuntimeValues(redactor, { dataDir: root, now: () => clock.now() });
    own.refresh(true);
    writeFileSync(path.join(root, 'runtime.json'), JSON.stringify({ port: 1, token: OWN, pid: 1 }));
    clock.advance(INTERVAL_MS);
    own.refresh();
    same(redactor.redact(OWN), RUNTIME_TOKEN_MARK, 'own folder');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
