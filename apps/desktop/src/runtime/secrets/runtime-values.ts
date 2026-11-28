// 28.11.2026 (three diagnostic steps of agents printed `Get-Content …\runtime.json`: the owner token of the running runtime
// went to the model provider, the run journal and the engine transcript): Autark's own access values are masked like stored
// secrets, by the one redactor every tool output, journal preview and chat line already passes (SecretVault.redact → Redactor):
//  - the launch token of this runtime (known at start) and the owner token in every company's <data>/runtime.json on this PC,
//  - the wake helper's private key (wake.json `key.pkcs8`) of every company on this PC.
// The mark is "‹secret:runtime-token›" / "‹secret:wake-key›" – in the style of the key-shape marks (redact.ts keyMark), no
// `secret://` handle (nothing can resolve it). runtime.json and wake.json stay as they are: the wf CLI, the app and the wake
// helper read them as before; only what leaves through a tool, a journal row or a chat is masked.
// Other companies' files change at each start of that company: the files are looked at again at most once per INTERVAL_MS
// (a stat per file; a changed file is read once) – never per redact call. A value stays masked after its file changed
// (the last KEPT values per file), because an old one may still stand in a transcript or a note.
// Owns: which files hold such values and the refresh. Never: writes or deletes a file, logs or returns a value, throws.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { isCompanyId, RUNTIME_FILE } from '../../shared/model/companies.ts';
import type { Redactor } from './redact.ts';

/** What stands where an owner token was. */
export const RUNTIME_TOKEN_MARK = '‹secret:runtime-token›';
/** What stands where a wake helper's private key was. */
export const WAKE_KEY_MARK = '‹secret:wake-key›';

const WAKE_FILE = 'wake.json'; // devices/wake-sign.ts WAKE_FILE (kept here: secrets/ does not import devices/)
/** Re-check the files at most this often. */
export const INTERVAL_MS = 1_000;
/** Values kept masked per file: the current one and the ones before it. */
export const KEPT = 3;
const MAX_FILE_BYTES = 64 * 1024;

export interface RuntimeValuesOptions {
  /** This company's data folder. */
  dataDir: string;
  /** The first company's folder and the parent of the others ("<first> Companies"), when this PC has several (AppInfo.companies). */
  companies?: { first: string; dir: string };
  now: () => number;
  intervalMs?: number;
}

type Kind = 'runtime' | 'wake';

interface Watched { stamp?: string; ids: Array<{ id: string; value: string }> } // newest first

/** The value a file holds that must not be printed; undefined: the file has none; null: not readable JSON (maybe half written). */
function valueOf(kind: Kind, text: string): string | undefined | null {
  try {
    const json = JSON.parse(text) as { token?: unknown; key?: { pkcs8?: unknown } } | null;
    const value = kind === 'runtime' ? json?.token : json?.key?.pkcs8;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return null;
  }
}

export class RuntimeValues {
  private readonly watched = new Map<string, Watched>(); // file → what was seen
  private checkedAt = Number.NEGATIVE_INFINITY;
  private serial = 0;

  private readonly redactor: Redactor;
  private readonly options: RuntimeValuesOptions;

  constructor(redactor: Redactor, options: RuntimeValuesOptions) {
    this.redactor = redactor;
    this.options = options;
  }

  /** This runtime's own owner token, known at start (options.launchToken); it is also in <data>/runtime.json once the server listens. */
  learnLaunchToken(token: string | undefined): void {
    if (token) this.redactor.setMarked('runtime:launch', token, RUNTIME_TOKEN_MARK);
  }

  /** Looks at the files again unless that happened less than INTERVAL_MS ago (`force`: now). Never throws. */
  refresh(force = false): void {
    try {
      const now = this.options.now();
      if (!force && now >= this.checkedAt && now - this.checkedAt < (this.options.intervalMs ?? INTERVAL_MS)) return;
      this.checkedAt = now;
      for (const dir of this.folders()) {
        this.look(path.join(dir, RUNTIME_FILE), 'runtime');
        this.look(path.join(dir, WAKE_FILE), 'wake');
      }
    } catch { /* masking what it can; the next call looks again */ }
  }

  /** This company's folder, the first company's and every other company's on this PC. */
  private folders(): string[] {
    const all = [this.options.dataDir];
    const info = this.options.companies;
    if (info) {
      all.push(info.first);
      try {
        for (const item of readdirSync(info.dir, { withFileTypes: true })) if (item.isDirectory() && isCompanyId(item.name)) all.push(path.join(info.dir, item.name));
      } catch { /* no other company yet */ }
    }
    const seen = new Set<string>();
    return all.filter((dir) => { const key = path.resolve(dir).toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
  }

  private look(file: string, kind: Kind): void {
    let stamp: string;
    try {
      const info = statSync(file);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) return;
      stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
    } catch {
      return; // no such file (the company does not run, wake is off): what was learnt stays masked
    }
    const entry = this.watched.get(file) ?? { ids: [] };
    if (entry.stamp === stamp) return;
    let value: string | undefined | null;
    try { value = valueOf(kind, readFileSync(file, 'utf8')); } catch { return; }
    if (value === null) return; // half written: no stamp, so the next refresh reads it again
    entry.stamp = stamp;
    this.watched.set(file, entry);
    if (!value || entry.ids.some((known) => known.value === value)) return;
    const id = `runtime:${++this.serial}`;
    entry.ids.unshift({ id, value });
    for (const old of entry.ids.splice(KEPT)) this.redactor.remove(old.id);
    this.redactor.setMarked(id, value, kind === 'runtime' ? RUNTIME_TOKEN_MARK : WAKE_KEY_MARK);
  }
}
