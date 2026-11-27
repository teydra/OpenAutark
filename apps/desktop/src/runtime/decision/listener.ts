// MM10: createListener – the one-shot helper turn of engine-runner.ts with one recording (media.listen) on a model
// that hears audio (caps.audioIn; while the catalog does not say, a known listening family).
// Recordings go through the compatible chat adapter (input_audio): compatible models, and
// OpenAI API models, whose API speaks the same chat completions. B-058 G7: a plan CLI model whose
// catalog entry says it hears audio (caps.audioIn – Codex inputModalities, an ACP agent's audio
// capability) listens on its own engine (Codex localAudio, ACP audio blocks); no name guess there.
// Every other model is excluded from the route, and `avoid` keeps accounts out; 0.3.22: so is a connection whose
// settings.json entry names only other uses than work or decisions for its models (a voice key). Pay-per-use accounts listen only with
// `allowPaid` (media.listen: listenOptions says whether the route may pick one); without it they are excluded and a routed one is refused before the
// call, also one that became usable while the router worked. Category 'cheap-chat' (economy)
// until routing knows 'audio-analysis' (models/priors.ts CATEGORIES).
// Owns: which models can listen, what listening can run on now, and the listening turn.
// Never: a recording sent to a model that cannot hear it, or to a pay-per-use account without allowPaid.

import type { Account, EngineId, ModelInfo } from '../../shared/model/providers.ts';
import type { AccountService, ModelCatalog, SettingsService } from '../contracts.ts';
import { accountCharge } from '../../shared/model/charge.ts';
import { servesAuto, type ProviderEntries } from '../../shared/model/provider-entries.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { callSignal, routeHelper, runOnce, type EngineRunnerDeps } from './engine-runner.ts';

export const NO_LISTENER = 'No connected model can listen to recordings. Connect one that hears audio in Settings › Models – for example Gemini (a Google API key or OpenRouter) or GPT-4o audio (an OpenAI API key); a local server works when its model hears audio.';
export const PAID_OFF = 'Listening now needs a pay-per-use account, and pay-per-use fallback is off here.';

/** Engines whose models reach the compatible chat adapter (OpenAI: the same chat completions API). */
const LISTEN_ENGINES: ReadonlySet<EngineId> = new Set(['compatible', 'openai']);
/** B-058 G7: plan CLI engines that send a recording themselves – only for a model the catalog says hears audio. */
const OWN_AUDIO_ENGINES: ReadonlySet<EngineId> = new Set(['codex', 'acp']);

/** Families that hear audio through chat completions, for models whose catalog entry has no audioIn flag. */
const KNOWN_LISTENERS = /(?:^|[/:])(?:gpt-4o(?:-mini)?-audio|gpt-audio|gemini-(?![\w.-]*(?:embed|tts|image|live|omni|nano-banana))|voxtral|qwen[\w.-]*omni|phi-4-multimodal)/i;

/** Can this model hear a recording (input_audio, or its CLI engine's own audio input)? Media function specialists (FN1) never chat. */
export function hearsAudio(model: Pick<ModelInfo, 'engine' | 'model' | 'caps' | 'functions'>): boolean {
  if (model.functions?.length) return false;
  if (OWN_AUDIO_ENGINES.has(model.engine)) return model.caps.audioIn === true;
  if (!LISTEN_ENGINES.has(model.engine)) return false;
  return model.caps.audioIn ?? KNOWN_LISTENERS.test(model.model);
}

/** The engine a listening turn runs on: the CLI's own for Codex/ACP models, else the compatible chat adapter. */
export function listenEngine(model: Pick<ModelInfo, 'engine'>): EngineId {
  return OWN_AUDIO_ENGINES.has(model.engine) ? model.engine : 'compatible';
}

export interface ListenerDeps extends Omit<EngineRunnerDeps, 'accounts' | 'catalog'> {
  accounts: Pick<AccountService, 'get' | 'candidates'>;
  catalog: Pick<ModelCatalog, 'get' | 'list'>;
  settings: Pick<SettingsService, 'get'>;
}

export interface ListenOptions {
  /** Connected models that can hear a recording. */
  models: ModelInfo[];
  /** Pay-per-use accounts that can run one of them. */
  paid: Account[];
  /** A free (local) or plan account can run one of them. */
  free: boolean;
  /** The route may pick one of `paid`: Settings allow the paid spill-over, or nothing else can listen (routing/pool.ts). */
  mayPay: boolean;
  /** Accounts kept out because their settings.json entry names other uses for its models. */
  scoped?: string[];
}

function canListen(id: string, model: string, entries: ProviderEntries | undefined): boolean {
  return servesAuto({ id }, entries, 'work', model) || servesAuto({ id }, entries, 'decision', model);
}

function providerEntries(deps: Pick<ListenerDeps, 'settings'>): ProviderEntries | undefined {
  try { return deps.settings.get().providers; } catch { return undefined; }
}

/** What listening can run on right now (cheap: no network). */
export function listenOptions(deps: Pick<ListenerDeps, 'accounts' | 'catalog' | 'settings'>): ListenOptions {
  const entries = providerEntries(deps);
  // Listening is a chat turn: models scoped to other uses stay out.
  const models = deps.catalog.list().filter((model) => model.available && hearsAudio(model) &&
    (!model.accounts.length || model.accounts.some((id) => canListen(id, model.model, entries))));
  const paid = new Map<string, Account>();
  const scoped = new Set<string>();
  const eligible = new Set<string>();
  let free = false;
  for (const model of models) {
    for (const account of deps.accounts.candidates(model.engine, model.model)) {
      if (account.provider !== model.provider || (model.accounts.length && !model.accounts.includes(account.id))) continue;
      if (!canListen(account.id, model.model, entries)) { scoped.add(account.id); continue; }
      eligible.add(account.id);
      if (accountCharge(account) === 'paid') paid.set(account.id, account);
      else free = true;
    }
  }
  let allowPaid = false;
  try { allowPaid = deps.settings.get().routing.allowPaidFallback; } catch { allowPaid = false; }
  for (const id of eligible) scoped.delete(id);
  return { models, paid: [...paid.values()], free, mayPay: paid.size > 0 && (allowPaid || !free), ...(scoped.size ? { scoped: [...scoped] } : {}) };
}

export interface ListenInput {
  audio: { path: string; name: string; mime: string };
  system: string;
  prompt: string;
  /**
   * A pay-per-use account may listen (listenOptions mayPay). Without it
   * they are kept out of the route, and a route to one (an account that became usable while the
   * router worked) is refused with PAID_OFF before anything is sent.
   */
  allowPaid: boolean;
  /** Account ids the turn may not use. */
  avoid?: readonly string[];
  signal?: AbortSignal;
}

export interface Heard {
  text: string;
  modelId: string;
  /** The turn ran on a pay-per-use account (shared/model/charge.ts accountCharge). */
  paid: boolean;
  /** The provider's own price of the turn (OpenRouter), when it reported one. */
  costUsd?: number;
}

export type Listener = (input: ListenInput) => Promise<Heard>;

/**
 * One listening turn. Fails with a user-safe WorkforceError: NO_LISTENER without a model,
 * PAID_OFF when only a pay-per-use account could listen and `allowPaid` is not set, the
 * router's reason when none can run now, or the engine's error with details { modelId, paid,
 * billed } – billed: the provider reported tokens, so a paid turn was charged.
 */
export function createListener(deps: ListenerDeps): Listener {
  return async ({ audio, system, prompt, allowPaid, avoid = [], signal }) => {
    const options = listenOptions(deps);
    const hearing = new Set(options.models.map((model) => model.id));
    if (!hearing.size) throw new WorkforceError('unavailable', NO_LISTENER, { details: { setup: true } });
    const keepOut = [...(allowPaid ? avoid : [...avoid, ...options.paid.map((account) => account.id)]), ...(options.scoped ?? [])];
    const exclude = [...deps.catalog.list().filter((model) => !hearing.has(model.id)).map((model) => model.id), ...keepOut];
    const route = await routeHelper(deps, 'listen', { exclude });
    const account = deps.accounts.get(route.accountId);
    const model = deps.catalog.get(route.modelId);
    if (!account || !model || !hearing.has(model.id) || !canListen(account.id, model.model, providerEntries(deps))) throw new WorkforceError('unavailable', NO_LISTENER);
    const paid = accountCharge(account) === 'paid';
    if (paid && !allowPaid) throw new WorkforceError('unavailable', PAID_OFF, { details: { modelId: model.id, paid: false, billed: false } });
    const result = await runOnce(deps, listenEngine(model), { account, model: model.model, effort: route.effort }, {
      system, input: [{ type: 'text', text: prompt }, { type: 'audio', ...audio }], signal: callSignal(deps, signal),
    });
    const costUsd = result.usage?.costUsd;
    if (result.stop !== 'done') {
      const billed = (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0) > 0;
      const code = result.stop === 'interrupted' ? 'cancelled' : result.error?.code ?? 'internal';
      throw new WorkforceError(code, result.error?.message ?? 'The model could not listen to the recording.', {
        retryAfterMs: result.error?.retryAfterMs, details: { modelId: model.id, paid, billed, ...(costUsd !== undefined ? { costUsd } : {}) },
      });
    }
    return { text: result.text, modelId: model.id, paid, ...(costUsd !== undefined ? { costUsd } : {}) };
  };
}
