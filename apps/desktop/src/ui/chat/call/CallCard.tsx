// B-085 (owner 08.11.: the fork's call look, but "weiterarbeiten und den Chat sehen"): the call card – a compact dark
// card that floats at one fixed spot of the chat column while this device talks in the chat (call.css: over the top
// of the messages, left; in a narrow column and on the phone at their foot, clear of the status lines). It is an
// overlay of fixed size: it never pushes, resizes or
// covers anything but the messages under it; the messages and the composer stay usable. CallHeader.tsx mounts it from
// the call cell and it lays itself into the chat column of that cell's chat view (a portal), so it shows only in the
// chat whose call runs and goes with the call.
// Content: the agent's face with the speaking ring (realtime voice: the live levels of levels.ts, written on the DOM on
// a short interval – no re-render; the voice conversation: its phase), the name, status + clock ("Listening · 1:23",
// call-card-model.ts), the call's newest line as the caption, Mute (mute.ts: realtime voice sends silence, the voice
// conversation's capture – composer/conversation-audio.ts – drops muted blocks), Camera and Screen (owner 19.11.2026: what
// this device shows goes with its lines – call-view.ts; the preview with its cut-out is CallShare.tsx under the card) and the
// red Hang up (the call cell's End). Team-Call 21.11.2026: while the card shows, with several people in the call the status line
// names who is in (their audio runs from the shell, people-call.ts – not from this card) ("… · Dominik and Momo").
// Konrad 27.11.2026: its foot line says "AI voice (machine-generated)" for as long as the card shows (the local voice's licence).
// Owns: the card's markup, its clock and its level loop. Never: starts or ends audio itself, or decides a call's state.

import { createPortal } from 'preact/compat';
import type { RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { AI_VOICE_NOTICE, callDeviceNames, callDevices } from '../../../shared/model/call.ts';
import type { ConversationSummary } from '../../../shared/model/chat.ts';
import { ChatFace, chatTitle } from '../../lib/chat-face.tsx';
import { voicePhase, voiceSessions } from '../../lib/shell-state.ts';
import { knownAgentMap, messagesFor } from '../../lib/store.ts';
import { AgentAvatar, Icon } from '../../lib/ui.tsx';
import { callSince, captionOf, phaseOf, runningCall, statusLine } from './call-card-model.ts';
import { micMeter, playMeter, ringScale, speakerOf } from './levels.ts';
import { callMuted, setCallMuted } from './mute.ts';
import { realtimeChat, realtimePhase } from './realtime-call.ts';
import { CallShare } from './CallShare.tsx';
import { callShare, canShare, stopShare, toggleShare, type ShareKind } from './call-view.ts';

const LEVEL_MS = 90;
const FACE = 36;

/** The chat column of the chat view `anchor` sits in (the card's place), else null. */
function chatColumnOf(anchor: Element | null): HTMLElement | null {
  return anchor?.closest('.chat-view')?.querySelector<HTMLElement>(':scope > .chat-body > .chat-column') ?? null;
}

/** Realtime voice: the ring follows the live levels, the side heard colours it; `playing` flips only when it changes. */
function useLevels(card: RefObject<HTMLElement>, on: boolean, onPlaying: (playing: boolean) => void): void {
  useEffect(() => {
    if (!on) return;
    const tick = () => {
      const root = card.current;
      if (!root) return;
      const now = performance.now();
      const mic = micMeter.read(now);
      const out = playMeter.read(now);
      const speaker = speakerOf(mic, out);
      root.style.setProperty('--call-ring', String(ringScale(Math.max(mic, out))));
      if (speaker) root.dataset.speaker = speaker; else delete root.dataset.speaker;
      onPlaying(playMeter.playing(now));
    };
    const timer = setInterval(tick, LEVEL_MS);
    return () => {
      clearInterval(timer);
      card.current?.style.removeProperty('--call-ring');
      if (card.current) delete card.current.dataset.speaker;
    };
  }, [on]);
}

export function CallCard(props: { chat: ConversationSummary; anchor: RefObject<Element>; onHangUp(): void }) {
  const { chat } = props;
  const card = useRef<HTMLElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [playing, setPlaying] = useState(false);
  const realtime = realtimeChat.value === chat.id;
  useLayoutEffect(() => { setHost(chatColumnOf(props.anchor.current)); }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useLevels(card, realtime, setPlaying);
  useEffect(() => () => stopShare(chat.id), [chat.id]); // what this device shows ends with its call here
  const sessions = voiceSessions.value;
  const voice = sessions.find((session) => session.conversationId === chat.id);
  const phase = phaseOf(realtime ? realtimePhase.value : undefined, voice && voicePhase(voice, sessions.length > 1), playing);
  // the voice conversation has no levels here: its phase colours the ring (realtime: useLevels writes it; its cleanup runs first)
  const agentSpeaks = !realtime && phase === 'speaking';
  useEffect(() => {
    const root = card.current;
    if (realtime || !root) return;
    if (agentSpeaks) root.dataset.speaker = 'agent'; else delete root.dataset.speaker;
  }, [realtime, agentSpeaks, host]);
  const call = runningCall(messagesFor(chat.id).value, now);
  const devices = call ? callDevices(call) : [];
  if (!host) return null;

  const agentId = call?.ring?.by ?? call?.agents?.[0];
  const name = (agentId && knownAgentMap.value.get(agentId)?.name) || chatTitle(chat);
  const caption = captionOf(call?.lines[call.lines.length - 1]);
  const people = call && new Set(devices.map((device) => device.person ?? '')).size > 1 ? callDeviceNames(call) : ''; // Team-Call: who is in
  const muted = callMuted.value; // B-082 gates the voice conversation's capture too (composer/conversation-audio.ts)
  const shows = callShare.value?.conversationId === chat.id ? callShare.value.kind : undefined;
  // realtime voice sends audio only: a picture reaches the agent with the voice conversation's lines
  const share = (kind: ShareKind, icon: 'camera' | 'monitor', label: string) => !realtime && canShare(kind) && (
    <button type="button" class="call-control share" aria-pressed={shows === kind} aria-label={shows === kind ? `Stop ${label.toLowerCase()}` : label} title={shows === kind ? `Stop ${label.toLowerCase()}` : label} onClick={() => void toggleShare(chat.id, kind)}>
      <Icon name={icon} size={18} />
    </button>
  );

  return createPortal(
    <section ref={card} class={`call-card phase-${phase}${realtime ? ' metered' : ''}`} aria-label={`Call with ${name}`}>
      <span class="call-face">{agentId ? <AgentAvatar agentId={agentId} size={FACE} /> : <ChatFace chat={chat} size={FACE} />}</span>
      <span class="call-who">
        <span class="call-name">{name}</span>
        <span class="call-status tabular">{muted && <span class="call-muted">Microphone off · </span>}{statusLine(phase, call ? callSince(call) : undefined, now)}{people && ` · ${people}`}</span>
      </span>
      <span class="call-controls">
        <button type="button" class="call-control" aria-pressed={muted} aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute' : 'Mute'} onClick={() => setCallMuted(!muted)}>
          <Icon name="microphone" size={18} />
        </button>
        {share('camera', 'camera', 'Show camera')}
        {share('screen', 'monitor', 'Share screen')}
        <button type="button" class="call-control hang-up" aria-label="Hang up" title="Hang up" onClick={props.onHangUp}>
          <Icon name="phone-disconnect" size={18} />
        </button>
      </span>
      <p class="call-caption" data-side={caption?.side}>{caption && <><strong>{caption.name}</strong> {caption.text}</>}</p>
      <p class="call-ai-voice">{AI_VOICE_NOTICE}</p>
      <CallShare conversationId={chat.id} />
    </section>,
    host,
  );
}
