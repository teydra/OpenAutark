// 0.3.19 (23.11.2026, owner: "da sollte doch eigentlich so ein Teil noch im Hintergrund laufen … das einfach nur hört, ob
// das Ding wieder angeschaltet werden muss – anhand von Cron-Job oder Handyweckung", and switchable): main's half of the
// waker on Windows. While "Wake while closed" (devices.wakeHelper, absent = on) is on, the installed app keeps one
// registration file per data folder at <Local AppData>\AutarkDesktopBroker\wakers\<key>.json (shared/model/launch.ts
// WakerRegistration); the desktop broker service (resources/broker/Waker.cs) reads it and, whenever neither this app nor
// a wake helper runs, starts the helper – as the person, in their session – so Wake and due work reach a closed app, also
// after Task Manager ended it. Off (or another platform, a dev run, test mode) removes the file. Without the broker
// nothing reads it: then the helper starts only after the person's own quit, as before (main/sleeper.ts).
// Owns: that file. Never: starts the helper or the app itself, or writes outside that folder.

import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WAKER_DIR, type WakerRegistration } from '../shared/model/launch.ts';

export interface WakerDeps {
  platform: string;
  packaged: boolean;
  testMode: boolean;
  localAppData: string | undefined; // process.env.LOCALAPPDATA
  exe: string;
  script: string | undefined; // main/sleeper.ts sleeperScript
  helper?: string | undefined; // main/sleeper.ts wakeHelperExe: the slim native helper, when this build has it
  dataDir: string;
  args: readonly string[];
  log?(line: string): void;
}

/** The registration's file: one per data folder (its path, case-insensitive on Windows). */
export function wakerFile(localAppData: string, dataDir: string): string {
  const key = createHash('sha256').update(path.win32.resolve(dataDir).toLowerCase()).digest('hex').slice(0, 16);
  return path.win32.join(localAppData, ...WAKER_DIR, `${key}.json`);
}

export function wakerRegistration(deps: Pick<WakerDeps, 'exe' | 'dataDir' | 'args' | 'helper'> & { script: string }): WakerRegistration {
  return { v: 1, exe: deps.exe, script: deps.script, data: deps.dataDir, args: [...deps.args], ...(deps.helper ? { helper: deps.helper } : {}) };
}

/** Writes (on) or removes (off) the registration; nothing outside the installed Windows app. Never throws. */
export async function applyWaker(enabled: boolean, deps: WakerDeps): Promise<'written' | 'removed' | 'skipped'> {
  if (deps.platform !== 'win32' || !deps.packaged || deps.testMode || !deps.localAppData) return 'skipped';
  const file = wakerFile(deps.localAppData, deps.dataDir);
  try {
    if (!enabled || !deps.script) {
      await rm(file, { force: true });
      return 'removed';
    }
    await mkdir(path.win32.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(wakerRegistration({ ...deps, script: deps.script }))}\n`, 'utf8');
    await rename(temp, file);
    return 'written';
  } catch (error) {
    deps.log?.(`waker registration not ${enabled ? 'written' : 'removed'}: ${(error as Error)?.message ?? 'error'}`);
    return 'skipped';
  }
}
