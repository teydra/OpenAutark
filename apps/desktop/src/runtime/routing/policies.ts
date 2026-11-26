// Model policies at three scopes and how the router combines them:
//   agent        → agents.model_policy (org.update)          – set by the user or a manager; `pin` is the agent's start
//                  model and `pinBy` who set it (B-083). 17.11.2026: it is the explicit choice that stands – the model
//                  the agent runs on from where its context next starts anew (router.ts); without one Auto settles it
//   chat + agent → conversation.settings.modelHints (else an older chat's models) / efforts / temperatures[agentId] –
//                  the person's suggestion in the chat (the composer chip). 13.11.2026 (owner: "einfach nur da, wird der
//                  KI so erklärt"): information for the AI, never routing – chatChoice reads it for the person's new
//                  line (context/render.ts suggestionTag) and the AI's model tools; a chat-scope setPolicy replaces model
//                  and effort whole
//   global       → kv ns 'routing', key 'default_policy'      – defaults for every agent; never a
//                  cost mode (23.10.2026: one global cost mode, Settings.routing.costMode – a
//                  global setPolicy with costMode writes it there; migration 55 moved stored ones) and
//                  never a pin (01.11.2026: the default model is the Work use, Settings.routing.work – a
//                  global setPolicy with a pin writes it there)
// Owns: validation of ModelPolicy input (B-083: `pinBy` kept, name ≤ 80 characters), get/set per scope, the PolicyApi
// factory for RPC, chatChoice and `effectivePolicy` (global defaults → agent; the default model is the Work use, router.ts).
// Never: routes (router.ts does), lets a chat scope store bounds (only pin/effort live there) or lets the chat choice route.

import type { RuntimeServices } from '../contracts.ts';
import type { PolicyApi } from '../rpc/extras.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { Effort, ModelInfo, ModelPolicy } from '../../shared/model/providers.ts';
import type { Message } from '../../shared/model/chat.ts';
import { addressedAgents } from '../chat/sticky-model.ts';
import { newestPersonLine } from '../chat/person-line.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { KvRepo } from '../store/kv.ts';
import { setNextRoute } from '../agents/next-route.ts';
import { normalizeEffort } from '../models/efforts.ts';
import { chosenFor, isProviderChoice } from '../../shared/model/models-uses.ts';

export interface PolicyScope {
  agentId?: string;
  conversationId?: string;
}

export const POLICY_NS = 'routing';
export const DEFAULT_POLICY_KEY = 'default_policy';
export const TIER_ORDER: ReadonlyArray<ModelInfo['tier']> = ['local', 'small', 'strong', 'frontier'];
const COST_MODES: ReadonlySet<string> = new Set(['economy', 'balanced', 'best']);
const MAX_LIST = 50;
const MAX_ID = 200;
const MAX_NAME = 80;
const MAX_TEMPERATURE = 2;

function bad(message: string): never {
  throw new WorkforceError('bad_request', message);
}

function modelId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '' || value === 'auto') return undefined;
  if (typeof value !== 'string' || value.length > MAX_ID || /[\u0000-\u001f]/.test(value)) bad(`Enter a valid model for ${field}.`);
  return value.trim() || undefined;
}

function tier(value: unknown, field: string): ModelInfo['tier'] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!TIER_ORDER.includes(value as ModelInfo['tier'])) bad(`Choose a valid ${field}.`);
  return value as ModelInfo['tier'];
}

function idList(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_LIST) bad(`Enter a valid list of models for ${field}.`);
  const out = [...new Set(value.map((item) => modelId(item, field)).filter((item): item is string => Boolean(item)))];
  return out.length ? out : undefined;
}

/** Validates and normalizes a policy (unknown fields dropped, 'auto' pin = no pin). */
export function cleanPolicy(value: unknown): ModelPolicy {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) bad('Enter a valid model policy.');
  const raw = value as Record<string, unknown>;
  const policy: ModelPolicy = {};
  const pin = modelId(raw.pin, 'the pinned model');
  if (pin) policy.pin = pin;
  if (raw.effort !== undefined && raw.effort !== null && raw.effort !== '' && raw.effort !== 'auto') {
    const effort = normalizeEffort(raw.effort);
    if (!effort) bad('Choose a valid effort.');
    policy.effort = effort;
  }
  const floor = tier(raw.floorTier, 'lowest tier');
  const ceiling = tier(raw.ceilingTier, 'highest tier');
  if (floor && ceiling && TIER_ORDER.indexOf(floor) > TIER_ORDER.indexOf(ceiling)) bad('The lowest allowed tier is above the highest allowed tier.');
  if (floor) policy.floorTier = floor;
  if (ceiling) policy.ceilingTier = ceiling;
  if (raw.costMode !== undefined && raw.costMode !== null && raw.costMode !== '') {
    if (!COST_MODES.has(String(raw.costMode))) bad('Choose economy, balanced or best.');
    policy.costMode = raw.costMode as ModelPolicy['costMode'];
  }
  const prefer = idList(raw.prefer, 'preferred models');
  const avoid = idList(raw.avoid, 'avoided models');
  if (prefer) policy.prefer = prefer;
  if (avoid) policy.avoid = avoid;
  const pinBy = setBy(raw.pinBy);
  if (pinBy) policy.pinBy = pinBy;
  return policy;
}

/** B-083: who set the start model (a name of at most MAX_NAME characters, when); anything else is dropped. */
function setBy(value: unknown): ModelPolicy['pinBy'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, MAX_NAME) : '';
  if (!name || typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return undefined;
  return { name, at: raw.at, ...(raw.self === true ? { self: true } : {}) };
}

function isEmpty(policy: ModelPolicy | undefined): boolean {
  return !policy || Object.values(policy).every((value) => value === undefined);
}

/** The single agent of a chat when a client names only the conversation (1:1 composer). */
function soleAgent(services: RuntimeServices, conversationId: string): string | undefined {
  const agents = services.chats.members(conversationId).filter((member) => member.kind === 'agent' && !member.leftAt);
  return agents.length === 1 ? agents[0].memberId : undefined;
}

function resolveScope(services: RuntimeServices, scope: PolicyScope): { kind: 'global' } | { kind: 'agent'; agentId: string } | { kind: 'chat'; agentId: string; conversationId: string } {
  const conversationId = scope.conversationId || undefined;
  let agentId = scope.agentId || undefined;
  if (conversationId) {
    agentId ??= soleAgent(services, conversationId);
    if (!agentId) bad('Choose which agent this model choice is for.');
    return { kind: 'chat', agentId, conversationId };
  }
  return agentId ? { kind: 'agent', agentId } : { kind: 'global' };
}

/** The global default policy (or undefined); a pin is no part of it (the Work use is). */
export function defaultPolicy(services: RuntimeServices): ModelPolicy | undefined {
  const stored = new KvRepo(services.db).get<ModelPolicy>(POLICY_NS, DEFAULT_POLICY_KEY);
  if (!stored) return undefined;
  try {
    const { pin: _pin, ...rest } = cleanPolicy(stored);
    return rest;
  } catch { return undefined; }
}

/**
 * The person's suggestion for one agent in one chat (the composer chip): the model (modelHints, else an older chat's
 * `models` entry), the effort and the temperature (0..2) – information for the AI, never a route ('auto' = none).
 */
export function chatChoice(services: RuntimeServices, conversationId: string | undefined, agentId: string): { pin?: string; effort?: Effort; temperature?: number } {
  if (!conversationId) return {};
  const settings = services.chats.get(conversationId)?.settings;
  const pin = settings?.modelHints?.[agentId] ?? settings?.models?.[agentId];
  const effort = settings?.efforts?.[agentId] === 'auto' ? undefined : normalizeEffort(settings?.efforts?.[agentId]);
  const temperature = settings?.temperatures?.[agentId];
  const warmth = typeof temperature === 'number' && temperature >= 0 && temperature <= MAX_TEMPERATURE ? { temperature } : {};
  return { pin: typeof pin === 'string' && pin && pin !== 'auto' ? pin : undefined, effort, ...warmth };
}

type LineChoice = { pin?: string; effort?: Effort; temperature?: number };

/**
 * 26.11.2026: what the person picked in the composer for ONE message, read off that line (meta.modelHint, stamped when the
 * line was sent – chat/sticky-model.ts; the chat's own pick is gone by then). Only for an agent the line addresses (a
 * mention, a reply, else the lead); {} on any other line, in Auto and where the line cannot be read.
 */
export function lineChoice(services: RuntimeServices, line: Pick<Message, 'conversationId' | 'authorKind' | 'kind' | 'meta' | 'mentions'> | undefined, agentId: string): LineChoice {
  const tag = line?.authorKind === 'human' && line.kind === 'text' ? line.meta?.modelHint : undefined;
  if (!line || !tag) return {};
  try {
    if (!addressedAgents(line, services.chats.members(line.conversationId)).includes(agentId)) return {};
  } catch { return {}; }
  const effort = tag.effort && tag.effort !== 'auto' ? normalizeEffort(tag.effort) : undefined;
  const warmth = typeof tag.temperature === 'number' && tag.temperature >= 0 && tag.temperature <= MAX_TEMPERATURE ? { temperature: tag.temperature } : {};
  return { pin: typeof tag.modelId === 'string' && tag.modelId && tag.modelId !== 'auto' ? tag.modelId : undefined, effort, ...warmth };
}

/** `lineChoice` of the person's newest line in a chat – for a turn that has no line of its own in hand. */
export function newestLineChoice(services: RuntimeServices, conversationId: string | undefined, agentId: string): LineChoice {
  try { return lineChoice(services, newestPersonLine(services, conversationId), agentId); } catch { return {}; }
}

export function getPolicy(services: RuntimeServices, scope: PolicyScope): ModelPolicy | null {
  const target = resolveScope(services, scope);
  if (target.kind === 'global') {
    const stored = defaultPolicy(services) ?? {};
    const work = chosenFor(services.settings.get().routing, 'work');
    const policy: ModelPolicy = { ...stored, ...(work && !isProviderChoice(work) ? { pin: work } : {}) };
    return isEmpty(policy) ? null : policy;
  }
  if (target.kind === 'agent') {
    const agent = services.org.get(target.agentId);
    if (!agent) throw new WorkforceError('not_found', 'This agent does not exist.');
    return isEmpty(agent.modelPolicy) ? null : { ...agent.modelPolicy };
  }
  const choice = chatChoice(services, target.conversationId, target.agentId);
  const policy: ModelPolicy = {};
  if (choice.pin) policy.pin = choice.pin;
  if (choice.effort) policy.effort = choice.effort;
  return isEmpty(policy) ? null : policy;
}

/**
 * `options.now` (26.11.2026, the agent page's "Now"): with an agent's start model, its next turn runs on that model at once –
 * the agent reads its whole conversation again on it (agents/next-route.ts `now`). Without it the start model applies from the
 * agent's next context, where its context is rebuilt – "From next context".
 */
export function setPolicy(services: RuntimeServices, scope: PolicyScope, policy: ModelPolicy, options: { now?: boolean } = {}): void {
  const clean = cleanPolicy(policy);
  const target = resolveScope(services, scope);
  if (target.kind === 'global') {
    // One global cost mode (Settings.routing.costMode) and one default model (the Work use, Settings.routing.work).
    const { costMode, pin, pinBy: _by, ...rest } = clean;
    if (costMode || pin) services.settings.update({ routing: { ...(costMode ? { costMode } : {}), ...(pin ? { work: pin } : {}) } });
    const kv = new KvRepo(services.db);
    if (isEmpty(rest)) kv.delete(POLICY_NS, DEFAULT_POLICY_KEY);
    else kv.set(POLICY_NS, DEFAULT_POLICY_KEY, rest, services.clock.now());
    return;
  }
  if (!services.org.get(target.agentId)) throw new WorkforceError('not_found', 'This agent does not exist.');
  if (target.kind === 'agent') {
    services.org.update(target.agentId, { modelPolicy: clean });
    // after the update: a start model other than the one asked for ends the ask (next-route.ts startModelSet)
    if (options.now && clean.pin && clean.pin !== 'auto') setNextRoute(services.db, target.agentId, { modelId: clean.pin, now: true, at: services.clock.now() });
    return;
  }
  // Chat scope stores only the composer choice; the maps are replaced whole (shallow settings merge).
  const conversation = services.chats.get(target.conversationId);
  if (!conversation) throw new WorkforceError('not_found', 'This chat does not exist.');
  const models = { ...(conversation.settings.models ?? {}) };
  const efforts = { ...(conversation.settings.efforts ?? {}) };
  if (clean.pin) models[target.agentId] = clean.pin;
  else delete models[target.agentId];
  if (clean.effort) efforts[target.agentId] = clean.effort;
  else delete efforts[target.agentId];
  // SG: the chat choice is replaced whole – the agent's soft hint goes too, so a later "no pin" never revives it.
  const hints = conversation.settings.modelHints;
  const modelHints = hints && target.agentId in hints ? Object.fromEntries(Object.entries(hints).filter(([id]) => id !== target.agentId)) : undefined;
  services.chats.update(target.conversationId, { settings: { models, efforts, ...(modelHints ? { modelHints } : {}) } }, 'human');
}

/** RPC surface (`models.getPolicy` / `models.setPolicy`). */
export function createPolicyApi(services: () => RuntimeServices): PolicyApi {
  return {
    get: (scope) => getPolicy(services(), scope ?? {}),
    set: (scope, policy, options) => setPolicy(services(), scope ?? {}, policy, options),
  };
}

/** The policy the router applies for one agent, with where each part came from. */
export interface EffectivePolicy {
  /** B-083: the agent's start model – it runs where the agent's context starts anew; the agent's own request there beats it.
   *  `self`: the agent set it itself (model.set) – it runs inside the band on the accounts Auto uses (router.ts). */
  pin?: { modelId: string; source: 'agent'; self?: true };
  /** Fixed effort of the agent policy (the agent's own request comes first – previous.ts startEffort). */
  agentEffort?: Effort;
  defaultEffort?: Effort;
  floorTier?: ModelInfo['tier'];
  ceilingTier?: ModelInfo['tier'];
  costMode?: ModelPolicy['costMode'];
  prefer: string[];
  avoid: string[];
}

export function effectivePolicy(services: RuntimeServices, agent: Agent): EffectivePolicy {
  let agentPolicy: ModelPolicy = {};
  try { agentPolicy = cleanPolicy(agent.modelPolicy); } catch { agentPolicy = {}; } // tolerate old rows
  const global = defaultPolicy(services) ?? {};
  // Agent bounds override the defaults; a conflict created by mixing them drops the default.
  let floorTier = agentPolicy.floorTier ?? global.floorTier;
  let ceilingTier = agentPolicy.ceilingTier ?? global.ceilingTier;
  if (floorTier && ceilingTier && TIER_ORDER.indexOf(floorTier) > TIER_ORDER.indexOf(ceilingTier)) {
    if (agentPolicy.floorTier) ceilingTier = agentPolicy.ceilingTier;
    else floorTier = undefined;
  }
  return {
    ...(agentPolicy.pin ? { pin: { modelId: agentPolicy.pin, source: 'agent' as const, ...(agentPolicy.pinBy?.self ? { self: true as const } : {}) } } : {}),
    agentEffort: agentPolicy.effort, defaultEffort: global.effort, floorTier, ceilingTier,
    costMode: agentPolicy.costMode ?? global.costMode,
    prefer: [...new Set([...(agentPolicy.prefer ?? []), ...(global.prefer ?? [])])],
    avoid: [...new Set([...(agentPolicy.avoid ?? []), ...(global.avoid ?? [])])],
  };
}
