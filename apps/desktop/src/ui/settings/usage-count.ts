// The anonymous usage count's words (owner 25.11.2026), one place for Settings › Security's switch and the first run's tick
// (README › What Autark counts says the same in full; runtime/usage/service.ts is what it does).
// Owns: the texts and what the first run writes. Never: renders or calls the runtime.

import type { Settings } from '../../shared/model/system.ts';

export const USAGE_TITLE = 'Anonymous usage count';
/** Under the switch and next to the tick: exactly what goes out. */
export const USAGE_TEXT = 'When this PC is used, it adds 1 to a counter of ours, at most once an hour. Only the platform and the hour are sent – no ID, no version, no content – and we store no IP address. Off: nothing is sent.';
/** The Settings group's one-line hint. */
export const USAGE_HINT = 'Tells us when Autark is used, so we know our busy hours; it cannot tell us who you are';

/** Whether the count is on: the stored switch, on where a settings file has none yet. */
export const usageOn = (settings: Pick<Settings, 'usage'> | null | undefined): boolean => settings?.usage?.count !== false;

/** The first run's tick: only what changed is written (left ticked on a new PC nothing is, unticked it is `count: false`). */
export function usagePatch(current: Settings['usage'] | undefined, on: boolean): { count: boolean } | undefined {
  return on === (current?.count !== false) ? undefined : { count: on };
}
