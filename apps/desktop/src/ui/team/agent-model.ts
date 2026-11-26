// The agent page's model choice (26.11.2026, owner): the page shows the model the agent is on; a click opens the list, and a
// picked model comes with two ways –
//   "From next context": stored as the agent's start model; it applies where the agent's context is next rebuilt (the router
//                        starts a context on the start model, routing/previous.ts) – until then the page names it as pending;
//   "Now":               the agent's next turn runs on it at once and reads the whole conversation again (models.setPolicy
//                        `now`, agents/next-route.ts) – that costs more, so the page asks first (SWITCH_NOW_CONFIRM).
// "Auto" (no start model) has only the first way – there is nothing to switch to.
// Owns: the request each way sends, the confirm words and what counts as pending. Never: renders or calls the runtime.

import type { ParamsOf } from '../../shared/api/methods.ts';
import type { ModelPolicy } from '../../shared/model/providers.ts';

export type SwitchWhen = 'next' | 'now';

export const SWITCH_LABEL: Readonly<Record<SwitchWhen, string>> = { next: 'From next context', now: 'Now' };
export const SWITCH_HINT: Readonly<Record<SwitchWhen, string>> = {
  next: 'It starts its next context on this model',
  now: 'It reads the whole conversation again on this model',
};

/** What "Now" asks before it switches – the app is English only. */
export const SWITCH_NOW_CONFIRM = {
  title: 'Switch model now?',
  body: 'The agent reads the whole conversation again with the new model. That costs more.',
  confirmLabel: 'Switch now',
} as const;

/** The request a pick sends: `model` '' is Auto (the start model goes); "Now" only means something with a model. */
export function switchRequest(agentId: string, current: ModelPolicy | undefined, model: string, when: SwitchWhen): ParamsOf<'models.setPolicy'> {
  const { pin: _old, pinBy: _by, ...rest } = current ?? {}; // who set it (pinBy) is the runtime's to write
  const policy: ModelPolicy = model ? { ...rest, pin: model } : rest;
  return { agentId, policy, ...(model && when === 'now' ? { now: true } : {}) };
}

/** The start model that waits for the agent's next context: set, and not the one it runs on already. */
export function pendingModel(pin: string | undefined, runsOn: string | undefined): string | undefined {
  return pin && pin !== 'auto' && pin !== runsOn ? pin : undefined;
}
