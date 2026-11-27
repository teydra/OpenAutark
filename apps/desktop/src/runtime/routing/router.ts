// The router: picks model, engine, account and effort for one turn.
// 17.11.2026 (the model settles; measured 15.–17.11.: 177 model switches in 1,474 runs, 147 on a live one-hour cache, 60 %
// undone within two runs, each one writing the whole context again): the model changes where a context starts anew
// anyway, the effort on every turn. One route, in this order:
//   category: the mode's, refined by keywords for generic modes (categories.ts), else 'chat'
//   → candidates (pool.ts: connected, not excluded, needs, the mode's tier as a preference, policy band, "never" priors)
//   → off a boundary (RouteRequest.boundary false – agents/boundary.ts: a live session) the turn runs on the model that
//     session is on, whoever asks for another: a start model set since, the Work model, my own model.set – they wait and
//     the reason names what waits. Two things move it there: that model cannot run now (no usable account, a need such
//     as images it cannot meet – the reason leads with it, unfit.ts cannotRun) and my own model.set with now.
//   → at a boundary (no session, a cold cache, a fold; also a preview and a part's first turn):
//     my own model.set – the kind of model I asked for (need.ts) or the model I named (B-079: it beats my start model; a
//       request nothing meets leaves the start model in place; D1: a named model that cannot run now leaves the turn on
//       the model it is on, else on the strongest model at least at its tier and at most its list price)
//     → the agent's start model (the person's or a lead's choice for this agent, or its own – ModelPolicy.pin)
//     → the Settings use (settings.json Models: agents the Work model, runtime helper calls the Decisions model –
//       routing/pins.ts), then for helper calls the helper default (helper-default.ts) on its qualifying plan accounts
//     → B-080/D3: a pin that cannot run now gets a stand-in from the strongest tier at most at its own list price
//       (score.ts listPrice) – Auto below chooses inside that set; none that cheap → the whole pool
//     → Auto: the model I am on while it fits my kind – that is its tier and nothing else (kind.ts: leading the
//       strongest tier, executing the strong one; an older version runs as its family's newest) – else my kind's
//       default; a model I only stand on because mine cannot run (`standIn`) is no model of mine, so my kind decides
//       again. A kind's default other than the one it is when every account runs (pool.ts whole) stands in too. The reason says which and why. A part starts on its origin's model; a fresh one that names none runs
//       on the executing default when its origin is above it.
//     → a runtime helper call without any of these: the deterministic score (score.ts), a model the subconscious measured
//       fast first (helper-default.ts fastest; 24.11.2026, Konrad #390: the fallback must not jump silently to a slow model)
//   → effort (previous.ts startEffortBy), clamped to the model's efforts – with nothing set and no weighing of my
//     subconscious, an agent's turn runs at medium on every model, a person's line included, and the reason says it was not
//     weighed (Runde „Halb“ 21.11.2026); account: the healthy accounts of that model – plans keep rotating as before.
// 13.11.2026 (owner: the chat's model choice is "einfach nur da, wird der KI so erklärt"): the person's suggestion in a
// chat (the composer chip, policies.ts chatChoice) never routes – it stands on their line (context/render.ts); a
// temperature comes only from my own request (TurnPlan.temperature).
// The reason names its source: "continues on my model", "requested by the agent", "my start model", the kind's default,
// and for an effort someone asked for whose it is – mine, my task's with who gave it, my subconscious's with its why
// (previous.ts effortSource).
// A split's turn (RouteRequest.split) has no agent pin and keeps an effort it names (split-route.ts).
// Owns: that order and the user-facing reason; a SYSTEM route that leaves or regains the helper default is noted once in the log
// (helper-default.ts noteHelperRoute, 24.11.2026). Never: changes state, asks a model, or exceeds the policy band
// silently (it fails with a clear message instead).

import type { RouteRequest, Router, RuntimeServices } from '../contracts.ts';
import type { Account, ModelInfo, RouteDecision } from '../../shared/model/providers.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { SYSTEM_ID } from '../../shared/ids.ts';
import { clampEffort } from '../models/efforts.ts';
import { categoryLabel, resolveCategory } from './categories.ts';
import { effectivePolicy } from './policies.ts';
import { PIN_TEXT, pinProblem, resolvePin, settingsPin } from './pins.ts';
import { BY_REQUEST, MODEL_REQUESTED, UNWEIGHED_TEXT, effortSource, modelAsked, startEffortBy } from './previous.ts';
import { NO_MODEL_MESSAGE, askedMiss, cannotRun, nothingFits } from './unfit.ts';
import { buildPool, type PoolEntry } from './pool.ts';
import { fastest, helperDefault, noteHelperRoute } from './helper-default.ts';
import { workPlanOf } from './preference.ts';
import { listPrice, marginalCost, scoreModel, strengthOf, tierRank, type CostMode, type Tier } from './score.ts';
import { NEED_TEXT, NO_FIT_TEXT, needChoice, raisedText, stepUpEffort } from './need.ts';
import { splitPolicy } from './split-route.ts';
import { topTier } from './person-turn.ts';
import { kindDefault, kindTier } from './kind.ts';
import { leads } from '../org/standard.ts';
import { companyPlansOnly } from './company-plans.ts';

export { NO_MODEL_MESSAGE };
const ALTERNATIVES = 3;

/** The reason of a turn that goes on where I am. */
export const ON_TEXT = 'continues on my model';
/** The reason of a part's first turn on the model its origin runs on. */
export const ORIGIN_TEXT = "my origin's model";

interface Ranked { model: ModelInfo; accounts: Account[]; score: number }

export class RouterImpl implements Router {
  private readonly deps: { services: () => RuntimeServices };

  constructor(deps: { services: () => RuntimeServices }) {
    this.deps = deps;
  }

  async route(request: RouteRequest): Promise<RouteDecision> {
    const decision = await this.pick(request);
    noteHelperRoute(this.deps.services(), request, decision); // 24.11.2026 (Konrad #390): a SYSTEM call leaving the helper default shows in the log
    return decision;
  }

  private async pick(request: RouteRequest): Promise<RouteDecision> {
    const s = companyPlansOnly(this.deps.services(), request.agent); // Konrad 27.11.2026 (ORENDA): a company agent on an employee's PC runs on the company's plans only
    let models = s.catalog.list();
    if (!models.some((model) => model.available)) {
      // Fresh install / first start: the catalog may not have been built yet (coalesced, throttled).
      await s.catalog.refresh().catch(() => undefined);
      models = s.catalog.list();
    }
    if (!models.some((model) => model.available)) throw new WorkforceError('unavailable', NO_MODEL_MESSAGE);

    const now = s.clock.now();
    const settings = s.settings.get().routing;
    const runtime = request.agent.id === SYSTEM_ID;
    const policy = splitPolicy(effectivePolicy(s, request.agent), request);
    const category = resolveCategory(request.mode.category, request.text);
    const costMode: CostMode = policy.costMode ?? settings.costMode ?? 'balanced';
    const workPlan = runtime ? undefined : workPlanOf(s); // agent work prefers that plan; helpers stay on the helper default
    const minTier = tierRank(request.needs?.tier) > tierRank(request.mode.minTier) ? request.needs?.tier : request.mode.minTier;

    const candidates = buildPool({ s, models, category, policy, needs: request.needs, minTier, exclude: new Set(request.exclude ?? []) });
    const { accountsFor, unusable, inBand } = candidates;
    let pool = candidates.entries;
    const prefer = new Set(policy.prefer);
    const rank = (entries: readonly PoolEntry[], mode: CostMode): Ranked[] => entries
      .map((entry) => ({ ...entry, score: scoreModel({ model: entry.model, account: entry.accounts[0], category, costMode: mode, preferred: prefer.has(entry.model.id), now, workPlan }) }))
      .sort((a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id));
    let ranked = rank(pool, costMode);
    /** B-080/D1/D3: who stands in for a model that cannot run now – at most its list price (at least `tier`), the strongest tier of those. */
    const standIns = (price: number, tier?: Tier): PoolEntry[] =>
      topTier(pool.filter((entry) => listPrice(entry.model) <= price + 1e-9 && tierRank(entry.model.tier) >= tierRank(tier)));

    const previous = request.previous;
    const asking = !runtime && (previous?.need !== undefined || modelAsked(previous)); // my own model.set names a model or a kind of one
    // The model I am on – under a request that names another it rides on `from` – and whether it can run this turn.
    const onId = asking ? previous?.from : previous?.modelId;
    const onModel = onId ? resolvePin(models, onId) : undefined;
    const on = onModel ? candidates.runs(onModel) : undefined;

    let leadNote: string | undefined; // what I asked for that nothing meets, or the model that cannot run – it leads every reason
    // The model I am on cannot run now: whatever runs instead stands in for it (and a turn that stays on a stand-in
    // stands in too), so my next boundary looks past it and my kind decides again.
    const cannotRunOn = onModel !== undefined && on === undefined;
    // Step 5's own answer, once Auto picks by my kind: its pick differs from the one it makes when every account runs.
    let kindStandIn: boolean | undefined;
    const standsIn = (chosen: ModelInfo): boolean => cannotRunOn || (kindStandIn ?? (previous?.standIn === true && chosen.id === onModel?.id));
    const decide = (chosen: { model: ModelInfo; accounts: Account[] }, by: RouteDecision['by'], reason: string, keptPrevious: boolean): RouteDecision => {
      // B-089: the origin of the effort rides on the decision (effortBy), so a run's stored route says where it came from
      // Runde „Halb“ 21.11.2026: no floor for a person's line – with nothing set and no weighing, an agent's turn runs at
      // medium and says so (previous.ts UNWEIGHED_EFFORT), a runtime helper call at its category's default.
      const start = startEffortBy(policy, previous, category, keptPrevious, !runtime);
      const notes = [...(leadNote ? [leadNote] : []), reason];
      // an effort someone asked for names whose it is – unless the whole route is my own request
      if (start.requested && (by !== BY_REQUEST || previous?.by)) notes.push(effortSource(previous));
      if (start.unweighed) notes.push(UNWEIGHED_TEXT);
      return {
        modelId: chosen.model.id, engine: chosen.model.engine, accountId: chosen.accounts[0].id, effort: clampEffort(start.effort, chosen.model.efforts), category,
        reason: notes.join(' · '), by: start.requested ? BY_REQUEST : by, effortBy: start.by,
        ...(standsIn(chosen.model) ? { standIn: true as const } : {}),
        alternatives: ranked.filter((entry) => entry.model.id !== chosen.model.id).slice(0, ALTERNATIVES).map((entry) => entry.model.id),
      };
    };

    // 1. Off a boundary the turn runs on the model its session is on; what asks for another waits for my next fresh
    //    context, and the reason names it. My own model.set with now moves it at once; a model that cannot run moves on below.
    if (request.boundary === false && !runtime) {
      if (on && !(asking && previous?.now)) {
        const usePin = settingsPin(settings, request);
        const wish = asking ? previous!.modelId : policy.pin?.modelId ?? usePin?.modelId;
        const waiting = wish ? resolvePin(models, wish) : undefined;
        const waits = waiting && waiting.id !== on.model.id ? `${waiting.name} from my next context` : undefined;
        return decide(on, 'previous', [ON_TEXT, waits, categoryLabel(category)].filter(Boolean).join(' · '), true);
      }
      if (!on && onModel) leadNote = cannotRun({ s, request, pool: candidates, named: onModel, category, now });
    }

    // 2. The start model runs when usable and I ask for nothing myself. It may leave the policy band and cost
    //    preferences; default pins stay inside the agent's band, and so does a start model the agent set itself
    //    (model.set), on the accounts Auto uses (pool.ts runs: pay-per-use keys only as a spill-over).
    //    `only`: the accounts that may run this pin (the helper default's plan logins); none left → undefined, no note.
    let fallbackReason: string | undefined;
    let failedPrice: number | undefined; // B-080: the list price of the first pin that cannot run now
    const tryPin = (pin: { modelId: string; source: keyof typeof PIN_TEXT; self?: true }, banded: boolean, only?: ReadonlySet<string>): RouteDecision | undefined => {
      const pinned = resolvePin(models, pin.modelId);
      let why = pinned ? unusable(pinned) : 'unavailable';
      if (!why && (banded || pin.self) && pinned && !inBand(pinned)) why = 'policy';
      const usable = pinned && !why ? (pin.self ? candidates.runs(pinned)?.accounts ?? [] : accountsFor(pinned)) : [];
      const accounts = usable.filter((account) => !only || only.has(account.id));
      if (pinned && accounts.length) {
        const reason = [fallbackReason, `${PIN_TEXT[pin.source]} · ${categoryLabel(category)}`].filter(Boolean).join(' · ');
        return decide({ model: pinned, accounts }, fallbackReason ? 'fallback' : 'pin', reason, onModel?.id === pinned.id);
      }
      if (only) return undefined;
      const unsuitable = why && why !== 'unavailable' ? why : undefined;
      if (pinned && !unsuitable) failedPrice ??= listPrice(pinned); // B-080: it cannot run now (not: unfit for this work)
      // 24.11.2026 (feedback 96AFD12B): a pin that only a pay-per-use key could run says so – the route line was silent on why.
      const paidOnly = pinned && !why && accountsFor(pinned).length > 0;
      fallbackReason ??= unsuitable ? `pinned model unsuitable (${pinProblem(unsuitable, category)})`
        : paidOnly ? `pinned model unavailable (${pinned.name}: only a pay-per-use key runs it)` : 'pinned model unavailable';
      return undefined;
    };
    const startPin = () => (policy.pin ? tryPin(policy.pin, false) : undefined);
    const pinned = !asking ? startPin() : undefined; // B-079: it yields to my own request
    if (pinned) return pinned;

    // 3. My own model.set: the kind of model I asked for, else the model I named.
    const need = runtime ? undefined : previous?.need;
    if (need) {
      const from = need.from ? models.find((model) => model.id === need.from) : undefined;
      const choice = needChoice({
        need: need.kind, from, category, cost: (entry: PoolEntry) => marginalCost(entry.model, entry.accounts[0], now),
        scope: pool, rank, costMode, named: previous?.modelId,
      });
      const entry = choice.named ?? choice.raised ?? choice.ranked[0];
      if (entry) {
        const lead = choice.raised ? raisedText(need.kind) : NEED_TEXT[need.kind];
        const decision = decide(entry, BY_REQUEST, [fallbackReason, `${lead} · ${categoryLabel(category)}`].filter(Boolean).join(' · '), entry.model.id === need.from);
        // stronger without a stronger model: one effort step up – unless the agent fixed its effort or asked for one.
        const lift = choice.raised && policy.agentEffort === undefined && previous?.asked === 'model';
        return lift ? { ...decision, effort: stepUpEffort(decision.effort, entry.model.efforts) } : decision;
      }
      leadNote = NO_FIT_TEXT[need.kind];
    }
    const named = !need && asking ? resolvePin(models, previous!.modelId) : undefined; // D5: older id forms too
    const runs = named ? candidates.entryFor(named) : undefined; // an older version I named runs as its family's newest
    const asked = runs ? ranked.find((entry) => entry.model.id === runs.model.id) : undefined;
    if (asked) return decide(asked, BY_REQUEST, [fallbackReason, `${MODEL_REQUESTED} · ${categoryLabel(category)}`].filter(Boolean).join(' · '), true); // same kind of work: my settled effort goes with me
    // D1: a model I named that cannot run now – my turn stays on the model it is on (its session and cache), else the strongest
    // model at least at its tier and at most its list price, else Auto below. The reason says first what I asked for and
    // why it cannot run.
    if (!need && asking) {
      leadNote = askedMiss({ s, request, pool: candidates, named, category, now });
      if (on) return decide(on, 'previous', `${ON_TEXT} · ${categoryLabel(category)}`, true);
      const like = named ? rank(standIns(listPrice(named), named.tier), 'best')[0] : undefined;
      if (like) return decide(like, BY_REQUEST, `${categoryLabel(category)} · strongest stand-in`, false);
    }
    // B-083: a request nothing meets leaves the start model in place.
    const started = asking ? startPin() : undefined;
    if (started) return started;

    // 4. The Settings use: agents the Work model (it stays inside the agent's band), runtime helper calls the Decisions
    //    model (it may leave the helper band); then helper calls take the helper default on its plan logins only.
    const usePin = settingsPin(settings, request);
    const byUse = usePin ? tryPin(usePin, !runtime) : undefined;
    if (byUse) return byUse;
    const helper = runtime ? helperDefault(s, request, candidates, models) : undefined;
    const byHelper = helper ? tryPin(helper, true, helper.accountIds) : undefined;
    if (helper && byHelper) return { ...byHelper, effort: clampEffort(helper.effort, resolvePin(models, helper.modelId)?.efforts ?? []) };

    // B-080/D3: a pin that cannot run now gets a stand-in from the strongest tier at most at its own list price (live
    // 07.11.: Sol at its limit → Opus max for hours; 08.11.: Luna or an unprofiled nano for an Opus or Terra pin in economy).
    // Auto chooses inside that set; my own model.set and the Settings Work model above choose freely. Nothing that
    // cheap connected → the whole pool runs.
    if (failedPrice !== undefined) {
      const within = standIns(failedPrice);
      if (within.length) { pool = within; ranked = rank(within, costMode); }
    }

    if (!ranked.length) throw nothingFits({ ...candidates, s, request, category, now });

    // A runtime helper call that nothing above answered: the best score.
    if (runtime) {
      const quick = fastest(s, ranked)!; // ranked is not empty here; a model measured fast stands before a better score that is not known fast
      const chosen = quick.entry;
      const why = chosen === ranked[0] ? ruleReason(chosen, category, costMode) : `measured fast (median ${((quick.median ?? 0) / 1000).toFixed(1)} s)`;
      return decide(chosen, fallbackReason ? 'fallback' : 'rules', [fallbackReason, `${categoryLabel(category)} · ${why}`].filter(Boolean).join(' · '), false);
    }

    // 5. Auto: the model I am on while it fits my kind – its tier, nothing else – and is not one I only stand on,
    //    an older version as its family's newest; else my kind's default. A part past its start stays where its session
    //    is; a fresh one that names no model starts on its origin's unless that is above what executing needs.
    const lead = !request.split && leads(s.org, request.agent); // a part executes
    const newest = onModel ? candidates.entryFor(onModel) : undefined;
    const mine = newest ? ranked.find((entry) => entry.model.id === newest.model.id) : undefined;
    const tier = kindTier(pool, lead, costMode);
    const fits = mine !== undefined && previous?.standIn !== true && ((request.split !== undefined && !request.split.fresh)
      || (request.split ? tierRank(mine.model.tier) <= tierRank(tier) : mine.model.tier === tier));
    if (mine && fits) {
      const kept = mine.model.id === onModel!.id;
      const why = kept ? (request.split?.fresh ? ORIGIN_TEXT : ON_TEXT) : `${mine.model.name} replaces ${onModel!.name}`;
      return decide(mine, fallbackReason ? 'fallback' : 'previous', [fallbackReason, why, categoryLabel(category)].filter(Boolean).join(' · '), kept);
    }
    const pick = kindDefault({ pool, rank, lead, costMode });
    if (!pick) throw nothingFits({ ...candidates, s, request, category, now });
    // My kind's own model was left out only because it cannot run now (a first turn in an outage too): the pick stands in.
    kindStandIn = kindDefault({ pool: candidates.whole(), rank, lead, costMode })?.entry.model.id !== pick.entry.model.id;
    return decide(pick.entry, fallbackReason ? 'fallback' : 'rules', [fallbackReason, pick.why, categoryLabel(category)].filter(Boolean).join(' · '), pick.entry.model.id === onModel?.id);
  }
}

function ruleReason(entry: Ranked, category: string, costMode: CostMode): string {
  if (strengthOf(entry.model, category) >= 0.5) return 'strongest fit';
  if (costMode === 'economy') return 'best value';
  if (costMode === 'best' && entry.model.tier === 'frontier') return 'top tier';
  return 'best fit';
}
