// Settings between the CEO's PCs (devices/sync/settings.ts), one stamp per section: a PC that joins as CEO adopts the
// existing company's name, owner and picture even when its own devices section changes at the link (the live bug of
// 04.11.2026: the new company's empty profile overwrote the main PC's); a section is stamped only when it really
// changes (a baseline at 0 before that); a change in one section never resets another; at the first link an empty
// text never clears the joiner's name (it goes back instead), while a text cleared later travels and stays cleared;
// a section only the joiner has reaches the other PC; an older single 'settings' stamp counts for every section.
// B-080: a key of a known section this PC does not know (a newer PC's) is left out of the patch and the rest applies –
// no more refusal of every section (live: voice.dictation). 22.11.2026: one rule across versions – the sections keep
// the form PCs since 0.3.13 send (pinned below), every other key is its own unit with no list to extend, and what this
// PC does not know is kept as it came and travels on (same value, same stamp: no echo); a kept unit this PC learns (a
// later version) moves into settings.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Settings } from '../../../src/shared/model/system.ts';
import { DevicesRepo, type DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { SettingsSync, settingsPatch, syncedSettings, type SettingsMessage } from '../../../src/runtime/devices/sync/settings.ts';
import { Stamps, hashOf } from '../../../src/runtime/devices/sync/stamps.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { deepMerge } from '../../../src/runtime/settings/validate.ts';
import { SECTIONS } from '../../../src/runtime/settings/schema.ts';
import { ManualClock, memoryDb, recordingBus, silentLog } from './fakes.ts';

const AVATAR = 'a'.repeat(64);

const record = (id: string, extra: Partial<DeviceRecord> = {}): DeviceRecord => ({
  id, name: id, kind: 'pc', role: 'home', fingerprint: `fp_${id}`, addresses: [], caps: {}, status: 'online', self: false, ...extra,
});

interface Pc { id: string; sync: SettingsSync; stamps: Stamps; store: { current: Settings }; clock: ManualClock; s: RuntimeServices; up: boolean }

/** Two PCs whose settings syncs reach each other directly (the mesh carries 'sync.file' op 'settings' the same way). */
function makePcs(a: Record<string, unknown>, b: Record<string, unknown>): [Pc, Pc] {
  const pcs = new Map<string, Pc>();
  const make = (id: string, settings: Record<string, unknown>, start: number): Pc => {
    const db = memoryDb();
    const { bus } = recordingBus();
    const clock = new ManualClock(start);
    new DevicesRepo(db).upsert(record(id, { self: true }));
    const store = { current: settings as unknown as Settings };
    const s = {
      db, bus, clock, log: silentLog,
      settings: { get: () => store.current, update: (patch: unknown) => { store.current = deepMerge(store.current, patch); bus.emit('settings.updated', store.current); return store.current; } },
    } as unknown as RuntimeServices;
    const stamps = new Stamps(db, clock);
    const pc: Pc = { id, store, clock, s, stamps, up: true, sync: undefined as unknown as SettingsSync };
    pc.sync = new SettingsSync(s, stamps, (message, except) => {
      for (const other of pcs.values()) {
        if (other.id === id || other.id === except || !other.up || !pc.up) continue;
        other.sync.receive(JSON.parse(JSON.stringify(message)) as SettingsMessage, id, other.id === 'dev_b');
      }
    });
    pcs.set(id, pc);
    return pc;
  };
  return [make('dev_a', a, 1_000_000), make('dev_b', b, 2_000_000)];
}

/** The link-up both ways: each PC sends its current copy (B joined A). */
function linkUp(a: Pc, b: Pc): void {
  b.sync.receive(JSON.parse(JSON.stringify(a.sync.current())) as SettingsMessage, a.id, true);
  a.sync.receive(JSON.parse(JSON.stringify(b.sync.current())) as SettingsMessage, b.id, false);
}

const profileOf = (pc: Pc) => pc.store.current.profile as unknown as Record<string, unknown>;
/** A settings edit on `pc` (any keys: the fake store takes them like the real one's patch). */
const edit = (pc: Pc, patch: Record<string, unknown>) => pc.s.settings.update(patch as never);

test('a PC that joins as CEO adopts the company name, the owner and the picture – its devices change at the link stamps nothing', () => {
  const [a, b] = makePcs(
    { profile: { name: 'Alex', company: 'Berger', avatarFileId: AVATAR }, routing: { work: 'auto' }, devices: { peerPort: 1 } },
    { profile: { name: '', company: '' }, routing: { work: 'auto' }, devices: { peerPort: 2 } },
  );
  const offs = [a.sync.attach(), b.sync.attach()];
  a.up = false; // the link exists, the channel is not up yet
  edit(b, { devices: { peerPort: 3, peer: 'lan' } }); // the new company's link writes its devices section
  assert.equal(b.stamps.get('settings/profile')?.at, 0, 'no shared change, no stamp: the baseline stays at 0');
  a.up = true;
  linkUp(a, b);
  assert.deepEqual(profileOf(b), { name: 'Alex', company: 'Berger', avatarFileId: AVATAR }, 'the joiner takes the company\'s profile');
  assert.deepEqual(profileOf(a), { name: 'Alex', company: 'Berger', avatarFileId: AVATAR }, 'the existing PC keeps it');
  assert.equal((b.store.current.devices as unknown as { peerPort: number }).peerPort, 3, 'its own devices section stays');
  for (const off of offs) off();
});

test('a change in one section never resets another: the later routing and the later name both win', () => {
  const [a, b] = makePcs(
    { profile: { name: 'Alex' }, routing: { work: 'auto' } },
    { profile: { name: 'Alex' }, routing: { work: 'auto' } },
  );
  const offs = [a.sync.attach(), b.sync.attach()];
  a.up = false;
  edit(a, { profile: { name: 'Alex Berger' } }); // A, at 1 000 000
  edit(b, { routing: { work: 'acc_1:gpt' } }); // B, later: at 2 000 000
  a.up = true;
  linkUp(a, b);
  for (const pc of [a, b]) {
    assert.equal(profileOf(pc).name, 'Alex Berger', `${pc.id}: A's name stays`);
    assert.equal((pc.store.current.routing as unknown as { work: string }).work, 'acc_1:gpt', `${pc.id}: B's routing arrives`);
  }
  for (const off of offs) off();
});

test('at the first link an empty name never clears the joiner\'s name – it goes back to the other PC instead', () => {
  const [a, b] = makePcs(
    { profile: { name: '', company: '' }, routing: { work: 'auto' } },
    { profile: { name: 'Alex', company: 'Berger' }, routing: { work: 'auto' } },
  );
  const offs = [a.sync.attach(), b.sync.attach()];
  linkUp(a, b);
  assert.deepEqual(profileOf(b), { name: 'Alex', company: 'Berger' }, 'the joiner keeps its texts');
  assert.deepEqual(profileOf(a), { name: 'Alex', company: 'Berger' }, 'what it kept went back');
  for (const off of offs) off();
});

test('a text cleared later travels like any change and stays cleared on the PC that cleared it', () => {
  const voice = { realtime: 'off', localStt: 'whisper', ttsVoice: 'anna' };
  const [a, b] = makePcs({ voice }, { voice });
  const offs = [a.sync.attach(), b.sync.attach()];
  edit(a, { voice: { localStt: '', ttsVoice: null } }); // B online: no local speech recognition, the default voice
  for (const pc of [a, b]) assert.deepEqual(pc.store.current.voice, { realtime: 'off', localStt: '' }, `${pc.id}: at once`);

  edit(b, { voice: { localStt: 'whisper', ttsVoice: 'anna' } });
  for (const pc of [a, b]) assert.deepEqual(pc.store.current.voice, voice, `${pc.id}: set again on B`);
  b.up = false;
  edit(a, { voice: { localStt: '', ttsVoice: null } }); // A clears them while B is away
  b.up = true;
  linkUp(a, b);
  for (const pc of [a, b]) assert.deepEqual(pc.store.current.voice, { realtime: 'off', localStt: '' }, `${pc.id}: after the link-up`);
  for (const off of offs) off();
});

test('a section only the joiner has reaches the PC it joined', () => {
  const provider = { prv_1: { kind: 'openai', label: 'OpenAI', secretId: 'sec_1' } };
  const [a, b] = makePcs({ profile: { name: 'Alex' } }, { profile: { name: '' }, providers: provider });
  const offs = [a.sync.attach(), b.sync.attach()];
  linkUp(a, b);
  for (const pc of [a, b]) {
    assert.equal(profileOf(pc).name, 'Alex', `${pc.id}: the company's name`);
    assert.deepEqual(pc.store.current.providers, provider, `${pc.id}: the joiner's API connection`);
  }
  for (const off of offs) off();
});

test('an older single settings stamp counts for every section; then a change stamps only its own section', () => {
  const [a] = makePcs({ profile: { name: 'Alex' }, routing: { work: 'auto' }, voice: { realtime: 'off' } }, {});
  a.stamps.set('settings', { at: 5000, h: 'whole file' });
  const off = a.sync.attach();
  assert.equal(a.stamps.get('settings'), undefined, 'the single stamp is gone');
  for (const section of ['profile', 'routing', 'voice']) assert.equal(a.stamps.get(`settings/${section}`)?.at, 5000, section);
  edit(a, { voice: { realtime: 'auto' } });
  assert.ok(a.stamps.get('settings/voice')!.at > 5000, 'the changed section is stamped now');
  assert.equal(a.stamps.get('settings/profile')?.at, 5000, 'the others keep theirs');
  assert.deepEqual(Object.keys(a.sync.current().sections).sort(), ['profile', 'profile.notes', 'routing', 'voice'], 'the link-up sends every section (and the unit profile.notes)');
  off();
});

test('the patch: a later copy makes the section equal; at the first link the joiner merges and an empty text never replaces its own', () => {
  const local = { profile: { name: 'Lena', company: 'Berger', timezone: 'Europe/Vienna' }, voice: { talker: true, realtime: 'off' }, devices: { peerPort: 1 } } as unknown as Settings;
  const incoming = { profile: { name: '', company: null }, voice: { realtime: 'auto' } };
  assert.deepEqual(
    settingsPatch(local, incoming),
    { profile: { name: '', company: null, timezone: null }, voice: { talker: null, realtime: 'auto' } },
    'a cleared text and a key the copy lacks follow',
  );
  assert.deepEqual(settingsPatch(local, incoming, true), { voice: { realtime: 'auto' } }, 'merging: the texts and what only this PC has stay');
  assert.deepEqual(settingsPatch(local, { profile: { name: 'Lena Berg' } }), { profile: { name: 'Lena Berg', company: null, timezone: null } }, 'a set text replaces one');
  assert.deepEqual(settingsPatch(local, { devices: { peerPort: 9 } }), {}, 'this PC\'s own sections never change');
});

test('B-078 with a 0.3.x PC: profile.notes travels as its own unit – the profile looks as before and an older copy never clears it', () => {
  const [a, b] = makePcs(
    { profile: { name: 'Alex', notes: 'German at work, du' }, library: { publish: true }, routing: { work: 'auto' } },
    { profile: { name: 'Alex', notes: '' }, library: { publish: true }, routing: { work: 'auto' } },
  );
  const offs = [a.sync.attach(), b.sync.attach()];
  // What an older PC gets from here: a profile without notes (the hash it computes itself), plus units it skips.
  const copy = a.sync.current();
  assert.deepEqual(copy.sections.profile.value, { name: 'Alex' });
  assert.equal(copy.sections.profile.h, hashOf({ name: 'Alex' }), 'the older PC sees no change of its own');
  assert.equal(copy.sections['profile.notes']!.value, 'German at work, du');
  assert.deepEqual(Object.keys(copy.sections).sort(), ['library', 'profile', 'profile.notes', 'routing'], '0.3.x skips library and the units (no settings sections there)');
  // The older PC's message: its profile without notes, stamped later – the name follows, the notes stay.
  const old: SettingsMessage = { sections: { profile: { at: 9_000_000, h: hashOf({ name: 'Stan' }), value: { name: 'Stan' } } } };
  a.sync.receive(old, 'dev_old', false);
  assert.deepEqual(profileOf(a), { name: 'Stan', notes: 'German at work, du' });
  // Between two new PCs the notes travel, and clearing them travels too; the rest of the profile is untouched.
  a.clock.advance(10_000_000);
  edit(a, { profile: { notes: 'English with clients' } });
  assert.equal(profileOf(b).notes, 'English with clients');
  assert.equal(profileOf(b).name, 'Stan', 'the profile came along with the older PC\'s name');
  b.clock.advance(20_000_000);
  edit(b, { profile: { notes: null } });
  assert.equal(profileOf(a).notes, undefined, 'cleared on the other PC as well');
  assert.equal(profileOf(a).name, 'Stan');
  // At the first link an empty notes text never replaces one that is set.
  const local = { profile: { name: 'Stan', notes: 'du' } } as unknown as Settings;
  assert.deepEqual(settingsPatch(local, { 'profile.notes': '' }, true), {});
  assert.deepEqual(settingsPatch(local, { 'profile.notes': 'Sie' }), { profile: { notes: 'Sie' } });
  for (const off of offs) off();
});

test('Umzug 21.11.2026: the section security stays on each PC; the units an older PC still sends for pcAccess and forEveryAgent change nothing here', () => {
  const trust = { mode: 'trust', read: 'all', readFolders: [], money: 'yes' };
  const [a, b] = makePcs({ profile: { name: 'Alex' }, security: trust }, { profile: { name: 'Alex' }, security: trust });
  const offs = [a.sync.attach(), b.sync.attach()];
  a.clock.advance(10_000_000);
  edit(a, { security: { mode: 'secure', read: 'chosen', readFolders: ['C:\\Docs'] } });
  assert.deepEqual(b.store.current.security, trust, 'each PC keeps its own mode');
  edit(a, { profile: { name: 'Alexa' } });
  assert.equal(profileOf(b).name, 'Alexa', 'the other sections still travel');
  edit(a, { profile: { name: 'Alex' } });
  const old: SettingsMessage = { sections: {
    'profile.pcAccess': { at: 99_000_000, h: hashOf('careful'), value: 'careful' },
    'profile.forEveryAgent': { at: 99_000_000, h: hashOf('Old line.'), value: 'Old line.' },
  } };
  b.sync.receive(old, 'dev_old', false);
  assert.deepEqual(profileOf(b), { name: 'Alex' }, 'nothing of the two old keys arrives');
  assert.equal(b.sync.current().sections['profile.pcAccess']?.value, 'careful', 'kept as it came: it travels on for a PC that knows it');
  for (const off of offs) off();
});

test('B-080: a newer PC\'s key in a known section is left out of the patch; the rest of every section applies', () => {
  const local = { voice: { realtime: 'off', vocabulary: [] }, profile: { name: 'Alex' } } as unknown as Settings;
  assert.deepEqual(settingsPatch(local, { voice: { realtime: 'auto', vocabulary: [], dictation: 'local' }, profile: { name: 'Alex', mood: 'calm' } }),
    { voice: { realtime: 'auto' } }, 'voice.dictation and profile.mood are no keys here');
  const [a] = makePcs({ profile: { name: 'Alex' }, voice: { realtime: 'off' }, routing: { work: 'auto' } }, {});
  const updates: unknown[] = [];
  const update = a.s.settings.update.bind(a.s.settings);
  a.s.settings.update = ((patch: Record<string, unknown>) => {
    // The real store refuses an unknown key (settings/validate.ts checkPatchShape) – the whole patch would fail.
    if (JSON.stringify(patch).includes('dictation')) throw new Error('Invalid setting voice.dictation: expected a known key.');
    updates.push(patch);
    return update(patch as never);
  }) as typeof a.s.settings.update;
  const message: SettingsMessage = { sections: {
    voice: { at: 9_000_000, h: hashOf({ realtime: 'auto', dictation: 'local' }), value: { realtime: 'auto', dictation: 'local' } },
    routing: { at: 9_000_000, h: hashOf({ work: 'acc_1:gpt' }), value: { work: 'acc_1:gpt' } },
  } };
  assert.doesNotThrow(() => a.sync.receive(message, 'dev_old', false));
  assert.equal((a.store.current.voice as unknown as { realtime: string }).realtime, 'auto');
  assert.equal('dictation' in (a.store.current.voice as unknown as Record<string, unknown>), false);
  assert.equal((a.store.current.routing as unknown as { work: string }).work, 'acc_1:gpt', 'the other section of the message applies too');
  assert.equal(updates.length, 1, 'one patch, and no echo after it');
  const voice = a.sync.current().sections.voice;
  assert.deepEqual(voice.value, { realtime: 'auto', dictation: 'local' }, '22.11.2026: the key this PC lacks is kept with the section and travels on');
  assert.equal(voice.h, message.sections.voice.h, 'the same hash: the newer PC sees no change of its own');
});

test('22.11.2026: a unit a newer PC sends that this PC does not know is kept as it came – passed on, sent again with its stamp, replaced by a newer copy', () => {
  const [a, b] = makePcs({ profile: { name: 'Alex' }, voice: { realtime: 'off' } }, { profile: { name: 'Alex' }, voice: { realtime: 'off' } });
  const offs = [a.sync.attach(), b.sync.attach()];
  const unit = (value: string, at: number): SettingsMessage => ({ sections: { 'voice.dictation': { at, h: hashOf(value), value } } });
  a.sync.receive(unit('local', 9_000_000), 'dev_new', false);
  assert.deepEqual(a.store.current.voice, { realtime: 'off' }, 'nothing of it in settings.json');
  for (const pc of [a, b]) assert.deepEqual(pc.sync.current().sections['voice.dictation'], { at: 9_000_000, h: hashOf('local'), value: 'local' }, `${pc.id}: kept and passed on`);
  edit(a, { voice: { realtime: 'auto' } });
  assert.equal(b.sync.current().sections['voice.dictation']?.value, 'local', 'an edit of the section leaves it standing');
  a.sync.receive(unit('cloud', 9_500_000), 'dev_new', false);
  for (const pc of [a, b]) assert.equal(pc.sync.current().sections['voice.dictation']?.value, 'cloud', `${pc.id}: the newer copy`);
  a.sync.receive(unit('local', 9_100_000), 'dev_new', false);
  assert.equal(a.sync.current().sections['voice.dictation']?.value, 'cloud', 'an older one never wins');
  for (const off of offs) off();
});

test('22.11.2026: a kept unit this PC knows now (a later version) moves into settings.json – with its stamp, so nothing goes out', () => {
  const [a] = makePcs({ profile: { name: 'Alex' } }, {});
  new KvRepo(a.s.db).set('sync.settings', 'profile.notes', { v: 'du' }, 1); // kept by an earlier version that lacked the key
  a.stamps.set('settings/profile.notes', { at: 7_000, h: hashOf('du') });
  const off = a.sync.attach();
  assert.equal(profileOf(a).notes, 'du', 'in settings.json now');
  assert.deepEqual(new KvRepo(a.s.db).list('sync.settings'), [], 'no longer kept');
  assert.deepEqual(a.stamps.get('settings/profile.notes'), { at: 7_000, h: hashOf('du') }, 'the same stamp: no change of its own');
  off();
});

/**
 * 22.11.2026: the form of each section as PCs since 0.3.13 send it (frozen: devices/sync/settings.ts BASE). Every other
 * key of a section travels as its own unit without an entry anywhere – today profile.notes and notifications.computerUse.
 */
const SECTION_FORM: Record<string, string[]> = {
  profile: ['name', 'company', 'avatarFileId', 'language', 'timezone'],
  preferences: ['theme', 'enterSends', 'openAtLogin', 'autoDownloadUpdates'], // the window layout never travels
  notifications: ['enabled', 'sound', 'quietHours', 'pushFor'],
  voice: ['ttsVoice', 'vocabulary', 'realtime', 'talker', 'localStt', 'localTts'],
  routing: ['work', 'decision', 'voice', 'stt', 'tts', 'image', 'video', 'music', 'sound', 'embeddings', 'costMode', 'allowPaidFallback'],
  day: ['workStart', 'workEnd', 'bufferMin', 'planAt', 'aiHelps', 'keepAwake'],
  calendar: ['googleClientId', 'googleSecretId'],
  lifecycle: ['retention'],
  feedback: ['includeDiagnostics'],
  library: ['publish'],
  onboarding: ['completed', 'step'],
};
const LAYOUT_KEYS = ['sidebarOpen', 'sidebarWidth', 'workspaceOpen', 'workspaceWidth'];

test('22.11.2026: the sections keep the form PCs since 0.3.13 send; every other key – a new one too – is its own unit', () => {
  const settings = Object.fromEntries(SECTIONS.map((section) => [section.key, section.free ? { prv_1: { kind: 'openai' } } : Object.fromEntries(section.keys.map((key) => [key.key, `${section.key}.${key.key}`]))]));
  const shared = syncedSettings(settings as unknown as Settings);
  const units: string[] = [];
  for (const section of SECTIONS) {
    if (['devices', 'pwa', 'security', 'usage'].includes(section.key)) { assert.equal(shared[section.key], undefined, `${section.key} stays on each PC`); continue; }
    if (section.free) { assert.deepEqual(shared[section.key], { prv_1: { kind: 'openai' } }, `${section.key} travels whole`); continue; }
    assert.deepEqual(Object.keys((shared[section.key] ?? {}) as object).sort(), [...(SECTION_FORM[section.key] ?? [])].sort(), `${section.key}: the frozen form (a section added later: units only)`);
    for (const key of section.keys) if (!SECTION_FORM[section.key]?.includes(key.key) && !(section.key === 'preferences' && LAYOUT_KEYS.includes(key.key))) units.push(`${section.key}.${key.key}`);
  }
  assert.deepEqual(Object.keys(shared).filter((name) => name.includes('.')).sort(), units.sort(), 'each other key as its own unit');
  assert.ok(units.includes('profile.notes') && units.includes('notifications.computerUse'), 'the two keys older PCs know as units');
});
