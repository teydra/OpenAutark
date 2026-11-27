// The model uses (owner 01.11.2026: "Provider, dann API-Key, dann KI-Modelle … wo man das jeweilige wählen kann, was
// man für das jeweilige braucht"): one short fixed list of purposes, each stored in settings.json's Models section
// (routing.<use>): "auto" while nothing is picked yet (the runtime takes what is there; Settings shows what that is,
// models.uses), or a model of any connection. Work = every agent turn (a model id, or a plan's
// provider id such as "codex" = that plan's best model for each turn); Decisions = small fast calls (choices,
// sorting, summaries, compaction); Voice = realtime conversations; stt … sound = the media functions ("off" turns
// one off; tts "local" = the local voice, image "codex" = the ChatGPT plan; stt "auto" and "codex" = the ChatGPT plan's
// dictation first while its login is here, "local" = this PC's model first – 21.11.2026); Embeddings = what vector.embed and vector.search embed with ("off" turns them off, "local" = this PC's small model). What a use resolves to is the runtime's job (routing/pins.ts, models/functions.ts, calls/realtime, models/uses.ts says it).
// 0.3.22 (Konrad 27.11.2026): Speech is what media.speak makes (voiceovers, narration), apart from Text to speech, the voice
// that reads replies aloud and speaks in calls; while Speech is "auto" it follows Text to speech (routeValue), so a stored
// setting does what it did. Voice "local" = a call on this PC's speech, held while a realtime key is connected.
// Owns: the list, its labels and texts, which models serve which use and the one mapping of a use's value onto settings
// (useWrite). Never: reads settings or the catalog itself, or decides a route.

import type { AbilityAction, AbilityState } from './abilities.ts';
import type { LocalSpeechOffer } from './local-speech-models.ts';
import type { ModelInfo, ProviderId } from './providers.ts';
import type { RoutingSettings, VoiceSettings } from './system.ts';

export const MODEL_USES = ['work', 'decision', 'voice', 'stt', 'tts', 'speech', 'image', 'video', 'music', 'sound', 'embeddings'] as const;
export type ModelUse = (typeof MODEL_USES)[number];

/** The use whose value a use takes while it stands on "auto": Speech (media.speak) speaks with Text to speech's choice. */
const FOLLOWS: Partial<Record<ModelUse, ModelUse>> = { speech: 'tts' };

/** The use a model's `uses` or a function stands for: Speech and Text to speech both take speech models ('tts'). */
export function speechAsTts<T extends string>(use: T): Exclude<T, 'speech'> | 'tts' {
  return (use === 'speech' ? 'tts' : use) as Exclude<T, 'speech'> | 'tts';
}

/** Nothing picked yet: the runtime takes what is there. */
export const USE_AUTO = 'auto';
/** A media use (or embeddings) turned off. */
export const USE_OFF = 'off';
/** This PC's own model, as a stored value (embeddings; tts: the local voice). */
export const USE_LOCAL = 'local';
/** The stored value that names a kind's free route (media/generate-route.ts). */
export const FREE_ROUTE_CHOICE = { speech: USE_LOCAL, image: 'codex' } as const;
/** routing.stt: the ChatGPT plan's dictation (voice/plan-transcribe.ts) – also what "auto" takes first while a plan login is here. */
export const PLAN_DICTATION = 'codex';
export const PLAN_DICTATION_NAME = 'ChatGPT dictation';

/** The plan writes a dictation down first: nothing picked, or the plan picked ("local" or a model: that one first). */
export function planHears(routing: unknown): boolean {
  const value = useValue(routing, 'stt');
  return value === USE_AUTO || value === PLAN_DICTATION;
}

/** One value a use can take, for the AI (models.uses `choices`; models.setUse takes `value`) and the fit hints in Settings. */
export interface UseChoice {
  value: string;
  label: string;
  /** A local model: how it fits this PC (local-speech-models.ts memoryFit). */
  fit?: 'good' | 'tight' | 'too-big';
  /** One short fact: "on this PC", "650 MB download", the account. */
  note?: string;
}

/**
 * What a use resolves to right now (models.uses, runtime/models/uses.ts) – what Settings' selects show.
 * 'model': a model on an account; 'plan': a plan account's best fit for each turn, or the ChatGPT plan's images;
 * 'this-pc': a model on this PC; 'off': turned off; 'none': nothing can serve it now.
 */
export interface UseNow {
  use: ModelUse;
  /** routing.<use> as stored ("auto": nothing picked yet). */
  stored: string;
  kind: 'model' | 'plan' | 'this-pc' | 'off' | 'none';
  accountId?: string;
  /** The catalog id, or a local speech model's id. */
  modelId?: string;
  /** The name to show. */
  name?: string;
  /** 'ready': works now; 'setup': one step away; 'off': off, or nothing can serve it. */
  state: AbilityState;
  /** Why it is not ready, or a limit. */
  note?: string;
  /** The one action that helps (a download of a local model, or the AI). */
  action?: AbilityAction;
  /** A stored choice that cannot serve now (something else stands in, or nothing). */
  gone?: string;
  /** This PC can run a model for this use. */
  thisPc?: boolean;
  /** The values this use can take now (runtime/models/use-choices.ts). */
  choices?: UseChoice[];
}

/** Uses that can be turned off (the media functions, embeddings). */
export const OFFABLE_USES: ReadonlySet<ModelUse> = new Set<ModelUse>(['stt', 'tts', 'speech', 'image', 'video', 'music', 'sound', 'embeddings']);

export const USE_LABELS: Readonly<Record<ModelUse, string>> = {
  work: 'Work', decision: 'Decisions', voice: 'Voice conversation', stt: 'Speech to text', tts: 'Text to speech', speech: 'Speech',
  image: 'Images', video: 'Video', music: 'Music', sound: 'Sound effects', embeddings: 'Embeddings',
};

/** What each use is for, one line (Settings rows and settings.json comments). */
export const USE_ABOUT: Readonly<Record<ModelUse, string>> = {
  work: 'Every agent turn – a chat\'s or an agent\'s own model choice comes first',
  decision: 'Small fast calls: choices, sorting, summaries, compaction',
  voice: 'The live spoken call with an agent: a real-time model, or this PC hearing with Speech to text and speaking with Text to speech',
  stt: 'Dictation and call transcripts',
  tts: 'The voice that reads replies aloud and speaks in calls on this PC',
  speech: 'Makes spoken audio – voiceovers, narration; with nothing picked it speaks with Text to speech',
  image: 'Makes images',
  video: 'Makes videos',
  music: 'Makes music and songs',
  sound: 'Makes sound effects',
  embeddings: 'Searches files and memory by meaning with the model chosen here – without one, finding goes by words',
};

/** The uses as stored (settings.json routing.<use>). */
export type ModelUses = Record<ModelUse, string>;

/** The settings change one value of a use makes (routing.<use>, for speech and voice also the voice keys; a local model not on this PC yet: its download). */
export interface UseWrite {
  routing?: Partial<RoutingSettings>;
  voice?: Partial<VoiceSettings>;
  /** A local model that has to come to this PC first (the download chooses it). */
  download?: string;
}

/** This PC's local speech model `offer` for stt, tts or speech: chosen when it is here, else fetched first. */
function localWrite(use: 'stt' | 'tts' | 'speech', offer: Pick<LocalSpeechOffer, 'id' | 'installed'> | undefined): UseWrite {
  const routing: Partial<RoutingSettings> = { [use]: USE_LOCAL };
  if (!offer) return { routing };
  if (!offer.installed) return { routing, download: offer.id };
  return { routing, voice: use === 'stt' ? { localStt: offer.id } : { localTts: offer.id } };
}

/**
 * The one mapping of a use's value onto settings (Settings' selects and models.setUse): "auto", "off" (the offable uses),
 * "local" (this PC: tts, speech, embeddings, voice = a call on this PC's speech), a local speech model's id (stt, tts – and voice:
 * the model a call on this PC hears with), "codex" (stt: the ChatGPT plan's dictation; work and image: that plan), else a
 * model id. Speech to text on another model than this PC's forgets the local choice, so that one does not come first.
 */
export function useWrite(use: ModelUse, value: string, offers: readonly Pick<LocalSpeechOffer, 'id' | 'purpose' | 'installed'>[]): UseWrite {
  const offer = offers.find((entry) => entry.id === value && (entry.purpose === speechAsTts(use) || (use === 'voice' && entry.purpose === 'stt')));
  if (use === 'voice') {
    if (value === USE_AUTO) return { routing: { voice: USE_AUTO }, voice: { realtime: 'auto' } };
    if (value === USE_LOCAL) return { routing: { voice: USE_LOCAL }, voice: { realtime: 'off' } };
    if (offer || value === PLAN_DICTATION) {
      const hear = useWrite('stt', value, offers);
      return { ...hear, routing: { ...hear.routing, voice: USE_LOCAL }, voice: { ...hear.voice, realtime: 'off' } };
    }
    return { routing: { voice: value }, voice: { realtime: 'auto' } };
  }
  if (use === 'stt' || use === 'tts' || use === 'speech') {
    if (offer || value === USE_LOCAL) return localWrite(use, offer);
    if (use === 'stt' && value !== USE_AUTO && value !== PLAN_DICTATION) return { routing: { stt: value }, voice: { localStt: '' } };
  }
  return { routing: { [use]: value } };
}

const filled = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** The stored value of a use: "auto", "off" or a model (or plan) id. */
export function useValue(routing: unknown, use: ModelUse): string {
  const value = filled(typeof routing === 'object' && routing !== null ? (routing as Record<string, unknown>)[use] : undefined);
  if (!value || (value === USE_OFF && !OFFABLE_USES.has(use))) return USE_AUTO;
  return value;
}

/** The effective use: Speech follows Text to speech when Speech is "auto". */
export function routeUse(routing: unknown, use: ModelUse): ModelUse {
  return useValue(routing, use) === USE_AUTO ? FOLLOWS[use] ?? use : use;
}

export function routeValue(routing: unknown, use: ModelUse): string {
  return useValue(routing, routeUse(routing, use));
}

/** A call runs on this PC's speech (Speech to text and Text to speech): realtime voice off, or Voice set to "local". */
export function callsOnThisPc(settings: { routing?: unknown; voice?: { realtime?: string } } | undefined): boolean {
  return settings?.voice?.realtime !== 'auto' || useValue(settings?.routing, 'voice') === USE_LOCAL;
}

/** The chosen model (or plan) id of a use; undefined for "auto" and "off". */
export function chosenFor(routing: unknown, use: ModelUse): string | undefined {
  const value = useValue(routing, use);
  return value === USE_AUTO || value === USE_OFF ? undefined : value;
}

/** The plans Work can name by provider alone ("codex" = that plan's best model for each turn). */
export const WORK_PLAN_PROVIDERS: readonly ProviderId[] = ['claude', 'codex', 'gemini-cli', 'copilot', 'kimi-cli'];

/** A use's value is a plan's provider id alone (Work: that plan's best model for each turn), not a model id. */
export function isProviderChoice(value: string): boolean {
  return (WORK_PLAN_PROVIDERS as readonly string[]).includes(value);
}

/** Strength at or below this means "never" for a category (runtime routing/score.ts NEVER). */
const NEVER = -0.95;
const REALTIME_NAME = /(^|[-_.:/])realtime([-_.]|$)|^(models\/)?gemini[\w.-]*([-_.]live([-_.]|$)|native-audio)/i;
const EMBEDDING_NAME = /embed|(^|\/)(bge-|e5-|gte-)/i;
const RERANK_NAME = /rerank/i;

/** The real-time model a key of these providers talks with when its server lists none (runtime/calls/realtime/adapters.ts). */
export const VOICE_DEFAULTS = { openai: 'gpt-realtime', google: 'gemini-3.8-live' } as const;

export function voiceDefault(provider: string): string | undefined {
  return Object.hasOwn(VOICE_DEFAULTS, provider) ? VOICE_DEFAULTS[provider as keyof typeof VOICE_DEFAULTS] : undefined;
}

/** A realtime voice model by its name (OpenAI's gpt-realtime family, compatible servers' *-realtime-*, Gemini's Live models). */
export function isRealtimeModel(model: Pick<ModelInfo, 'model'>): boolean {
  return REALTIME_NAME.test(model.model);
}

/** A realtime model a person can talk with (a live transcriber or translator streams too, but gives no conversation). */
export function talksLive(model: Pick<ModelInfo, 'model'>): boolean {
  return isRealtimeModel(model) && !/transcribe|translate/i.test(model.model);
}

/** A general model the agents can talk with (no media specialist, not "never" for chat, no realtime stream). */
export function isChatModel(model: Pick<ModelInfo, 'functions' | 'strengths' | 'model'>): boolean {
  return !model.functions?.length && (model.strengths?.chat ?? 0) > NEVER && !isRealtimeModel(model);
}

/** Whether `model` can serve `use`: settings.json says so (caps.uses), else its name and kind tell. */
export function servesUse(model: Pick<ModelInfo, 'functions' | 'strengths' | 'model'> & { caps?: ModelInfo['caps'] }, use: ModelUse): boolean {
  if (model.caps?.uses?.some((said) => speechAsTts(said) === speechAsTts(use))) return true;
  if (use === 'work' || use === 'decision') return isChatModel(model);
  if (use === 'voice') return talksLive(model);
  if (use === 'embeddings') return EMBEDDING_NAME.test(model.model) && !RERANK_NAME.test(model.model);
  return Boolean(model.functions?.includes(speechAsTts(use)));
}

/** The connected models that can serve `use`, by provider and name. */
export function modelsFor(use: ModelUse, models: readonly ModelInfo[]): ModelInfo[] {
  return models.filter((model) => model.available && servesUse(model, use))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name, 'en', { numeric: true }) || a.id.localeCompare(b.id));
}
