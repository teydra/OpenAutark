// Calls: a chat's voice mode on the device the person uses (shared/voice/conversation.ts) – or, with a realtime key, a
// realtime voice session the runtime keeps (runtime/calls/realtime). Every call is one value in its chat: one quiet row
// whose meta.call is the call (CallRecord – written only by the PC of the device, runtime/calls/call-log.ts) with every
// line said in it; each line itself carries meta.call (CallLineMeta) with the call's id. This file holds those shapes, the
// calls.* methods and how a line said by voice is marked (SpeechMeta.live, SpeechMeta.call on the way in).
// B-081 (owner 08.11.2026 "dass die KI den User auch noch anrufen kann … wie bei WhatsApp"): an agent's call (tool
// chat.call) is the same row, born ringing (CallRecord.ring); the device that accepts takes the row (calls.start with
// the callId – also a takeover from another device), and the row's holder is its PC plus participant (callHolder).
// callState reads ringing / running / missed / declined / ended from the row and the clock; calls.live lists the
// ringing and running calls for every device.
// Owner 19.11.2026 ("mit dem anderen Gerät auch noch reingehen"): more devices of the person join a running call beside
// its holder (CallRecord.joined, calls.start with join); each one's lines go into the same call, each one leaves alone,
// and the holder's place goes to the next device when it leaves (call-log.ts). callMember says whether a device is in.
// Team-Call 21.11.2026 (owner: "wenn zwei Menschen in der Gruppe sind, müssen die joinen können"): the people of a chat
// share its call – every member's PC window sees Join (LiveCall.others: another person's PC holds it) and gets in beside
// the others; each device names its person (CallJoin.person). People hear each other live over WebRTC between their PC
// windows (ui/chat/call/people-audio.ts): calls.peers names whom a window talks to, calls.signal carries the SDP to that
// PC (runtime/calls/call-peer.ts; the event calls.signal there). The holder's device leaving while another person is
// still in keeps the call with its PC (holderOut) until the last one is out.
// Owns: the shapes shared by runtime and clients (augmenting Methods like model/remote.ts). Never: carries audio beyond the
// realtime chunks or provider keys; a call's lines are copies of its chat rows (text capped at CALL_LINE_TEXT), written and
// kept in step with those rows only by the PC that holds the call row.

import type { Message } from './chat.ts';

/** The device a call runs on: its key ('pc' for this PC's window, else the paired device id) and its label. */
export interface CallDevice { key: string; name: string }

/** How a line was said in a call (meta.call, set by the runtime – never by a client). */
export interface CallLineMeta {
  /** The call's id (its row in the chat, CallRecord). */
  id: string;
  /** Who said it: 'device:<key>' (the person on that device) or 'agent:<agentId>' (its realtime voice, its talker or its turn). */
  participant: string;
  /** Its label at that time. */
  name: string;
  /** An agent line the realtime voice already spoke: no voice loop reads it aloud again. */
  spoken?: true;
  /** The agent's live voice said it, a realtime session or the talker (runtime/calls/talker.ts), not the agent's full turn. */
  voice?: 'realtime' | 'talker';
  /** Owner 19.11.2026: the person said it on a device joined from another PC – stored quiet; the call voice of the PC that holds the call answers it. */
  relay?: true;
}

/** One line of a call's transcript (CallRecord.lines): who said what when, and the chat row it is. */
export interface CallLine {
  at: number;
  /** 'device:<key>' – the person; 'agent:<agentId>'; another member as '<kind>:<id>'. */
  from: string;
  name: string;
  text: string;
  messageId?: string;
}

/**
 * The call's own row (kind 'status', quiet): meta.call with the device as participant 'device:<key>' and its name, the PC
 * that writes it, when it started and ended, and its lines – both sides, the newest CALL_LINES. Every device renders it as
 * one bubble.
 */
export interface CallRecord extends CallLineMeta {
  /** The PC that writes this row (its device id; absent where the PC has no device record): its lines follow edits and deletions there. */
  pc?: string;
  startedAt: number;
  endedAt?: number;
  lines: CallLine[];
  /** B-081: an agent's call – it rang until `until`; answeredAt when a device took it, declined when the person said no. */
  ring?: CallRing;
  /** B-081: the agents in the call – the caller first, then those it brought in or who joined. */
  agents?: string[];
  /** Owner 19.11.2026: the person's other devices in the call beside the holder (participant, name, pc), in the order they joined. */
  joined?: CallJoin[];
  /** Team-Call: the person on the holder's device (its PC's profile name). */
  person?: string;
  /** Team-Call: the holder's device left while another person stayed in – the call runs on, still written by its PC. */
  holderOut?: true;
}

/** Owner 19.11.2026: a device of the person in a call beside its holder – named like the holder (callHolder of it is its id); Team-Call: with its person's name. */
export interface CallJoin { participant: string; name: string; pc?: string; person?: string }

/** B-081: how an agent rang (chat.call): who, why (shown on every ringing device), its opening line and the deadline. */
export interface CallRing { by: string; why: string; say?: string; until: number; answeredAt?: number; declined?: { at: number; name: string } }

/** B-081: an agent's call rings this long on every device of the person. */
export const RING_MS = 45_000;
/** B-081: why a device's part of a call ended when another device took it over (no fallback, no error). */
export const TAKEN_OVER = 'The call goes on on another device.';
/**
 * Konrad 27.11.2026 (the local voice's licence, OpenRAIL-M, asks for a clear notice that its speech is machine-generated):
 * the words the call card shows for as long as it shows, and every ring notice carries (the Android app: CallVoiceNote).
 */
export const AI_VOICE_NOTICE = 'AI voice (machine-generated)';

/** A ring notice's body (the PC's OS notice, the phones' push): the AI voice notice first – it stays when a long why is cut –, then why. */
export function ringBody(why: string): string {
  return why ? `${AI_VOICE_NOTICE}\n${why}` : AI_VOICE_NOTICE;
}

export type CallState = 'ringing' | 'running' | 'missed' | 'declined' | 'ended';

/** Lines a call row keeps (the newest) and characters of one line's text. */
export const CALL_LINES = 120;
export const CALL_LINE_TEXT = 1000;

/** The call a row is the record of (its meta.call with lines), else undefined. */
export function callRecord(message: Pick<Message, 'kind' | 'meta'>): CallRecord | undefined {
  const call = message.meta.call;
  return message.kind === 'status' && call && Array.isArray((call as Partial<CallRecord>).lines) ? call as CallRecord : undefined;
}

/** B-081: where a call stands now – a ring nobody took is missed once its time is over (also before its end is written). */
export function callState(record: Pick<CallRecord, 'ring' | 'endedAt'>, now: number): CallState {
  const ring = record.ring;
  if (ring && ring.answeredAt === undefined) {
    if (ring.declined) return 'declined';
    return record.endedAt !== undefined || now >= ring.until ? 'missed' : 'ringing';
  }
  return record.endedAt === undefined ? 'running' : 'ended';
}

/** B-081: who holds the call row – its PC and participant (device key 'pc' is the same on every PC). */
export function callHolder(record: Pick<CallRecord, 'pc' | 'participant'>): string {
  return `${record.pc ?? ''}/${record.participant}`;
}

/** Owner 19.11.2026: whether the device `who` (callHolder form) is in the call – as its holder or joined beside it. */
export function callMember(record: Pick<CallRecord, 'pc' | 'participant' | 'joined' | 'holderOut'>, who: string): boolean {
  return (!record.holderOut && callHolder(record) === who) || (record.joined ?? []).some((device) => callHolder(device) === who);
}

/** Team-Call: the devices in the call now, the holder first (not after it left: holderOut). */
export function callDevices(record: Pick<CallRecord, 'participant' | 'name' | 'joined'> & Partial<Pick<CallRecord, 'pc' | 'person' | 'holderOut'>>): CallJoin[] {
  const holder: CallJoin = { participant: record.participant, name: record.name, ...(record.pc ? { pc: record.pc } : {}), ...(record.person ? { person: record.person } : {}) };
  return [...(record.holderOut ? [] : [holder]), ...(record.joined ?? [])];
}

/**
 * Who is in the call by name, the holder first: one person's devices by device name ("Pixel", "Pixel and laptop",
 * "Pixel, laptop and office-pc"); Team-Call: several people by their names ("Dominik and Momo").
 */
export function callDeviceNames(record: Pick<CallRecord, 'name' | 'joined'> & Partial<Pick<CallRecord, 'participant' | 'pc' | 'person' | 'holderOut'>>): string {
  const devices = callDevices({ participant: '', ...record });
  const people = new Set(devices.map((device) => device.person ?? ''));
  const names = [...new Set(devices.map((device) => (people.size > 1 ? device.person || device.name : device.name)))];
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? '';
}

/** B-081: a ringing or running call as every device lists it (calls.live): the status line's Accept / Take over. */
export interface LiveCall {
  callId: string;
  rowId: string;
  conversationId: string;
  state: 'ringing' | 'running';
  /** The calling agent's name (a ring). */
  agentName?: string;
  why?: string;
  until?: number;
  /** The devices in it (running): the holder's name, with those joined beside it ("Pixel and laptop"). */
  device?: string;
  holder?: string;
  /** The call's newest line. */
  last?: { name: string; text: string };
  /** Team-Call: another person's PC holds it – this device joins it beside them (no take-over of someone else's place). */
  others?: true;
}

/** Team-Call: one WebRTC signal between two people's PC windows in a call (no trickle: an SDP carries its candidates). */
export type CallSignal = { op: 'hello' } | { op: 'bye' } | { op: 'offer' | 'answer'; sdp: string };
/** Team-Call: a PC window this window hears and is heard by in a call (callHolder form) and its person's name. */
export interface CallPeer { id: string; name: string }
/** The longest SDP a signal carries. */
export const MAX_CALL_SDP = 12 * 1024;

/** Team-Call: the signal a value is, else undefined (checked on both PCs). */
export function callSignal(value: unknown): CallSignal | undefined {
  const o = value as { op?: unknown; sdp?: unknown } | null;
  if (o?.op === 'hello' || o?.op === 'bye') return { op: o.op };
  if ((o?.op === 'offer' || o?.op === 'answer') && typeof o.sdp === 'string' && o.sdp.length > 0 && o.sdp.length <= MAX_CALL_SDP) return { op: o.op, sdp: o.sdp };
  return undefined;
}

/** "4:42", "1:02:05": how long a call ran. */
export function callLength(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const two = (value: number) => String(value).padStart(2, '0');
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}:${two(minutes)}:${two(seconds % 60)}` : `${minutes}:${two(seconds % 60)}`;
}

/** Audio and turn events of a realtime session for its device (calls.realtimePull). */
export type RealtimeOut =
  | { seq: number; type: 'audio'; data: string } // base64 PCM16 LE mono 24 kHz
  | { seq: number; type: 'speaking' } // the model started an answer
  | { seq: number; type: 'done' } // the answer ended
  | { seq: number; type: 'interrupted' } // the person talked over it: stop playback now
  | { seq: number; type: 'error'; message: string };

export interface RealtimePull { events: RealtimeOut[]; next: number; closed?: string }

/** Sample rate of realtime audio in both directions (PCM16 LE mono). */
export const REALTIME_RATE = 24_000;
/** One calls.realtimeSend chunk: at most this many base64 characters (≈ 0.5 s of audio). */
export const REALTIME_MAX_CHUNK = 32_768;

declare module './chat.ts' {
  interface MessageMeta {
    /** A line said in a call (CallLineMeta), or – on the call's own quiet row – the call itself (CallRecord). */
    call?: CallLineMeta | CallRecord;
  }
  interface SpeechMeta {
    /** Said in a live conversation (not dictated into the composer): never folded into a running turn. */
    live?: true;
    /** On the way in only (messages.send): the call the live line belongs to (calls.start); stored as meta.call. */
    call?: string;
  }
}

declare module '../api/methods.ts' {
  interface Methods {
    /**
     * Opens this device's call in a chat – its quiet row – or returns the one already open there; it ends with calls.end or
     * the connection. B-081: a callId takes that call – answers a ring (say: the agent's opening line, also posted in the
     * chat) or takes it over from another device. Owner 19.11.2026: `join` with a callId joins that running call beside the
     * devices in it instead. holder: this device as the call names it (callHolder form); joined: it is in beside the holder.
     */
    'calls.start': { params: { conversationId: string; callId?: string; join?: boolean }; result: { callId: string; holder: string; say?: string; joined?: true } };
    /** This device leaves its call; the call ends with the last device in it (its row gets endedAt). */
    'calls.end': { params: { callId: string }; result: { ok: true } };
    /** B-081: the person says no to a ringing call (any device): the row ends declined and the agent hears it. */
    'calls.decline': { params: { callId: string }; result: { ok: true } };
    /** B-081: the ringing and running calls (also pushed as the event calls.live on topic chats). */
    'calls.live': { params: void; result: { calls: LiveCall[] } };
    /**
     * One call turn as the device measured it (ui/chat/call/turn-meter.ts), in ms after the end of the person's speech:
     * heard, the answer's first word, the answer handed to the reading voice; who heard it (voice.transcribe's `by`) and who
     * answered (the talker, the agent's turn or the program's own line, with the model). Written as one log line.
     */
    'calls.turn': { params: { callId: string; heardMs: number; answerMs: number; speakMs: number; heardBy: string; answeredBy: 'talker' | 'turn' | 'program'; model?: string }; result: { ok: true } };
    /** Opens a realtime voice session for this device in a chat (only with a connected realtime model); B-081: a callId takes that call. */
    'calls.realtimeOpen': { params: { conversationId: string; callId?: string }; result: { sessionId: string; model: string; agentId: string } };
    /** Microphone audio: base64 PCM16 LE mono 24 kHz. */
    'calls.realtimeSend': { params: { sessionId: string; audio: string }; result: { ok: true } };
    /** Waits (≤ 25 s) for the session's next audio/turn events after `after`. */
    'calls.realtimePull': { params: { sessionId: string; after?: number }; result: RealtimePull };
    /** The person talked over the answer on this device: the model stops it. */
    'calls.realtimeInterrupt': { params: { sessionId: string; playedMs?: number }; result: { ok: true } };
    'calls.realtimeClose': { params: { sessionId: string }; result: { ok: true } };
    /** Team-Call: whom this PC window hears in its call – the other people's PC windows in it – and how the call names it. */
    'calls.peers': { params: { conversationId: string; callId: string }; result: { me: string; peers: CallPeer[] } };
    /** Team-Call: a WebRTC signal to one of those peers (its PC's window hears the event calls.signal); sent false: not a peer now. */
    'calls.signal': { params: { conversationId: string; callId: string; to: string; data: CallSignal }; result: { sent: boolean } };
  }
}

declare module '../api/events.ts' {
  interface EventMap {
    /** Team-Call: a peer's WebRTC signal for this PC's window in a call (topic 'system': this PC's own window). */
    'calls.signal': { conversationId: string; callId: string; from: string; data: CallSignal };
  }
}
