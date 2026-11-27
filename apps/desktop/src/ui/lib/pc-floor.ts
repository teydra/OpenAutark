// The one rule between this interface and a PC (owner 27.11.2026: the phone app carries its own interface, so the two
// versions part; "no extra logic for people on an old version – then they simply update"): the interface names the
// oldest Autark it works with, OLDEST_PC. A PC's socket says its version first (lib/rpc.ts asks system.info before
// anything else); an older PC gets nothing more from this page, and the quiet state says "Update Autark on <PC>"
// (shell/connection-line.ts). Raised in the same change that makes the interface need something newer of the PC.
// Owns: the constant and the check. Never: guesses around a missing method, or asks anything itself.

import { compareAppVersions } from '../../shared/model/devices.ts';

/** The oldest PC version this interface works with: the release whose methods it calls (v0.3.21). */
export const OLDEST_PC = '0.3.21';

/** True when a PC that names `version` is at least OLDEST_PC; anything unreadable is not. */
export function pcFits(version: unknown, oldest: string = OLDEST_PC): boolean {
  return typeof version === 'string' && /^v?\d+\.\d+\.\d+/.test(version.trim()) && compareAppVersions(version, oldest) >= 0;
}
