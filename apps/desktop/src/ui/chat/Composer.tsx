// The one composer: auto-growing field (to ~40 % of the window), Enter sends (setting), per-chat drafts,
// attachments (Plus menu, drag/drop, paste), @mentions and /commands, dictation into the caret (the
// waveform sits in the action row's spacer) and one primary button: Send, disabled without content – a take that records or
// is transcribed counts (feedback FCMWNZ0H 20.11.2026: Send stops it, waits for its words and sends them, an empty field too);
// while it runs the + is an × that cancels it (composer/PlusCancel.tsx), the mic cell only shows its state.
// Action row, fixed cells: [+] [spacer] [Model] [Mic] [Send] – nothing in it moves on a click (B-083: no Ultra cell –
// the agent splits itself when it pays, owner 08.11.). `slim` (a task's thread in its detail, the mockup's line "Write to
// Clara about this…"): one row [+] [field] [Mic] [Send] without the big frame and the model cell (composer.css .slim).
// How a message goes out: /important, /silent, or the Plus menu's and the Send button's right-click menu's "Send as important",
// "Send silently" (with nothing to send yet: the draft's level) and "Schedule…": that switches the composer into schedule
// mode (composer/ScheduleBar.tsx above the text, the field taller, Send = Schedule; Esc or × leaves; text only – a draft
// with files cannot be scheduled and says so). Plus › Secret opens the secret mode the same way (settings/SecretRows.tsx
// ChatSecretBar above the text: each row becomes a chip).
// A reply shows its quote chip above the field (X or Esc cancels it) and goes out as `replyTo`.
// A one-shot fill ("/task ") goes only into an empty composer – it never overwrites the person's draft.
// B-082: unsure places of dictated text are highlighted behind the field (composer/MarkLayer.tsx); a click or tap with
// the caret in one opens its menu (composer/MarkMenu.tsx). The text itself stays plain. A kept take's chip has
// "Transcribe again" (composer/voice.ts retryTake: the words go in at the caret).
// F23: Plus › Record audio / Record video open composer/RecordBar.tsx in the same slot above the text (the take goes in
// as a chip, a recording or video not bound to the 20 MB of other files; Send waits while a take records, attaches or
// waits there); Photos & videos takes both; on a phone Take photo and Record video are the camera app's.
// Owner 24.11.2026 (task_ec8e4ztn): a Send while a take is still heard shows the line in the chat at once (pending-sends.ts).
// Owns: input handling and when to send (the send itself: composer/send.ts). Never: message rendering or chat settings UI.

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ConversationSummary, MessageLevel } from '../../shared/model/chat.ts';
import { Icon } from '../lib/ui.tsx';
import { useContextMenu } from '../lib/context-menu.tsx';
import { composerPlaceholder } from '../lib/chat-naming.ts';
import { isMobile, preferences } from '../lib/store.ts';
import { bridge } from '../lib/platform.ts';
import { toAttachment, uploadFile } from '../lib/files.ts';
import { COMPOSER_BUSY, composerFill, composerFillText } from '../lib/shell-state.ts';
import { pushToast, toastError } from '../lib/toasts.ts';
import { ComposerAttachments } from './Attachments.tsx';
import { SecretAttachments } from './SecretAttachments.tsx';
import { ChatSecretBar } from '../settings/SecretRows.tsx';
import { ReplyQuote } from './ReplyQuote.tsx';
import { draftFor, flushDraft, setReply, updateDraft } from './composer/draft.ts';
import { sendDraft } from './composer/send.ts';
import { addPending, pendingSends, removePending } from './pending-sends.ts';
import { joinPieces } from '../lib/take-pieces.ts';
import { dictation } from '../lib/dictation.ts';
import { newId } from '../../shared/ids.ts';
import { createTaskFromText, parseSlash, runSlash, sendMenuItems } from './composer/slash.ts';
import { findToken, suggestionsFor, SuggestionList, useSuggestions } from './composer/Suggestions.tsx';
import type { Suggestion } from './composer/Suggestions.tsx';
import { ModelChip } from './composer/ModelChip.tsx';
import { PlusMenu } from './composer/PlusMenu.tsx';
import { useRecordSlot } from './composer/RecordBar.tsx';
import { isMedia, uploadMedia } from './composer/record-take.ts';
import { ScheduleBar } from './composer/ScheduleBar.tsx';
import { leaveScheduleMode, openScheduleMode, patchForm, scheduleDraft, scheduleModeFor } from './composer/schedule-mode.ts';
import { scheduleSpec } from './composer/schedule-form.ts';
import { useNextRun } from './composer/schedule-next.ts';
import { clearDraftSpeech, dictateIntoDraft, dictating, retryTake, settleTake, transcribing } from './composer/voice.ts';
import { MicButton, targetOf, useDictationField, waveState } from './composer/MicButton.tsx';
import { DictationWave } from './composer/DictationWave.tsx';
import { mentionsIn, targetAgent } from './composer/target.ts';
import { composerControls } from './composer/controls.ts';
import type { SpanMark } from '../../shared/voice/marks.ts';
import { markAt } from './composer/draft-marks.ts';
import { MarkLayer } from './composer/MarkLayer.tsx';
import { MarkMenu } from './composer/MarkMenu.tsx';

/** Preview only this take: another chat can start recording before the last piece comes back. */
function dictationPreview(chatId: string): (() => string) | undefined {
  const source = dictation.heardSource;
  if (source?.chatId !== chatId) return;
  let words = '';
  const preview = () => {
    const pieces = dictation.heardPieces.value;
    if (source === dictation.heardSource) words = joinPieces(pieces.flatMap((piece) => piece.text ? [{ text: piece.text }] : [])).text;
    return words;
  };
  preview();
  return preview;
}

export function Composer(props: { chat: ConversationSummary; slim?: boolean }) {
  const { chat } = props;
  const draft = draftFor(chat.id);
  const { text, attachments, level, replyTo, secrets = [], marks } = draft.value;
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [openMark, setOpenMark] = useState<SpanMark | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const [uploading, setUploading] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [secretOpen, setSecretOpen] = useState(false);
  const [modelSignal, setModelSignal] = useState(0);
  const mode = scheduleModeFor(chat.id).value; // schedule mode (null = a normal composer)
  const scheduling = mode !== null;
  const suggest = useSuggestions();
  const record = useRecordSlot(chat.id, (files) => void addFiles(files)); // F23: the RecordBar, the camera input
  const isDictating = dictating.value === chat.id;
  const transcribingHere = transcribing.value.has(chat.id); // the stopped take's text is still on its way
  const hasContent = text.trim().length > 0 || attachments.length > 0 || secrets.length > 0;

  const setText = (value: string) => updateDraft(chat.id, { text: value });
  useDictationField(chat.id, fieldRef, setCaret); // D13: the caret after a dictated take

  // Auto-grow up to ~40 % of the viewport, then scroll (schedule mode: from a taller minimum, composer.css).
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, Math.round(innerHeight * 0.4))}px`;
  }, [text, scheduling]);
  useEffect(() => { if (scheduling) fieldRef.current?.focus(); }, [scheduling]); // opened from a menu: write the message

  useEffect(() => {
    if (!isMobile.value && !props.slim) fieldRef.current?.focus(); // a task's thread line never takes the caret from its detail
    return () => flushDraft(chat.id);
  }, [chat.id]);
  useEffect(() => { if (replyTo) fieldRef.current?.focus(); }, [replyTo]); // Reply on a message: write it here

  // An emptied draft (sent, turned into a task, cleared) was not dictated any more; reads the draft as it
  // is now, so a failed send that gave the speech back with the text keeps it.
  useEffect(() => { if (!draft.peek().text.trim()) clearDraftSpeech(chat.id); }, [chat.id, text]);

  // One-shot fills ("/task " from the palette and the task panel): only into an empty composer; a
  // draft stays as it is – the field takes the focus and a toast says why nothing was inserted.
  useEffect(() => {
    const fill = composerFill.value;
    if (!fill || fill.conversationId !== chat.id) return;
    composerFill.value = null;
    const next = composerFillText(text, fill.text); // never over the person's draft
    if (next === null) pushToast({ title: COMPOSER_BUSY, tone: 'info' }, 4000);
    else setText(next);
    requestAnimationFrame(() => { const field = fieldRef.current; field?.focus({ preventScroll: true }); field?.setSelectionRange(field.value.length, field.value.length); });
  }, [composerFill.value]);

  const token = findToken(text, caret);
  const items = suggestionsFor(chat, token);
  const visibleItems = suggest.dismissed === items.map((item) => item.key).join() ? [] : items;

  const accept = (item: Suggestion) => {
    if (!token) return;
    const next = text.slice(0, token.start) + item.insert + text.slice(caret);
    setText(next);
    const position = token.start + item.insert.length;
    requestAnimationFrame(() => { fieldRef.current?.setSelectionRange(position, position); setCaret(position); });
  };

  const addFiles = async (list: File[]) => {
    if (!list.length) return;
    setUploading((current) => [...current, ...list.map((file) => file.name)]);
    for (const file of list) {
      try {
        const attachment = isMedia(file) ? await uploadMedia(file, file.name, chat.id) // a recording or video: chunked, no 20 MB cap
          : await uploadFile(file, undefined, { conversationId: chat.id }); // F-52: a person's file goes into this chat
        updateDraft(chat.id, { attachments: [...draft.value.attachments, attachment] });
      } catch (error) { toastError(error, 'Upload failed'); }
      setUploading((current) => { const index = current.indexOf(file.name); return index === -1 ? current : [...current.slice(0, index), ...current.slice(index + 1)]; });
    }
  };

  const pickFiles = async (images: boolean) => {
    if (bridge) {
      // Desktop: the native dialog; main uploads the choice by path (no bytes through here).
      try {
        const refs = await bridge.files.pick(images ? 'images' : 'files');
        if (refs.length) updateDraft(chat.id, { attachments: [...draft.value.attachments, ...refs.map(toAttachment)] });
      } catch (error) { toastError(error, 'Upload failed'); }
      return;
    }
    (images ? imageRef : fileRef).current?.click();
  };

  // The whole draft goes out – files, secrets, reply – also at another level (composer/send.ts).
  const sendAs = (body: string, sentLevel: MessageLevel, clientId?: string) => sendDraft({ conversationId: chat.id, body, level: sentLevel, mentions: (sent) => mentionsIn(sent, chat), ...(clientId ? { clientId } : {}) });

  /** `sentLevel`: the Plus menu's "Send as important" / "Send silently" (no slash command then). */
  const send = async (sentLevel?: MessageLevel) => {
    if (sending || record.held) return; // never sends without the take
    setSending(true); // also while a dictation is transcribed first (a second tap sends nothing twice)
    // Owner 24.11.2026 (task_ec8e4ztn): a Send while the take is still heard shows the line at once – the typed text and
    // the words heard so far (PendingMessages.tsx) – instead of an empty chat until the last piece is transcribed.
    const early = dictating.peek() === chat.id || transcribing.peek().has(chat.id) ? newId('req') : undefined;
    if (early) addPending({
      clientId: early, conversationId: chat.id, body: draft.peek().text.trim(), attachments: draft.peek().attachments,
      state: 'transcribing', preview: dictationPreview(chat.id),
    });
    try {
      // A running take stops, a stopped one is waited for: its words go out with the draft. One that came back as a
      // recording, failed or was cancelled leaves the draft: the person sees it (and the toast) first.
      if (!(await settleTake(chat.id))) return;
      const body = draft.value.text;
      if (!body.trim() && !draft.value.attachments.length && !draft.value.secrets?.length) return;
      const slash = sentLevel ? null : parseSlash(body);
      if (slash) {
        let sent = false;
        const originalText = draft.peek().text;
        const clear = await runSlash(slash, {
          chat,
          openModelMenu: () => setModelSignal(Date.now()),
          setLevel: (next) => updateDraft(chat.id, { level: next }),
          send: (rest, options) => { sent = true; return sendAs(rest, options?.level ?? draft.peek().level, early); },
        });
        if (clear && !sent && draft.peek().text === originalText) updateDraft(chat.id, { text: '' });
        return;
      }
      await sendAs(body, sentLevel ?? draft.value.level, early);
    } finally {
      if (early && pendingSends.peek().some((line) => line.clientId === early && line.state === 'transcribing')) removePending(early); // nothing went out
      setSending(false);
      fieldRef.current?.focus();
    }
  };

  /** Schedule mode's Send: posts the draft at the settings' time(s) – also at another level (the right-click menu). */
  const scheduleNow = async (sentLevel?: MessageLevel) => {
    if (sending) return;
    setSending(true);
    try {
      if (!(await settleTake(chat.id))) return;
      if (sentLevel) updateDraft(chat.id, { level: sentLevel });
      await scheduleDraft(chat);
    } finally {
      setSending(false);
      fieldRef.current?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (openMark) { setOpenMark(null); if (event.key === 'Escape') { event.preventDefault(); return; } } // typing closes the mark menu
    if (suggest.onKeyDown(event, visibleItems, accept)) { event.preventDefault(); return; }
    if (event.key === 'Escape' && scheduling) { event.preventDefault(); leaveScheduleMode(chat.id); return; }
    if (event.key === 'Escape' && draft.peek().replyTo) { event.preventDefault(); setReply(chat.id, null); return; }
    if (event.key !== 'Enter' || event.isComposing) return;
    const mod = event.ctrlKey || event.metaKey;
    const enterSends = preferences.value.enterSends && !isMobile.value;
    if ((enterSends && !event.shiftKey && !mod) || (!enterSends && mod)) { event.preventDefault(); void (scheduling ? scheduleNow() : send()); }
  };

  const onPaste = (event: ClipboardEvent) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length) { event.preventDefault(); void addFiles(files); }
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragOver(false);
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length) void addFiles(files);
  };

  const makeTask = async () => {
    const body = draft.value.text.trim();
    if (!body) composerFill.value = { conversationId: chat.id, text: '/task ' }; // an empty field: write the task there
    else if (await createTaskFromText(chat.id, body)) updateDraft(chat.id, { text: '', replyTo: undefined });
  };

  const agentId = targetAgent(text, chat, replyTo);
  const placeholder = composerPlaceholder(chat, scheduling); // a task's thread: "Write about <task>…"

  const controls = composerControls({ hasContent, dictating: isDictating, transcribing: transcribingHere });
  // A scheduled message is text only: files and secrets in the draft would be left behind, so the mode says so (note)
  const heavy = [attachments.length ? 'files' : '', secrets.length ? 'secrets' : ''].filter(Boolean).join(' and ');
  const note = scheduling && heavy ? `A scheduled message is text only – remove the ${heavy} to schedule it.` : undefined;
  const built = mode ? scheduleSpec(mode.form, Date.now()) : null;
  const next = useNextRun(built && 'spec' in built ? built.spec : null);
  const scheduleReady = !!built && 'spec' in built && !next.error && !note && (!!text.trim() || isDictating || transcribingHere);
  const sendActions = {
    sendAs: scheduling ? (scheduleReady ? (sentLevel: MessageLevel) => void scheduleNow(sentLevel) : undefined) : controls.primary === 'send' ? (sentLevel: MessageLevel) => void send(sentLevel) : undefined,
    level, setLevel: (next: MessageLevel) => updateDraft(chat.id, { level: next }),
    schedule: () => openScheduleMode(chat.id),
    scheduling,
  };
  const sendMenu = useContextMenu(() => [{ items: sendMenuItems(sendActions) }]);
  // Schedule mode: the same round cell with a clock (a wider label would move the model and the mic)
  const primary = <button type="button" class="send-button" aria-label={scheduling ? 'Schedule' : 'Send'} title={scheduling ? 'Schedule' : undefined} {...sendMenu}
    disabled={(scheduling ? !scheduleReady : controls.primary === 'send-disabled') || sending || uploading.length > 0 || record.held}
    onClick={() => void (scheduling ? scheduleNow() : send())}><Icon name={scheduling ? 'clock' : 'arrow-up'} size={19} /></button>;

  return (
    <div class={`composer-area${props.slim ? ' slim' : ''}`}>
      <div class={`composer${dragOver ? ' drag-over' : ''}${level === 'important' ? ' important' : ''}${scheduling ? ' scheduling' : ''}`}
        onDragOver={(event) => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); setDragOver(true); } }}
        onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
        <SuggestionList items={visibleItems} active={suggest.active} onPick={accept} onHover={suggest.setActive} />
        {mode && <ScheduleBar form={mode.form} editing={!!mode.edit} next={next} note={note} onChange={(patch) => patchForm(chat.id, patch)} onLeave={() => leaveScheduleMode(chat.id)} />}
        {secretOpen && <ChatSecretBar key={chat.id} conversationId={chat.id} room={20 - secrets.length} onLeave={() => { setSecretOpen(false); fieldRef.current?.focus(); }}
          onAttach={(id) => updateDraft(chat.id, { secrets: [...(draft.peek().secrets ?? []), id] })} />}
        {record.bar}
        {replyTo && <ReplyQuote conversationId={chat.id} messageId={replyTo} onCancel={() => { setReply(chat.id, null); fieldRef.current?.focus(); }} />}
        <SecretAttachments ids={secrets} onRemove={id => updateDraft(chat.id, { secrets: secrets.filter(entry => entry !== id) })} />
        <ComposerAttachments attachments={attachments} uploading={uploading} conversationId={chat.id}
          onRetry={(attachment) => retryTake(chat.id, attachment, targetOf(fieldRef.current))}
          onRemove={(fileId) => updateDraft(chat.id, { attachments: draft.value.attachments.filter((entry) => entry.fileId !== fileId) })} />
        <div class="composer-field">
          {marks?.uncertain?.length ? <MarkLayer field={fieldRef} layer={layerRef} text={text} marks={marks.uncertain} /> : null}
          <textarea
            ref={fieldRef}
            class="composer-input"
            rows={1}
            value={text}
            placeholder={placeholder}
            aria-label={placeholder}
            onInput={(event) => { const field = event.target as HTMLTextAreaElement; setText(field.value); setCaret(field.selectionStart); suggest.dismiss(null); setOpenMark(null); }}
            onKeyDown={onKeyDown}
            onKeyUp={(event) => setCaret((event.target as HTMLTextAreaElement).selectionStart)}
            onClick={(event) => {
              const field = event.target as HTMLTextAreaElement;
              setCaret(field.selectionStart);
              const index = field.selectionStart === field.selectionEnd ? markAt(draft.peek().marks, field.selectionStart) : -1;
              setOpenMark(index < 0 ? null : draft.peek().marks?.uncertain?.[index] ?? null);
            }}
            onPaste={onPaste}
          />
          {openMark && <MarkMenu key={`${openMark.start}:${openMark.end}`} conversationId={chat.id} field={fieldRef} layer={layerRef} mark={openMark} onClose={() => setOpenMark(null)} onCaret={setCaret} />}
        </div>
        <div class="composer-actions">
          <PlusMenu chat={chat} actions={{
            pickFiles: () => void pickFiles(false),
            pickImages: () => void pickFiles(true),
            secret: secrets.length < 20 ? () => setSecretOpen(true) : undefined,
            makeTask: () => void makeTask(),
            ...record.actions,
            ...sendActions,
          }} />
          <div class="composer-spacer"><DictationWave state={waveState(chat.id)} /></div>
          {!props.slim && <ModelChip chat={chat} agentId={agentId} openSignal={modelSignal} />}
          <MicButton draftKey={chat.id} field={fieldRef} onStop={() => void dictateIntoDraft()} />
          {primary}
        </div>
      </div>
      <input ref={fileRef} type="file" multiple hidden onChange={(event) => { const input = event.target as HTMLInputElement; void addFiles([...(input.files ?? [])]); input.value = ''; }} />
      <input ref={imageRef} type="file" accept="image/*,video/*" multiple hidden onChange={(event) => { const input = event.target as HTMLInputElement; void addFiles([...(input.files ?? [])]); input.value = ''; }} />
      {record.input}
    </div>
  );
}
