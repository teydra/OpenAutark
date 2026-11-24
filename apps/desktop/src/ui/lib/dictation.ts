// Dictation, one path on the desktop and the phone: the microphone (microphone.ts, 16 kHz through the
// worklet tap) → pieces of the take as 16 kHz mono WAVs → files.upload → voice.transcribe → editable text. The
// runtime decides who hears it: the Codex plan, this PC's speech model, a transcription service or a listening
// model (runtime/voice/transcribe.ts). While this PC's speech model still downloads and nothing else can
// hear, dictationNote() says "Speech model downloading NN %" (the mic shows it). STIMME 21.11.2026: in the Android app a
// piece is first heard by the phone itself at the person's plan (dictation-direct.ts; counts as the plan's), uploaded only after.
// Compact pieces (owner 10.11.2026: "nicht so einer komplett großen, unkompakten Datei"): once the PC's ChatGPT plan
// heard this page's last piece (voice.transcribe `by` 'plan', remembered across reloads), the next pieces go up as Ogg
// Opus (ogg-opus.ts, about a tenth of the WAV), which the plan reads as it is. An answer from another way, a failed
// piece or a PC that names no `by` sends WAVs again: every other way reads those as before.
// B-082: a long take is cut at pauses while it is recorded (take-pieces.ts); each piece is uploaded at once and heard
// right away, one after the other, with the text heard before as context – after Stop only the last piece is left.
// finish() joins the pieces' texts (marks moved along). Nothing is lost: a piece whose hearing failed comes back in
// `kept` with its upload (from KEEP_TAKE_MS on), a piece whose upload failed waits in this page (take-store.ts) and
// uploads itself once the link is back; a take that gave no text at all throws TakeNotTranscribed with its kept
// pieces. An answer lost with the connection may still have been heard (and the file released), so that piece is
// stored again in the background (same bytes, same id). keep() only stores the pieces (audio where nothing hears).
// One take at a time: a newer start tells the older caller its take ended, a start overtaken while the
// microphone opens throws DictationCancelled. F27 (16.11.2026, "ein inkonsistentes System"): when the ChatGPT plan's
// dictation was asked first and gave no text (voice.transcribe planMissed) and another way heard the take, finish() says
// so once per take in the status line (fallbackNote) – marked words then come from that way. F23: `heardPieces` gives the
// latest take's pieces as each is heard (its words or why not) – the live words while recording (blocks/ui/live-words.ts,
// a Dictation of its own on the recorder's stream, with its short `cutter`). Owner 19.11.2026: `dictationLive` says whether any
// take of this page holds the microphone – part of the page's "voice live" (boot/voice-live.ts), so it goes on hidden.
// Owns: the take's microphone lifetime, its pieces and their format, the "can this page dictate" note and the take's
// fallback notice. Never: API keys or provider calls, audio sent anywhere but the runtime's blob store, the Android
// app's port (dictation-direct.ts) or this page's held pieces, a microphone left open after finish/keep/cancel; a piece
// without voice (shared/voice/voiced.ts, 24.11.2026) sent to any recognizer – it counts as heard with no words.

import { signal } from '@preact/signals';
import type { ResultOf } from '../../shared/api/methods.ts';
import type { HeardBy } from '../../shared/api/methods-app.ts';
import { localSpeechModel } from '../../shared/model/local-speech-models.ts';
import { functionCandidates } from '../../shared/model/providers.ts';
import { useValue } from '../../shared/model/models-uses.ts';
import type { FileRef } from '../../shared/model/system.ts';
import { languageHint } from '../../shared/voice/conversation.ts';
import type { MarkedText, TextMarks } from '../../shared/voice/marks.ts';
import { pcmHasVoice } from '../../shared/voice/voiced.ts';
import { pullPercent, running } from '../settings/speech-models-text.ts';
import { speechPulls, watchSpeechPulls } from '../settings/speech-models.ts';
import { directHearing, type DirectHearing } from './dictation-direct.ts';
import { compactRefusedMemory, planHeardMemory } from './dictation-memory.ts';
import { uploadRef } from './files.ts';
import { openMicrophone } from './microphone.ts';
import type { Microphone, SampleListener } from './microphone.ts';
import { oggOpus } from './ogg-opus.ts';
import { LevelHistory, meterLevel, PCM_RATE, Pcm16Encoder, rms, wavFile } from './pcm.ts';
import { RpcError, rpc } from './rpc.ts';
import { blockedNote } from './session.ts';
import { models, settings } from './store.ts';
import { takeName } from './take-name.ts';
import { PieceCutter, joinPieces, type Piece } from './take-pieces.ts';
import { takeStore, type HeldTake } from './take-store.ts';
import { pushToast } from './toasts.ts';

/** A piece at least this long is kept when it was not heard (B-082: from 1 s on). */
export const KEEP_TAKE_MS = 1000;
const BLOCK_MS = 32;
/** The text heard before a piece, as its context (voice.transcribe takes ≤ 2000 chars). */
const BEFORE_CHARS = 2000;

/** Whether any take of this page (every Dictation: the composer's, the recorder's live words) holds the microphone. */
export const dictationLive = signal(false);
const holding = new Set<object>();

/** The running take's input levels (0..1, the waveform beside the mic button reads them). */
export const dictationLevels = new LevelHistory(48);

/** A piece that was not heard: its upload (`ref`) or, with the link down, held in this page (`held`); `error`: why. */
export interface KeptPiece { ref?: FileRef; held?: HeldTake; error?: string; lengthMs: number }

/** A finished take: its text ('' when nothing was heard), the marks beside it, the pieces kept unheard. */
export interface DictationResult { text: string; marks?: TextMarks; kept?: KeptPiece[] }

/** Nothing of the take was heard; `kept` holds its pieces worth keeping (`recording`: the first upload). */
export class TakeNotTranscribed extends Error {
  readonly kept: KeptPiece[];
  constructor(cause: unknown, kept: KeptPiece[] = []) {
    super(errorText(cause));
    this.name = 'TakeNotTranscribed';
    this.kept = kept;
  }
  get recording(): FileRef | undefined { return this.kept.find((piece) => piece.ref)?.ref; }
}

/** Thrown by a start that a newer start or a cancel overtook (double tap, another panel) – not a failure. */
export class DictationCancelled extends Error {
  constructor() {
    super('Dictation was cancelled.');
    this.name = 'DictationCancelled';
  }
}

export interface DictationDeps {
  /** Why this page cannot record (no microphone API, plain http), or undefined. */
  problem(): string | undefined;
  openMicrophone(onSamples: SampleListener): Promise<Microphone>;
  upload(blob: Blob, name: string): Promise<FileRef>;
  transcribe(params: { fileId: string; language?: string; chatId?: string; before?: string }): Promise<ResultOf<'voice.transcribe'>>;
  now(): number;
  /** The transcription call was lost with the connection, not answered (absent: never). */
  lost?(error: unknown): boolean;
  /** The link is down now: a piece is held at once instead of waiting for it (absent: never). */
  offline?(): boolean;
  /** Holds a piece whose upload failed until the link is back (absent: such a piece is lost). */
  hold?(blob: Blob, name: string, owner?: string): Promise<HeldTake>;
  /** Deletes a held piece (its take was discarded). */
  drop?(key: string): void;
  /** F27: one line for the person in the status line (absent: none). */
  notice?(note: { title: string; body: string }): void;
  /** How a take is cut into pieces (absent: take-pieces.ts PieceCutter). */
  cutter?(): Cutter;
  /** A piece's PCM16 as Ogg Opus, undefined when this page cannot encode it (absent: WAV only). */
  compact?(pcm: readonly Uint8Array[]): Promise<Blob | undefined>;
  /** Whether the PC's ChatGPT plan heard this page's last piece, kept across reloads (absent: this page's memory only). */
  planHeard?: { get(): boolean; set(heard: boolean): void };
  /** Until when (ms) pieces go as WAV because the plan missed a compact one – else a plan that does not take Ogg would
   * get every other piece and the rest would fall to this PC's slower model (absent: compact whenever the plan hears). */
  compactRefused?: { get(): number; set(until: number): void };
  /** The phone hears a piece itself first (absent: always the PC's way). */
  direct?: DirectHearing;
}

/** How long one compact piece the plan missed keeps the page on WAV. */
export const COMPACT_REFUSED_MS = 24 * 60 * 60 * 1000;

/** What cuts a take into pieces. */
export type Cutter = Pick<PieceCutter, 'push' | 'flush'>;

/** F23: one piece of the latest take once heard, in order – its words, or why it was not heard; `ms`: its length. */
export interface HeardPiece { ms: number; text?: string; error?: string }

/** F27: what finish() says once per take when the ChatGPT plan's dictation gave no text and `by` heard the take. */
export function fallbackNote(by: Exclude<HeardBy, 'plan'>): { title: string; body: string } {
  const who = by === 'local' ? 'This PC\'s speech model wrote it' : by === 'service' ? 'The transcription service wrote it' : 'A listening model wrote it';
  return { title: 'ChatGPT dictation was not reachable', body: by === 'service' ? `${who}.` : `${who}; unsure words are highlighted.` };
}

/** How a take is heard: the language hint, the chat as context, the draft its held pieces belong to. */
export interface HearOptions {
  language?: string;
  chatId?: string;
  owner?: string;
  /** false: pieces are only stored while recording (nothing can hear right now); finish() still hears them. */
  hear?: boolean;
}

type Stored = { ref: FileRef } | { held: HeldTake } | { error: unknown };

/** A piece's file as it goes up: a WAV, or Ogg Opus once the plan hears this page (see the header). */
interface TakeFile { blob: Blob; name: string }

/** `stored`: its upload, started at once – or only once needed while the phone hears by itself (storedOf). */
interface TakePiece { file: Promise<TakeFile>; lengthMs: number; owner?: string; stored?: Promise<Stored>; tried: boolean; voiceless?: true; heard?: MarkedText; error?: unknown; missedBy?: Exclude<HeardBy, 'plan'> }

interface Take {
  mic: Microphone | null;
  encoder: Pcm16Encoder | null;
  cutter: Cutter;
  pieces: TakePiece[];
  chain: Promise<void>;
  options: HearOptions;
  cancelled: boolean;
  startedAt: number;
  onEnded?: () => void;
}

function errorText(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : 'The transcription failed.';
}

export class Dictation {
  private readonly deps: DictationDeps;
  private take: Take | null = null;
  /** Bumped by every start and cancel: a start that is no longer the latest gives up. */
  private starts = 0;
  /** F23: the latest take's pieces as they are heard (a start empties it). */
  readonly heardPieces = signal<readonly HeardPiece[]>([]);
  private heardTake: Take | null = null;
  /** Whether the PC's ChatGPT plan heard this page's last piece (read once from deps.planHeard). */
  private planHeard: boolean | undefined;

  constructor(deps: DictationDeps) {
    this.deps = deps;
  }

  /** A take holds the microphone. */
  get active(): boolean { return this.take !== null; }

  /** Opens the microphone and records. `onEnded` fires when a newer start takes the microphone. */
  async start(onEnded?: () => void, options: HearOptions = {}): Promise<void> {
    const previous = this.take;
    if (previous) {
      this.cancel(); // one microphone at a time: the other caller is told its take ended
      previous.onEnded?.();
    }
    const ticket = ++this.starts;
    const problem = this.deps.problem();
    if (problem) throw new Error(problem);
    const take: Take = { mic: null, encoder: null, cutter: this.deps.cutter?.() ?? new PieceCutter(), pieces: [], chain: Promise.resolve(), options: { ...options }, cancelled: false, startedAt: this.deps.now(), onEnded };
    this.own(take);
    this.heardTake = take;
    this.heardPieces.value = [];
    dictationLevels.clear();
    let mic: Microphone;
    try {
      mic = await this.deps.openMicrophone((samples, rate) => this.heard(take, samples, rate));
    } catch (error) {
      if (this.take === take) this.own(null);
      throw error;
    }
    if (ticket !== this.starts || this.take !== take) { mic.close(); throw new DictationCancelled(); }
    take.mic = mic;
    take.startedAt = this.deps.now();
  }

  /** Stops the take and waits for its last pieces ('' when nothing was recorded or heard); `language` is a hint ("de", "en-US"). */
  async finish(language?: string, { chatId }: { attachable?: boolean; chatId?: string } = {}): Promise<DictationResult> {
    const take = this.stopTake();
    if (!take) return { text: '' };
    if (language !== undefined) take.options.language = language;
    if (chatId) take.options.chatId = chatId; // context for a listening model
    for (const piece of take.pieces) this.queue(take, piece);
    await take.chain;
    const joined = joinPieces(take.pieces.flatMap((piece) => piece.heard ? [piece.heard] : []));
    const missedBy = take.pieces.find((piece) => piece.heard && piece.missedBy)?.missedBy;
    if (missedBy && joined.text) this.deps.notice?.(fallbackNote(missedBy)); // once per take, only with words to show
    const kept: KeptPiece[] = [];
    let failure: unknown;
    for (const piece of take.pieces) {
      if (piece.heard) continue;
      failure ??= piece.error;
      const entry = piece.lengthMs >= KEEP_TAKE_MS ? keptOf(await this.storedOf(piece), piece) : null;
      if (entry) kept.push(entry);
    }
    if (!joined.text && failure !== undefined) throw new TakeNotTranscribed(failure, kept);
    return kept.length ? { ...joined, kept } : joined;
  }

  /** Stops the take and stores its pieces without hearing them (audio attachments); [] when empty. */
  async keep(): Promise<KeptPiece[]> {
    const take = this.stopTake();
    if (!take) return [];
    const kept = await Promise.all(take.pieces.map(async (piece) => keptOf(await this.storedOf(piece), piece)));
    return kept.filter((piece): piece is KeptPiece => piece !== null);
  }

  /** Hears one stored file again ("Transcribe again" on a kept piece). */
  async hear(fileId: string, options: { language?: string; chatId?: string } = {}): Promise<MarkedText> {
    const language = languageHint(options.language);
    const heard = await this.deps.transcribe({ fileId, ...(language ? { language } : {}), ...(options.chatId ? { chatId: options.chatId } : {}) });
    return markedOf(heard);
  }

  /** Discards the take (its held pieces too); a start still opening the microphone gives up, too. */
  cancel(): void {
    this.starts += 1;
    const take = this.take;
    this.own(null);
    if (!take) return;
    take.cancelled = true;
    take.mic?.close();
    for (const piece of take.pieces) void piece.stored?.then((stored) => { if ('held' in stored) this.deps.drop?.(stored.held.key); });
  }

  private heard(take: Take, samples: Float32Array, rate: number): void {
    if (this.take !== take) return;
    dictationLevels.push(meterLevel(rms(samples)));
    take.encoder ??= new Pcm16Encoder(rate, PCM_RATE, { lowPass: true }); // at 16 kHz already: no resampling
    const piece = take.cutter.push(take.encoder.push(samples));
    if (piece) this.addPiece(take, piece, take.options.hear !== false);
  }

  private addPiece(take: Take, piece: Piece, hear: boolean): void {
    const file = this.fileOf(piece.pcm, new Date(take.startedAt), take.pieces.length + 1);
    const entry: TakePiece = { file, lengthMs: piece.ms, owner: take.options.owner, tried: false, ...(pcmHasVoice(piece.pcm) ? {} : { voiceless: true as const }) };
    if (!this.deps.direct?.ready() && !entry.voiceless) void this.storedOf(entry); // keep() still stores a voiceless piece
    take.pieces.push(entry);
    if (hear) this.queue(take, entry);
  }

  /** The piece's file: Ogg Opus once the plan hears this page and the page can encode it, else a WAV (see the header). */
  private async fileOf(pcm: readonly Uint8Array[], at: Date, index: number): Promise<TakeFile> {
    const refused = (this.deps.compactRefused?.get() ?? 0) > Date.now();
    const compact = this.planHears() && !refused ? await this.deps.compact?.(pcm).catch(() => undefined) : undefined;
    const blob = compact ?? new Blob([wavFile(pcm).buffer as ArrayBuffer], { type: 'audio/wav' });
    const base = takeName(blob.type, at);
    return { blob, name: index === 1 ? base : base.replace(/(\.\w+)$/, ` (${index})$1`) };
  }

  private planHears(): boolean {
    return this.planHeard ??= this.deps.planHeard?.get() ?? false;
  }

  /** Every answered piece says whether the plan heard it; a failed one counts as not. */
  private notePlan(heard: boolean): void {
    if (this.planHears() === heard) return;
    this.planHeard = heard;
    this.deps.planHeard?.set(heard);
  }

  /** The piece's upload, started on first need. */
  private storedOf(piece: TakePiece): Promise<Stored> {
    return piece.stored ??= piece.file.then(({ blob, name }) => this.store(blob, name, piece.lengthMs, piece.owner));
  }

  /** Uploads a piece; with the link down (or the upload failing) a piece worth keeping is held in this page. */
  private async store(blob: Blob, name: string, lengthMs: number, owner?: string): Promise<Stored> {
    const hold = async (error: unknown): Promise<Stored> => {
      if (!this.deps.hold || lengthMs < KEEP_TAKE_MS) return { error };
      try { return { held: await this.deps.hold(blob, name, owner) }; } catch { return { error }; }
    };
    if (this.deps.offline?.()) return hold(new Error('The connection is down: the recording uploads once it is back.'));
    try { return { ref: await this.deps.upload(blob, name) }; } catch (error) { return hold(error); }
  }

  /** Hears the piece after the pieces before it (their text is its context). */
  private queue(take: Take, piece: TakePiece): void {
    take.chain = take.chain.then(() => this.hearPiece(take, piece));
  }

  private async hearPiece(take: Take, piece: TakePiece): Promise<void> {
    if (take.cancelled || piece.tried) return;
    piece.tried = true;
    // 24.11.2026: a piece without voice (the pause before Stop, the tap, room noise) goes to no recognizer – one wrote the
    // ChatGPT login's name ("Colearning Salzburg") for it (shared/voice/voiced.ts); it is heard as no words
    if (piece.voiceless) {
      piece.heard = { text: '' };
      this.tell(take, { ms: piece.lengthMs, text: '' });
      return;
    }
    const language = languageHint(take.options.language);
    if (this.deps.direct?.ready()) {
      const text = await this.deps.direct.hear((await piece.file).blob, language).catch(() => undefined);
      if (take.cancelled) return;
      if (text !== undefined) {
        piece.heard = { text };
        this.notePlan(true);
        this.tell(take, { ms: piece.lengthMs, text });
        return;
      }
    }
    const stored = await this.storedOf(piece);
    if (!('ref' in stored)) {
      piece.error = 'error' in stored ? stored.error : new Error('The connection is down: the recording uploads once it is back.');
      this.tell(take, { ms: piece.lengthMs, error: errorText(piece.error) });
      return;
    }
    const earlier = take.pieces.slice(0, take.pieces.indexOf(piece)).flatMap((other) => other.heard ? [other.heard] : []);
    const before = joinPieces(earlier).text.slice(-BEFORE_CHARS);
    const chatId = take.options.chatId;
    try {
      const heard = await this.deps.transcribe({ fileId: stored.ref.id, ...(language ? { language } : {}), ...(chatId ? { chatId } : {}), ...(before ? { before } : {}) });
      piece.heard = markedOf(heard);
      if (heard?.planMissed && heard.by && heard.by !== 'plan') {
        piece.missedBy = heard.by;
        if ((await piece.file).blob.type === 'audio/ogg') this.deps.compactRefused?.set(Date.now() + COMPACT_REFUSED_MS);
      }
      this.notePlan(heard?.by === 'plan');
      this.tell(take, { ms: piece.lengthMs, text: piece.heard.text });
    } catch (error) {
      piece.error = error;
      this.notePlan(false);
      this.tell(take, { ms: piece.lengthMs, error: errorText(error) });
      // Sent again once the connection is back, before the draft that holds the piece is saved.
      if (piece.lengthMs >= KEEP_TAKE_MS && this.deps.lost?.(error)) {
        const { blob, name } = await piece.file;
        void this.deps.upload(blob, name).catch(() => undefined);
      }
    }
  }

  /** The take holding the microphone (or none) – and `dictationLive` with it. */
  private own(take: Take | null): void {
    this.take = take;
    if (take) holding.add(this);
    else holding.delete(this);
    dictationLive.value = holding.size > 0;
  }

  /** F23: a heard piece goes into `heardPieces` while its take is the latest one. */
  private tell(take: Take, piece: HeardPiece): void {
    if (this.heardTake === take) this.heardPieces.value = [...this.heardPieces.value, piece];
  }

  /** Detaches the take (a start or cancel meanwhile leaves it alone), releases the microphone, cuts the last piece; null without audio. */
  private stopTake(): Take | null {
    const take = this.take;
    this.own(null);
    if (!take) return null;
    take.mic?.close();
    const tail = take.encoder ? take.cutter.push(take.encoder.flush()) : null; // the resampler's delayed tail
    if (tail) this.addPiece(take, tail, false);
    const last = take.cutter.flush();
    if (last) this.addPiece(take, last, false);
    return take.pieces.length ? take : null;
  }
}

function markedOf(heard: ResultOf<'voice.transcribe'> | undefined): MarkedText {
  const text = typeof heard?.text === 'string' ? heard.text : '';
  const uncertain = Array.isArray(heard?.marks) ? heard.marks : [];
  return uncertain.length ? { text, marks: { uncertain } } : { text };
}

function keptOf(stored: Stored, piece: TakePiece): KeptPiece | null {
  const error = piece.error === undefined ? {} : { error: errorText(piece.error) };
  if ('ref' in stored) return { ref: stored.ref, lengthMs: piece.lengthMs, ...error };
  if ('held' in stored) return { held: stored.held, lengthMs: piece.lengthMs, ...error };
  return null;
}

// ------------------------------------------------------------------ this page

/** Why this browser cannot record, or undefined. */
export function recordingProblem(): string | undefined {
  const supported = typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof AudioContext !== 'undefined';
  if (supported) return undefined;
  if (typeof isSecureContext === 'boolean' && !isSecureContext) return 'Open the HTTPS address to dictate: browsers allow the microphone only there.';
  return 'This browser cannot record audio.';
}

/** "Speech model downloading NN %" while this PC's first speech model downloads and no transcription service could hear meanwhile. */
function downloadNote(): string | undefined {
  watchSpeechPulls();
  const current = settings.value;
  if (current?.voice?.localStt) return undefined;
  if (functionCandidates('stt', useValue(current?.routing, 'stt'), models.value).length) return undefined; // a service hears meanwhile
  const pull = Object.values(speechPulls.value).find((entry) => running(entry) && localSpeechModel(entry.id)?.purpose === 'stt');
  if (!pull) return undefined;
  return pull.state === 'unpacking' ? 'Speech model unpacking…' : `Speech model downloading ${pullPercent(pull)} %`;
}

/** Why the mic gives no text on this page right now (reactive), or undefined when it can dictate. */
export function dictationNote(): string | undefined {
  return blockedNote('voice.transcribe') ?? blockedNote('files.upload') ?? recordingProblem() ?? downloadNote();
}

/** This page's dictation: the browser's microphone, the app's rpc, held pieces in this page's IndexedDB. */
export const dictation = new Dictation({
  problem: recordingProblem,
  openMicrophone: (onSamples) => openMicrophone(onSamples, { sampleRate: PCM_RATE, blockMs: BLOCK_MS }),
  upload: (blob, name) => uploadRef(blob, name),
  transcribe: (params) => rpc.call('voice.transcribe', params),
  now: () => Date.now(),
  // rpc rejects every pending call with 'unavailable' once the connection is closed.
  lost: (error) => error instanceof RpcError && error.code === 'unavailable' && rpc.status.peek() !== 'open',
  offline: () => rpc.status.peek() !== 'open', // a call made now would wait in rpc's queue: hold the piece instead
  hold: (blob, name, owner) => takeStore.hold(blob, name, owner),
  drop: (key) => void takeStore.drop(key),
  notice: (note) => pushToast({ ...note, tone: 'info' }, 8000),
  compact: (pcm) => oggOpus(pcm, PCM_RATE),
  direct: directHearing(),
  planHeard: planHeardMemory,
  compactRefused: compactRefusedMemory,
});
