// F07 (owner 15.11.2026: "die Standardsprache ist immer Englisch"; 18.11.2026: "Generell nichts in der App …
// standardmäßig nirgendwo"): a new profile starts English on every PC – a German Windows too –, only an explicit choice
// changes it, and a profile language already stored stays as it is. The PC's display language (AUTARK_SYSTEM_LANGUAGE,
// which the desktop app sets from Electron's preferred system languages, main/runtime-link.ts runtimeEnv) still reaches
// the runtime as a speech hint; the Windows installer speaks English only (no NSIS language picked from the OS).
// Owns: these assertions. Never: a real Electron or OS setting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultSettings, languageOf, systemEnvironment } from '../../../src/runtime/settings/defaults.ts';
import { runtimeEnv } from '../../../src/main/runtime-link.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { RootWatcher } from '../../../src/runtime/root/watcher.ts';
import { clock, memoryDb, recordingBus, tempDir } from '../store/helpers.ts';

test('the display language from the desktop app wins over Intl; without it Intl; the time zone stays Intl\'s', () => {
  const intl = Intl.DateTimeFormat().resolvedOptions();
  assert.deepEqual(systemEnvironment({ AUTARK_SYSTEM_LANGUAGE: 'en-US' }), { locale: 'en-US', timezone: intl.timeZone || 'UTC' });
  assert.equal(systemEnvironment({ AUTARK_SYSTEM_LANGUAGE: '  fr-FR ' }).locale, 'fr-FR');
  assert.equal(systemEnvironment({}).locale, intl.locale || 'en', 'a runtime started without the app');
  assert.equal(systemEnvironment({ AUTARK_SYSTEM_LANGUAGE: '' }).locale, intl.locale || 'en', 'an empty value is no value');
});

test('an unusable language gives English; a usable one its code', () => {
  assert.equal(languageOf('de-AT'), 'de');
  assert.equal(languageOf('zh-Hans-CN'), 'zh');
  for (const value of ['Deutsch', '!!', '', '1-2']) assert.equal(languageOf(value), 'en', value);
  assert.equal(defaultSettings({ locale: 'Deutsch' }).profile.language, 'en');
  assert.equal(defaultSettings({ locale: 'es-MX' }).profile.language, 'en', 'owner 18.11.2026: English on every PC');
  assert.equal(defaultSettings({ locale: 'de-AT' }).profile.language, 'en');
});

test('the desktop app hands the display language to the runtime; none when Electron has none', () => {
  assert.equal(runtimeEnv({ PATH: '/bin' }, undefined, 'de-DE').AUTARK_SYSTEM_LANGUAGE, 'de-DE');
  assert.equal('AUTARK_SYSTEM_LANGUAGE' in runtimeEnv({ PATH: '/bin' }, undefined, undefined), false);
  assert.equal('AUTARK_SYSTEM_LANGUAGE' in runtimeEnv({ PATH: '/bin' }, undefined, ' '), false);
});

test('a fresh profile on a German Windows starts English; an explicit choice changes it and stays', (t) => {
  const temp = tempDir('wf-settings-language-de-');
  const time = clock();
  const root = new RootWatcher({ root: temp.dir, clock: time, watch: false, debounceMs: 1, maxWaitMs: 5 });
  root.start();
  const before = process.env.AUTARK_SYSTEM_LANGUAGE;
  process.env.AUTARK_SYSTEM_LANGUAGE = 'de-DE'; // what the desktop app hands in on a German Windows
  const store = () => new SettingsStore({ db: memoryDb(), bus: recordingBus().bus, clock: time, env: { locale: 'de-DE', timezone: 'Europe/Vienna' }, dataDir: temp.dir, root });
  t.after(() => {
    root.stop(); temp.cleanup();
    if (before === undefined) delete process.env.AUTARK_SYSTEM_LANGUAGE; else process.env.AUTARK_SYSTEM_LANGUAGE = before;
  });
  assert.equal(defaultSettings().profile.language, 'en', 'the defaults ignore the display language');
  const fresh = store();
  assert.equal(fresh.get().profile.language, 'en', 'a German display language: still English');
  assert.equal(fresh.get().profile.timezone, 'Europe/Vienna', 'the time zone still comes from the PC');
  fresh.update({ profile: { language: 'de' } }); // the explicit choice
  fresh.close();
  const later = store();
  assert.equal(later.get().profile.language, 'de');
  later.close();
});

test('the Windows installer is English only: no NSIS language follows the OS', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { build: { nsis: Record<string, unknown> } };
  assert.equal(pkg.build.nsis.multiLanguageInstaller, false, 'electron-builder otherwise bundles every language and NSIS picks the OS one');
  assert.deepEqual(pkg.build.nsis.installerLanguages, ['en_US']);
  assert.equal(pkg.build.nsis.displayLanguageSelector ?? false, false);
});

test('a stored profile language stays; a fresh profile starts English', (t) => {
  const temp = tempDir('wf-settings-language-');
  const time = clock();
  const root = new RootWatcher({ root: temp.dir, clock: time, watch: false, debounceMs: 1, maxWaitMs: 5 });
  root.start();
  const store = (locale: string) => new SettingsStore({ db: memoryDb(), bus: recordingBus().bus, clock: time, env: { locale, timezone: 'UTC' }, dataDir: temp.dir, root });
  t.after(() => { root.stop(); temp.cleanup(); });
  const first = store('en-US');
  assert.equal(first.get().profile.language, 'en', 'an English display language: English');
  first.update({ profile: { language: 'de' } }); // settings.json now holds it
  first.close(); // the next start of the app
  const later = store('fr-FR');
  assert.equal(later.get().profile.language, 'de', 'the stored choice is never rewritten');
  later.close();
});
