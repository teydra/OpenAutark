// Bridge general-1121 (Halb round 21.11.2026, package AUT): a general.md the 19.11. bridge wrote – the old shipped text with
// the name filled in, then the person's own lines – loses the old paragraph and keeps the lines; one that held only the old
// paragraph is removed, so the shipped default shows; one whose first paragraph was changed stays as it is. In Secure mode
// too (the topics' own save, not a file edit that would be put back), logged, and a second run changes nothing.
// Owns: these assertions only, on a temporary data folder built here. Never: a company's data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OLD_GENERAL, generalPart, withoutOldGeneral } from '../../../src/runtime/bridge/general-1121.ts';
import { SecurityTopics, fillName } from '../../../src/runtime/security/topics.ts';
import { readSecurityChanges, type LogKv } from '../../../src/runtime/settings/security-log.ts';
import { securityDefaults, type SecurityMode } from '../../../src/shared/model/security-settings.ts';
import type { Settings } from '../../../src/shared/model/system.ts';
import { RESOURCES, clock, tempDir } from '../store/helpers.ts';

const silent = { debug() {}, info() {}, warn() {}, error() {} } as never;
const bridged = (lines: string) => `${[fillName(OLD_GENERAL, 'Ada Lind'), lines].filter(Boolean).join('\n\n')}\n`; // as appendGeneral wrote it

function rig(mode: SecurityMode) {
  const temp = tempDir('wf-general-1121-');
  const store = new Map<string, unknown>();
  const kv: LogKv = { get: <T>(ns: string, key: string) => store.get(`${ns}/${key}`) as T | undefined, set: (ns, key, value) => { store.set(`${ns}/${key}`, value); } };
  const settings = { profile: { name: 'Ada Lind' }, security: securityDefaults(mode) } as unknown as Settings;
  const file = (m: SecurityMode) => path.join(temp.dir, 'security', m, 'general.md');
  const write = (m: SecurityMode, text: string) => { mkdirSync(path.dirname(file(m)), { recursive: true }); writeFileSync(file(m), text); };
  const make = () => new SecurityTopics({ dataDir: temp.dir, resourcesDir: RESOURCES, settings: { get: () => settings }, kv, clock: clock(), log: silent });
  return { kv, file, write, make, done: () => temp.cleanup() };
}

test('the old paragraph goes, the person\'s lines stay; only the old paragraph: the file goes; a changed first paragraph stays', () => {
  const h = rig('secure');
  try {
    h.write('trust', bridged('I sign with my name.\nNo calls before 10:00.'));
    h.write('secure', bridged(''));
    const topics = h.make();
    assert.deepEqual(generalPart(topics), ['trust', 'secure']);
    assert.equal(readFileSync(h.file('trust'), 'utf8'), 'I sign with my name.\nNo calls before 10:00.\n');
    assert.equal(existsSync(h.file('secure')), false, 'nothing of theirs left: the shipped default shows');
    assert.match(topics.text('secure', 'general'), /a doubt about a step beyond my own work goes to Ada Lind\.$/, 'today\'s default');
    assert.equal(topics.isAccepted('security/trust/general.md', 'I sign with my name.\nNo calls before 10:00.'), true, 'accepted, so sync carries it');
    assert.equal(readSecurityChanges(h.kv).filter((entry) => entry.field === 'security/trust/general.md' || entry.field === 'security/secure/general.md').length, 2, 'logged');
    assert.deepEqual(generalPart(topics), [], 'once');
  } finally { h.done(); }
  const changed = rig('trust');
  try {
    const own = fillName(OLD_GENERAL, 'Ada Lind').replace('far more than it costs', 'more than it costs') + '\n\nI sign with my name.\n';
    changed.write('trust', own);
    changed.write('secure', `My own rule first.\n\n${bridged('')}`);
    assert.deepEqual(generalPart(changed.make()), [], 'a changed first paragraph, or the old text further down, is the person\'s');
    assert.equal(readFileSync(changed.file('trust'), 'utf8'), own);
  } finally { changed.done(); }
});

test('withoutOldGeneral: any name, CRLF, a paragraph that runs on is not the old one', () => {
  assert.equal(withoutOldGeneral(`${fillName(OLD_GENERAL, 'the person')}\r\n\r\nMine.\r\n`), 'Mine.');
  assert.equal(withoutOldGeneral(fillName(OLD_GENERAL, 'Lena Berg')), null);
  assert.equal(withoutOldGeneral(`${fillName(OLD_GENERAL, 'Lena')} And one more sentence of mine.`), undefined);
  assert.equal(withoutOldGeneral('I decide and act.'), undefined);
});
