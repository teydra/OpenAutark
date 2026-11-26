// Each opted-in company has a Windows task (launcher-windows.ts). If one is missing, another
// company's launcher can still recover it at sign-in. Children run the same launch decision but do
// not fan out again; Electron's per-company lock arbitrates simultaneous launcher starts.
// Owns: election of opted-in sibling profiles after a Windows reboot. Never: runs their runtimes directly.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { stripJsonc } from '../shared/jsonc.ts';
import { companyArgs, remainingCompanies, spawnApp } from './companies.ts';
import { BACKGROUND_FLAG, LAUNCHER_FLAG, readRunState } from './launcher.ts';

export const LAUNCHER_PEER_FLAG = '--launcher-peer';

function optedInToLogin(dataDir: string): boolean {
  try {
    const settings = JSON.parse(stripJsonc(readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).trim());
    return settings?.preferences?.openAtLogin === true;
  } catch {
    return false;
  }
}

/** Whether the task's own profile may start, after attempting sibling recovery once. */
export function launchWindowsCompanies(input: {
  companies: { first: string; dir: string } | null; // null for WORKFORCE_TEST_DATA
  current: string | null | undefined;
  dataDir: string;
  bootAt: number;
  peer?: boolean;
  start?: (args: string[]) => void;
}): boolean {
  const { companies, current, bootAt, start = spawnApp } = input;
  if (!companies) return false;
  if (!input.peer) launchOptedInSiblings(companies, current, bootAt, start);
  return current !== undefined && optedInToLogin(input.dataDir);
}

function launchOptedInSiblings(
  companies: { first: string; dir: string },
  current: string | null | undefined,
  bootAt: number,
  start: (args: string[]) => void,
): void {
  for (const id of remainingCompanies(companies)) {
    if (id === current) continue;
    const dir = id === null ? companies.first : path.join(companies.dir, id);
    const previous = readRunState(dir);
    // Do not turn another company's same-boot crash or deliberate quit into a restart.
    if ((previous && previous.at >= bootAt) || !optedInToLogin(dir)) continue;
    try { start([BACKGROUND_FLAG, LAUNCHER_FLAG, LAUNCHER_PEER_FLAG, ...companyArgs(id)]); }
    catch { /* a failed spawn does not stop the other companies */ }
  }
}
