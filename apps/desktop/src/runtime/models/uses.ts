// What each model use resolves to right now (models.uses), through the resolvers the work itself goes through: the
// router for Work and Decisions, calls/realtime for Voice, the speech order and generate-route's routes for the media
// uses, models/embeddings.ts for Embeddings. Settings' selects show this, so a person sees the model that really runs,
// also while the file says "auto". Decisions without a decision connection name the chat model that stands in, as one
// step left ('setup', "Set up with AI"). The state and the one action of a media use come from the abilities
// overview (runtime/abilities/**), which keeps its own rules for the AI's abilities.status. 21.11.2026: Speech to text names
// the ChatGPT plan's dictation first while routing.stt is "auto" or "codex" and a plan login is here (the order
// voice/transcribe.ts hears in), and says so when Codex is signed in on this PC but not used here yet; a call on this
// PC's speech names the model it hears with; every use carries its choices (use-choices.ts). 0.3.22: Text to speech and
// Speech each resolve by their own value (Speech by Text to speech's while it is "auto"); Voice "local" is this PC's speech.
// Owns: mapping those answers onto UseNow. Never: decides a route itself, changes anything, or calls a network (the
// router may refresh an empty catalog once, as for a turn).

import type { RuntimeServices } from '../contracts.ts';
import type { Ability, AbilityAction, AbilityId } from '../../shared/model/abilities.ts';
import { accountCharge } from '../../shared/model/charge.ts';
import { localSpeechModel } from '../../shared/model/local-speech-models.ts';
import { callsOnThisPc, isProviderChoice, MODEL_USES, PLAN_DICTATION, PLAN_DICTATION_NAME, planHears, useValue, USE_AUTO, USE_LOCAL, USE_OFF, type ModelUse, type UseNow } from '../../shared/model/models-uses.ts';
import { planAccount } from '../voice/plan-transcribe.ts';
import { useChoices } from './use-choices.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { RouteDecision } from '../../shared/model/providers.ts';
import { modelOwner } from '../../shared/model/provider-entries.ts';
import { abilityFacts } from '../abilities/facts.ts';
import { decisionConnection } from '../decision/systemone.ts';
import { resolvePin } from '../routing/pins.ts';
import { abilityList } from '../abilities/status.ts';
import { chosenRealtime, realtimeChoice } from '../calls/realtime/setup.ts';
import { routeHelper, runtimeAgent } from '../decision/engine-runner.ts';
import { listenOptions } from '../decision/listener.ts';
import { routesFor } from '../media/generate-route.ts';
import type { GenerationKind } from '../media/providers/types.ts';
import { GENERAL_MODE } from '../modes/service.ts';
import { isDecisionModelName } from './catalog-merge.ts';
import { LOCAL_EMBEDDING_NAME, LocalEmbedder } from '../vectors/local-model.ts';
import { embeddingChoice } from './embeddings.ts';
import { functionStatus } from './functions.ts';

type Resolved = Omit<UseNow, 'use' | 'stored' | 'state'>;

const quiet = <T>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };
const NONE: Resolved = { kind: 'none' };
const OFF: Resolved = { kind: 'off' };
const SET_UP_WITH_AI: AbilityAction = { kind: 'ai', label: 'Set up with AI', target: 'decision' };

/** The ability that holds a media use's state and action. */
const ABILITY_OF: Partial<Record<ModelUse, AbilityId>> = { stt: 'hear-speech', tts: 'speak', speech: 'speak', image: 'make-images', music: 'make-music', sound: 'make-sounds', video: 'make-video' };
const KIND_OF: Partial<Record<ModelUse, GenerationKind>> = { tts: 'speech', speech: 'speech', image: 'image', music: 'music', sound: 'sound', video: 'video' };

/** Work is routed for a plain agent: no agent's or chat's own choice, the same rules a turn goes through. */
function plainAgent(now: number): Agent {
  return { ...runtimeAgent(now, true), id: 'ag_uses', name: 'Any agent', modelPolicy: {} };
}

function shown(s: RuntimeServices, modelId: string): { modelId: string; name: string } {
  const model = quiet(() => s.catalog.get(modelId), undefined);
  return { modelId, name: model?.name ?? modelId };
}

async function routedUse(s: RuntimeServices, use: 'work' | 'decision', stored: string): Promise<Resolved> {
  const connection = use === 'decision' ? quiet(() => decisionConnection(s), undefined) : undefined;
  if (connection) return { kind: 'model', accountId: connection.account.id, modelId: `${connection.account.id}:${connection.model}`, name: connection.model };
  const route = async (): Promise<RouteDecision> => use === 'work'
    ? s.router.route({ agent: plainAgent(s.clock.now()), mode: GENERAL_MODE, text: '' })
    : routeHelper({ router: s.router, clock: s.clock }, 'Which model decides', {});
  let decision: RouteDecision;
  try { decision = await route(); } catch { return { ...NONE, ...(stored === USE_AUTO ? {} : { gone: stored }) }; }
  const account = quiet(() => s.accounts.get(decision.accountId), undefined);
  const named = stored === USE_AUTO ? undefined : stored;
  // a plan on Work picks its best fit for each turn, by choice or while nothing is picked; a named model is that model
  const perTurn = use === 'work' && account !== undefined && accountCharge(account) === 'plan' && (!named || account.provider === named);
  const picked = named && !isProviderChoice(named) ? quiet(() => resolvePin(s.catalog.list(), named)?.id, undefined) : undefined; // also an older "<provider>:<model>"
  const gone = named && !(isProviderChoice(named) ? account?.provider === named : decision.modelId === named || decision.modelId === picked || decision.modelId.endsWith(`:${named}`)) ? named : undefined;
  const model = shown(s, decision.modelId);
  // no decision connection: a chat model answers the small calls in its place – said so, with the AI one step away
  const standIn = use === 'decision' && !isDecisionModelName(decision.modelId.slice(decision.modelId.indexOf(':') + 1))
    ? { note: `No decision model yet – ${model.name}, a chat model, answers these calls`, action: SET_UP_WITH_AI } : {};
  return {
    kind: perTurn ? 'plan' : 'model', accountId: decision.accountId, ...model,
    ...(perTurn ? { modelId: account!.provider } : {}), ...(gone ? { gone } : {}), ...standIn,
  };
}

function voiceUse(s: RuntimeServices, stored: string): Resolved {
  // on this PC's speech (realtime off, or Voice "local") the name is filled in by modelUses (the stt and tts models)
  if (quiet(() => callsOnThisPc(s.settings.get()), true)) return { kind: 'this-pc', thisPc: true };
  const choice = realtimeChoice(s);
  const wanted = chosenRealtime(stored);
  const served = choice && wanted && choice.model === wanted.model && (choice.account.id === wanted.owner || choice.account.provider === wanted.owner);
  const gone = stored !== USE_AUTO && !served ? { gone: stored } : {};
  // no realtime model: a call goes on in this PC's speech (ui/chat/call/CallHeader.tsx)
  if (!choice) return { kind: 'this-pc', thisPc: true, ...gone };
  return { kind: 'model', accountId: choice.account.id, modelId: `${modelOwner(choice.account, quiet(() => s.settings.get().providers, undefined))}:${choice.model}`, name: choice.model, thisPc: true, ...gone };
}

/** A Codex login this PC found that is no account here yet (accounts/adoption.ts: only offered until "Use"). */
const FOUND_CODEX = 'Codex is signed in on this PC – Use it under the plans above and dictation goes through the ChatGPT plan';

function sttUse(s: RuntimeServices, stored: string, facts: ReturnType<typeof abilityFacts>): Resolved {
  const thisPc = facts.engine;
  // the order transcribe.ts hears in: the plan's dictation first while nothing or the plan is picked, then this PC's model
  const plan = planHears({ stt: stored }) ? quiet(() => planAccount(s), undefined) : undefined;
  if (plan) return { kind: 'plan', accountId: plan.id, modelId: PLAN_DICTATION, name: PLAN_DICTATION_NAME, thisPc };
  const found = stored === USE_AUTO && quiet(() => s.accounts.lastDetection?.()?.found?.some((entry) => entry.provider === 'codex' && entry.where === 'this-pc' && !entry.declined), false);
  const resolved = sttLocalOrService(s, stored, facts);
  return found ? { ...resolved, note: FOUND_CODEX } : stored === PLAN_DICTATION ? { ...resolved, gone: PLAN_DICTATION_NAME } : resolved;
}

function sttLocalOrService(s: RuntimeServices, stored: string, facts: ReturnType<typeof abilityFacts>): Resolved {
  const thisPc = facts.engine;
  if (facts.stt && facts.engine) return { kind: 'this-pc', modelId: facts.stt.id, name: facts.stt.label, thisPc };
  const status = quiet(() => functionStatus(s, 'stt'), { settingUnavailable: false, off: false } as ReturnType<typeof functionStatus>);
  if (status.off) return { ...OFF, thisPc };
  const gone = status.settingUnavailable ? { gone: stored } : {};
  if (status.choice) return { kind: 'model', accountId: status.choice.accountId, ...shown(s, status.choice.modelId), thisPc, ...gone };
  const listener = quiet(() => listenOptions(s).models[0], undefined);
  const account = listener ? quiet(() => s.accounts.candidates(listener.engine, listener.model)[0], undefined) : undefined;
  if (listener && account) return { kind: 'model', accountId: account.id, modelId: listener.id, name: listener.name, thisPc, ...gone };
  return { ...NONE, thisPc, ...gone };
}

function madeUse(s: RuntimeServices, use: ModelUse, stored: string, thisPc: boolean): Resolved {
  // each row by its own value: Text to speech by routing.tts, Speech by routing.speech (Text to speech's while "auto")
  const routes = quiet(() => routesFor(s, KIND_OF[use]!, use), {});
  const first = routes.first;
  const pc = use === 'tts' || use === 'speech' ? { thisPc } : {};
  if (first?.via === 'model') {
    const older = `${first.target.account.provider}:${first.target.model}`; // a connection that now names itself
    const named = stored !== USE_AUTO && first.target.modelId !== stored && first.target.model !== stored && older !== stored ? { gone: stored } : {};
    return { kind: 'model', accountId: first.target.account.id, ...shown(s, first.target.modelId), ...pc, ...named };
  }
  const standIn = routes.note ? { gone: stored } : {}; // the chosen model cannot serve, the free route takes over
  if (first?.via === 'plan') return { kind: 'plan', accountId: first.account.id, modelId: 'codex', name: 'GPT Image', ...pc, ...standIn };
  if (first?.via === 'local') {
    const voiceId = quiet(() => s.settings.get().voice?.localTts, undefined);
    const offers = quiet(() => s.stt.localModels().models, []).filter((offer) => offer.purpose === 'tts');
    // the order generate-local.ts speaks in: the chosen voice while it is here, else one that is here, else the one it fetches
    const voice = offers.find((offer) => offer.id === voiceId && offer.installed) ?? offers.find((offer) => offer.installed) ?? offers.find((offer) => offer.recommended) ?? offers[0];
    return { kind: 'this-pc', ...(voice ? { modelId: voice.id, name: localSpeechModel(voice.id)?.label ?? voice.label } : {}), ...pc, ...standIn };
  }
  if (stored === USE_OFF) return { ...OFF, ...pc };
  return { ...NONE, ...pc, ...(stored === USE_AUTO || stored === USE_LOCAL ? {} : { gone: stored }) };
}

function embeddingsUse(s: RuntimeServices, stored: string): Resolved {
  const possible = quiet(() => new LocalEmbedder({ dataDir: s.paths.data }).possible(), false);
  if (stored === USE_OFF || stored === USE_AUTO) return { ...OFF, thisPc: possible }; // nothing chosen: finding goes by words
  const choice = quiet(() => embeddingChoice(s, possible), undefined);
  if (choice?.kind === 'local') return { kind: 'this-pc', modelId: USE_LOCAL, name: LOCAL_EMBEDDING_NAME, thisPc: possible };
  if (choice?.kind === 'http') {
    const account = quiet(() => s.accounts.get(choice.accountId), undefined);
    const modelId = `${account ? modelOwner(account, quiet(() => s.settings.get().providers, undefined)) : choice.provider}:${choice.model}`;
    return { kind: 'model', accountId: choice.accountId, modelId, name: choice.model, thisPc: possible };
  }
  return { ...NONE, thisPc: possible, gone: stored };
}

const STATE_OF: Readonly<Record<UseNow['kind'], UseNow['state']>> = { model: 'ready', plan: 'ready', 'this-pc': 'ready', off: 'off', none: 'setup' };

/** The row's state, note and action: a media use's from its ability, the rest from what it resolves to (an action left: one step). */
function finish(use: ModelUse, stored: string, now: Resolved, ability: Ability | undefined): UseNow {
  // an account chosen on purpose, or the plan's dictation: nothing left to do
  const picked = (now.kind === 'model' && stored !== USE_AUTO && !now.gone) || (use === 'stt' && now.kind === 'plan');
  const useAbility = ability && !picked && now.kind !== 'off';
  return {
    ...now, use, stored, state: useAbility ? ability.state : now.action ? 'setup' : STATE_OF[now.kind],
    ...(useAbility && ability.note && !now.note ? { note: ability.note } : {}),
    ...(useAbility && ability.action ? { action: ability.action } : {}),
  };
}

/** Every use now, in MODEL_USES order. */
export async function modelUses(s: RuntimeServices): Promise<UseNow[]> {
  const routing = s.settings.get().routing;
  const facts = abilityFacts(s);
  const abilities = new Map(abilityList(facts).map((ability) => [ability.id, ability]));
  const stored = (use: ModelUse) => useValue(routing, use);
  const answer = async (use: ModelUse): Promise<UseNow> => {
    const value = stored(use);
    const now = use === 'work' || use === 'decision' ? await routedUse(s, use, value)
      : use === 'voice' ? voiceUse(s, value)
        : use === 'stt' ? sttUse(s, value, facts)
          : use === 'embeddings' ? embeddingsUse(s, value)
            : madeUse(s, use, value, facts.engine);
    const id = ABILITY_OF[use];
    return finish(use, value, now, id ? abilities.get(id) : undefined);
  };
  const list = await Promise.all(MODEL_USES.map(answer));
  // A call on this PC's speech hears and speaks with the stt and tts models: name those, not a mode word (B-072).
  // 21.11.2026: its model cell is the model it hears with, so the row can change it like Speech to text's.
  const named = (use: ModelUse) => list.find((now) => now.use === use && now.kind !== 'none' && now.kind !== 'off');
  const hears = named('stt');
  const speech = [hears?.name, named('tts')?.name].filter(Boolean).join(' + ');
  const heard = hears && (hears.kind === 'plan' || hears.kind === 'this-pc') && hears.modelId ? { modelId: hears.modelId } : {};
  const choices = useChoices(s, list);
  return list.map((now) => {
    const call = now.use === 'voice' && now.kind === 'this-pc' && !now.name ? { ...(speech ? { name: speech } : {}), ...heard } : {};
    return { ...now, ...call, choices: choices[now.use] };
  });
}
