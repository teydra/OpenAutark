// D13 – the composers' dictation controls, read from their source (no DOM here): owner's feedback FCMWNSOZ (20.11.2026)
// turned the old rule around – while a take records or is transcribed the + turns 45° into the × that cancels it (one
// element, one transition; the chat's composer and the Tasks page's input line) and the mic cell only shows state –, the mic keeps the field's focus and hands its caret
// to startDictation, shows the starting state in its own slot, the waveform sits in the spacer, and
// the worklet that feeds it is bundled next to index.html. B-082: the take goes in with hidden marks, and an unheard
// recording stays retrievable (chip, message button or toast with "Transcribe again").
// Owns: these assertions only. Never: renders components.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');

test('FCMWNSOZ: the + turns into the × that cancels a take, in the composer and the Tasks page\'s input line; the mic cell only shows state', () => {
  for (const file of ['src/ui/chat/Composer.tsx']) {
    const source = read(file);
    assert.match(source, /<MicButton draftKey=\{[^}]+\} field=\{fieldRef\}/, `${file}: the shared mic button`);
    assert.match(source, /<div class="composer-spacer"><DictationWave state=\{waveState\([^)]+\)\} \/><\/div>/, `${file}: the waveform in the spacer`);
    assert.doesNotMatch(source, /discardDictation|discard=\{/, `${file}: no "Discard dictation" menu entry any more`);
  }
  assert.match(read('src/ui/chat/composer/PlusMenu.tsx'), /const cancel = takeCancel\(props\.chat\.id\);[^]*<PlusCancel buttonRef=\{ref\} class="composer-plus"/);
  const plus = read('src/ui/chat/composer/PlusCancel.tsx');
  assert.equal((plus.match(/<button /g) ?? []).length, 1, 'one element in both states: the turn is a transition, nothing is swapped');
  assert.match(plus, /<Icon name="plus" size=/);
  assert.doesNotMatch(plus, /name="x"/, 'the × is the plus turned, not a second icon');
  const css = read('src/ui/styles/composer.css');
  assert.match(css, /\.plus-cancel \.icon \{ transition: transform \.2s/);
  assert.match(css, /\.plus-cancel\.is-cancel \.icon \{ transform: rotate\(45deg\);/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \.plus-cancel \.icon \{ transition: none; \}/);
  for (const file of ['src/ui/chat/composer/MicButton.tsx', 'src/ui/tasks/FieldMic.tsx']) {
    const source = read(file);
    assert.doesNotMatch(source, /cancelTranscribing|name="x"|Cancel transcription/, `${file}: the old spinner with × is gone`);
    assert.match(source, /class="icon-button( small)? dictation-busy"[^>]*disabled/, `${file}: starting and transcribing show a spinner, nothing to click`);
  }
  const line = read('src/ui/tasks/LineExtras.tsx'); // the input line's + (its menu) and, in quest mode, a mark – both the × of a take
  assert.match(line, /<PlusCancel mark cancel=\{props\.mic\.cancel\}/);
  assert.match(line, /<PlusCancel buttonRef=\{ref\} class="task-input-plus"[^>]*\n?\s*cancel=\{props\.mic\.cancel\}/);
  assert.match(read('src/ui/tasks/TaskInput.tsx'), /<LinePlus line=\{line\} mic=\{mic\} field=\{field\}/);
  assert.match(read('src/ui/tasks/use-dictation.ts'), /cancel: takeCancel\(key\),/);
});

test('the mic keeps the field focused and passes its caret; starting and transcribing take the same slot', () => {
  const mic = read('src/ui/chat/composer/MicButton.tsx');
  assert.match(mic, /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/);
  assert.match(mic, /startDictation\(key, targetOf\(props\.field\.current\)\)/);
  assert.match(mic, /dictationStarting\.value === key/);
  assert.match(mic, /disabled=\{waitsForSpeechModel\(note\)\}/,'while the speech model downloads the mic waits (its title says so)');
  assert.doesNotMatch(read('src/ui/chat/Composer.tsx'), /SpeechMarks|SpeechChips/, 'dictation inserts plain text: no unsure-word marks or chips');
});

test('the AudioWorklet tap is its own bundle next to index.html (the CSP allows it as self)', () => {
  const build = read('scripts/build.mjs');
  assert.match(build, /entryPoints: \['src\/ui\/lib\/pcm-worklet\.ts'\], outfile: 'app\/ui\/pcm-worklet\.js'/);
  assert.match(read('src/ui/lib/pcm-worklet.ts'), /export const PCM_TAP_MODULE = 'pcm-worklet\.js';/);
  assert.match(read('src/ui/lib/dictation.ts'), /\{ sampleRate: PCM_RATE, blockMs: BLOCK_MS, plain: true \}/, 'dictation asks for 16 kHz, plain (no call processing)');
});

test('B-082: a take goes in with its marks hidden; unheard recordings stay as chips or toasts with "Transcribe again"', () => {
  const voice = read('src/ui/chat/composer/voice.ts');
  assert.match(voice, /insertMarked\(draft\.text, draft\.marks, at, piece/, 'the text plain, its marks beside it');
  assert.doesNotMatch(voice, /wrapDictation/, 'no inline ⟦Diktat⟧ tags in the draft');
  assert.match(voice, /export async function retryTake\(/);
  assert.match(read('src/ui/chat/Attachments.tsx'), /label="Transcribe again"/);
  assert.match(read('src/ui/chat/Attachments.tsx'), /rpc\.call\('voice\.retranscribe', \{ messageId: props\.messageId \}\)/);
  assert.match(read('src/ui/chat/MessageItem.tsx'), /<AttachmentList [^>]*message=\{human \? message : undefined\}/);
  assert.match(read('src/ui/tasks/use-dictation.ts'), /offerRetry\(kept, append, outcome\.error, key\)/);
  assert.doesNotMatch(read('src/ui/lib/dictation.ts'), /MAX_BYTES/, 'no silent cut at 10 min');
});

test('B-082 review: a held piece uploaded while its take still runs lands once, as the uploaded file; a field keeps its words', () => {
  const voice = read('src/ui/chat/composer/voice.ts');
  assert.match(voice, /if \(!chip\) uploadedHeld\.set\(held\.key, attachment\);/, 'remembered for the take that is still finishing');
  assert.match(voice, /if \(!chip && \(dictating\.peek\(\) === held\.owner \|\| transcribing\.peek\(\)\.has\(held\.owner\)\)\) return;/, 'no second chip while the take runs');
  assert.match(voice, /\(result\.kept \?\? \[\]\)\.map\(uploadedChip\)\.filter\(/, 'dictateIntoDraft swaps in the upload and skips a chip already there');
  assert.match(voice, /heldFields\.set\(heldKey\(attachment\.fileId\) as string, \{ onText, \.\.\.\(key \? \{ key \} : \{\}\) \}\)/, "My day's held piece still gives its words to the field");
  const chips = read('src/ui/chat/Attachments.tsx');
  assert.equal((chips.match(/<span class="icon-button small"><Spinner size=\{14\} label="Transcribing" \/><\/span>/g) ?? []).length, 2, 'the spinner takes the button\'s size: nothing moves on click');
  assert.match(chips, /useEffect\(\(\) => \(\) => \{ if \(playing\.peek\(\) === attachment\.fileId\) togglePlay/, 'a chip that goes stops its recording');
});

test('feedback 08604667: a take being transcribed can be cancelled (since FCMWNSOZ by the + turned ×); its late text is dropped', () => {
  const voice = read('src/ui/chat/composer/voice.ts');
  assert.match(voice, /if \(transcribing\.value\.has\(key\)\) return \{ label: 'Cancel transcription', run: \(\) => cancelTranscribing\(key\) \};/);
  assert.match(voice, /export function cancelTranscribing\(conversationId: string\): void \{/);
  assert.match(voice, /if \(cancelled\(\)\) return \{ failed: true \};/, 'the text that comes after a cancel goes nowhere; Send leaves the draft');
});
