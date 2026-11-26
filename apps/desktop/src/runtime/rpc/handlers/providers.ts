// RPC handlers: provider accounts (list/detect/add/update/login/logout/remove/install), usage,
// the model catalog (list/recent/refresh/status), model policies (agent, chat+agent, global),
// routing previews (with the chat's return choice like a turn, agents/next-route.ts) and the
// efforts a model supports.
// Owns: param checks and scope rules for these methods. B-078 ("alles vom Handy"): accounts.* are open to the owner's
// phone with 'settings' on a secure transport (the app's loopback tunnel; a plain LAN browser stays without them) – plans,
// API keys and sign-ins from the phone; a CLI sign-in a phone starts (other than Codex/Claude Code, B-091) opens its page as a tab in this PC's own browser pane
// (global), which the phone mirrors and works in, so the provider's callback lands on this PC. Catalog refreshes stay
// owner-only; phones with 'chat' read usage, models, recent models, efforts, policies and the
// catalog status; 'manage' sets policies and previews routing – except the global cost mode and default model
// (Settings.routing.costMode and the Work use routing.work), which only the owner sets.
// accounts.useReset (a Codex reset, after the person confirmed) and accounts.test (an API endpoint's or a
// local server's models before adding it; the key is used for that call only) are owner only.
// accounts.add and accounts.test take `apiKey` typed or as a handle secret://<id> of the catalog (accounts/connect.ts).
// models.uses (read-only, like accounts.*: the owner and the owner's phone with 'settings' on a secure transport): what
// each model use resolves to right now (models/uses.ts).
// B-051: accounts.try (one tiny real turn on one account, accounts/try-turn.ts – owner only) and the sign-in
// page an `accounts.add`/`accounts.login` hands back (never logged here). B-091: from a device both start an "away"
// sign-in the person finishes on the phone (`code`/`paste`; nothing opens on the PC) and accounts.loginCode hands the
// code the Claude page showed to that sign-in (never logged or echoed).
// B-083: models.setPolicy for one agent (no chat) stores who set its start model – a changed pin `pinBy` = the person's
// name (the profile name; devices are the owner's) and the time, an unchanged pin keeps its origin, no pin or 'auto'
// none; a `pinBy` the caller sends (a getPolicy → setPolicy round trip) is ignored. accounts.update takes `credits` (an
// API key holding a plan's monthly credits; the account service refuses it where no plan credits exist) and `extraUsage`.
// 17.11.2026 (Konrad task_bgykyzcx): what makes a plan login usable or lets a plan spend – accounts.useFound, accounts.declineFound,
// accounts.add `detected` ("Add again"), accounts.update `extraUsage: true` (the provider bills it) and `thisPcOnly` (which PCs get the login) – is the person's click:
// the desktop window or the phone (secure, 'settings'); an agent's `wf`, a script with the launch token and a `wf` by hand are refused.
// Never: business logic, and never echoes or logs API keys –
// `accounts.add` hands the key straight to the account service, which stores it encrypted (an
// environment key arrives as its variable's name only).

import { WorkforceError } from '../../../shared/errors.ts';
import { GLOBAL_SPACE } from '../../../shared/api/workspace-browser.ts';
import { DECISION_PROVIDER, ENV_KEY_PROVIDERS, type ModelPolicy, type ProviderId } from '../../../shared/model/providers.ts';
import { tryDecisionConnection } from '../../decision/systemone.ts';
import { bad, id, input, notFound, obj, oneOf, onlyKeys, optBool, optId, optNum, optOneOf, optStrings, optText, text, type Obj } from '../params.ts';
import { scopeHas } from '../table.ts';
import type { ClientScope } from '../../../shared/api/protocol.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';
import { returnChoice } from '../../agents/next-route.ts';
import { boundaryOf } from '../../agents/boundary.ts';
import { MAIN_THREAD } from '../../../shared/model/origin.ts';
import { personName } from '../../agents/publishing.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { tryAccount } from '../../accounts/try-turn.ts';
import { setupCredits } from '../../accounts/credits-setup.ts';
import { modelUses } from '../../models/uses.ts';
import { setUse } from '../../models/set-use.ts';

const CHAT = { capability: 'chat' } as const;
/** accounts.*: the owner, and the owner's phone on a secure transport. */
const ACCOUNTS = { capability: 'settings', secure: true } as const;
const MANAGE = { capability: 'manage' } as const;

const PROVIDERS: readonly ProviderId[] = [
  'codex', 'claude', 'openai', 'anthropic', 'openrouter', 'google', 'xai', 'deepseek',
  'ollama', 'lmstudio', 'llamacpp', 'vllm', 'compatible',
  'gemini-cli', 'copilot', 'kimi-cli', // PR8 (B-044: Kimi Code): plan CLIs on the ACP engine
  'groq', 'elevenlabs', 'fal', // B-058
  'decision-api',
];
/** B-044: providers an endpoint test can reach (the HTTP engines' providers – the API form's and the local servers' "Test"). */
const TESTABLE: readonly ProviderId[] = ['openai', 'anthropic', 'openrouter', 'google', 'xai', 'deepseek', 'groq', 'compatible', 'ollama', 'lmstudio', 'llamacpp', 'vllm'];
const INSTALLABLE = ['claude', 'codex'] as const;
const ENV_KEY_NAMES: readonly string[] = Object.keys(ENV_KEY_PROVIDERS);
const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const TIERS = ['local', 'small', 'strong', 'frontier'] as const;
const COST_MODES = ['economy', 'balanced', 'best'] as const;
/** Model ids look like `codex:gpt-6.1-sol` or `openrouter:anthropic/claude-…`. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,199}$/;
/** Runs a routing preview reads for the choice to return to (agents/turn-prepare.ts RETURN_WINDOW). */
const PREVIEW_RUNS = 50;

function modelId(o: Obj, key: string): string {
  const value = text(o, key, { max: 200 });
  if (!MODEL_ID.test(value)) bad(key, 'a model id');
  return value;
}

function optModelIds(o: Obj, key: string): string[] | undefined {
  const values = optStrings(o, key, { maxItems: 50, max: 200 });
  if (values?.some((value) => !MODEL_ID.test(value))) bad(key, 'a list of model ids');
  return values;
}

function baseUrlOf(o: Obj): string | undefined {
  const value = optText(o, 'baseUrl', { max: 2048 });
  if (value === undefined) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return bad('baseUrl', 'an http(s) URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') bad('baseUrl', 'an http(s) URL');
  return value;
}

/** Only known policy fields; tier bounds must be ordered. */
export function policyOf(o: Obj): ModelPolicy {
  // pinBy is the runtime's (withOrigin); a sent one is ignored
  onlyKeys(o, ['pin', 'effort', 'floorTier', 'ceilingTier', 'costMode', 'prefer', 'avoid', 'pinBy'], 'policy');
  const policy: ModelPolicy = {};
  if (o.pin !== undefined && o.pin !== null) policy.pin = modelId(o, 'pin');
  const effort = optOneOf(o, 'effort', EFFORTS);
  if (effort) policy.effort = effort;
  const floorTier = optOneOf(o, 'floorTier', TIERS);
  if (floorTier) policy.floorTier = floorTier;
  const ceilingTier = optOneOf(o, 'ceilingTier', TIERS);
  if (ceilingTier) policy.ceilingTier = ceilingTier;
  if (floorTier && ceilingTier && TIERS.indexOf(floorTier) > TIERS.indexOf(ceilingTier)) bad('floorTier', 'a tier not above ceilingTier');
  const costMode = optOneOf(o, 'costMode', COST_MODES);
  if (costMode) policy.costMode = costMode;
  const prefer = optModelIds(o, 'prefer');
  if (prefer) policy.prefer = prefer;
  const avoid = optModelIds(o, 'avoid');
  if (avoid) policy.avoid = avoid;
  return policy;
}

function policyScope(o: Obj): { agentId?: string; conversationId?: string } {
  const scope: { agentId?: string; conversationId?: string } = {};
  const agentId = optId(o, 'agentId');
  if (agentId) scope.agentId = agentId;
  const conversationId = optId(o, 'conversationId');
  if (conversationId) scope.conversationId = conversationId;
  return scope;
}

/**
 * B-083: an agent's start model with its origin – a changed pin names the person now ("Stanislaus set it on my page";
 * cleanPolicy caps the name), an unchanged one keeps its own.
 */
function withOrigin(ctx: HandlerContext, agentId: string, policy: ModelPolicy): ModelPolicy {
  const agent = policy.pin && policy.pin !== 'auto' ? ctx.services.org.get(agentId) : undefined;
  if (!agent) return policy; // no pin ('auto' is none), or no such agent (the store refuses it)
  const before = agent.modelPolicy;
  if (before?.pin === policy.pin) return before.pinBy ? { ...policy, pinBy: before.pinBy } : policy;
  return { ...policy, pinBy: { name: personName(ctx.services, HUMAN_ID) ?? 'the person', at: ctx.services.clock.now() } };
}

/**
 * A sign-in a phone started: the page the CLI printed opens as a tab in this PC's own pane (global) – the phone mirrors
 * that pane and works in it, and the provider's callback reaches this PC's localhost. The owner's window opens it itself.
 * B-091: an away Codex/Claude Code sign-in (`code` or `paste`) finishes on the phone itself – nothing opens on the PC.
 */
async function openOnPc<T>(ctx: HandlerContext, result: T): Promise<T> {
  if (ctx.scope.kind !== 'device') return result;
  const page = result as { url?: unknown; signInUrl?: unknown; code?: unknown; paste?: unknown } | undefined;
  if (page?.code || page?.paste) return result;
  const url = page?.url ?? page?.signInUrl;
  const sideBrowser = ctx.services.host?.sideBrowser;
  if (typeof url !== 'string' || !/^https?:\/\//.test(url) || !sideBrowser) return result;
  try {
    await sideBrowser({ action: 'open', url, newTab: true, show: true, space: GLOBAL_SPACE, agent: { id: 'human', name: 'Sign-in' } });
  } catch (error) {
    ctx.services.log.warn('sign-in page not opened on the PC', { error: String((error as Error)?.message ?? error).slice(0, 200) });
  }
  return result;
}

/**
 * The person's own click: the desktop window or their phone - not an agent's `wf` (owner scope with agentId), not the launch token alone.
 * Any `device` scope passes here; what keeps a device that is no person's out is the registration: every handler that asks personOnly is added with
 * ACCOUNTS (`capability: 'settings', secure: true`, the rpc table's own check) - a handler added without it is open to every device.
 */
function byThePerson(scope: ClientScope): boolean {
  return scope.kind === 'device' || (scope.kind === 'owner' && scope.person === true && !scope.agentId);
}

function personOnly(ctx: HandlerContext, what: string): void {
  if (!byThePerson(ctx.scope)) throw new WorkforceError('forbidden', `${what} is the person's own click in Settings › Accounts – an agent or a script cannot do it for them.`);
}

/** A refresh asks providers / the catalog again: the owner and 'manage' devices only. */
function mayRefresh(ctx: HandlerContext, params: unknown): boolean {
  return (optBool(input(params), 'refresh') ?? false) && scopeHas(ctx.scope, 'manage');
}

export function register(table: HandlerTable): void {
  // ---------------------------------------------------------------- accounts
  table.add('accounts.list', (_params, ctx) => ctx.services.accounts.list(), ACCOUNTS);
  table.add('accounts.detect', (params, ctx) => ctx.services.accounts.detect(optBool(input(params), 'force') ?? false), ACCOUNTS);
  table.add('accounts.add', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['provider', 'label', 'apiKey', 'baseUrl', 'envVar', 'detected']);
    // PR5: `envVar` names a key variable of the one table (its value never travels), `detected` = "Add again".
    const envVar = optOneOf(o, 'envVar', ENV_KEY_NAMES);
    const detected = optBool(o, 'detected');
    if (detected) personOnly(ctx, 'Adding a found sign-in again');
    return ctx.services.accounts.add({
      provider: oneOf(o, 'provider', PROVIDERS),
      label: optText(o, 'label', { max: 80 }),
      apiKey: optText(o, 'apiKey', { max: 4096 }),
      baseUrl: baseUrlOf(o),
      ...(envVar ? { envVar } : {}),
      ...(detected ? { detected } : {}),
    }, { away: ctx.scope.kind === 'device' }).then((added) => openOnPc(ctx, added));
  }, ACCOUNTS);
  table.add('accounts.update', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'label', 'priority', 'enabled', 'credits', 'extraUsage', 'thisPcOnly']);
    const patch: { label?: string; priority?: number; enabled?: boolean; credits?: boolean; extraUsage?: boolean; thisPcOnly?: boolean } = {};
    const label = optText(o, 'label', { max: 80 });
    if (label !== undefined) patch.label = label;
    const priority = optNum(o, 'priority', { min: -10_000, max: 10_000 });
    if (priority !== undefined) patch.priority = priority;
    const enabled = optBool(o, 'enabled');
    if (enabled !== undefined) patch.enabled = enabled;
    const credits = optBool(o, 'credits'); // B-083: the key holds a plan's monthly API credits (shared/model/charge.ts)
    if (credits !== undefined) patch.credits = credits;
    const extraUsage = optBool(o, 'extraUsage'); // 17.11.2026: the plan goes on past its limit on the provider's extra usage (billed by the provider)
    if (extraUsage === true) personOnly(ctx, 'Allowing a plan\'s extra usage');
    if (extraUsage !== undefined) patch.extraUsage = extraUsage;
    const thisPcOnly = optBool(o, 'thisPcOnly'); // 17.11.2026: a plan login stays on this PC, or goes to the company's PCs (the person's choice either way)
    if (thisPcOnly !== undefined) { personOnly(ctx, 'Choosing where a sign-in is used'); patch.thisPcOnly = thisPcOnly; }
    return ctx.services.accounts.update(id(o), patch);
  }, ACCOUNTS);
  // 23.11.2026 (task_pkzytj9m): "Let the AI set it up" – the personal manager's to-do for a Claude plan's monthly API credits
  table.add('accounts.setupCredits', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    personOnly(ctx, 'Handing the API credits of a plan to the manager');
    const { task, assignee } = setupCredits(ctx.services, id(o));
    return { taskId: task.id, assignee };
  }, ACCOUNTS);
  // 17.11.2026: a plan login on offer (accounts.detect → found) is used here only after the person's "Use"; "Not here" keeps it out
  table.add('accounts.useFound', (params, ctx) => {
    personOnly(ctx, 'Using a found sign-in');
    const o = input(params);
    onlyKeys(o, ['key', 'thisPcOnly']);
    return ctx.services.accounts.useFound?.(text(o, 'key', { max: 300 }), { thisPcOnly: optBool(o, 'thisPcOnly') ?? false }) ?? notFound('Found sign-ins');
  }, ACCOUNTS);
  table.add('accounts.declineFound', async (params, ctx) => {
    personOnly(ctx, 'Declining a found sign-in');
    const o = input(params);
    onlyKeys(o, ['key']);
    await (ctx.services.accounts.declineFound?.(text(o, 'key', { max: 300 })) ?? notFound('Found sign-ins'));
    return { ok: true as const };
  }, ACCOUNTS);
  // B-051 L4: the person's own UI gets the sign-in page the CLI printed (`url`; agent tools never do).
  // B-091: from a device (the phone) the sign-in is "away" – finished there (code/paste), the code back via accounts.loginCode.
  table.add('accounts.login', (params, ctx) => ctx.services.accounts.login(id(input(params)), { page: true, away: ctx.scope.kind === 'device' }).then((started) => openOnPc(ctx, started)), ACCOUNTS);
  table.add('accounts.loginCode', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'code']);
    const code = text(o, 'code', { max: 4096 }); // never logged or echoed
    if (/[\u0000-\u001f\u007f]/.test(code)) bad('code', 'a code without control characters');
    return ctx.services.accounts.loginCode?.(id(o), code) ?? notFound('Sign-in codes');
  }, ACCOUNTS);
  table.add('accounts.logout', async (params, ctx) => {
    await ctx.services.accounts.logout(id(input(params)));
    return { ok: true };
  }, ACCOUNTS);
  table.add('accounts.remove', async (params, ctx) => {
    await ctx.services.accounts.remove(id(input(params)));
    return { ok: true };
  }, ACCOUNTS);
  table.add('accounts.install', async (params, ctx) => {
    const provider = oneOf(input(params), 'provider', INSTALLABLE);
    await ctx.services.accounts.install(provider);
    return { ok: true };
  }, ACCOUNTS);
  // B-051: one tiny real turn on exactly this account (accounts/try-turn.ts) – never a routing change.
  table.add('accounts.try', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    const s = ctx.services;
    const decision = s.accounts.get(id(o));
    if (decision?.provider === DECISION_PROVIDER) return tryDecisionConnection(s, decision); // no engine: one question of its own protocol
    return tryAccount({ engines: s.engines, catalog: s.catalog, accounts: s.accounts, paths: s.paths, clock: s.clock, notifications: s.notifications }, id(o));
  }, ACCOUNTS);
  // B-044: redeem a banked Codex reset after the person confirmed (accounts/resets.ts).
  table.add('accounts.useReset', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'creditId']);
    const creditId = optText(o, 'creditId', { max: 200 });
    const outcome = await (ctx.services.accounts.useReset?.(id(o), creditId) ?? notFound('Account resets'));
    return { outcome };
  }, ACCOUNTS);
  // B-044: the API key form's Test – the key reaches the engine for this one call, never storage or logs.
  table.add('accounts.test', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['provider', 'baseUrl', 'apiKey']);
    return ctx.services.accounts.test?.({ provider: oneOf(o, 'provider', TESTABLE), baseUrl: baseUrlOf(o), apiKey: optText(o, 'apiKey', { max: 4096 }) }) ?? notFound('Endpoint test');
  }, ACCOUNTS);
  // refresh = the quota details opened: the account monitor asks the providers at most once a minute.
  table.add('usage.list', (params, ctx) => ctx.services.accounts.usage(mayRefresh(ctx, params)), CHAT);

  // ---------------------------------------------------------------- models & routing
  table.add('models.list', async (params, ctx) => {
    if (mayRefresh(ctx, params)) await ctx.extras.catalogRefresh();
    return ctx.services.catalog.list();
  }, CHAT);
  table.add('models.uses', (params, ctx) => {
    onlyKeys(input(params), []);
    return modelUses(ctx.services);
  }, ACCOUNTS); // B-084: the phone's Settings › Models reads it like accounts.* (it was owner-only → empty pickers)
  table.add('models.setUse', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['use', 'value']);
    return setUse(ctx.services, text(o, 'use', { max: 20 }), text(o, 'value', { max: 300 }), { pull: (id) => ctx.extras.voice.pullLocal(id) });
  }, ACCOUNTS); // the same keys settings.update's Models section writes
  table.add('models.recent', (params, ctx) => ctx.services.catalog.recent(optId(input(params), 'agentId')), CHAT);
  table.add('models.getPolicy', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['agentId', 'conversationId']);
    return ctx.extras.policies.get(policyScope(o));
  }, CHAT);
  table.add('models.setPolicy', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['agentId', 'conversationId', 'policy', 'now']);
    const scope = policyScope(o);
    const policy = policyOf(obj(o, 'policy'));
    const now = optBool(o, 'now') === true;
    if (now && (!scope.agentId || scope.conversationId)) bad('now', 'only with an agent\'s start model');
    // The global cost mode and default model are Settings.routing.costMode / routing.work (policies.ts): the same rule as
    // settings.update's routing section (B-084: the owner's phone with 'settings' on a secure transport may, every other
    // device not). Agent/chat choices stay 'manage'.
    const global = !scope.agentId && !scope.conversationId;
    const securePhone = ctx.scope.kind === 'device' && ctx.scope.secure === true && ctx.scope.capabilities.includes('settings');
    if (global && (policy.costMode || policy.pin) && ctx.scope.kind !== 'owner' && !securePhone) {
      throw new WorkforceError('forbidden', 'The model choice for all agents can only be changed on the PC (Settings › Models).', { details: { key: policy.costMode ? 'costMode' : 'pin' } });
    }
    const stored = scope.agentId && !scope.conversationId ? withOrigin(ctx, scope.agentId, policy) : policy;
    if (now) ctx.extras.policies.set(scope, stored, { now: true });
    else ctx.extras.policies.set(scope, stored);
    return { ok: true };
  }, MANAGE);
  table.add('routing.preview', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['agentId', 'conversationId', 'text', 'mode', 'ignorePin']);
    const agent = ctx.services.org.get(id(o, 'agentId')) ?? notFound('Agent');
    const mode = ctx.services.modes.get(optText(o, 'mode', { max: 80 }) ?? agent.mode);
    const conversationId = optId(o, 'conversationId');
    // RT5: like a turn (agents/turn-prepare.ts), the model the agent is on (its session's, else its last done run's – any
    // chat, one context) is where the preview starts, and – 17.11.2026, the model settles – it asks like the turn whether
    // the agent's context starts anew anyway (agents/boundary.ts): in a live session the next turn stays on that model (a
    // pending model.set request is not consumed by a preview); a chat's model choice never routes (13.11.2026), so a
    // chat's preview is what Auto runs. `ignorePin` = what the agent page's "nothing chosen" option would run: without a
    // chat the agent's own pin does not answer. 0.3.20 (no PC outranks another): the answer is for the PC this connection is to –
    // its accounts, its limits, its cooling-down plans; a turn that runs on another PC routes with that PC's own.
    const ignorePin = optBool(o, 'ignorePin');
    const { pin: _pin, ...unpinned } = agent.modelPolicy ?? {};
    const boundary = conversationId ? boundaryOf(ctx.services, agent.id, MAIN_THREAD) : undefined;
    const previous = conversationId ? returnChoice(ctx.services.runs.list(agent.id, PREVIEW_RUNS), undefined, { on: boundary?.on?.modelId }) : undefined;
    return ctx.services.router.route({
      agent: ignorePin && !conversationId ? { ...agent, modelPolicy: unpinned } : agent,
      conversationId,
      mode,
      text: optText(o, 'text', { max: 20_000, multiline: true, allowEmpty: true }),
      ...(previous ? { previous } : {}), ...(boundary ? { boundary: boundary.at } : {}),
    });
  }, MANAGE);
  table.add('catalog.refresh', async (_params, ctx) => {
    const result = await ctx.extras.catalogRefresh();
    return { ok: true, models: result.models, fetchedAt: result.fetchedAt, refreshedAt: ctx.extras.catalogStatus().refreshedAt };
  });
  // Read-only – like models.list for 'chat' devices.
  table.add('catalog.status', (_params, ctx) => ctx.extras.catalogStatus(), CHAT);
  table.add('efforts.forModel', (params, ctx) => [...(ctx.services.catalog.get(modelId(input(params), 'modelId'))?.efforts ?? [])], CHAT);
}
