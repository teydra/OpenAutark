// B-041: the settings sections `day` (working hours, buffer, the end of the night, AI helps, keep awake – Quests round
// 20.11.2026: the morning plan's and the agents' lane's keys are gone, an old stored one is dropped) and `calendar` (the person's Google OAuth client – the secret only as a vault id): defaults, merge and
// persistence in settings.json (the whole section), the value rules (HH:MM, start before end, buffer 0–60, booleans), unknown keys refused, a damaged
// stored section falling back to the defaults and daySettingsOf for settings stored before the section existed.
// Quests round 20.11.2026: the one "day without a time" rule (isDayOnly), when such a day rings (ringAt) and the next
// start of work (nextWorkStart).
// Owns: checks of these two sections and that rule only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { parseText } from '../../../src/runtime/settings/schema.ts';
import { DAY_BOUNDARY_HOUR, DEFAULT_DAY_SETTINGS, clockMinutes, daySettingsOf, isDayOnly, nextWorkStart, ringAt } from '../../../src/shared/model/day-settings.ts';
import { wallTime } from '../../../src/shared/text/when.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { clock, memoryDb, recordingBus, tempDir } from '../store/helpers.ts';
import { storedSettings } from './stored.ts';

const env = { locale: 'de-DE', timezone: 'Europe/Berlin' };

function setup() {
  const db = memoryDb();
  const recorder = recordingBus();
  return { db, settings: new SettingsStore({ db, bus: recorder.bus, clock: clock(), env }), ...recorder };
}

const refused = (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request';

test('defaults: 08:00–20:00, 10 min buffer, the night until 06:00, AI helps and keep awake on; no calendar section', () => {
  const { settings } = setup();
  assert.deepEqual(settings.get().day, { workStart: '08:00', workEnd: '20:00', bufferMin: 10, planAt: '06:00', aiHelps: true });
  assert.deepEqual(settings.get().day, { ...DEFAULT_DAY_SETTINGS });
  assert.equal(settings.get().calendar, undefined);
  assert.equal(DAY_BOUNDARY_HOUR, 4);
});

test('a patch merges into the day section, is stored in settings.json and survives a restart', (t) => {
  const temp = tempDir('wf-day-');
  t.after(temp.cleanup);
  const recorder = recordingBus();
  const settings = new SettingsStore({ bus: recorder.bus, clock: clock(), env, dataDir: temp.dir });
  const next = settings.update({ day: { workStart: '07:30', bufferMin: 0, aiHelps: false } });
  assert.deepEqual(next.day, { ...DEFAULT_DAY_SETTINGS, workStart: '07:30', bufferMin: 0, aiHelps: false });
  assert.equal(recorder.of('settings.updated').length, 1);
  assert.deepEqual(parseText(readFileSync(path.join(temp.dir, 'settings.json'), 'utf8')).data?.day, next.day, 'the whole section, as it applies');
  assert.deepEqual(new SettingsStore({ bus: recordingBus().bus, clock: clock(), env, dataDir: temp.dir }).get().day, next.day);
});

test('an older settings.json with the morning plan\'s and the agents\' lane\'s keys: they are dropped, the rest of the day applies', (t) => {
  const temp = tempDir('wf-day-old-');
  t.after(temp.cleanup);
  const file = path.join(temp.dir, 'settings.json');
  writeFileSync(file, JSON.stringify({ day: { workStart: '07:00', autoPlan: false, agentLane: true, aiHelps: false } }));
  const settings = new SettingsStore({ bus: recordingBus().bus, clock: clock(), env, dataDir: temp.dir });
  assert.deepEqual(settings.get().day, { ...DEFAULT_DAY_SETTINGS, workStart: '07:00', aiHelps: false });
  const written = parseText(readFileSync(file, 'utf8')).data?.day as Record<string, unknown>;
  assert.ok(!('autoPlan' in written) && !('agentLane' in written), 'written again without them');
});

test('the value rules: HH:MM, the work start before its end, a buffer of 0–60 whole minutes, booleans, known keys', () => {
  const { settings, of } = setup();
  for (const day of [
    { workStart: '8:00' }, { workEnd: '24:00' }, { planAt: '06:60' }, { workStart: '20:00' }, { workEnd: '08:00' },
    { bufferMin: 61 }, { bufferMin: -1 }, { bufferMin: 2.5 }, { autoPlan: true }, { agentLane: false }, { aiHelps: 1 }, { keepAwake: true }, { colour: 'red' },
  ]) {
    assert.throws(() => settings.update({ day: day as never }), refused, JSON.stringify(day));
  }
  assert.deepEqual(settings.get().day, { ...DEFAULT_DAY_SETTINGS }, 'a refused patch changes nothing');
  assert.equal(of('settings.updated').length, 0);
  assert.equal(settings.update({ day: { workStart: '06:00', workEnd: '23:59', bufferMin: 60 } }).day?.bufferMin, 60);
});

test('calendar: a Google client id and a vault id for its secret; anything else is refused', () => {
  const { settings } = setup();
  const next = settings.update({ calendar: { googleClientId: '1234-abc.apps.googleusercontent.com', googleSecretId: 'sec_01jab3k9z7mx2c4q' } });
  assert.deepEqual(next.calendar, { googleClientId: '1234-abc.apps.googleusercontent.com', googleSecretId: 'sec_01jab3k9z7mx2c4q' });
  for (const calendar of [{ googleClientId: 'has spaces' }, { googleClientId: 42 }, { googleSecretId: 'x'.repeat(81) }, { clientSecret: 'plain' }]) {
    assert.throws(() => settings.update({ calendar: calendar as never }), refused, JSON.stringify(calendar));
  }
  assert.equal(settings.update({ calendar: { googleSecretId: null as never } }).calendar?.googleSecretId, undefined, 'null clears it');
});

test('a damaged stored day section falls back to the defaults and keeps the other sections', (t) => {
  const { settings, done } = storedSettings({ day: { workStart: 'late' }, profile: { name: 'Ana' } }, env);
  t.after(done);
  const s = settings.get();
  assert.deepEqual(s.day, { ...DEFAULT_DAY_SETTINGS });
  assert.equal(s.profile.name, 'Ana');
});

test('daySettingsOf fills keys missing in older settings; clockMinutes reads HH:MM', () => {
  assert.deepEqual(daySettingsOf(undefined), { ...DEFAULT_DAY_SETTINGS });
  assert.deepEqual(daySettingsOf({ day: { planAt: '05:15' } }), { ...DEFAULT_DAY_SETTINGS, planAt: '05:15' });
  assert.equal(clockMinutes('20:00'), 1200);
  assert.equal(clockMinutes('7:00'), undefined);
});

test('a day without a time: `at` at local midnight and no minutes; it rings at the start of work, a timed one at its time', () => {
  const zone = 'Europe/Berlin';
  const midnight = wallTime('2026-11-21', 0, zone);
  assert.equal(isDayOnly({ at: midnight }, zone), true);
  assert.equal(isDayOnly({ at: midnight, minutes: 30 }, zone), false, 'a time at 00:00 carries minutes');
  assert.equal(isDayOnly({ at: wallTime('2026-11-21', 9 * 60, zone) }, zone), false);
  assert.equal(isDayOnly({}, zone), false);
  assert.equal(ringAt({ at: midnight }, zone, '07:30'), wallTime('2026-11-21', 7 * 60 + 30, zone), 'that day\'s work start');
  assert.equal(ringAt({ at: midnight }, zone, 'nonsense'), wallTime('2026-11-21', 8 * 60, zone), '08:00 without a valid start');
  assert.equal(ringAt({ at: midnight + 60_000 }, zone, '07:30'), midnight + 60_000, 'a time rings at its time');
  assert.equal(ringAt({}, zone), undefined);
  assert.equal(nextWorkStart(wallTime('2026-11-21', 6 * 60, zone), zone, '08:00'), wallTime('2026-11-21', 8 * 60, zone));
  assert.equal(nextWorkStart(wallTime('2026-11-21', 8 * 60, zone), zone, '08:00'), wallTime('2026-11-22', 8 * 60, zone), 'after it: the next day');
});
