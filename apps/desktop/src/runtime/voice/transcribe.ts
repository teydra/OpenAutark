// Speech to text for the person's dictation and conversations (RPC voice.transcribe) and agents hearing
// recordings (attachment transcripts, media.transcribe) – one instance, RuntimeServices.stt. One fixed order:
//   1. this PC's speech model (settings voice.localStt, local/service.ts) when it is downloaded and can read the
//      take (WAV/PCM itself; other formats through the desktop app's decoder, media/hear-any.ts);
//   2. else – also when the local model could not hear it (memory, a failed load, a format it cannot read) – the
//      speech-to-text function model (models/functions.ts: routing.stt, else the first connected one)
//      at its OpenAI-compatible /audio/transcriptions (transcribe-endpoint.ts), with the learned words as prompt;
//   3. else a listening model on a free or plan account (listen-transcribe.ts);
//   4. else the local model's reason, or "not set up" (the composer keeps the recording).
// A dictation the recognizer heard no words in is empty text ({ text: '' }), not a failure (SM9); a WAV dictation piece
// without voice (shared/voice/voiced.ts, 24.11.2026) is that text before any recognizer hears it; agent hearing
// keeps the "no usable text" error. A service or a listener gets no English hint on a PC whose OS speaks another
// language (local/service.ts serviceLanguage: it detects). A decode hears a recording's first 20 minutes: such a
// result is `partial`, and an agent transcript then starts with partialNote's line. A heard dictation take (the
// caller's fresh upload only) goes to the blob clean-up, due after a hold (files/cleanup.ts).
// A dictation (owner 07.11.2026) shows what was not understood: this PC's model marks its weakest words, a listening
// model marks unsure places itself with alternatives and the sounds heard (shared/voice/marks.ts).
// B-080 (owner: "ohne dass der User ein extra KI-Modell einrichten muss", "nicht zehn Wege"): one way, no setting.
// B-088 (owner 10.11.2026, fast again): a dictation goes first to the person's ChatGPT plan, in one request, when its
// login is here (plan-transcribe.ts: the Codex app's own dictation endpoint, seconds for a minute of speech): no model
// to prompt, no second hearing, no comparison; its text is the text. When the plan cannot (no login, a rejection, a
// limit, the network) the usual order follows: this PC's model (its weakest words marked), then the service, then a
// listener, which hears a dictation with the chat's last agent message and the learned words as context, its unsure
// places marked. The earlier real-time WebRTC hearing with the comparison (B-080/B-082) is no longer on this path.
// 21.11.2026 (owner: an employee's PC showed no Codex choice): the plan goes first only while routing.stt is "auto" or
// "codex"; a person who picks this PC's model ("local") or a service gets that one first.
// Once the plan heard a page's dictation, the page sends its next pieces as Ogg Opus (ui/lib/ogg-opus.ts, a tenth of
// the WAV): the plan takes it as it is, and after a plan failure this PC's model reads it through the app's decoder.
// B-082: voice.transcribe converts inline marks once (marks.ts spansFromInline) and answers plain text with the unsure
// places as spans beside it. `before` (text heard earlier in the same take) goes along as the listener's context.
// `live` (a spoken conversation line) goes the same way and is never marked. F27 (16.11.2026, "ein inkonsistentes
// System"): the answer names who heard it (`by`) and whether the plan was asked first and gave no text (`planMissed`),
// so the person learns why a dictation came back marked (ui/lib/dictation.ts).
// Owns: that order, the transcript cache in the file's text column (secret-redacted, one agent transcription at a
// time) and user-safe errors. Never: logs or returns the key or the provider's raw error body, or sends audio
// anywhere but the one endpoint or listener.

import type { RuntimeServices, SpeechToText, SpeechToTextState } from '../contracts.ts';
import type { VoiceApi } from '../rpc/extras.ts';
import type { Account } from '../../shared/model/providers.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { vocabularyPrompt } from '../../shared/voice/vocabulary.ts';
import { wavHasVoice } from '../../shared/voice/voiced.ts';
import { accountTerms, withoutAccounts } from '../../shared/voice/hint.ts';
import { markUncertainWords, spansFromInline, type SpanMark } from '../../shared/voice/marks.ts';
import { endpointFor } from '../engines/http/common.ts';
import { reclaimerOf } from '../files/cleanup.ts';
import { functionStatus } from '../models/functions.ts';
import { FileRepo } from '../store/files.ts';
import type { LocalSpeechModels, SpokenAudio } from '../../shared/model/local-speech-models.ts';
import type { HeardBy } from '../../shared/api/methods-app.ts';
import { readsTake, serviceLanguage, type LocalSpeech } from './local/service.ts';
import { systemEnvironment } from '../settings/defaults.ts';
import { canListen, listenerReady, listenTranscript } from './listen-transcribe.ts';
import { audioExtension, endpointHeard, partialNote, uploadOf, uploadWay, type FetchFn, type Heard } from './transcribe-endpoint.ts';
import type { Listener } from '../decision/listener.ts';
import { planMissing, planReady, planTranscribe, type PlanTranscription } from './plan-transcribe.ts';
import { planHears } from '../../shared/model/models-uses.ts';
import { correctDictation } from './correct-dictation.ts';
import { helperOf } from '../day/helper.ts';
import type { StructuredRunner } from '../decision/types.ts';

export { audioExtension, LANGUAGES_FIELD, languageCode, MAX_AUDIO_BYTES, PIECE_MS } from './transcribe-endpoint.ts';
export type { FetchFn, Heard, HeardPart } from './transcribe-endpoint.ts';

/** Providers without an OpenAI-compatible /audio/transcriptions (plans, CLIs, media-only APIs). */
const NO_TRANSCRIPTION = new Set(['codex', 'claude', 'anthropic', 'gemini-cli', 'copilot', 'kimi-cli', 'elevenlabs', 'fal']);
const NOT_SET_UP = 'Speech to text is not set up yet: this PC downloads its speech model by itself (Settings › Models › Speech to text), or connect an OpenAI or OpenAI-compatible account with a transcription model.';
/** A WAV up to this size is checked for voice before it is heard (a minute of 16 kHz PCM16 is 1.9 MB). */
export const VOICE_CHECK_MAX_BYTES = 32 * 1024 * 1024;
/** A dictation transcribes the take it uploaded just before (the run itself takes ≤ 120 s) … */
export const FRESH_TAKE_MS = 5 * 60_000;
/** … and its heard take waits this long for the clean-up (a client whose connection dropped attaches it meanwhile). */
export const HEARD_TAKE_HOLD_MS = 10 * 60_000;

export interface TranscriberDeps {
  services: () => RuntimeServices;
  fetch?: FetchFn;
  timeoutMs?: number; // per request, default 120 s
  /** This PC's local speech models (absent: the service and listener only). */
  local?: LocalSpeech;
  /** The listening turn (default: decision/listener.ts createListener over the services; tests). */
  listener?: Listener;
  /** The OS locale (default: Intl, settings/defaults.ts systemEnvironment). */
  systemLocale?: () => string;
  /** The longest decoded piece one request uploads (default transcribe-endpoint.ts PIECE_MS; tests). */
  pieceMs?: number;
  /** B-088: the plan's transcription of a dictation (default: plan-transcribe.ts, when a plan login is here; tests). */
  plan?: PlanTranscription;
  /** 16.11.2026: the text model that corrects this PC's model's dictation (default: the helper route, day/helper.ts; false: none; tests). */
  correct?: StructuredRunner | false;
}

/** voice.transcribe's input (B-082: `before` – text heard earlier in this take, context; `live` – a spoken conversation line). */
export interface TranscribeInput { fileId: string; language?: string; chatId?: string; before?: string; live?: boolean }

export class Transcriber implements VoiceApi, SpeechToText {
  private readonly deps: TranscriberDeps;
  private readonly hearing = new Map<string, Promise<string>>(); // fileId → agent transcription
  private queue: Promise<unknown> = Promise.resolve(); // agent transcriptions run one at a time

  constructor(deps: TranscriberDeps) {
    this.deps = deps;
  }

  state(): SpeechToTextState {
    try {
      const s = this.deps.services();
      if (this.deps.local?.sttModel()) return 'ready'; // this PC's own model
      const status = functionStatus(s, 'stt');
      if (status.off) return 'off';
      if (!status.choice) return listenerReady(s) ? 'ready' : 'missing';
      const account = s.accounts.get(status.choice.accountId);
      return account?.enabled && !NO_TRANSCRIPTION.has(account.provider) ? 'ready' : 'missing';
    } catch {
      return 'missing';
    }
  }

  /**
   * Dictation and conversations (RPC voice.transcribe), nothing cached; '' when no words were heard. A heard take
   * only carried its words, so it goes to the blob clean-up – due after the hold, since the runtime cannot tell
   * whether the answer arrived – and only the caller's fresh upload (a chat device may name any file here). The
   * clean-up keeps what a draft or a message uses; a failed take stays: the composer may attach it.
   */
  async transcribe(input: TranscribeInput): Promise<Heard & { marks?: SpanMark[]; by?: HeardBy; planMissed?: true }> {
    if (await this.voiceless(input.fileId)) { // heard by nobody: no `by`
      try { this.release(input.fileId); } catch { /* the clean-up logs its own failures */ }
      return { text: '' };
    }
    const heard = await this.run(input, true);
    try { this.release(input.fileId); } catch { /* the clean-up logs its own failures */ }
    const { text, marks } = spansFromInline(heard.text); // B-082: plain text, the unsure places beside it
    return { ...heard, text, ...(marks?.uncertain && !input.live ? { marks: marks.uncertain } : {}) };
  }

  /**
   * 24.11.2026: a WAV take without voice (shared/voice/voiced.ts – the pause before Stop, a tap, room noise) goes to no
   * recognizer: one wrote the ChatGPT login's name ("Colearning Salzburg") for such a piece. False when it holds voice,
   * is no WAV (a compressed piece: the page checked it before encoding) or cannot be read – then it is heard as before.
   */
  private async voiceless(fileId: string): Promise<boolean> {
    try {
      const s = this.deps.services();
      const ref = s.files.get(fileId);
      if (!ref?.size || ref.size > VOICE_CHECK_MAX_BYTES || audioExtension(ref.mime, ref.name) !== 'wav') return false;
      const quiet = wavHasVoice(await s.files.read(ref.id)) === false;
      if (quiet) s.log?.info('dictation piece without voice', { bytes: ref.size }); // never the audio
      return quiet;
    } catch {
      return false;
    }
  }

  /** Queues the caller's fresh take for the blob clean-up, due after HEARD_TAKE_HOLD_MS (see transcribe). */
  private release(fileId: string): void {
    const s = this.deps.services();
    const now = s.clock.now();
    const take = s.files.get(fileId);
    if (!take || now - take.createdAt > FRESH_TAKE_MS) return;
    reclaimerOf(s.files)?.reclaim([fileId], { notBefore: now + HEARD_TAKE_HOLD_MS });
  }

  transcript(fileId: string, dictation?: { chatId?: string }): Promise<string> {
    const known = this.cached(fileId);
    if (known) return Promise.resolve(known);
    const running = this.hearing.get(fileId);
    if (running) return running;
    const job = this.queue.then(() => this.hear(fileId, dictation));
    this.queue = job.catch(() => undefined);
    this.hearing.set(fileId, job);
    const done = () => { this.hearing.delete(fileId); };
    job.then(done, done);
    return job;
  }

  /** One queued agent transcription: recognized text (after partialNote's line when only the start was heard), redacted, cached for every later reader. */
  private async hear(fileId: string, dictation?: { chatId?: string }): Promise<string> {
    const known = this.cached(fileId); // an earlier caller in the queue may have heard it already
    if (known) return known;
    const s = this.deps.services();
    const heard = await this.run({ fileId, ...(dictation?.chatId ? { chatId: dictation.chatId } : {}) }, Boolean(dictation));
    const text = heard.partial ? `${partialNote(heard.partial)}\n${heard.text}` : heard.text;
    let clean = text;
    try { clean = s.secrets.redact(text); } catch { /* vault locked: the context redacts again before any engine sees it */ }
    // B-082: a transcript that is only unreadable places ("⟦?…⟧") is no text – not cached, so hearing it again really hears it again
    if (spansFromInline(clean).text.trim()) {
      try { new FileRepo(s.db).setText(fileId, clean); } catch (error) { s.log.debug('transcript not cached', { fileId, error: String(error) }); }
    }
    return clean;
  }

  private cached(fileId: string): string | undefined {
    try { return new FileRepo(this.deps.services().db).cachedText(fileId) || undefined; } catch { return undefined; }
  }

  private async run(input: TranscribeInput, dictation: boolean): Promise<Heard & { by: HeardBy; planMissed?: true }> {
    const s = this.deps.services();
    const ref = s.files.get(input.fileId);
    if (!ref) throw new WorkforceError('not_found', 'The recording was not found. Record again.');
    if (!ref.size) throw new WorkforceError('bad_request', 'The recording is empty. Record again.');
    const local = this.deps.local;
    const model = local?.sttModel();
    const decodes = local?.hostDecodes() ?? false;
    const hearLocal = () => local!.hear({ fileId: input.fileId, mime: ref.mime, name: ref.name, language: input.language, dictation });
    // 21.11.2026: the plan first while nothing is picked or the plan is (routing.stt "auto" / "codex"); "local" or a model: that one
    const picked = !planHears((() => { try { return s.settings.get().routing; } catch { return undefined; } })()); // a stub without settings: nothing picked
    const plan = dictation && !picked ? this.deps.plan ?? (planReady(s) ? planTranscribe : undefined) : undefined;
    // A dictation without the plan says why: a weak transcript is otherwise unexplained (16.11.2026).
    if (dictation && !plan) s.log?.info('plan transcription skipped', { reason: picked ? 'other_choice' : planMissing(s) }); // ?.: service stubs without a log
    let planMissed = false;
    if (plan) { // B-088: whenever the plan's login is here, one request; its text is the text
      const asked = Date.now();
      const upload = { bytes: ref.size, format: audioExtension(ref.mime, ref.name) ?? 'other' }; // a compact piece is ogg (ui/lib/ogg-opus.ts)
      try {
        const heard = await plan(s, ref, serviceLanguage(input.language, this.systemLocale()), this.deps.fetch);
        s.log.info('plan transcription heard', { ms: Date.now() - asked, chars: heard.text.length, ...upload }); // measured, never the words
        return { ...heard, by: 'plan' };
      } catch (error) {
        planMissed = true;
        s.log.info('plan transcription falls back', { code: error instanceof WorkforceError ? error.code : 'internal', ms: Date.now() - asked, ...upload });
      }
    }
    /** The answer of another way than the plan, named (and whether the plan was asked first). */
    const by = (way: HeardBy, heard: Heard) => ({ ...heard, by: way, ...(planMissed ? { planMissed: true as const } : {}) });
    let failed: WorkforceError | undefined; // this PC's model could not hear the take
    if (model && !readsTake(model, ref.mime, ref.name, decodes)) {
      failed = new WorkforceError('bad_request', decodes ? "This PC's speech model cannot read this recording format." : "This PC's speech model reads WAV recordings only; this recording is compressed.");
    }
    else if (local && model) {
      let heard: Heard | undefined;
      try {
        heard = await hearLocal();
      } catch (error) {
        if (!(error instanceof WorkforceError)) throw error;
        failed = error;
        s.log.info('local transcription falls back', { code: error.code });
      }
      if (heard) {
        // No words heard is no failure to fall back after (silence must not go on to a paid service).
        if (!heard.text && !dictation) throw new WorkforceError('unavailable', 'The transcription returned no usable text.');
        if (!dictation || !heard.text) return by('local', heard);
        const marked = markUncertainWords(heard.text, heard.words);
        if (input.live) return by('local', { ...heard, text: marked }); // a spoken conversation line waits for no second model
        // 16.11.2026: this PC's small model mishears names and terms; a text model reads it once with the chat in mind
        const asked = Date.now();
        const corrected = await correctDictation(this.corrector(s), marked, this.dictationContext(s, input.chatId, input.before), serviceLanguage(input.language, this.systemLocale()));
        s.log?.info('local dictation correction', { corrected: corrected !== undefined, ms: Date.now() - asked }); // never the words
        // the corrected text no longer matches the model's word times, so they do not go along with it
        return by('local', corrected ? { text: corrected, ...(heard.partial ? { partial: heard.partial } : {}) } : { ...heard, text: marked });
      }
    }
    const status = functionStatus(s, 'stt');
    const hint = serviceLanguage(input.language, this.systemLocale()); // no 'en' for speech of another language
    if (status.choice && !status.off) return by('service', await this.endpoint(s, ref, status.choice, hint, dictation));
    if (!status.off && canListen(s, ref)) {
      try {
        const text = await listenTranscript(s, ref, hint, this.deps.listener, dictation ? this.dictationContext(s, input.chatId, input.before) : undefined);
        if (!text && !dictation) throw new WorkforceError('unavailable', 'The transcription returned no usable text.');
        return by('listener', { text });
      } catch (error) {
        if (!failed) throw error;
        s.log.info('listening fallback failed', { code: error instanceof WorkforceError ? error.code : 'internal' });
      }
    }
    if (failed) throw failed; // the local model's reason (memory, blocked engine) is the one the person can act on
    if (status.off) throw new WorkforceError('unavailable', 'Speech to text is turned off (routing.stt in settings.json).');
    throw new WorkforceError('unavailable', status.settingUnavailable
      ? 'The chosen speech-to-text model is not available. Connect its account again or choose another one (routing.stt in settings.json).'
      : NOT_SET_UP);
  }

  /** The take heard by the speech-to-text function model's transcription endpoint. */
  private async endpoint(s: RuntimeServices, ref: { id: string; mime: string; name: string; size: number }, choice: { accountId: string; model: string }, language: string | undefined, dictation: boolean): Promise<Heard> {
    const account: Account | undefined = s.accounts.get(choice.accountId);
    if (!account || !account.enabled) throw new WorkforceError('unavailable', 'The speech-to-text account is not available. Turn it on or connect another one (Settings › Models).');
    if (NO_TRANSCRIPTION.has(account.provider)) throw new WorkforceError('bad_request', 'This account offers no transcription endpoint. Connect an OpenAI or OpenAI-compatible account (Settings › Models).');
    let url: string;
    try { url = `${endpointFor(account)}/audio/transcriptions`; } catch (error) {
      throw new WorkforceError('bad_request', error instanceof Error ? error.message : 'The transcription account has no valid server URL.');
    }
    const way = uploadWay(s, ref); // as it is, or decoded (over 25 MB, a format the endpoint does not take)
    let key: string | undefined;
    try { key = await s.accounts.apiKey(account.id); } catch { key = undefined; }
    let prompt: string | undefined;
    try { prompt = vocabularyPrompt(s.settings.get().voice?.vocabulary, undefined, this.accountTerms(s)); } catch { prompt = undefined; }
    try {
      const upload = await uploadOf(s, ref, way, this.deps.pieceMs);
      return await endpointHeard({ url, key, model: choice.model, language, prompt, dictation, fetch: this.deps.fetch ?? fetch, timeoutMs: this.deps.timeoutMs ?? 120_000 }, upload);
    } catch (error) {
      if (error instanceof WorkforceError) throw error;
      throw new WorkforceError('unavailable', 'The transcription failed.');
    }
  }

  /** What a listening model gets along with a dictation: the take's earlier text, the chat's last agent message (redacted) and the learned words. */
  private dictationContext(s: RuntimeServices, chatId: string | undefined, before?: string): { lastReply?: string; vocabulary?: string; before?: string } {
    const terms = this.accountTerms(s);
    let lastReply: string | undefined;
    if (chatId) {
      try {
        const row = s.db.get<{ body: string }>(`SELECT body FROM messages WHERE conversation_id = ? AND author_kind = 'agent' AND kind = 'text'
          AND state = 'final' AND body <> '' ORDER BY seq DESC LIMIT 1`, [chatId]);
        // 25.11.2026: no account address or name in a hint (shared/voice/hint.ts) – the recognizer wrote one for a piece without speech
        if (row?.body) lastReply = withoutAccounts(s.secrets.redact(row.body), terms) || undefined;
      } catch { lastReply = undefined; } // a locked vault or a missing chat: no context, never the raw text
    }
    let vocabulary: string | undefined;
    try { vocabulary = vocabularyPrompt(s.settings.get().voice?.vocabulary, undefined, terms); } catch { vocabulary = undefined; }
    const earlier = before?.trim() ? withoutAccounts(before.trim(), terms) : '';
    return { ...(earlier ? { before: earlier } : {}), ...(lastReply ? { lastReply } : {}), ...(vocabulary ? { vocabulary } : {}) };
  }

  /** What names this PC's accounts – their addresses, name parts and labels – for the hints a recognizer is given (hint.ts). */
  private accountTerms(s: RuntimeServices): string[] {
    try { return accountTerms(s.accounts.list()); } catch { return []; }
  }

  /** The text model that corrects a local dictation, or undefined (none connected, or switched off in tests). */
  private corrector(s: RuntimeServices): StructuredRunner | undefined {
    if (this.deps.correct === false) return undefined;
    if (this.deps.correct) return this.deps.correct;
    try { return helperOf(s); } catch { return undefined; }
  }

  private systemLocale(): string | undefined {
    try { return this.deps.systemLocale?.() ?? systemEnvironment().locale; } catch { return undefined; }
  }

  localModels(): LocalSpeechModels { return this.localSpeech().models(); }
  pullLocal(id: string, options?: { choose?: () => boolean }): Promise<{ ok: true }> { return this.localSpeech().pull(id, options); }
  /** `signal`: the caller gave up (stop, deadline) – the local voice speaks no further sentence (local/engine.ts). */
  speak(input: { text: string; voice?: string; language?: string; signal?: AbortSignal }): Promise<SpokenAudio> { return this.localSpeech().speak(input); }

  private localSpeech(): LocalSpeech {
    if (!this.deps.local) throw new WorkforceError('unavailable', 'Local speech is not available in this runtime.');
    return this.deps.local;
  }
}
