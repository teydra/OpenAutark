// settings.json's Models section (key "routing"): the check of its values after a merge (runtime/settings/validate.ts).
// A use is "auto", a model id "<connection or provider>:<model>" (a bare model name from an older client is accepted too),
// for Work also a plan's provider id, for the media uses and embeddings also "off", for tts, speech, embeddings and voice
// also "local", for images also "codex".
// Owns: this rule. Never: checks that a chosen model is connected (an unavailable choice falls back at routing
// time, models/functions.ts and routing/router.ts) or writes settings.

import type { RoutingSettings } from '../../shared/model/system.ts';
import { MODEL_USES, OFFABLE_USES, USE_AUTO, USE_OFF } from '../../shared/model/models-uses.ts';

type Bad = (path: string, expected: string) => never;

const COST_MODES: readonly string[] = ['economy', 'balanced', 'best'];
/** A model id, a plan's provider id or "auto"/"off": no white space or control characters. */
const VALUE = /^[^\s\u0000-\u001f]{1,200}$/;

/** Checks the Models section of a complete Settings object. */
export function validateRouting(routing: RoutingSettings, bad: Bad): void {
  if (!COST_MODES.includes(routing.costMode)) bad('routing.costMode', COST_MODES.join(' | '));
  if (typeof routing.allowPaidFallback !== 'boolean') bad('routing.allowPaidFallback', 'true or false');
  for (const use of MODEL_USES) {
    const value: unknown = routing[use];
    const expected = `"${USE_AUTO}"${OFFABLE_USES.has(use) ? `, "${USE_OFF}"` : ''} or a model "<connection>:<model>"`;
    if (typeof value !== 'string' || !VALUE.test(value)) bad(`routing.${use}`, expected);
    if (value === USE_OFF && !OFFABLE_USES.has(use)) bad(`routing.${use}`, expected);
  }
}
