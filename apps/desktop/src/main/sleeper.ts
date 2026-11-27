// Sicher-Runde 19.11.2026: main's side of the wake helper (runtime/devices/sleeper.ts) – when it starts and how. It starts
// after the person's own quit when the runtime said a wake is possible (devices.bye answered `sleeper: true`: the meeting
// server is set and an own PC is linked, <data>/wake.json written), and at a launcher start that stays quit (the
// person had quit) while that file is there. It is this same Autark.exe as Node (ELECTRON_RUN_AS_NODE) with
// app/sleeper.mjs (app.asar.unpacked when packaged) – Smart App Control blocks new unsigned executables, so it is no new
// program – detached, hidden, no window; it gets the app's own start arguments (another company's --company=<id>).
// 0.3.22: on Windows the slim native AutarkWakeHelper.exe (resources/broker/WakeHelper.cs, under 20 MB) is started instead when it is
// there; the Node helper above is the fallback (missing file, no start). Mac and Linux keep the Node helper (launchd / systemd --user).
// Owns: that decision and the spawn. Never: imports electron, starts the helper while the app runs, or reads the key file.

import { spawn as spawnChild } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AwayReason } from '../shared/model/devices.ts';
import type { QuitBy } from '../shared/model/launch.ts';
import type { LaunchDecision, LaunchSource } from './launcher.ts';

export const SLEEPER_SCRIPT = 'sleeper.mjs';
/** The file the runtime writes for the helper (runtime/devices/wake-sign.ts WAKE_FILE). */
export const WAKE_FILE = 'wake.json';

/** After the quit: only the person's own quit, and only when the runtime wrote the helper's file. */
export function sleeperAtQuit(by: QuitBy | undefined, bye: { sleeper?: boolean } | undefined): boolean {
  return by === 'person' && bye?.sleeper === true;
}

/** At a launcher start (sign-in, due work) that stays quit because the person had quit, with the helper's file there. */
export function sleeperAtLaunch(decision: Pick<LaunchDecision, 'start' | 'reason'>, source: LaunchSource, wakeFile: boolean): boolean {
  return source !== 'person' && !decision.start && decision.reason === 'quit' && wakeFile;
}

/** app/sleeper.mjs beside main.cjs (`appDir`: main's own folder), unpacked from the asar archive; undefined in a build without it. */
export function sleeperScript(appDir: string, exists: (file: string) => boolean = existsSync): string | undefined {
  const file = path.join(appDir, SLEEPER_SCRIPT).replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  return exists(file) ? file : undefined;
}

export const WAKE_HELPER = 'AutarkWakeHelper.exe';

/**
 * 0.3.22 (Windows only): the slim native wake helper (resources/broker/WakeHelper.cs, ~15 MB idle instead of the Node helper's 113 MB),
 * unpacked beside the broker; undefined on Mac and Linux (they keep the Node helper: launchd / systemd --user) and in a build without it.
 * `root`: the app's root (app.asar), the same as broker-setup.ts.
 */
export function wakeHelperExe(root: string, platform: string = process.platform, exists: (file: string) => boolean = existsSync): string | undefined {
  if (platform !== 'win32') return undefined;
  const file = path.win32.join(root, 'resources', 'broker', WAKE_HELPER).replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  return exists(file) ? file : undefined;
}

export interface SleeperStart {
  exe: string; // process.execPath
  script: string | undefined;
  /** The native helper (wakeHelperExe), Windows only: tried first; the Node helper (exe + script) when it is absent or does not start. */
  helper?: string | undefined;
  dataDir: string;
  /** The app's own start arguments (another company's --company=<id>). */
  args: readonly string[];
  spawn?: typeof spawnChild;
  exists?(file: string): boolean;
  log?(line: string): void;
}

/** desktop.ts's part of the quit order (shutdown.ts QuitActions): who quit, the goodbye over main's link, the helper's start. */
export function quitWake(input: { by: QuitBy | undefined; call(method: 'devices.bye', params: { reason: AwayReason }): Promise<{ sleeper: boolean }>; start: SleeperStart }) {
  return {
    by: input.by,
    bye: () => input.call('devices.bye', { reason: input.by === 'system' ? 'session-end' : 'quit' }),
    startSleeper: () => startSleeper(input.start),
  };
}

/** Starts the helper detached; false when the build or the data folder has no helper. Never throws. */
export function startSleeper(input: SleeperStart): boolean {
  const wakeFile = path.join(input.dataDir, WAKE_FILE);
  if ((!input.script && !input.helper) || !(input.exists ?? existsSync)(wakeFile)) return false;
  if (input.helper && startNative(input, input.helper, wakeFile)) return true;
  return input.script ? startNode(input, input.script, wakeFile) : false;
}

/** The native helper: `<helper> <wake.json> --app <Autark.exe> -- <the app's arguments>`, no ELECTRON_RUN_AS_NODE; it starts the app itself on a wake. */
function startNative(input: SleeperStart, helper: string, wakeFile: string): boolean {
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    // memory: a plain GC and a 1 MB youngest generation (hex) – about 4 MB less private memory (the helper removes both again from the app it starts; the broker sets the same pair)
    env.COMPlus_gcConcurrent = '0';
    env.COMPlus_GCgen0size = '100000';
    const child = (input.spawn ?? spawnChild)(helper, [wakeFile, '--app', input.exe, '--', ...input.args], { detached: true, stdio: 'ignore', windowsHide: true, env });
    child.on('error', (error) => {
      input.log?.(`native wake helper did not start: ${error.message}`);
      if (input.script) startNode(input, input.script, wakeFile); // refused or damaged: the Node helper takes over
    });
    child.unref();
    input.log?.('native wake helper started');
    return true;
  } catch (error) {
    input.log?.(`native wake helper did not start: ${(error as Error)?.message ?? 'error'}`);
    return false;
  }
}

function startNode(input: SleeperStart, script: string, wakeFile: string): boolean {
  try {
    const child = (input.spawn ?? spawnChild)(input.exe, [script, wakeFile, '--', ...input.args], {
      detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.on('error', (error) => input.log?.(`wake helper did not start: ${error.message}`));
    child.unref();
    input.log?.('wake helper started');
    return true;
  } catch (error) {
    input.log?.(`wake helper did not start: ${(error as Error)?.message ?? 'error'}`);
    return false;
  }
}
