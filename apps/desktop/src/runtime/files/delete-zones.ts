// Where a delete must not reach (task_7ja3mcr6, after 24.11. and 27.11.2026: an unquoted `cmd /c rd /s /q` under
// "…\Autark Companies\…" split at its space and deleted "…\Roaming\Autark", the first company's data folder). One rule for
// files.delete (tools/builtin/files-delete.ts) and the shell guard of shell.exec (shell-deletes.ts):
//   - kept folders: every company's data folder, the folder of the other companies with this PC's plan logins, the app's
//     installation and resources (packaged builds), the person's browser profiles. Neither such a folder, nor a folder that
//     holds one (an ancestor: AppData, the home folder, a drive), nor anything inside it may go;
//   - open folders: the workspaces and scratch folders, some inside a kept one (<data>/workspace, <data>/tmp) – what lies
//     inside them may go, the folder itself stays; a workspace's whole contents at once (a wildcard at its top) do not;
//   - the innermost zone decides (an open folder inside a kept one opens only its own inside);
//   - a filesystem root never goes.
// A path is compared as resolved (`..` folded) and, where it exists, as its real path too (links followed), case-folded on
// Windows and macOS. Ordered paths with links on the way are files.delete's own check (linkOnWay).
// Owns: the zones, the rule and the data-folder marks. Never: deletes, reads a file's contents, throws on a missing folder.

import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Zone { dir: string; what: string }
export interface OpenZone extends Zone { /** Its whole contents at once may go (a scratch folder), not only one entry at a time. */ bulk: boolean }

export interface DeleteZones {
  platform: NodeJS.Platform;
  kept: Zone[];
  open: OpenZone[];
  /** Folders a path may reach through a link above them (macOS /var → /private/var above the temp folder, a linked workspace). */
  linkedOk: string[];
}

export interface ZoneInput {
  platform?: NodeJS.Platform;
  data?: string;
  workspace?: string;
  temp?: string;
  accounts?: string;
  companies?: { first: string; dir: string };
  app?: { packaged?: boolean; executable?: string; resourcesDir?: string };
  home?: string;
  env?: NodeJS.ProcessEnv;
  tmp?: string;
}

/** Files that mark a folder as data wherever it lies: a company (a copy or backup too), a Chromium or Firefox profile root. */
export const DATA_MARKS: readonly string[] = ['workforce.db', 'Local State', 'profiles.ini'];

export const pathOf = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);
const folds = (platform: NodeJS.Platform) => platform === 'win32' || platform === 'darwin';

/** `target` as compared: resolved, case-folded where the file system ignores case. */
function key(platform: NodeJS.Platform, target: string): string {
  const resolved = pathOf(platform).resolve(target);
  return folds(platform) ? resolved.toLowerCase() : resolved;
}

/** True when `target` lies strictly inside `root`. */
export function within(platform: NodeJS.Platform, root: string, target: string): boolean {
  const m = pathOf(platform);
  const rel = m.relative(key(platform, root), key(platform, target));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${m.sep}`) && !m.isAbsolute(rel);
}

export function samePath(platform: NodeJS.Platform, a: string, b: string): boolean {
  return key(platform, a) === key(platform, b);
}

/** The person's browser profile folders on this platform (whether they exist or not). */
export function browserProfiles(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): Zone[] {
  const m = pathOf(platform);
  const zone = (dir: string, name: string): Zone => ({ dir, what: `the person's ${name} profile data` });
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || m.join(home, 'AppData', 'Local');
    const roaming = env.APPDATA || m.join(home, 'AppData', 'Roaming');
    return [
      zone(m.join(local, 'Google', 'Chrome', 'User Data'), 'Chrome'), zone(m.join(local, 'Microsoft', 'Edge', 'User Data'), 'Edge'),
      zone(m.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'), 'Brave'), zone(m.join(local, 'Chromium', 'User Data'), 'Chromium'),
      zone(m.join(local, 'Vivaldi', 'User Data'), 'Vivaldi'), zone(m.join(roaming, 'Opera Software'), 'Opera'), zone(m.join(roaming, 'Mozilla', 'Firefox'), 'Firefox'),
    ];
  }
  if (platform === 'darwin') {
    const support = m.join(home, 'Library', 'Application Support');
    return [
      zone(m.join(support, 'Google', 'Chrome'), 'Chrome'), zone(m.join(support, 'Microsoft Edge'), 'Edge'), zone(m.join(support, 'BraveSoftware', 'Brave-Browser'), 'Brave'),
      zone(m.join(support, 'Chromium'), 'Chromium'), zone(m.join(support, 'Firefox'), 'Firefox'), zone(m.join(home, 'Library', 'Safari'), 'Safari'),
    ];
  }
  const config = env.XDG_CONFIG_HOME || m.join(home, '.config');
  return [
    zone(m.join(config, 'google-chrome'), 'Chrome'), zone(m.join(config, 'microsoft-edge'), 'Edge'), zone(m.join(config, 'BraveSoftware', 'Brave-Browser'), 'Brave'),
    zone(m.join(config, 'chromium'), 'Chromium'), zone(m.join(home, '.mozilla'), 'Firefox'),
  ];
}

/** The app's installation folder of a packaged build: the .app bundle on macOS, else the executable's folder. */
function installDir(platform: NodeJS.Platform, executable: string): string {
  const m = pathOf(platform);
  if (platform === 'darwin') {
    const at = executable.toLowerCase().lastIndexOf('.app/');
    if (at > 0) return executable.slice(0, at + 4);
  }
  return m.dirname(executable);
}

const subfolders = (dir: string): string[] => {
  try { return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { return []; }
};

/** The zones of this PC for one company (what the runtime knows of itself; a missing piece is left out). */
export function deleteZones(input: ZoneInput): DeleteZones {
  const platform = input.platform ?? process.platform;
  const m = pathOf(platform);
  const home = input.home ?? os.homedir();
  const env = input.env ?? process.env;
  const kept: Zone[] = [];
  const open: OpenZone[] = [];
  const keep = (dir: string | undefined, what: string) => { if (dir) kept.push({ dir: m.resolve(dir), what }); };
  const opening = (dir: string | undefined, what: string, bulk: boolean) => { if (dir) open.push({ dir: m.resolve(dir), what, bulk }); };
  keep(input.data, "this company's data folder");
  if (input.companies) {
    keep(input.companies.first, "the first company's data folder");
    keep(input.companies.dir, "the folder of this PC's other companies and their plan logins");
    opening(m.join(input.companies.first, 'tmp'), "the first company's scratch folder", true);
    for (const id of subfolders(input.companies.dir)) {
      opening(m.join(input.companies.dir, id, 'workspace'), `the workspace of company ${id}`, false);
      opening(m.join(input.companies.dir, id, 'tmp'), `the scratch folder of company ${id}`, true);
    }
  }
  keep(input.accounts, "this PC's plan logins");
  if (input.app?.packaged && input.app.executable) keep(installDir(platform, input.app.executable), "the app's installation");
  if (input.app?.packaged && input.app.resourcesDir) keep(input.app.resourcesDir, "the app's resources");
  kept.push(...browserProfiles(platform, home, env));
  opening(input.workspace, "this company's workspace", false);
  opening(input.temp, "this company's scratch folder", true);
  opening(m.join(home, 'Workforce'), "the first company's workspace", false);
  opening(home, "the person's home folder", false);
  const tmp = input.tmp ?? os.tmpdir();
  return { platform, kept, open, linkedOk: [home, tmp, input.workspace, input.data].filter((dir): dir is string => Boolean(dir)) };
}

/**
 * Why `target` must not go – undefined when it may. `contents`: what lies inside `target` goes, `target` stays (a wildcard
 * or `del /s`): the folder's own contents at once.
 */
export function zoneRefusal(target: string, zones: DeleteZones, contents = false): string | undefined {
  const { platform } = zones;
  const m = pathOf(platform);
  const full = m.resolve(target);
  if (m.dirname(full) === full) return `${full} is the root of a drive or file system`;
  const is = zones.kept.find((zone) => samePath(platform, zone.dir, full));
  if (is) return `${full} is ${is.what}`;
  const holds = zones.kept.find((zone) => within(platform, full, zone.dir));
  if (holds) return `${full} holds ${holds.what} (${holds.dir})`;
  for (const zone of zones.open) {
    if (samePath(platform, zone.dir, full) && !(contents && zone.bulk)) return contents ? `${full} is ${zone.what}: its whole contents at once do not go, one entry at a time does` : `${full} is ${zone.what} itself: what lies inside it can go, the folder stays`;
    if (within(platform, full, zone.dir)) return `${full} holds ${zone.what} (${zone.dir})`;
  }
  // the innermost zone around the target decides: kept, or an open folder (inside a kept one or not)
  const around = [...zones.kept.map((zone) => ({ ...zone, kept: true })), ...zones.open.map((zone) => ({ ...zone, kept: false }))]
    .filter((zone) => within(platform, zone.dir, full) || (contents && samePath(platform, zone.dir, full)))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
  if (around?.kept) return `${full} lies inside ${around.what} (${around.dir})`;
  return undefined;
}

/** The real path of `target` as far as it exists (links followed), plus the parts that do not exist yet. */
export function realExisting(target: string): string {
  const rest: string[] = [];
  let probe = path.resolve(target);
  for (;;) {
    try { return path.join(realpathSync.native(probe), ...rest); } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return path.resolve(target);
      rest.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

/** zoneRefusal of the path as written and, on this platform, of its real path (a link inside the workspace may point into a kept folder). */
export function refusalOf(target: string, zones: DeleteZones, contents = false): string | undefined {
  const written = zoneRefusal(target, zones, contents);
  if (written || zones.platform !== process.platform) return written;
  const real = realExisting(target);
  if (samePath(zones.platform, real, target)) return undefined;
  const why = zoneRefusal(real, zones, contents);
  return why ? `${target} leads through a link to ${real}: ${why}` : undefined;
}

/** The first link (symlink or junction) on the way to `target` – its parent folders, not `target` itself – that no allowed folder explains. */
export function linkOnWay(target: string, zones: DeleteZones): string | undefined {
  const m = pathOf(zones.platform);
  const full = m.resolve(target);
  const chain: string[] = [];
  for (let dir = m.dirname(full); ; dir = m.dirname(dir)) {
    chain.unshift(dir);
    if (m.dirname(dir) === dir) break;
  }
  for (const dir of chain) {
    let link = false;
    try { link = lstatSync(dir).isSymbolicLink(); } catch { return undefined; } // a missing folder: the target's own check answers
    if (link && !zones.linkedOk.some((ok) => samePath(zones.platform, ok, dir) || within(zones.platform, dir, ok))) return dir;
  }
  return undefined;
}
