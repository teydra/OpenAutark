// settings.json between the CEO's own PCs (op 'settings' of 'sync.file', files.ts), in units with a stamp each (key
// 'settings/<unit>', stamps.ts). Never travels what belongs to this PC: devices (its listener, requests, meeting
// server), pwa (who reaches its HTTP port), security (each PC its own mode and switches) and the window layout.
// The one rule across versions: a section carries the keys it carried on 22.11.2026 (BASE – what every PC since 0.3.13
// sends in it, frozen); every other key is its own unit '<section>.<key>' (also every key of a section added later),
// and a free section (providers) travels whole. So a PC on an older version never sees a key it does not know inside a
// section (its own copies would drop it and clear it here), and its copies never name such a key – a unit a copy does
// not name stays as it is. What arrives that this PC does not know – a unit of a newer version, or a key a section
// carries that this PC lacks – is kept as received (kv 'sync.settings') and travels on in this PC's copies with the same
// value and hash, so nothing echoes and nothing is lost on the way; once this PC knows it (a later version), it moves
// into settings.json. A unit is stamped only when its shared part really changes; one without a stamp gets a baseline
// at 0 (an older single 'settings' stamp counts for every unit), so a change in one unit never resets another and a
// PC that joins never beats the existing PC with settings nobody changed. The receiver turns a unit that wins into a
// settings.update patch (a known key the copy lacks becomes null), so the store checks and announces it like an edit.
// A PC that joins takes the existing PC's settings and keeps what only it had (at 0 the joiner merges, and an empty or
// null text there never clears a text it has; the merged copy then travels back as its change). API connections
// (`providers`) travel here; their keys are handles, the values go with the secrets; the security texts travel as files.
// Owns: the units, their stamps, what is kept for a newer version, and the patch. Never: writes settings.json itself
// or sends to a PC that is no 'ceo' link.

import type { RuntimeServices } from '../../contracts.ts';
import type { Settings, SettingsPatch } from '../../../shared/model/system.ts';
import { SECTIONS } from '../../settings/schema.ts';
import { isSettingsSection, unknownKeys } from '../../settings/validate.ts';
import { KvRepo } from '../../store/kv.ts';
import { hashOf, wins, type Stamp, type Stamps } from './stamps.ts';

/** The keys each section carries as one unit – what PCs since 0.3.13 send in it (frozen 22.11.2026: never changed). */
const BASE: Readonly<Record<string, readonly string[]>> = {
  profile: ['name', 'company', 'avatarFileId', 'language', 'timezone'],
  preferences: ['theme', 'enterSends', 'openAtLogin', 'autoDownloadUpdates'],
  notifications: ['enabled', 'sound', 'quietHours', 'pushFor'],
  voice: ['ttsVoice', 'vocabulary', 'realtime', 'talker', 'localStt', 'localTts'],
  routing: ['work', 'decision', 'voice', 'stt', 'tts', 'image', 'video', 'music', 'sound', 'embeddings', 'costMode', 'allowPaidFallback'],
  day: ['workStart', 'workEnd', 'bufferMin', 'planAt', 'aiHelps'],
  calendar: ['googleClientId', 'googleSecretId'],
  lifecycle: ['retention'],
  feedback: ['includeDiagnostics'],
  library: ['publish'],
  onboarding: ['completed', 'step'],
};

const PREFIX = 'settings/';
/** The single stamp of older versions (the whole file). */
const LEGACY = 'settings';
/** kv: what arrived that this PC does not know, by unit (`v`: a unit's value; `keys`: a section's keys it lacks). */
const KEPT = 'sync.settings';
const MAX_KEPT = 100;
const MAX_KEPT_CHARS = 64 * 1024;
const LOCAL_SECTIONS: ReadonlySet<string> = new Set(['devices', 'pwa', 'security', 'usage']); // usage (25.11.2026): each PC counts itself, with its own switch
const LAYOUT: ReadonlySet<string> = new Set(['sidebarOpen', 'sidebarWidth', 'workspaceOpen', 'workspaceWidth']);
const FREE: ReadonlySet<string> = new Set(SECTIONS.filter((section) => section.free).map((section) => section.key));
const KEYS: ReadonlyMap<string, readonly string[]> = new Map(SECTIONS.map((section) => [section.key, section.keys.map((key) => key.key)]));
/** A unit's name: 'section' or 'section.key'. */
const NAME = /^[a-z][A-Za-z0-9]{0,40}(\.[A-Za-z][A-Za-z0-9_]{0,60})?$/;

type Plain = Record<string, unknown>;
/** What is kept of one unit this PC does not know (`v`), or of one section the keys it does not know (`keys`). */
interface Kept { v?: unknown; keys?: Plain }
const plain = (value: unknown): value is Plain => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const setText = (value: unknown) => typeof value === 'string' && value !== '';
const layout = (section: string, key: string) => section === 'preferences' && LAYOUT.has(key);
const pick = (value: Plain, keys: readonly string[]): Plain => Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key)));
/** Whether a unit may travel at all (a newer PC's too): a plain name, not this PC's own. */
const travels = (name: string): boolean => NAME.test(name) && !LOCAL_SECTIONS.has(name.split('.')[0]) && !layout(name.split('.')[0], name.split('.')[1] ?? '');

/** The unit `name` is here: a section (its BASE keys, or a free section whole) or one key of a section; undefined: unknown here. */
function unitOf(name: string): { section: string; key?: string } | undefined {
  const [section, key, more] = name.split('.');
  if (more !== undefined || LOCAL_SECTIONS.has(section) || !isSettingsSection(section)) return undefined;
  if (key === undefined) return BASE[section] || FREE.has(section) ? { section } : undefined;
  return FREE.has(section) || BASE[section]?.includes(key) || layout(section, key) || !KEYS.get(section)?.includes(key) ? undefined : { section, key };
}

/** The part of the settings the CEO's PCs share, in units (with what is `kept` for a newer version, as it came). */
export function syncedSettings(settings: Settings, kept: ReadonlyMap<string, Kept> = new Map()): Plain {
  const out: Plain = {};
  for (const [section, value] of Object.entries(settings)) {
    if (LOCAL_SECTIONS.has(section) || value === undefined) continue;
    if (FREE.has(section) || !plain(value)) { out[section] = value; continue; }
    const base = BASE[section];
    if (base) out[section] = pick(value, base);
    for (const key of KEYS.get(section) ?? []) {
      if (!base?.includes(key) && !layout(section, key)) out[`${section}.${key}`] = value[key] ?? null; // a key that is gone travels as null (cleared)
    }
  }
  for (const [name, entry] of kept) {
    if (entry.keys) out[name] = { ...(plain(out[name]) ? out[name] : {}), ...entry.keys };
    else out[name] = entry.v ?? null;
  }
  return out;
}

/** Adds one section's patch part to `patch` (a unit and its section both write that section). */
function addPart(patch: Plain, section: string, part: Plain): void {
  patch[section] = plain(patch[section]) ? { ...patch[section], ...part } : part;
}

/**
 * What turns `local` into `incoming` for the store's deep merge: changed keys, null for keys `incoming` lacks;
 * `merge` (the first link): those stay, and an empty or null value never replaces a text that is set here.
 */
function diff(local: Plain, incoming: Plain, merge: boolean): Plain {
  const out: Plain = {};
  for (const key of new Set([...Object.keys(local), ...Object.keys(incoming)])) {
    const mine = local[key];
    const theirs = incoming[key];
    if (merge && (theirs === null || theirs === '') && setText(mine)) continue;
    if (theirs === undefined) { if (mine !== undefined && !merge) out[key] = null; continue; }
    if (JSON.stringify(mine) === JSON.stringify(theirs)) continue;
    out[key] = plain(mine) && plain(theirs) ? diff(mine, theirs, merge) : theirs;
  }
  return out;
}

/**
 * The settings.update patch that makes the units in `incoming` equal there (units unknown here and this PC's own left
 * out; a unit `incoming` does not name stays as it is); `merge` (the first link): what only this PC has and the texts
 * set here stay.
 */
export function settingsPatch(local: Settings, incoming: Plain, merge = false): SettingsPatch {
  const mine = syncedSettings(local);
  const patch: Plain = {};
  for (const [name, theirs] of Object.entries(incoming)) {
    const unit = unitOf(name);
    if (!unit) continue;
    if (unit.key) {
      if (merge && (theirs === null || theirs === undefined || theirs === '') && setText(mine[name])) continue;
      if (JSON.stringify(mine[name]) !== JSON.stringify(theirs)) addPart(patch, unit.section, { [unit.key]: theirs ?? null });
      continue;
    }
    const change = diff(plain(mine[name]) ? mine[name] : {}, plain(theirs) ? theirs : {}, merge);
    for (const key of unknownKeys(name, change)) delete change[key]; // a key this PC does not know stays kept (receive)
    if (Object.keys(change).length) addPart(patch, name, change);
  }
  return patch as SettingsPatch;
}

/** One unit as it travels. */
export interface SectionCopy { at: number; h: string; value: unknown }
export interface SettingsMessage { sections: Record<string, SectionCopy> }

const validCopy = (copy: unknown): copy is SectionCopy => plain(copy) && typeof copy.at === 'number' && typeof copy.h === 'string';

export class SettingsSync {
  private readonly s: RuntimeServices;
  private readonly stamps: Stamps;
  private readonly kv: KvRepo;
  /** Sends stamped units to the CEO PCs (files.ts), `except` the one they came from. */
  private readonly send: (message: SettingsMessage, except?: string) => void;

  constructor(s: RuntimeServices, stamps: Stamps, send: (message: SettingsMessage, except?: string) => void) {
    this.s = s;
    this.stamps = stamps;
    this.kv = new KvRepo(s.db);
    this.send = send;
  }

  /** Takes in what was kept and is known now, stamps what changed while no PC was linked (or baselines), then listens. */
  attach(): () => void {
    this.adopt();
    this.changed();
    return this.s.bus.on('settings.updated', () => this.changed());
  }

  private kept(): Map<string, Kept> {
    return new Map(this.kv.list<Kept>(KEPT, '').map(({ key, value }) => [key, value]));
  }

  private keep(name: string, entry: Kept | undefined): void {
    if (entry) this.kv.set(KEPT, name, entry, this.s.clock.now());
    else this.kv.delete(KEPT, name);
  }

  /** What was kept and this PC knows now (a later version) moves into settings.json; the rest stays kept. */
  private adopt(): void {
    const settings = this.s.settings.get();
    const patch: Plain = {};
    const done = new Map<string, Kept | undefined>();
    for (const [name, entry] of this.kept()) {
      if (entry.keys) {
        const known = Object.keys(entry.keys).filter((key) => unitOf(name) && !unknownKeys(name, { [key]: true }).length);
        if (!known.length) continue;
        addPart(patch, name, pick(entry.keys, known));
        const rest = Object.fromEntries(Object.entries(entry.keys).filter(([key]) => !known.includes(key)));
        done.set(name, Object.keys(rest).length ? { keys: rest } : undefined);
      } else if (unitOf(name)) {
        for (const [section, part] of Object.entries(settingsPatch(settings, { [name]: entry.v ?? null }) as Plain)) addPart(patch, section, part as Plain);
        done.set(name, undefined);
      }
    }
    if (!done.size) return;
    try {
      if (Object.keys(patch).length) this.s.settings.update(patch as SettingsPatch);
      for (const [name, entry] of done) this.keep(name, entry);
    } catch (error) {
      this.s.log.warn('kept settings not taken', { units: [...done.keys()], error: String((error as Error)?.message ?? error) }); // they stay kept and travel as they are
    }
  }

  /** A unit's stamp here: its own, else the older single stamp's time with its current hash. */
  private stampOf(name: string, value: unknown): Stamp | undefined {
    const own = this.stamps.get(PREFIX + name);
    if (own) return own;
    const legacy = this.stamps.get(LEGACY);
    return legacy ? { at: legacy.at, h: hashOf(value) } : undefined;
  }

  /** Stamps and sends each unit whose shared part changed since its stamp; a unit without one gets its baseline. */
  private changed(): void {
    try {
      const shared = syncedSettings(this.s.settings.get(), this.kept());
      const sections: Record<string, SectionCopy> = {};
      for (const [name, value] of Object.entries(shared)) {
        const h = hashOf(value);
        const old = this.stampOf(name, value);
        if (!old) { this.stamps.set(PREFIX + name, { at: 0, h }); continue; } // nothing changed since the link
        if (old.h === h) { if (!this.stamps.get(PREFIX + name)) this.stamps.set(PREFIX + name, old); continue; }
        const stamp = this.stamps.next(old, h);
        this.stamps.set(PREFIX + name, stamp);
        sections[name] = { at: stamp.at, h, value };
      }
      if (this.stamps.get(LEGACY)) this.stamps.drop(LEGACY); // every unit has its own stamp now
      if (Object.keys(sections).length) this.send({ sections });
    } catch (error) {
      this.s.log.warn('settings change not synced', { error: String((error as Error)?.message ?? error) });
    }
  }

  /** Every unit for a catch-up (at 0 when it never changed since the link), what is kept included. */
  current(): SettingsMessage {
    const sections: Record<string, SectionCopy> = {};
    for (const [name, value] of Object.entries(syncedSettings(this.s.settings.get(), this.kept()))) {
      sections[name] = { at: this.stampOf(name, value)?.at ?? 0, h: hashOf(value), value };
    }
    return { sections };
  }

  /** Units from a CEO PC: each one that wins is applied (or kept, when this PC does not know it), then passed on. `joined`: this PC joined the sender. */
  receive(message: SettingsMessage, from: string, joined: boolean): void {
    if (!plain(message?.sections)) return;
    const kept = this.kept();
    const shared = syncedSettings(this.s.settings.get(), kept);
    const room = (name: string, copy: SectionCopy) => Boolean(unitOf(name)) || ((kept.has(name) || kept.size < MAX_KEPT) && JSON.stringify(copy.value ?? null).length <= MAX_KEPT_CHARS);
    const won: Record<string, SectionCopy> = {};
    for (const [name, copy] of Object.entries(message.sections)) {
      if (!validCopy(copy) || !travels(name) || !room(name, copy)) continue;
      // A unit this PC never had is taken as it comes (also a joiner's at 0).
      const local = this.stampOf(name, shared[name]) ?? (shared[name] === undefined ? undefined : { at: 0, h: hashOf(shared[name]) });
      if (local?.h !== copy.h && wins({ at: copy.at, h: copy.h }, local, joined)) won[name] = copy;
    }
    const names = Object.keys(won);
    if (!names.length) return;
    const before = new Map(names.map((name) => [name, { stamp: this.stamps.get(PREFIX + name), kept: kept.get(name) }]));
    // First the stamps and what is kept: the store's settings.updated then finds a change only where this PC keeps something.
    for (const name of names) this.stamps.set(PREFIX + name, { at: won[name].at, h: won[name].h });
    try {
      const patch: Plain = {};
      for (const name of names) {
        const { value, at } = won[name];
        const unit = unitOf(name);
        if (!unit) { this.keep(name, { v: value ?? null }); continue; } // a newer version's unit: kept as it came
        if (!unit.key && !FREE.has(name) && plain(value)) {
          const lacked = pick(value, unknownKeys(name, value)); // a section's keys this PC does not know: kept with it
          this.keep(name, Object.keys(lacked).length ? { keys: lacked } : undefined);
        }
        // At the first link (both at 0) the joiner merges: what only it had and its texts stay and go back as its own change.
        for (const [section, part] of Object.entries(settingsPatch(this.s.settings.get(), { [name]: value }, at === 0) as Plain)) addPart(patch, section, part as Plain);
      }
      if (Object.keys(patch).length) this.s.settings.update(patch as SettingsPatch);
    } catch (error) {
      for (const [name, { stamp, kept: entry }] of before) {
        if (stamp) this.stamps.set(PREFIX + name, stamp); else this.stamps.drop(PREFIX + name);
        this.keep(name, entry);
      }
      throw error;
    }
    this.changed(); // what a joiner kept at the merge travels back, also when nothing else changed here
    this.send({ sections: won }, from);
  }
}
