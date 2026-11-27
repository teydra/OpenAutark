// Call speed 27.11.2026 (Konrad: the first piece of an answer is spoken from the first comma, later pieces as before):
// sentencesDone (shared/voice/conversation-parts.ts) – the rule the call voice (runtime/calls/talker.ts) and every reader
// (shared/voice/conversation.ts, the Android bubble's SpokenPieces) use on a row still being written – gives the part up to
// the first comma while no sentence is finished, never a piece shorter than FIRST_CLAUSE_MIN, never a decimal comma at the
// end of what arrived so far, and once a sentence is finished cuts at sentence ends only. What it gives only grows.
// Owns: these assertions only. Never: a model, a voice or a runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIRST_CLAUSE_MIN, sentencesDone } from '../../../src/shared/voice/conversation-parts.ts';
import { sayableSoFar } from '../../../src/runtime/calls/voice-text.ts';

test('first piece: before any finished sentence, the part up to the first comma', () => {
  assert.equal(sentencesDone('Gute Frage, die Fahrt'), 'Gute Frage,');
  assert.equal(sentencesDone('Gute Frage, '), 'Gute Frage,', 'the comma as the stream left it');
  assert.equal(sentencesDone('Gute Frage,'), 'Gute Frage,', 'the reader gets the row trimmed (talker.ts wrote just that)');
  assert.equal(sentencesDone('Mit dem Zug, je nach Verbindung, etwa'), 'Mit dem Zug,', 'the first comma, not the last');
});

test('first piece: too short a clause waits for the next comma; a decimal comma is no cut', () => {
  assert.ok(FIRST_CLAUSE_MIN > 'Ja,'.length);
  assert.equal(sentencesDone('Ja, das'), '');
  assert.equal(sentencesDone('Ja, klar, die Fahrt'), 'Ja, klar,');
  assert.equal(sentencesDone('Das kostet 3,'), '', 'it may still become 3,5');
  assert.equal(sentencesDone('Das kostet 3,5 Euro'), '', 'no space after the comma: inside a number');
  assert.equal(sentencesDone('Das kostet 3,5 Euro, also'), 'Das kostet 3,5 Euro,');
});

test('later pieces as before: once a sentence is finished, only sentence ends cut', () => {
  assert.equal(sentencesDone('Der Build läuft noch durch. Danach, wenn'), 'Der Build läuft noch durch.');
  assert.equal(sentencesDone('Gute Frage, die Fahrt dauert drei Stunden. Und dann, wenn'), 'Gute Frage, die Fahrt dauert drei Stunden.');
  assert.equal(sentencesDone('Der Build läuft'), '', 'no comma, no sentence end: nothing yet');
});

test('streamed token by token through the call voice, the part only grows and the first piece comes at the first comma', () => {
  const answer = 'Gute Frage, mit dem Zug dauert es ungefähr zwei Stunden und zwanzig Minuten. Der Railjet fährt, soweit ich weiß, jede Stunde.';
  let before = '';
  const pieces: string[] = [];
  for (let at = 1; at <= answer.length; at++) {
    const done = sentencesDone(sayableSoFar(answer.slice(0, at)));
    assert.ok(done.startsWith(before), `"${done}" goes on from "${before}"`);
    if (done.length > before.length) pieces.push(done.slice(before.length).trim());
    before = done;
  }
  assert.deepEqual(pieces, [
    'Gute Frage,',
    'mit dem Zug dauert es ungefähr zwei Stunden und zwanzig Minuten.',
    'Der Railjet fährt, soweit ich weiß, jede Stunde.',
  ]);
});
