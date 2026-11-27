// Konrad 27.11.2026 (the local voice's licence, OpenRAIL-M, asks for a clear notice that its speech is machine-generated):
// "AI voice (machine-generated)" stands for as long as a call shows – on the call card (ui/chat/call/CallCard.tsx, the same
// card in the Android app's page), in every ring notice (the PC's OS notice and the phones' push body: shared/model/call.ts
// ringBody; the window's status line: call-notices.ts) and in the Android app's own notices (CallNotice's header line,
// KeepAlive's "Call running" line – both CallVoiceNote.TEXT, the same words). The card has no DOM test here, so its markup
// and style are read from the sources: the line is rendered unconditionally and has its own row of the fixed-size card.
// Owns: these assertions only. Never: a DOM, a phone or a runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AI_VOICE_NOTICE, ringBody } from '../../../src/shared/model/call.ts';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const ANDROID = '../../../../android/app/src/main/java/com/teydralab/autark/android/';

test('the words, and a ring notice\'s body: the notice first (a long why is cut at its end), then why', () => {
  assert.equal(AI_VOICE_NOTICE, 'AI voice (machine-generated)');
  assert.equal(ringBody('Logo decision'), 'AI voice (machine-generated)\nLogo decision');
  assert.equal(ringBody(''), 'AI voice (machine-generated)');
});

test('call card: its foot line shows the notice whatever the call does, in its own row of the card', () => {
  const card = read('../../../src/ui/chat/call/CallCard.tsx');
  assert.match(card, /<p class="call-ai-voice">\{AI_VOICE_NOTICE\}<\/p>/, 'rendered as its own line, not behind a condition');
  const css = read('../../../src/ui/styles/call.css');
  const rule = /\.call-ai-voice \{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.match(rule, /grid-column: 1 \/ -1/);
  assert.doesNotMatch(rule, /display: none|visibility: hidden|opacity: 0/);
  const cardRule = /\.call-card \{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.match(cardRule, /grid-template-rows: 44px 36px 14px/, 'a third row for the line');
  assert.match(cardRule, /height: 132px/, '12 + 44 + 8 + 36 + 8 + 14 + 10: the line fits the fixed card');
});

test('Android: the incoming call notice and the "Call running" notice carry the same words', () => {
  const note = read(`${ANDROID}CallVoiceNote.java`);
  assert.ok(note.includes(`public static final String TEXT = "${AI_VOICE_NOTICE}";`), 'the same words as the page');
  assert.match(read(`${ANDROID}CallNotice.java`), /\.setSubText\(CallVoiceNote\.TEXT\)/, 'the ring notice: its header line');
  assert.match(read(`${ANDROID}KeepAlive.java`), /if \(call\) builder\.setContentText\(CallVoiceNote\.TEXT\)/, 'the call notice: its line while the call runs');
});
