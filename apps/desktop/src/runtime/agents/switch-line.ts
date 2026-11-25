// Wording of the quiet "model switched" status line (RT5; B-083 – owner 08.11.: the switches between models, efforts and
// temperatures in the chat, "jeweil Agent Name", "und dass es wirklich auch stimmt"): "<Agent> → <model> · <effort>
// [· temperature T[ (stance)]] – <why>", at most 120 characters. The chat shows the text (whose line it is stays readable
// in a group) and the agent reads the same text in its delta ("· Mara → …", context/render.ts), so both know why it changed.
// 17.11.2026: the line is for a turn on another model than my last one and for an effort somebody asked for (route-line.ts
// decides which); the effort my subconscious sets shows in the live bar.
//   why = the first segment of the route reason ("my start model", "requested by me", a need's text, my kind's default, the
//   model that cannot run now or that I asked for in vain); a bare category label joins what follows ("strongest fit for
//   coding"); the router's "requested by the agent" reads in the agent's own voice ("requested by me"). An effort change on
//   the same model names whose it is: "effort requested by me" (model.set, RT2) or "effort from my task (given by <name>)".
//   temperature: the turn's (the agent's own request – 13.11.2026: the chat's suggestion never routes); "(stance)" where the model samples at
//   its own setting.
//   failover = what happened to the model before ("GPT-6.1 Sol hit its usage limit"); the same
//   model on another account names no account (labels may hold an e-mail address).
// Owns: these texts. Never: posts lines (route-line.ts does) or reads state.

import type { Effort, RouteDecision } from '../../shared/model/providers.ts';
import { temperatureText } from '../../shared/model/runs.ts';
import { categoryLabel } from '../routing/categories.ts';
import { EFFORT_OF_TASK, EFFORT_REQUESTED, MODEL_REQUESTED, SUBCONSCIOUS } from '../routing/previous.ts';

/** Longest status text (the chat line and the agent's delta stay one short line). */
export const STATUS_MAX = 120;
const SEGMENT = ' · ';

/** B-083: why of a temperature the agent asked for (model.set) and of its model.set inside the running turn. */
export const REQUESTED_WHY = 'requested by me';
/** The router's words for the agent's own request, in the agent's voice (the line is its own). */
const MINE: Readonly<Record<string, string>> = { [MODEL_REQUESTED]: REQUESTED_WHY, [EFFORT_REQUESTED]: 'effort requested by me' };

/** What a turn runs on, as the line names it. */
export interface SwitchTo { modelName: string; effort: Effort; temperature?: number; sent?: boolean }

/** Cuts at a word boundary when one is near and ends with "…". */
export function capText(text: string, max = STATUS_MAX): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space >= max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s·—–→-]+$/u, '')}…`;
}

/** The segments of a route reason (router.ts joins them with " · "). */
export function reasonParts(reason: string | undefined): string[] {
  return (reason ?? '').split(SEGMENT).map((segment) => segment.trim()).filter(Boolean);
}

/** The first reason segment of a route reason. */
export function firstReason(reason: string | undefined, category: string | undefined): string | undefined {
  const [first, next] = reasonParts(reason);
  if (!first) return undefined;
  const label = category ? categoryLabel(category) : undefined;
  if (first !== label) return MINE[first] ?? first;
  return next ? `${next} for ${label}` : `for ${label}`;
}

/** "Claude Opus 5.5 · high · temperature 0.3 (stance)". */
export function runsOnText(to: SwitchTo): string {
  const warmth = to.temperature === undefined ? '' : ` · temperature ${temperatureText(to.temperature)}${to.sent ? '' : ' (stance)'}`;
  return `${to.modelName} · ${to.effort}${warmth}`;
}

/** "Mara → Claude Opus 5.5 · high – my start model". */
export function switchText(agent: string, to: SwitchTo, why?: string): string {
  return capText(`${agent} → ${runsOnText(to)}${why ? ` – ${why}` : ''}`);
}

/** The failover line: the model (or account) the turn moved away from and why. */
export function failoverText(agent: string, to: SwitchTo, input: { failedName: string; sameModel: boolean; limited: boolean; switchedOff?: boolean }): string {
  if (input.sameModel) {
    const why = input.limited ? 'the first one hit its usage limit' : input.switchedOff ? 'the first one was switched off' : 'the first one is unavailable right now';
    return capText(`${agent} → another account · ${runsOnText(to)} – ${why}`);
  }
  return switchText(agent, to, input.limited ? `${input.failedName} hit its usage limit` : input.switchedOff ? `${input.failedName} was switched off` : `${input.failedName} is unavailable right now`);
}

/**
 * The why of a switch away from `from` (what my last turn ran on): an effort-only change somebody asked for names whose
 * request it is – mine or my task's –, else the first reason.
 */
export function switchWhy(route: Pick<RouteDecision, 'modelId' | 'reason' | 'category'>, from: { modelId: string }): string | undefined {
  const effort = route.modelId === from.modelId ? reasonParts(route.reason).find((part) => part === EFFORT_REQUESTED || part.startsWith(EFFORT_OF_TASK)) : undefined;
  return effort ? MINE[effort] ?? effort : firstReason(route.reason, route.category);
}

/** B-083: the reason segment of the effort my subconscious set before the turn ("my subconscious: <why>", routing/previous.ts effortSource). */
export function subconsciousWhy(reason: string): string | undefined {
  return reasonParts(reason).find((segment) => segment.startsWith(SUBCONSCIOUS));
}
