// Feedback FCMWNZ0H / FCMWNSOZ (20.11.2026, phone and PC, three times): Send while a take records – with an empty field
// too – stops it, waits for its words and sends them; Send while a stopped take is still transcribed waits for it; a take
// cancelled by the + turned × (voice.ts takeCancel) sends nothing. The composer's Send cell is live during both, and the
// model chip loses its stuck hover box on touch.
// Owns: these assertions only. Never: a real microphone, runtime or rendering (lib/dictation.ts's take is faked).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { SessionInfo } from '../../../src/shared/api/methods.ts';
import { composerControls } from '../../../src/ui/chat/composer/controls.ts';
import { dictation } from '../../../src/ui/lib/dictation.ts';
import { session } from '../../../src/ui/lib/session.ts';
import { rpc } from '../../../src/ui/lib/rpc.ts';

Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { getUserMedia: () => undefined } }, configurable: true });
(globalThis as { AudioContext?: unknown }).AudioContext ??= class {};
session.value = { kind: 'owner', allowedMethods: [], capabilities: [] } as unknown as SessionInfo;

(rpc as unknown as { call: unknown }).call = async () => ({ ok: true }); // the draft's save: no connection (and no reconnect timer) here

/** The take: start opens nothing, finish answers when the test lets it (`hear`), cancel is counted. */
let answer: (text: string) => void = () => undefined;
let cancels = 0;
const fake = dictation as unknown as Record<string, unknown>;
fake.start = async () => undefined;
fake.finish = () => new Promise<{ text: string }>((resolve) => { answer = (text) => resolve({ text }); });
fake.cancel = () => { cancels += 1; };
let heardAgain: (text: string) => void = () => undefined;
fake.hear = () => new Promise<{ text: string }>((resolve) => { heardAgain = (text) => resolve({ text }); });
const hear = async (text: string) => { await new Promise((resolve) => setTimeout(resolve, 0)); answer(text); };

const { draftFor, updateDraft } = await import('../../../src/ui/chat/composer/draft.ts');
const voice = await import('../../../src/ui/chat/composer/voice.ts');
const { toasts } = await import('../../../src/ui/lib/toasts.ts');
const { takeFieldWords } = await import('../../../src/ui/chat/composer/field-words.ts');

test('Send is live while a take records or is transcribed, an empty field too; idle and empty it is not', () => {
  assert.deepEqual(composerControls({ hasContent: false, dictating: false, transcribing: false }), { primary: 'send-disabled' });
  assert.deepEqual(composerControls({ hasContent: false, dictating: true, transcribing: false }), { primary: 'send' });
  assert.deepEqual(composerControls({ hasContent: false, dictating: false, transcribing: true }), { primary: 'send' });
  assert.deepEqual(composerControls({ hasContent: true, dictating: false, transcribing: false }), { primary: 'send' });
});

test('Send while recording with an empty field: the take stops, its words are in the draft, then it may go out', async () => {
  const chat = 'ch_rec_empty';
  await voice.startDictation(chat);
  assert.equal(voice.dictating.peek(), chat);
  assert.equal(voice.takeCancel(chat)?.label, 'Cancel dictation', 'the + is an × while it records');
  const settled = voice.settleTake(chat); // Composer.tsx send(): settleTake first, then the draft goes out
  assert.equal(voice.dictating.peek(), null, 'the microphone stopped at the tap');
  assert.equal(voice.takeCancel(chat)?.label, 'Cancel transcription', 'the + is an × while it is transcribed');
  void hear('Wie geht es dir?');
  assert.equal(await settled, true);
  assert.equal(draftFor(chat).peek().text, 'Wie geht es dir?');
  assert.equal(voice.takeCancel(chat), undefined, 'back to the plus');
});

test('Send while recording with text in the field: the words join the typed text', async () => {
  const chat = 'ch_rec_text';
  updateDraft(chat, { text: 'Kurz:' });
  await voice.startDictation(chat);
  const settled = voice.settleTake(chat);
  void hear('alles gut');
  assert.equal(await settled, true);
  assert.match(draftFor(chat).peek().text, /^Kurz:\s*alles gut$/);
});

test('Send after the mic stopped the take: it waits for the words still being transcribed and sends them', async () => {
  const chat = 'ch_transcribing';
  await voice.startDictation(chat);
  const byMic = voice.dictateIntoDraft(); // the mic's Stop
  assert.ok(voice.transcribing.peek().has(chat));
  const settled = voice.settleTake(chat); // then Send, before the words are back
  void hear('Hallo');
  assert.equal(await settled, true);
  assert.equal(await byMic, true);
  assert.equal(draftFor(chat).peek().text, 'Hallo', 'the words once, not twice');
});

test('the × while transcribing: Send sends nothing and the late words go nowhere', async () => {
  const chat = 'ch_cancel';
  await voice.startDictation(chat);
  const settled = voice.settleTake(chat);
  voice.takeCancel(chat)?.run();
  assert.equal(voice.transcribing.peek().has(chat), false, 'the spinner goes at once');
  void hear('verworfen');
  assert.equal(await settled, false, 'nothing goes out');
  assert.equal(draftFor(chat).peek().text, '');
});

test('the × while recording throws the take away; nothing is waited for', async () => {
  const chat = 'ch_discard';
  const before = cancels;
  await voice.startDictation(chat);
  voice.takeCancel(chat)?.run();
  assert.equal(cancels, before + 1);
  assert.equal(voice.dictating.peek(), null);
  assert.equal(await voice.settleTake(chat), true, 'nothing running: Send goes on with the draft as it is');
  assert.equal(draftFor(chat).peek().text, '');
});

test(`review: My day's Add while the toast's "Transcribe again" is heard waits for those words; the field does not get them too`, async () => {
  const field = 'day:input';
  const got: string[] = [];
  const kept = { fileId: 'c'.repeat(64), name: 'take.webm', mime: 'audio/webm', size: 1 };
  voice.offerRetry(kept, (text) => got.push(text), 'offline', field);
  const toast = toasts.peek().at(-1);
  assert.equal(toast?.action?.label, 'Transcribe again');
  toast!.action!.run();
  assert.ok(voice.transcribing.peek().has(field), 'the field shows it (its + is the ×)');
  assert.equal(voice.takeCancel(field)?.label, 'Cancel transcription');
  const added = takeFieldWords(field); // DayInput submit → settle
  heardAgain('Milch kaufen');
  assert.equal(await added, 'Milch kaufen', 'the Add gets the words');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(got.length, 0, 'and the field does not get them a second time'); // deepEqual(got, []) would narrow got to never[]
  assert.equal(voice.transcribing.peek().has(field), false);

  voice.offerRetry(kept, (text) => got.push(text), undefined, field); // no Add: the words go to the field as before
  toasts.peek().at(-1)!.action!.run();
  heardAgain('Brot');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(got, ['Brot']);
});

test('the composer sends through settleTake; the model chip shows no stuck hover box on touch', () => {
  const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
  const composer = read('src/ui/chat/Composer.tsx');
  assert.match(composer, /if \(!\(await settleTake\(chat\.id\)\)\) return;/);
  assert.match(composer, /composerControls\(\{ hasContent, dictating: isDictating, transcribing: transcribingHere \}\)/);
  assert.doesNotMatch(composer, /if \(preparingSend\.current \|\| record\.held \|\| transcribing/, 'no early return while a take is transcribed');
  assert.match(read('src/ui/styles/composer.css'), /@media \(hover: none\) \{\s*\.composer-actions \.chip:hover:not\(\[aria-expanded=true\]\)/);
});
