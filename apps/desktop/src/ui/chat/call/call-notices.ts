// B-081: an agent's call and a call on another device in the status line (shell/StatusLine.tsx registers it; an overlay
// line – nothing in the frame moves). One signal fed by the 'calls.live' event (topic chats) and loaded again after every
// (re)connect – no polling –, and a pure provider:
//   ringing:  "<Agent> calls · AI voice (machine-generated) · <why>"  [Accept] (opens the chat and answers, CallHeader.tsx answerCall) [Decline]
//   running elsewhere (not talking on this device): "Call on <device> · <name>: <last line>"  [Take over] [Join]
//   (owner 19.11.2026: Join brings this device in beside the others – CallHeader.tsx answerCall with join – and opens the
//   call's chat first when another one is open, so its call card shows)
//   Team-Call 21.11.2026 – another person's call (LiveCall.others): "Call with <who is in> · <name>: <last line>"  [Join]
// While a call rings here a ring tone plays: one WebAudio two-tone pattern scheduled once on the audio timeline for the
// ring's remaining time (no JS interval); it stops when the ring leaves the list or this device talks in that chat. The
// only timer is one armed for the ring's end, so the line goes even before the runtime's next list.
// It rings whatever the chat's notification level says: the call is the agent's own decision.
// Team-Call 21.11.2026: registering also starts people audio (people-call.ts watchPeopleAudio) for the calls this window talks in.
// Owns: that signal, the provider, the tone. Never: decides a call's state (runtime/calls/ring.ts) or starts audio input.

import { effect, signal } from '@preact/signals';
import { AI_VOICE_NOTICE, type LiveCall } from '../../../shared/model/call.ts';
import { navigate } from '../../lib/router.ts';
import { rpc } from '../../lib/rpc.ts';
import { can } from '../../lib/session.ts';
import { activeConversationId } from '../../lib/store.ts';
import { toastError } from '../../lib/toasts.ts';
import { watchPeopleAudio } from './people-call.ts';
import { NOTICE_PRIORITY, registerNotice, type Notice, type NoticeAction } from '../../shell/notices.ts';

/** The ringing and running calls of the person (empty until the runtime answered). */
export const liveCalls = signal<readonly LiveCall[]>([]);
/** Bumped when a ring's time is over (one armed timer), so the providers read the clock again. */
const ringClock = signal(0);

export interface CallNoticeContext { now: number; open: string | null; talking(conversationId: string): boolean }
export interface CallNoticeActions { answer(conversationId: string, callId: string, join?: boolean): unknown; decline(callId: string): unknown; open(conversationId: string): void }

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The calls that ring on this device now (not where it already talks in that chat). */
export function ringingHere(calls: readonly LiveCall[], context: Pick<CallNoticeContext, 'now' | 'talking'>): LiveCall[] {
  return calls.filter((call) => call.state === 'ringing' && (call.until ?? 0) > context.now && !context.talking(call.conversationId));
}

/** The status line's call lines: a ring with Accept / Decline, a call on another device with Take over / Join. */
export function callNotices(calls: readonly LiveCall[], context: CallNoticeContext, actions: CallNoticeActions): Notice[] {
  const ringing = ringingHere(calls, context).map((call): Notice => ({
    id: `ring:${call.callId}`, tone: 'info', text: `${call.agentName ?? 'An agent'} calls · ${AI_VOICE_NOTICE}${call.why ? ` · ${clip(call.why, 120)}` : ''}`, priority: NOTICE_PRIORITY.ring,
    actions: [
      { label: 'Accept', primary: true, run: () => { if (context.open !== call.conversationId) actions.open(call.conversationId); return actions.answer(call.conversationId, call.callId); } },
      { label: 'Decline', run: () => actions.decline(call.callId) },
    ],
  }));
  const elsewhere = calls.filter((call) => call.state === 'running' && !context.talking(call.conversationId)).map((call): Notice => {
    const take: NoticeAction = { label: 'Take over', run: () => actions.answer(call.conversationId, call.callId) };
    const join: NoticeAction = { label: 'Join', run: () => { if (context.open !== call.conversationId) actions.open(call.conversationId); return actions.answer(call.conversationId, call.callId, true); } };
    const last = call.last ? ` · ${call.last.name}: ${clip(call.last.text, 90)}` : '';
    // Team-Call: another person's call – this device joins them, it takes nobody's place
    const text = call.others ? `Call with ${call.device ?? 'someone'}${last}` : `Call on ${call.device ?? 'another device'}${last}`;
    return {
      id: `call-on:${call.callId}`, tone: 'info', text, detail: call.last?.text, priority: NOTICE_PRIORITY.call,
      actions: call.others ? [{ ...join, primary: true }] : [take, join],
    };
  });
  return [...ringing, ...elsewhere];
}

// ------------------------------------------------------------------ the ring tone

let tone: { context: AudioContext; until: number } | null = null;

/** One two-tone ring (440 + 480 Hz, two short bursts every 3 s) scheduled until `until` on the audio timeline. */
function playTone(until: number): void {
  if (tone?.until === until) return;
  stopTone();
  const seconds = (until - Date.now()) / 1000;
  if (seconds <= 0 || typeof AudioContext === 'undefined') return;
  try {
    const context = new AudioContext();
    void context.resume?.().catch(() => undefined);
    const gain = context.createGain();
    gain.gain.value = 0;
    gain.connect(context.destination);
    const start = context.currentTime + 0.05;
    const end = start + seconds;
    for (const frequency of [440, 480]) {
      const oscillator = context.createOscillator();
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start(start);
      oscillator.stop(end);
    }
    for (let at = start; at < end; at += 3) {
      for (const [on, off] of [[0, 0.4], [0.6, 1]]) {
        if (at + on >= end) break;
        gain.gain.setTargetAtTime(0.08, at + on, 0.01);
        gain.gain.setTargetAtTime(0, Math.min(at + off, end), 0.01);
      }
    }
    tone = { context, until };
  } catch {
    tone = null; // no audio here: the line and the OS notice still ring
  }
}

function stopTone(): void {
  const playing = tone;
  tone = null;
  if (playing) void playing.context.close().catch(() => undefined);
}

// ------------------------------------------------------------------ registration

let watching = false;

function load(): void {
  if (!can('calls.live')) return;
  rpc.call('calls.live').then((answer) => { liveCalls.value = answer.calls; }, () => undefined);
}

/** Follows the calls once (idempotent): the event, a load after every (re)connect, the ring's end and the tone. */
function watchCalls(talking: CallNoticeContext['talking']): void {
  if (watching) return;
  watching = true;
  rpc.on('calls.live', (data) => { liveCalls.value = data.calls; });
  rpc.onOpen(load);
  load();
  let armed: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    void ringClock.value;
    const ringing = ringingHere(liveCalls.value, { now: Date.now(), talking });
    if (armed !== undefined) clearTimeout(armed);
    armed = undefined;
    if (!ringing.length) { stopTone(); return; }
    const until = Math.max(...ringing.map((call) => call.until ?? 0));
    playTone(until);
    armed = setTimeout(() => { armed = undefined; ringClock.value += 1; }, Math.max(0, Math.min(...ringing.map((call) => call.until ?? 0)) - Date.now()) + 50);
  });
}

/** Registers the provider (once per app start); `answer` and `talking` come from the chat header (CallHeader.tsx). */
export function registerCallNotices(header: { answer: CallNoticeActions['answer']; talking: CallNoticeContext['talking'] }): () => void {
  watchCalls(header.talking);
  watchPeopleAudio(liveCalls, header.talking); // Team-Call: people in a call hear each other in every view
  const actions: CallNoticeActions = {
    answer: header.answer,
    decline: (callId) => rpc.call('calls.decline', { callId }).catch((error: unknown) => toastError(error, 'Call not declined')),
    open: (conversationId) => navigate({ view: 'chat', id: conversationId }),
  };
  return registerNotice(() => {
    void ringClock.value;
    return callNotices(liveCalls.value, { now: Date.now(), open: activeConversationId.value, talking: header.talking }, actions);
  });
}
