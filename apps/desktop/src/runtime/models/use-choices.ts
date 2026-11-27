// The values each model use can take right now (models.uses `choices`, what models.setUse takes): "auto" and "off" where a
// use has them, the plans that serve it (Work's best for each turn, the ChatGPT plan's images and dictation), this PC's
// local models (speech, the voice of a call, embeddings) and the connected models that serve the use (modelsFor, at most
// LISTED per use – models.list compares the rest). A local model carries how it fits this PC (memoryFit: a standard
// estimate from its usual memory and this PC's RAM – the speech models' figures, MiniLM's 500 MB, a local server's chat
// model by its size in the name; never a benchmark). Settings reads the fits for its hints; the AI reads all of it.
// Owns: that list. Never: changes a setting, calls a network or names a key.

import os from 'node:os';
import type { RuntimeServices } from '../contracts.ts';
import { accountCharge, LOCAL_PROVIDER_IDS } from '../../shared/model/charge.ts';
import { FIT_WORDS, localChatRamMb, memoryFit, type LocalSpeechOffer } from '../../shared/model/local-speech-models.ts';
import {
  modelsFor, MODEL_USES, OFFABLE_USES, PLAN_DICTATION, PLAN_DICTATION_NAME, USE_AUTO, USE_LOCAL, USE_OFF, voiceDefault, WORK_PLAN_PROVIDERS,
  type ModelUse, type UseChoice, type UseNow,
} from '../../shared/model/models-uses.ts';
import { modelOwner } from '../../shared/model/provider-entries.ts';
import type { Account, ModelInfo } from '../../shared/model/providers.ts';
import { LOCAL_EMBEDDING_NAME } from '../vectors/local-model.ts';
import { planAccount } from '../voice/plan-transcribe.ts';

/** Connected models listed per use. */
export const LISTED = 40;
/** MiniLM-L12 while it embeds (vectors/local-model.ts: 430–530 MB). */
const EMBEDDING_RAM_MB = 500;

const quiet = <T>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };

const fitted = (ramMb: number, totalMb: number): Pick<UseChoice, 'fit'> => ({ fit: memoryFit(ramMb, totalMb) });

function offerChoice(offer: LocalSpeechOffer): UseChoice {
  return { value: offer.id, label: offer.label, fit: offer.fit, note: `${offer.installed ? 'on this PC' : `${offer.downloadMb} MB download`} · ${FIT_WORDS[offer.fit]}` };
}

/** A connected model: its first account named; a local server's chat model with its fit. */
function modelChoice(model: ModelInfo, accounts: readonly Account[], totalMb: number): UseChoice {
  const account = accounts.find((entry) => entry.enabled && entry.provider === model.provider && (!model.accounts.length || model.accounts.includes(entry.id)));
  const ram = LOCAL_PROVIDER_IDS.has(model.provider) ? localChatRamMb(model.model) : undefined;
  const fit = ram !== undefined ? fitted(ram, totalMb) : {};
  const facts = [account?.label, fit.fit ? FIT_WORDS[fit.fit] : undefined].filter(Boolean).join(' · ');
  return { value: model.id, label: model.name || model.model, ...fit, ...(facts ? { note: facts } : {}) };
}

/** Every use's choices now; `now` is models.uses' answer (which uses this PC can serve). */
export function useChoices(s: RuntimeServices, now: readonly UseNow[], totalMb = Math.round(os.totalmem() / 1_048_576)): Record<ModelUse, UseChoice[]> {
  const models = quiet(() => s.catalog.list(), [] as ModelInfo[]);
  const accounts = quiet(() => s.accounts.list(), [] as Account[]);
  const offers = quiet(() => s.stt.localModels().models, [] as LocalSpeechOffer[]);
  const entries = quiet(() => s.settings.get().providers, undefined);
  const plans = accounts.filter((account) => account.enabled && account.auth === 'cli' && accountCharge(account) === 'plan');
  const dictation = quiet(() => planAccount(s), undefined);
  const out = {} as Record<ModelUse, UseChoice[]>;
  for (const use of MODEL_USES) {
    const list: UseChoice[] = [{ value: USE_AUTO, label: 'Nothing picked: what is there' }];
    if (OFFABLE_USES.has(use)) list.push({ value: USE_OFF, label: 'Off' });
    if (use === 'work') for (const plan of plans.filter((entry) => WORK_PLAN_PROVIDERS.includes(entry.provider))) list.push({ value: plan.provider, label: `${plan.label}: its best model for each turn` });
    if (use === 'image' && plans.some((entry) => entry.provider === 'codex')) list.push({ value: 'codex', label: 'GPT Image on the ChatGPT plan' });
    if (use === 'stt' && dictation) list.push({ value: PLAN_DICTATION, label: PLAN_DICTATION_NAME, note: dictation.label });
    if (use === 'stt' || use === 'tts') list.push(...offers.filter((offer) => offer.purpose === use).map(offerChoice));
    if (use === 'tts' || use === 'speech') list.push({ value: USE_LOCAL, label: 'This PC\'s voice' });
    if (use === 'voice') list.push({ value: USE_LOCAL, label: 'This PC: hears with Speech to text, speaks with Text to speech' });
    if (use === 'embeddings' && now.find((entry) => entry.use === 'embeddings')?.thisPc) list.push({ value: USE_LOCAL, label: LOCAL_EMBEDDING_NAME, ...fitted(EMBEDDING_RAM_MB, totalMb), note: `this PC · ${FIT_WORDS[memoryFit(EMBEDDING_RAM_MB, totalMb)]}` });
    const served = modelsFor(use, models);
    list.push(...served.slice(0, LISTED).map((model) => modelChoice(model, accounts, totalMb)));
    if (use === 'voice') {
      // a key that talks in real time while its server lists no such model (shared/model/models-uses.ts VOICE_DEFAULTS)
      for (const account of accounts.filter((entry) => entry.enabled && (entry.auth === 'api_key' || entry.auth === 'env') && voiceDefault(entry.provider))) {
        const value = `${modelOwner(account, entries)}:${voiceDefault(account.provider)}`;
        if (!list.some((choice) => choice.value === value)) list.push({ value, label: voiceDefault(account.provider)!, note: account.label });
      }
    }
    out[use] = list;
  }
  return out;
}
