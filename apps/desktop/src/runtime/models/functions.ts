// Function models: which catalog model and account serve a media function (speech to text, text
// to speech, image, video, music) – the one resolver every consumer uses (transcription today,
// media generation later).
// Owns: the rule "the Settings choice (the use routing.<fn>, shared/model/models-uses.ts) while it is still available, else
// the first available specialist" (shared/model/providers.ts functionCandidates) plus the account
// pick: healthy accounts of that model, free/local ones before pay-per-use keys. Without a choice
// the router's money rule applies too: specialists reachable on a free connection (local runtime,
// plan, keyless server) come before API keys, and API keys are skipped entirely while a free one
// exists and routing.allowPaidFallback is off. A Settings choice keeps its (possibly paid) account. 0.3.22: the
// automatic order passes over a connection whose settings.json entry names other uses for its models (servesAuto), and
// media.speak reads its own use, Speech, which follows Text to speech while it is "auto".
// Never: routes chat turns (the router does), reads keys, or picks a general chat model.

import type { RuntimeServices } from '../contracts.ts';
import { functionCandidates, type Account, type ModelFunction, type ModelInfo, type ProviderId } from '../../shared/model/providers.ts';
import { accountCharge } from '../../shared/model/charge.ts';
import { PLAN_DICTATION, routeUse, useValue, USE_AUTO, USE_LOCAL, USE_OFF, type ModelUse } from '../../shared/model/models-uses.ts';
import { servesAuto } from '../../shared/model/provider-entries.ts';
import { runnableAccounts, spillOver } from '../routing/pool.ts';

export interface FunctionModel {
  modelId: string;
  accountId: string;
  provider: ProviderId;
  /** Provider model id sent to the endpoint (e.g. "whisper-1"). */
  model: string;
  /** 'settings' = the person's choice; 'auto' = first available specialist. */
  source: 'settings' | 'auto';
}

export interface FunctionStatus {
  choice?: FunctionModel;
  /** The stored choice (routing.<fn>), when there is one. */
  setting?: string;
  /** A choice is stored but not usable right now (unavailable or not a model for this function). */
  settingUnavailable: boolean;
  /** routing.<fn> === 'off'. */
  off: boolean;
}

type Services = Pick<RuntimeServices, 'catalog' | 'accounts' | 'settings'>;

/** Pay-per-use connection (API key, key from the environment, CLI signed in with an API key); local runtimes and plans are free at the margin. */
const paid = (account: Account) => accountCharge(account) === 'paid';

/** Healthy accounts that can run this catalog model (routing/pool.ts), free ones first (stable within each group). */
function accountsFor(s: Services, model: ModelInfo): Account[] {
  const usable = runnableAccounts(s, model);
  return [...usable.filter((account) => !paid(account)), ...usable.filter(paid)];
}

type Reachable = { model: ModelInfo; source: 'settings' | 'auto'; accounts: Account[] };

/** Automatic candidates under the money rule: free connections first, API keys only as spill-over. */
function autoOrder(candidates: Reachable[], allowPaid: boolean): Reachable[] {
  const pool = spillOver(candidates, allowPaid).entries;
  // accountsFor lists free accounts first, so accounts[0] is paid only when the model has no free one.
  return [...pool.filter((entry) => !paid(entry.accounts[0])), ...pool.filter((entry) => paid(entry.accounts[0]))];
}

/**
 * Resolution with the reasons a caller needs for a clear message. `use` is the use whose value counts (default the
 * function's own; media.speak: 'speech', which follows Text to speech while it is "auto" – models-uses.ts routeUse).
 * The automatic order skips accounts whose settings.json entry names other uses for its models (provider-entries.ts servesAuto).
 */
export function functionStatus(s: Services, fn: ModelFunction, use: ModelUse = fn): FunctionStatus {
  const settings = s.settings.get();
  const routing = settings.routing;
  const effectiveUse = routeUse(routing, use);
  const value = useValue(routing, effectiveUse);
  const off = value === USE_OFF;
  // stt "codex" (the plan's dictation) and "local" (this PC's model) name no function model: after them the automatic order
  const setting = value === USE_AUTO || (fn === 'stt' && (value === PLAN_DICTATION || value === USE_LOCAL)) ? undefined : value;
  let models: ModelInfo[];
  try { models = s.catalog.list(); } catch { models = []; }
  const reachable: Reachable[] = functionCandidates(fn, setting, models)
    .map((candidate) => ({
      ...candidate,
      accounts: accountsFor(s, candidate.model).filter((account) => candidate.source === 'settings' || servesAuto(account, settings.providers, effectiveUse, candidate.model.model)),
    }))
    .filter((candidate) => candidate.accounts.length > 0);
  const chosen = reachable.find((candidate) => candidate.source === 'settings');
  const pick = chosen ?? autoOrder(reachable.filter((candidate) => candidate.source === 'auto'), Boolean(routing.allowPaidFallback))[0];
  const choice: FunctionModel | undefined = pick
    ? { modelId: pick.model.id, accountId: pick.accounts[0].id, provider: pick.model.provider, model: pick.model.model, source: pick.source }
    : undefined;
  return { choice, setting, settingUnavailable: Boolean(setting) && !off && !chosen, off };
}

