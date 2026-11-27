// The voice conversation's shapes and pure helpers (conversation.ts holds the loop and re-exports these): the views the
// page shows, the runtime surface and the injected platform, a talking chat's state, the limits, and how a spoken line
// is marked, an answer made speakable and a take told apart from others' words (echoOf).
// Owns: these shapes and helpers. Never: state, timers or platform globals.

import type { EventMap } from '../api/events.ts';
import type { MethodName, ParamsOf, ResultOf } from '../api/methods.ts';
import type { Topic } from '../api/protocol.ts';
import type { Attachment, SpeechMeta } from '../model/chat.ts';

/** What the microphone does: the listening chat and its state ('speaking' while any reply is read). */
export interface VoiceSessionView {
  id: string;
  conversationId: string;
  status: 'starting' | 'listening' | 'transcribing' | 'responding' | 'speaking';
  hint?: string;
}

/** One talking chat (the listening one first). */
export interface VoiceSessionEntry extends VoiceSessionView {
  listening: boolean;
  /** Replies of this chat waiting to be read aloud. */
  queued?: number;
}

/** The runtime surface a conversation needs (the app's rpc). */
export interface ConversationRpc {
  call<M extends MethodName>(method: M, params?: ParamsOf<M>, timeoutMs?: number): Promise<ResultOf<M>>;
  on<E extends 'message.created' | 'message.updated'>(event: E, listener: (data: EventMap[E]) => void): () => void;
  /** Holds the topic until the returned release is called. */
  subscribe(topic: Topic): Promise<() => void>;
}

export interface VoiceSessionsDeps {
  rpc: ConversationRpc;
  /** The microphone's view (null: no chat talks), why a chat ended, and every talking chat. */
  publish(mic: VoiceSessionView | null, error: string | undefined, chats: VoiceSessionEntry[]): void;
  /** Read `text` aloud, then call spokenDone(micId). */
  speak(micId: string, text: string): void;
  /** Stop reading now. */
  silence(): void;
  newId(): string;
  /** Runs `fn` once after `ms`; returns its cancel. */
  after(ms: number, fn: () => void): () => void;
  /** The transcription's language hint (the profile language). */
  language?(): string | undefined;
  /** B-081: an agent's name, said in front of its line when the speaker changes (one reading voice for every agent). */
  nameOf?(agentId: string): string | undefined;
  replyTimeoutMs?: number;
  /** Owner 19.11.2026: what this device shows on the chat's call (its camera, its screen, a cut-out) – it goes with the line. */
  shown?(conversationId: string): Promise<Attachment[]>;
}

/** One talking chat inside the loop (conversation.ts VoiceSessions). */
export interface TalkingChat {
  id: string;
  conversationId: string;
  title: string;
  starting: boolean;
  sentSeq: number | null;
  awaiting: boolean;
  sending: boolean;
  pending: string;
  spoken: Set<string>;
  /** This device's call in the chat (calls.start), when the page may start calls, and how the call names this device (callHolder form). */
  callId?: string;
  holder?: string;
  /** Owner 19.11.2026: this device is in the call beside its holder (calls.start's `joined`). */
  joined?: boolean;
  /** Owner 19.11.2026: the newest person's line of the call, said on any device of it (its seq), and this device's lines on their way. */
  heard?: number;
  out?: number;
  /** Owner 19.11.2026: the last words said in the call by others (agents, the person on another device), by row – the echo check. */
  lately?: Map<string, string>;
  /** The agent whose line was read last (its name goes in front when another one speaks). */
  speaker?: string;
  /** KI-Runde 17.11.2026: the call voice's row still being written and what of it was already read aloud. */
  said?: { id: string; text: string };
  release?: () => void;
  cancelTimer?: () => void;
}

/** A reply waiting to be read: its chat, its words and the speaker's name when it changed. */
export interface Reading { chat: TalkingChat; text: string; name?: string }

export const MAX_VOICE_SESSIONS = 3;
export const SESSIONS_FULL = `At most ${MAX_VOICE_SESSIONS} voice conversations run at once. End one to start another.`;
export const REPEAT_HINT = 'I did not catch that. Please say it again.';
export const REPLY_TIMEOUT_MS = 120_000;
export const TRANSCRIBE_TIMEOUT_MS = 130_000;
/** What voice.transcribe accepts as `language`. */
const LANGUAGE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;

/** A transcription language hint ("de", "en-US"), else undefined: the take goes without one. */
export function languageHint(language: string | undefined): string | undefined {
  return language && language.length <= 16 && LANGUAGE.test(language) ? language : undefined;
}

/** How a dictated (`live` false) or live-spoken line is marked when it is sent. */
export function spokenMeta(live: boolean): SpeechMeta {
  return live ? { source: 'endpoint', live: true } : { source: 'endpoint' };
}

/** A sentence ends at one of these, followed by space or the end of the text; a line of its own ends one too. */
const SENTENCE_END = /[.!?…](?:["'”’)\]]*)(?=\s|$)|\n/g;
/** A finished piece is at least this long, so a short opening like "Ok." waits for what follows. */
const PIECE_MIN = 15;
/**
 * A word whose dot is no sentence end: one letter or digit ("S.", "1."), one with a dot inside ("z.B.", "d.h.") or a common
 * short abbreviation ("ca.", "Dr.") – while the answer streams, the word after it is not there yet to tell.
 */
const ABBREVIATION = /(?:^|\s)(?:[\p{L}\d]|[\p{L}\d]+\.[\p{L}\d.]*|ca|bzw|usw|etc|vgl|ggf|evtl|inkl|zzgl|bspw|Nr|Dr|Prof|Hr|Fr|St|Str|Tel|Mio|Mrd|Mr|Mrs|Ms|Jr|vs|approx)\.$/iu;
/** A dot that a lowercase word follows ends no sentence either. */
const GOES_ON = /^["'”’)\]]*\s+\p{Ll}/u;

/** Call speed 27.11.2026: a comma followed by space (or the end) – before the first finished sentence it ends the first piece. */
const CLAUSE_END = /,(?=\s|$)/g;
/** The first piece cut at a comma is at least this long, so "Ja," alone waits for the next comma or the sentence end. */
export const FIRST_CLAUSE_MIN = 8;

/**
 * KI-Runde 17.11.2026: the leading part of a text whose last sentence is finished ('' while none is) – what the call voice
 * can already say while it still writes the rest (conversation.ts, runtime/calls/voice-text.ts). Call speed 27.11.2026
 * (Konrad: the first piece from the first comma): while no sentence is finished yet, the part up to the first comma is
 * the first piece – a short first piece is heard ~2 s sooner from the local voice; every later piece ends at a sentence
 * end as before. The part only ever grows while the text grows (the reader reads on past what it already has).
 */
export function sentencesDone(text: string): string {
  let at = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length;
    if (match[0] === '.' && (ABBREVIATION.test(text.slice(Math.max(0, match.index - 40), end)) || GOES_ON.test(text.slice(end)))) continue;
    if (end - at >= PIECE_MIN) at = end;
  }
  if (at === 0) at = firstClause(text);
  return at > 0 ? text.slice(0, at).trim() : '';
}

/** Where the first comma ends the first piece (at least FIRST_CLAUSE_MIN long), else 0; "3," at the very end may still become "3,5". */
function firstClause(text: string): number {
  for (const match of text.matchAll(CLAUSE_END)) {
    const end = match.index + 1;
    if (end === text.length && /\d$/.test(text.slice(0, match.index))) return 0;
    if (end >= FIRST_CLAUSE_MIN) return end;
  }
  return 0;
}

/** A take with this share of its word pairs (single words for one or two) among what others just said is their echo. */
const ECHO_SHARE = 0.7;
const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const pairsOf = (words: readonly string[]) => (words.length < 3 ? [...words] : words.slice(1).map((word, index) => `${words[index]} ${word}`));

/**
 * Owner 19.11.2026: whether a take is what others just said in the call (`said`) – another device of the call reading a
 * reply aloud, or the same line heard there too – rather than the person speaking to this device. Compared in word pairs, so
 * common words alone do not make a new sentence an echo.
 */
export function echoOf(take: string, said: Iterable<string>): boolean {
  const heard = pairsOf(wordsOf(take));
  if (!heard.length) return false;
  const known = new Set<string>();
  for (const text of said) { const words = wordsOf(text); for (const unit of [...words, ...pairsOf(words)]) known.add(unit); }
  return heard.filter((unit) => known.has(unit)).length / heard.length >= ECHO_SHARE;
}

/**
 * Turns a Markdown answer into speakable text: no code/ui/app fences, no markup or list bullets, a link as its words, and a
 * line that ends without a stop (a heading, a list item) ends as a sentence; bounded.
 */
export function speakable(markdown: string, max = 4000): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*[-+•][ \t]+/gm, '')
    .replace(/[`*_#>|~]+/g, ' ')
    .replace(/([^\s.!?:;,])[ \t]*\n\s*(?=\S)/g, '$1. ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
