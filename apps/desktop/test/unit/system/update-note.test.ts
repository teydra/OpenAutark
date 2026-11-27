// The update note (system/update-note.ts, Fest 22.11.2026): resources/updates.md holds one section per version, newest
// first; at runtime start the personal manager on its home PC gets one wake – its own lead plus every section since the
// version this folder ran last (kv system/version, which recordStart stores right after) – never on a fresh install or a
// folder whose first run is not done, only this version's section where the last version is unknown, nothing for a
// manager at home on another PC, an archived one or none. Versions follow semver order (a local build before its release).
// Owns: these assertions only. Never: a real runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { agent, FakeOrg } from '../chat/harness.ts';
import { record } from '../devices/sync-net.ts';
import { clock, memoryDb, RESOURCES, tempDir } from '../store/helpers.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { WakeQueueImpl } from '../../../src/runtime/wakes/queue.ts';
import {
  parseUpdates, readUpdates, sectionsFor, sendUpdateNote, updateLead, versionOrder, type NoteServices,
} from '../../../src/runtime/system/update-note.ts';

const UPDATES = [
  '# Autark updates', '', 'Intro for people.', '',
  '## 0.3.19', '', 'Nineteen.', '',
  '## 0.3.18', '', 'Eighteen.', '', '**A leftover.** Shows as: x. I check: y. I fix it: z.', '',
  '## 0.3.17', '', 'Seventeen.', '',
].join('\r\n');

function setup(options: { step?: string; previous?: string; name?: string; updates?: string | null } = {}) {
  const db = memoryDb();
  const time = clock();
  const org = new FakeOrg();
  const wakes = new WakeQueueImpl({ db, clock: time });
  const { dir, cleanup } = tempDir('wf-update-note-');
  if (options.updates !== null) writeFileSync(path.join(dir, 'updates.md'), options.updates ?? UPDATES);
  const step = options.step ?? 'done';
  const settings = { get: () => ({ onboarding: { completed: step === 'done', step }, profile: { name: options.name ?? 'Momo' } }), update: () => undefined };
  if (options.previous !== undefined) new KvRepo(db).set('system', 'version', options.previous, 1);
  const logs: string[] = [];
  const log = { debug() {}, info: (message: string) => { logs.push(message); }, warn: (message: string) => { logs.push(message); }, error() {} };
  const s = { db, org, wakes, settings, log, paths: { resources: dir } } as unknown as NoteServices;
  return { db, org, wakes, s, logs, cleanup };
}

const manager = (extra: Parameters<typeof agent>[2] = {}) => agent('ag_konrad', 'Konrad', { template: 'manager', mode: 'manager', ...extra });

test('versionOrder: semver order – a local build before its release, its parts by number; no version: undefined', () => {
  assert.equal(versionOrder('0.3.17', '0.3.18'), -1);
  assert.equal(versionOrder('0.3.18', '0.3.9'), 1, 'numbers, not text');
  assert.equal(versionOrder('1.0.0', '0.9.99'), 1);
  assert.equal(versionOrder('0.3.18', 'v0.3.18'), 0);
  assert.equal(versionOrder('0.3.18-local.2', '0.3.18'), -1, 'a local build comes before its release');
  assert.equal(versionOrder('0.3.18-local.2', '0.3.17'), 1);
  assert.equal(versionOrder('0.3.18-local.2', '0.3.18-local.10'), -1);
  assert.equal(versionOrder('0.3.18-local.3', '0.3.18-local.3'), 0);
  assert.equal(versionOrder('dev', '0.3.18'), undefined);
});

test('parseUpdates: each version heading with its paragraphs, in file order; the intro is no section', () => {
  const sections = parseUpdates(UPDATES);
  assert.deepEqual(sections.map((section) => section.version), ['0.3.19', '0.3.18', '0.3.17']);
  assert.equal(sections[1].text, '## 0.3.18\n\nEighteen.\n\n**A leftover.** Shows as: x. I check: y. I fix it: z.');
  assert.deepEqual(parseUpdates('## Notes\n\ntext\n### 0.3.1\n'), [], 'a heading without a version, or a deeper one, is none');
});

test('sectionsFor: after the last version up to this one, newest first; unknown last version: this one alone', () => {
  const sections = parseUpdates(UPDATES);
  const of = (previous: string | undefined, version: string) => sectionsFor(sections, previous, version).map((section) => section.version);
  assert.deepEqual(of('0.3.16', '0.3.19'), ['0.3.19', '0.3.18', '0.3.17']);
  assert.deepEqual(of('0.3.17', '0.3.18'), ['0.3.18']);
  assert.deepEqual(of(undefined, '0.3.18'), ['0.3.18']);
  assert.deepEqual(of('garbage', '0.3.18'), ['0.3.18'], 'a mark that is no version counts as unknown');
  assert.deepEqual(of('0.3.18', '0.3.18'), []);
  assert.deepEqual(of('0.3.19', '0.3.18'), [], 'an older version installed again: nothing');
  assert.deepEqual(of('0.3.17', '0.3.18-local.1'), [], 'a local build never brings its release\'s section');
  assert.deepEqual(of('0.3.18-local.3', '0.3.18'), ['0.3.18'], 'the release brings it once, after its local builds');
  assert.deepEqual(of('0.3.18-local.3', '0.3.19-local.1'), ['0.3.18']);
});

test('the shipped updates.md: version sections only, newest first, each with what a person reads', () => {
  const text = readFileSync(path.join(RESOURCES, 'updates.md'), 'utf8');
  assert.equal(text.includes('\r'), false, 'LF line ends');
  const sections = readUpdates(RESOURCES);
  assert.ok(sections.length >= 1);
  assert.deepEqual(sections.map((section) => section.version), [...sections].sort((a, b) => versionOrder(b.version, a.version)!).map((section) => section.version));
  for (const section of sections) assert.ok(section.text.split('\n').slice(1).join('\n').trim().length > 40, `${section.version} says something`);
  assert.equal(sections.filter((section) => /^\d+\.\d+\.\d+$/.test(section.version)).length, sections.length, 'released versions only');
});

test('a fresh install, or a folder whose first run is not done: no wake', () => {
  for (const options of [{ step: 'ai' }, { step: 'tour', previous: '0.3.17' }]) {
    const h = setup(options);
    h.org.add(manager());
    assert.equal(sendUpdateNote(h.s, '0.3.19'), false);
    assert.equal(h.wakes.list('ag_konrad').length, 0);
    h.cleanup();
  }
});

test('an older version with several sections: one wake for the personal manager – its lead, then every section since, newest first', () => {
  const h = setup({ previous: '0.3.17' });
  h.org.add(agent('ag_paula', 'Paula', { mode: 'manager', createdAt: -5 })); // a department head beside the seed
  h.org.add(manager());
  assert.equal(sendUpdateNote(h.s, '0.3.19'), true);
  const [wake] = h.wakes.list('ag_konrad');
  assert.equal(h.wakes.list('ag_konrad').length, 1);
  assert.equal(h.wakes.list('ag_paula').length, 0, 'only the personal manager');
  assert.equal(wake.reason, 'event');
  assert.deepEqual(wake.origin, { source: 'system', label: 'Update to 0.3.19' });
  const parts = wake.note!.split('\n\n');
  assert.equal(parts[0], updateLead({ previous: '0.3.17', version: '0.3.19', person: 'Momo' }));
  assert.match(parts[0], /^Autark on this PC moved from 0\.3\.17 to 0\.3\.19\./);
  assert.match(parts[0], /where only Momo can tell what was meant, I ask in one line\.$/);
  assert.deepEqual(wake.note!.match(/^## .+$/gm), ['## 0.3.19', '## 0.3.18'], 'newest first, nothing older than the last version');
  assert.equal(wake.note!.includes('Intro for people'), false);
  assert.equal(sendUpdateNote(h.s, '0.3.19'), true);
  assert.equal(h.wakes.list('ag_konrad').length, 1, 'a start before recordStart stored the version: the same wake, merged');
  new KvRepo(h.db).set('system', 'version', '0.3.19', 2); // recordStart
  assert.equal(sendUpdateNote(h.s, '0.3.19'), false, 'the next start of the same version: nothing');
  h.cleanup();
});

test('a folder that ran before without a known version: this version\'s section alone', () => {
  const h = setup({ name: '' });
  h.org.add(manager());
  assert.equal(sendUpdateNote(h.s, '0.3.18'), true);
  const [wake] = h.wakes.list('ag_konrad');
  assert.match(wake.note!, /^Autark on this PC runs 0\.3\.18 now\./);
  assert.match(wake.note!, /where only the person can tell/);
  assert.deepEqual(wake.note!.match(/^## .+$/gm), ['## 0.3.18']);
  h.cleanup();
});

test('no section for this version, or no updates.md: no wake', () => {
  const none = setup({ previous: '0.3.19' });
  none.org.add(manager());
  assert.equal(sendUpdateNote(none.s, '0.3.20-local.1'), false);
  none.cleanup();
  const missing = setup({ previous: '0.3.17', updates: null });
  missing.org.add(manager());
  assert.equal(sendUpdateNote(missing.s, '0.3.18'), false);
  assert.equal(missing.wakes.list('ag_konrad').length, 0);
  missing.cleanup();
});

test('the manager at home on another of my PCs: nothing here – its home PC sends it', () => {
  const h = setup({ previous: '0.3.17' });
  new DevicesRepo(h.db).upsert(record('dev_self', { self: true }));
  new DevicesRepo(h.db).upsert(record('dev_server')); // one of my own PCs ('ceo' link)
  h.org.add(manager({ deviceId: 'dev_server' }));
  assert.equal(sendUpdateNote(h.s, '0.3.18'), false);
  assert.equal(h.wakes.list('ag_konrad').length, 0);
  h.org.add(manager({ deviceId: 'dev_self' }));
  assert.equal(sendUpdateNote(h.s, '0.3.18'), true, 'at home here: woken here');
  h.cleanup();
});

test('an archived manager or none: no wake', () => {
  const h = setup({ previous: '0.3.17' });
  assert.equal(sendUpdateNote(h.s, '0.3.18'), false, 'no agent at all');
  h.org.add(manager({ archivedAt: 5 }));
  h.org.add(agent('ag_ida', 'Ida'));
  assert.equal(sendUpdateNote(h.s, '0.3.18'), false);
  assert.equal(h.wakes.list('ag_konrad').length + h.wakes.list('ag_ida').length, 0);
  h.cleanup();
});

test('the lead is the manager\'s own will: first person, no permission or must words, nothing about what the person wants', () => {
  for (const lead of [updateLead({ previous: '0.3.16', version: '0.3.17', person: 'Momo' }), updateLead({ version: '0.3.17' })]) {
    assert.doesNotMatch(lead, /\b(you|your|must|may|allowed|only if|should|wants?)\b/i);
    assert.match(lead, /\bI check our company for each with my own tools\b/);
  }
});

test('owner: "My day" is gone everywhere – the shipped updates.md (read by the manager, quoted to people) never names it', () => {
  const text = readFileSync(path.join(RESOURCES, 'updates.md'), 'utf8');
  assert.doesNotMatch(text, /\bmy[ -]?day\b/i, 'the page is Tasks since the Quests round of 20.11.2026');
});

test('main.ts sends the note before recordStart stores this start\'s version', () => {
  const main = readFileSync(new URL('../../../src/runtime/main.ts', import.meta.url), 'utf8');
  const note = main.indexOf('sendUpdateNote(s, options.version)');
  const seed = main.indexOf('s.org.ensureSeed()');
  assert.ok(note > seed, 'after the first Manager is seeded');
  assert.ok(note > 0 && note < main.indexOf('recordStart(s,'), 'before the version is stored');
});
