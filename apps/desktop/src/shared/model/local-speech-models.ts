// B-047 D14: the local speech models this PC can download and run itself (sherpa-onnx in the runtime,
// runtime/voice/local/*) – speech to text and text to speech, size-tiered, with the download (one
// archive or file, its SHA-256 and size as GitHub's k2-fsa/sherpa-onnx release lists it), the disk and
// memory it takes, its languages and licence – and how well each fits this PC (fitLocalSpeech: memory and
// CPU cores; int8 models run on the CPU, so the graphics card does not matter) with one recommended model
// per purpose. Checked on 28.10.2026 against the release assets (asr-models, tts-models):
//   stt tiny   NVIDIA stt_de FastConformer hybrid large int8, transducer (B-058 G2: German only, punctuation
//              and capitals, token timestamps; CC-BY-4.0) – the German model
//   stt tiny   NVIDIA Canary-180M-Flash int8 (en/de/es/fr, punctuation and capitals; CC-BY-4.0) – English,
//              Spanish, French
//   stt small  NVIDIA Parakeet-TDT-0.6B-v3 int8 (25 European languages, token timestamps; CC-BY-4.0)
// B-058 G2, measured on the 8 GB reference PC (i3-1215U, 4 threads, 29.10.2026, the app's engine, synthetic
// German speech 41 s clean / echo + 20 dB / echo + 12 dB, the 16.8 s "Hallo." + run-on take; WER):
// FastConformer 0 / 0 / 5.6 / 2.9 %, RTF 0.10–0.20, process peak 460–520 MB; Canary (de) 2–9 %, RTF 0.45–0.65,
// peak ~500 MB, misspells German ("Project", "funktionirt"); Canary (en) 0 % on 33 s. Parakeet not measured
// (it needs ≥ 1.3 GB free; this PC had 0.4–1.0 GB). Whisper turbo is not offered (slower than real time here).
//   tts tiny   Supertone Supertonic 3 int8 (31 languages incl. German, 10 preset voices; raw text in, no
//              phonemizer; weights OpenRAIL-M – use restrictions, the licence text travels with the notice)
//   vad        Silero VAD (MIT) – fetched with every speech-to-text model, never listed on its own
//   turn       Smart Turn v3.2 (BSD-2-Clause, B-082) – fetched with Silero VAD; both run in the conversation page
//   tagging    CED Mini (B-058, sound events; Apache-2.0) – AUDIO_TAGGER, outside the fit rule and the voice settings
// Not offered: Kokoro (no German voice), Piper de_DE voices (sherpa-onnx 2.0 removed the GPL espeak-ng
// phonemizer they need), Pocket TTS (its sherpa archive needs a reference recording and German is unverified).
// `ramMb` is the estimate while loaded (weights plus the ONNX runtime), `sizeMb` the unpacked files.
// The same memory rule (memoryFit) rates the local embedding model and – by the usual size of a 4-bit build (localChatRamMb) –
// a local server's chat models; the graphics card is not read (a standard estimate, no benchmark).
// Owns: these ids, figures, files, the fit rule and the turn detector's fixed file names. Never: I/O.

export type LocalSpeechPurpose = 'stt' | 'tts';
export type LocalSpeechTier = 'tiny' | 'small' | 'medium';
/** How the runtime builds the model (runtime/voice/local/addon.ts configs); B-058 'ced': sherpa-onnx AudioTagging `{ model: { ced } }`. */
export type LocalSpeechKind = 'canary' | 'nemo-transducer' | 'supertonic' | 'silero-vad' | 'ced' | 'smart-turn';

export interface LocalSpeechDownload {
  url: string;
  sha256: string;
  bytes: number;
  /** 'tar.bz2': unpacked, `folder` is its top folder; 'file': stored as `file`. */
  format: 'tar.bz2' | 'file';
  folder?: string;
  file?: string;
}

export interface LocalSpeechModel {
  id: string;
  /** B-058 'tagging': sound-event labels (AUDIO_TAGGER), never ranked by fitLocalSpeech or accepted by voice settings. */
  purpose: LocalSpeechPurpose | 'vad' | 'tagging';
  tier: LocalSpeechTier;
  kind: LocalSpeechKind;
  label: string;
  publisher: string;
  /** ISO-639-1 codes. */
  languages: readonly string[];
  licence: string;
  licenceUrl: string;
  /** The files the model needs inside its folder (installed = all present). */
  files: readonly string[];
  download: LocalSpeechDownload;
  sizeMb: number;
  ramMb: number;
  /** The recognizer gives per-token timestamps (word marks, segments). */
  timestamps?: boolean;
  /** B-058 G2: languages this model measured best for among its tier (the fit's tie-break). */
  prefer?: readonly string[];
  note: string;
}

const ASR = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/';
const TTS = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/';
const CC_BY = 'https://creativecommons.org/licenses/by/4.0/';
const PARAKEET_LANGUAGES = ['bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'hr', 'hu', 'it', 'lt', 'lv', 'mt', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'uk'];
const SUPERTONIC_LANGUAGES = ['ar', 'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'hi', 'hr', 'hu', 'id', 'it', 'ja', 'ko', 'lt', 'lv', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'vi'];
const archive = (base: string, folder: string, sha256: string, bytes: number): LocalSpeechDownload =>
  ({ url: `${base}${folder}.tar.bz2`, sha256, bytes, format: 'tar.bz2', folder });

/** The listed models (speech to text, then text to speech, smallest first – the order never changes with the fit). */
export const LOCAL_SPEECH_MODELS: readonly LocalSpeechModel[] = [
  {
    id: 'fastconformer-de-int8', purpose: 'stt', tier: 'tiny', kind: 'nemo-transducer', label: 'FastConformer German', publisher: 'NVIDIA',
    languages: ['de'], licence: 'CC-BY-4.0', licenceUrl: CC_BY,
    files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'],
    download: archive(ASR, 'sherpa-onnx-nemo-transducer-stt_de_fastconformer_hybrid_large_pc-int8', '73b3cce9f94a19fc04bc54b55abd576b622e3925a84ddd554a95e5984bc11677', 108_124_747),
    sizeMb: 140, ramMb: 450, timestamps: true, prefer: ['de'], note: 'German only, with punctuation and capitals; small, quick and the most accurate for German.',
  },
  {
    id: 'canary-180m-flash-int8', purpose: 'stt', tier: 'tiny', kind: 'canary', label: 'Canary 180M Flash', publisher: 'NVIDIA',
    languages: ['en', 'de', 'es', 'fr'], licence: 'CC-BY-4.0', licenceUrl: CC_BY,
    files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt'],
    download: archive(ASR, 'sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8', '7a38ed8b13f014ad632b09ff8d22e0c6f1359dd046af9235d281dfae841b9ab9', 153_692_328),
    sizeMb: 200, ramMb: 500, prefer: ['en'], note: 'English, German, Spanish and French with punctuation; small and quick.',
  },
  {
    id: 'parakeet-tdt-0.6b-v3-int8', purpose: 'stt', tier: 'small', kind: 'nemo-transducer', label: 'Parakeet TDT 0.6B v3', publisher: 'NVIDIA',
    languages: PARAKEET_LANGUAGES, licence: 'CC-BY-4.0', licenceUrl: CC_BY,
    files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'],
    download: archive(ASR, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf', 487_170_055),
    sizeMb: 650, ramMb: 1_100, timestamps: true, note: '25 European languages with word timing; more accurate, needs more memory.',
  },
  {
    id: 'supertonic-3-int8', purpose: 'tts', tier: 'tiny', kind: 'supertonic', label: 'Supertonic 3', publisher: 'Supertone',
    languages: SUPERTONIC_LANGUAGES, licence: 'OpenRAIL-M', licenceUrl: 'https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE',
    files: ['duration_predictor.int8.onnx', 'text_encoder.int8.onnx', 'vector_estimator.int8.onnx', 'vocoder.int8.onnx', 'tts.json', 'unicode_indexer.bin', 'voice.bin'],
    download: archive(TTS, 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11', '82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427', 128_774_318),
    sizeMb: 140, ramMb: 350, note: '31 languages including German, ten preset voices.',
  },
];

/** Silero VAD: cuts long recordings into utterances and drops silence; comes with every speech-to-text download. */
export const SILERO_VAD: LocalSpeechModel = {
  id: 'silero-vad', purpose: 'vad', tier: 'tiny', kind: 'silero-vad', label: 'Silero VAD', publisher: 'Silero',
  languages: [], licence: 'MIT', licenceUrl: 'https://github.com/snakers4/silero-vad/blob/master/LICENSE',
  files: ['silero_vad.onnx'],
  download: { url: `${ASR}silero_vad.onnx`, sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6', bytes: 643_854, format: 'file', file: 'silero_vad.onnx' },
  sizeMb: 1, ramMb: 30, note: 'Voice activity detection.',
};

/**
 * B-082 decision 8: Smart Turn v3.2 CPU (int8, pipecat-ai/smart-turn-v3, BSD-2-Clause; 23 languages incl. German) –
 * whether a spoken line is finished, run in the conversation page (ui/lib/turn-models.ts). Pinned to the repo revision
 * of 08.11.2026, SHA-256 from Hugging Face's LFS record. Fetched with Silero VAD, never listed on its own.
 */
export const SMART_TURN: LocalSpeechModel = {
  id: 'smart-turn-v3.2-cpu', purpose: 'vad', tier: 'tiny', kind: 'smart-turn', label: 'Smart Turn v3.2', publisher: 'Pipecat',
  languages: [], licence: 'BSD-2-Clause', licenceUrl: 'https://huggingface.co/pipecat-ai/smart-turn-v3',
  files: ['smart-turn-v3.2-cpu.onnx'],
  download: {
    url: 'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.2-cpu.onnx',
    sha256: '2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f', bytes: 8_679_182, format: 'file', file: 'smart-turn-v3.2-cpu.onnx',
  },
  sizeMb: 9, ramMb: 40, note: 'End of turn: whether a spoken line is finished.',
};

/** B-082: where the conversation page loads its turn detector's files – app://app/turn/<name> and the runtime's /turn/<name>. */
export const TURN_ROUTE = '/turn/';
/** onnxruntime-web's single-thread WebAssembly build and its loader, as shipped under node_modules/onnxruntime-web/dist. */
export const ORT_WASM_FILES: readonly string[] = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];

/** What one fixed name under TURN_ROUTE serves: an ort file or a model's one file; anything else is no file. */
export function turnFile(name: string): { ort: string } | { model: LocalSpeechModel } | undefined {
  if (ORT_WASM_FILES.includes(name)) return { ort: name };
  const model = [SILERO_VAD, SMART_TURN].find((entry) => entry.files[0] === name);
  return model ? { model } : undefined;
}

/**
 * B-058 G9: CED-mini audio tagging (sherpa-onnx AudioTagging, 527 AudioSet sound classes with scores; 9.6M
 * parameters, AudioSet mAP 49.0). Checked on 29.10.2026: release audio-tagging-models, archive downloaded once,
 * SHA-256 computed locally (GitHub lists no digest for it), top folder and files as below; the archive also holds
 * model.onnx (fp32, 39 MB) and test_wavs/. Weights Apache-2.0 on Hugging Face (mispeech/ced-mini; the training code
 * repo RicherMans/CED is GPL-3.0). `ramMb` is an estimate, not measured. Not in LOCAL_SPEECH_MODELS (no fit, no setting).
 */
export const AUDIO_TAGGER: LocalSpeechModel = {
  id: 'ced-mini', purpose: 'tagging', tier: 'tiny', kind: 'ced', label: 'CED Mini', publisher: 'Xiaomi (mispeech)',
  languages: [], licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/mispeech/ced-mini',
  files: ['model.int8.onnx', 'class_labels_indices.csv'],
  download: archive('https://github.com/k2-fsa/sherpa-onnx/releases/download/audio-tagging-models/', 'sherpa-onnx-ced-mini-audio-tagging-2024-04-19', 'bec8bfa0af2c20ec3a9e7c6dd6c92d0fb6e96d6b25370ebe7a48e7283a60a02c', 47_658_399),
  sizeMb: 53, ramMb: 80, note: 'Recognises sounds (music, voices, animals, alarms, traffic …) and when they occur.',
};

/** B-058: the local audio taggers (one today); kept apart from the speech lists the fit rule ranks. */
export const LOCAL_TAGGING_MODELS: readonly LocalSpeechModel[] = [AUDIO_TAGGER];

/** A catalog model by id (listed models, the VAD and – B-058 – the audio tagger); `purpose` narrows it. */
export function localSpeechModel(id: string | undefined, purpose?: LocalSpeechPurpose | 'vad' | 'tagging'): LocalSpeechModel | undefined {
  const wanted = (id ?? '').trim();
  const found = wanted === SILERO_VAD.id ? SILERO_VAD : wanted === SMART_TURN.id ? SMART_TURN : LOCAL_SPEECH_MODELS.find((entry) => entry.id === wanted) ?? LOCAL_TAGGING_MODELS.find((entry) => entry.id === wanted);
  return found && (!purpose || found.purpose === purpose) ? found : undefined;
}

/**
 * Call speed 27.11.2026 (Noah's measure on teydra-server: the local voice is most of the ~6 s from the person's last word to
 * the first sound): `settings.voice.localTtsSteps`, the steps the local voice takes for each piece it reads aloud
 * (voice.speak). 3 is about 1 s sooner per sentence, 6 the finer sound; voices without such steps ignore it.
 */
export const TTS_STEPS = [3, 6] as const;
export type TtsSteps = (typeof TTS_STEPS)[number];
/** The steps while `voice.localTtsSteps` is unset (Konrad 27.11.2026: 6 until the 3-step sample was heard) – the one line for the default. */
export const DEFAULT_TTS_STEPS: TtsSteps = 6;

/** The steps a setting's value means: 3 or 6, anything else (unset, an old file) the default. */
export function ttsSteps(value: unknown): TtsSteps {
  return (TTS_STEPS as readonly unknown[]).includes(value) ? value as TtsSteps : DEFAULT_TTS_STEPS;
}

/** The ids `settings.voice.localStt` / `localTts` accept besides '' (validate.ts). */
export const localSpeechIds =(purpose: LocalSpeechPurpose): string[] => LOCAL_SPEECH_MODELS.filter((entry) => entry.purpose === purpose).map((entry) => entry.id);

/** This PC as the fit sees it (memory in MB). */
export interface SpeechHardware { totalRamMb: number; freeRamMb: number; cpuCores: number }

export type LocalSpeechFit = 'good' | 'tight' | 'too-big';

/** One row of voice.localModels. */
export interface LocalSpeechOffer {
  id: string;
  purpose: LocalSpeechPurpose;
  tier: LocalSpeechTier;
  label: string;
  publisher: string;
  /** Download size (MB). */
  downloadMb: number;
  /** Unpacked on disk (MB). */
  sizeMb: number;
  /** Memory while loaded (estimate, MB). */
  ramMb: number;
  languages: string[];
  licence: string;
  licenceUrl: string;
  note: string;
  fit: LocalSpeechFit;
  recommended: boolean;
  installed: boolean;
}

/** Memory kept for Windows, the app and the person's programs (MB). */
export const SPEECH_RAM_RESERVE_MB = 4_096;
/** What a fit means, as Settings and the AI read it. */
export const FIT_WORDS: Readonly<Record<LocalSpeechFit, string>> = { good: 'fits well', tight: 'tight on this PC', 'too-big': 'too big for this PC' };

/** How a local model that takes `ramMb` while loaded fits a PC of `totalRamMb`: well at most half of what the reserve leaves, tight up to all of it. */
export function memoryFit(ramMb: number, totalRamMb: number): LocalSpeechFit {
  const spare = Math.max(0, totalRamMb - SPEECH_RAM_RESERVE_MB);
  return ramMb <= spare / 2 ? 'good' : ramMb <= spare ? 'tight' : 'too-big';
}

/**
 * 21.11.2026: the usual memory of a local chat model on a local server (Ollama, LM Studio …) by its name – the common 4-bit
 * builds take about 0.6 GB per billion parameters plus about 0.5 GB for the runtime and a short context (a standard estimate,
 * never measured here; "30b-a3b" counts all 30B, they are all loaded). Undefined when the name carries no size.
 */
export function localChatRamMb(model: string): number | undefined {
  const size = /(?:^|[^a-z0-9.])(\d{1,3}(?:\.\d)?)b(?![a-z])/i.exec(model.replace(/^.*\//, ''));
  const billions = size ? Number(size[1]) : NaN;
  return Number.isFinite(billions) && billions > 0 ? Math.round(billions * 600 + 500) : undefined;
}

/** The small tier is only recommended with this many cores (a 0.6B encoder on two cores is slow). */
const SMALL_TIER_CORES = 4;

/**
 * The listed models with their fit and one recommended model per purpose: of the models that fit well
 * and speak `language`, the one measured best for it (`prefer`, B-058 G2), else the strongest; else the
 * smallest tight one that speaks it; else the same two without the language (then the model that speaks
 * the most languages among equals).
 * Fits well: its memory is at most half of what the reserve leaves of the total – the small tier also
 * needs SMALL_TIER_CORES cores, or 16 GB, or 3 GB free on 8 GB –; at most all of it is tight.
 */
export function fitLocalSpeech(hardware: SpeechHardware, language = 'en', installed: (id: string) => boolean = () => false): LocalSpeechOffer[] {
  const lang = (/^([a-z]{2,3})/i.exec(language.trim())?.[1] ?? 'en').toLowerCase();
  const rows = LOCAL_SPEECH_MODELS.map((entry): LocalSpeechOffer => {
    const roomy = hardware.totalRamMb >= 16_384 || (hardware.totalRamMb >= 8_192 && hardware.freeRamMb >= 3_072);
    const strongEnough = entry.tier === 'tiny' || (hardware.cpuCores >= SMALL_TIER_CORES && roomy);
    const memory = memoryFit(entry.ramMb, hardware.totalRamMb);
    const fit: LocalSpeechFit = memory === 'good' && !strongEnough ? 'tight' : memory;
    return {
      id: entry.id, purpose: entry.purpose as LocalSpeechPurpose, tier: entry.tier, label: entry.label, publisher: entry.publisher,
      downloadMb: Math.round(entry.download.bytes / 1_000_000), sizeMb: entry.sizeMb, ramMb: entry.ramMb, languages: [...entry.languages],
      licence: entry.licence, licenceUrl: entry.licenceUrl, note: entry.note, fit, recommended: false, installed: installed(entry.id),
    };
  });
  const rank = (row: LocalSpeechOffer) => ({ tiny: 1, small: 2, medium: 3 })[row.tier];
  const preferred = (row: LocalSpeechOffer) => (localSpeechModel(row.id)?.prefer?.includes(lang) ? 1 : 0);
  const breadth = (a: LocalSpeechOffer, b: LocalSpeechOffer) => b.languages.length - a.languages.length;
  for (const purpose of ['stt', 'tts'] as const) {
    const mine = rows.filter((row) => row.purpose === purpose);
    const strongest = (fit: LocalSpeechFit, speaks: boolean) => mine.filter((row) => row.fit === fit && (!speaks || row.languages.includes(lang))).sort((a, b) => preferred(b) - preferred(a) || rank(b) - rank(a) || breadth(a, b))[0];
    const smallest = (speaks: boolean) => mine.filter((row) => row.fit === 'tight' && (!speaks || row.languages.includes(lang))).sort((a, b) => a.ramMb - b.ramMb || breadth(a, b))[0];
    const pick = strongest('good', true) ?? smallest(true) ?? strongest('good', false) ?? smallest(false);
    if (pick) pick.recommended = true;
  }
  return rows;
}

/** voice.localModels: the rows, and whether the local speech engine runs on this PC at all (`error`: why not). */
export interface LocalSpeechModels { models: LocalSpeechOffer[]; engine: { ready: boolean; error?: string } }

/** voice.speak: one spoken line – base64 PCM16 LE mono at `sampleRate` ('' for a blank line). */
export interface SpokenAudio { audio: string; sampleRate: number; durationMs: number }

/** Progress of one voice.pullLocal (event 'voice.pull'): bytes so far and in all, then 'done' or 'failed'. */
export interface LocalSpeechPull {
  id: string;
  state: 'downloading' | 'unpacking' | 'done' | 'failed';
  done: number;
  total: number;
  error?: string;
  /** B-058 G1: the runtime fetches this model by itself (no click: the notice band shows it). */
  auto?: boolean;
}
