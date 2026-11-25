// STIMME 21.11.2026: the phone hears a dictation piece itself (ui/lib/dictation-direct.ts over the Android app's port) and
// only a piece that gave nothing goes the PC's way (ui/lib/dictation.ts): the request's shape ({t:'hear', id, data,
// mime, language}), the answer by id, refusals and silence give undefined, nothing without the app's 'hear'; a take
// heard directly is never uploaded, a failed direct piece is uploaded and heard by voice.transcribe as before, and the
// direct answer counts as the plan's (the next pieces go compact). Also nativeCan reads the app's status.
// Owns: these assertions. Never: a real WebView, app or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64Of, directHearing, type DirectPort } from '../../../src/ui/lib/dictation-direct.ts';
import { Dictation, type Cutter, type DictationDeps } from '../../../src/ui/lib/dictation.ts';
import type { SampleListener } from '../../../src/ui/lib/microphone.ts';
import { adoptPort, nativeCan, resetNativePort } from '../../../src/ui/pwa/native-port.ts';
import { join, pcm16, rumble, speech, tap } from '../../helpers/voice-signals.ts';

/** A fake app port: records what the page sends, answers 'hear' as `answer` says. */
function fakePort(answer: (msg: Record<string, unknown>) => Record<string, unknown> | null, can = true) {
  const sent: Array<Record<string, unknown>> = [];
  const listeners = new Map<string, Set<(msg: Record<string, unknown>) => void>>();
  const port: DirectPort = {
    can: (feature) => can && feature === 'hear',
    send: (msg) => {
      sent.push(msg);
      const reply = answer(msg);
      if (reply) queueMicrotask(() => { for (const fn of listeners.get('heard') ?? []) fn({ t: 'heard', id: msg.id, ...reply }); });
      return true;
    },
    on: (type, fn) => {
      const set = listeners.get(type) ?? new Set();
      listeners.set(type, set);
      set.add(fn);
      return () => { set.delete(fn); };
    },
  };
  return { port, sent, listeners };
}

const wav = (bytes = 64) => new Blob([new Uint8Array(bytes).fill(3)], { type: 'audio/wav' });

test('a piece goes to the app as base64 with its type and language; the app\'s text for that id comes back trimmed', async () => {
  const app = fakePort(() => ({ text: '  Hallo Welt. ' }));
  const hearing = directHearing(app.port, 1000);
  assert.equal(hearing.ready(), true);
  assert.equal(await hearing.hear(wav(), 'de'), 'Hallo Welt.');
  assert.equal(app.sent.length, 1);
  assert.equal(app.sent[0].t, 'hear');
  assert.equal(app.sent[0].mime, 'audio/wav');
  assert.equal(app.sent[0].language, 'de');
  assert.equal(app.sent[0].data, await base64Of(wav()));
  assert.equal([...app.listeners.get('heard')!].length, 0, 'the listener goes with the answer');
  assert.equal(await directHearing(fakePort(() => ({ text: '' })).port, 1000).hear(wav(), undefined), '', 'no words is a text');
});

test('an error, another id, a slow app, no app or another format give undefined (the PC\'s way follows)', async () => {
  assert.equal(await directHearing(fakePort(() => ({ error: 'missed' })).port, 1000).hear(wav(), 'de'), undefined);
  const other = fakePort(() => null);
  const pending = directHearing(other.port, 30).hear(wav(), 'de');
  for (const fn of other.listeners.get('heard') ?? []) fn({ t: 'heard', id: 'not-mine', text: 'x' });
  assert.equal(await pending, undefined, 'only its own id, then the wait ends');
  const none = fakePort(() => ({ text: 'x' }), false);
  assert.equal(directHearing(none.port, 1000).ready(), false);
  assert.equal(await directHearing(none.port, 1000).hear(wav(), 'de'), undefined);
  assert.equal(none.sent.length, 0);
  const webm = fakePort(() => ({ text: 'x' }));
  assert.equal(await directHearing(webm.port, 1000).hear(new Blob([new Uint8Array(8)], { type: 'audio/webm' }), 'de'), undefined);
  assert.equal(webm.sent.length, 0);
});

test('nativeCan reads the app\'s last status while its port is here', () => {
  resetNativePort();
  assert.equal(nativeCan('hear'), false);
  let onmessage: ((event: MessageEvent) => void) | null = null;
  const port = { postMessage: () => undefined, close: () => undefined, set onmessage(fn: ((event: MessageEvent) => void) | null) { onmessage = fn; }, get onmessage() { return onmessage; } };
  adoptPort(port as unknown as MessagePort);
  onmessage!({ data: JSON.stringify({ t: 'status', connected: true, wake: true }) } as MessageEvent);
  assert.equal(nativeCan('hear'), false, 'an older app');
  onmessage!({ data: JSON.stringify({ t: 'status', connected: true, wake: true, hear: true }) } as MessageEvent);
  assert.equal(nativeCan('hear'), true);
  resetNativePort();
  assert.equal(nativeCan('hear'), false);
});

/** A Dictation with a fake microphone, upload and voice.transcribe, and `direct` as given. */
function rig(direct: DictationDeps['direct'], planHeard = { value: false }, cutter?: () => Cutter) {
  const uploads: string[] = [];
  const transcribed: string[] = [];
  const listeners: SampleListener[] = [];
  const deps: DictationDeps = {
    problem: () => undefined,
    openMicrophone: async (onSamples) => { listeners.push(onSamples); return { stream: {} as MediaStream, close: () => undefined }; },
    upload: async (blob, name) => { uploads.push(blob.type); return { id: 'f'.repeat(64), name, mime: blob.type, size: blob.size } as never; },
    transcribe: async (params) => { transcribed.push(params.language ?? '-'); return { text: 'vom PC', by: 'plan' }; },
    now: () => 1000,
    compact: async () => new Blob([new Uint8Array([0x4f, 0x67, 0x67, 0x53])], { type: 'audio/ogg' }),
    planHeard: { get: () => planHeard.value, set: (heard) => { planHeard.value = heard; } },
    direct,
    ...(cutter ? { cutter } : {}),
  };
  return { dictation: new Dictation(deps), uploads, transcribed, planHeard, speak: (seconds: number) => listeners.at(-1)!(new Float32Array(16_000 * seconds).fill(0.25), 16_000) };
}

test('heard by the phone: nothing is uploaded, the text is the take\'s, and it counts as the plan\'s', async () => {
  const languages: Array<string | undefined> = [];
  const t = rig({ ready: () => true, hear: async (_blob, language) => { languages.push(language); return 'vom Handy'; } });
  await t.dictation.start(undefined, { language: 'de-DE' });
  t.speak(2);
  assert.deepEqual(await t.dictation.finish('de-DE'), { text: 'vom Handy' });
  assert.deepEqual(t.uploads, [], 'the take never went over the PC');
  assert.deepEqual(t.transcribed, []);
  assert.deepEqual(languages, ['de-DE'], 'the hint as the PC gets it; the app asks the PC which one it would send');
  assert.equal(t.planHeard.value, true, 'the next pieces go as Ogg Opus');
});

test('the phone could not hear it: the piece is uploaded and heard by voice.transcribe as before', async () => {
  const t = rig({ ready: () => true, hear: async () => undefined });
  await t.dictation.start();
  t.speak(2);
  assert.deepEqual(await t.dictation.finish('de'), { text: 'vom PC' });
  assert.deepEqual(t.uploads, ['audio/wav']);
  assert.deepEqual(t.transcribed, ['de']);
  const thrown = rig({ ready: () => true, hear: async () => { throw new Error('port gone'); } });
  await thrown.dictation.start();
  thrown.speak(2);
  assert.deepEqual(await thrown.dictation.finish('de'), { text: 'vom PC' });
});

test('without the app (desktop, iPhone) a piece uploads at once and the PC hears it; keep() still stores every piece', async () => {
  const t = rig({ ready: () => false, hear: async () => 'never' });
  await t.dictation.start();
  t.speak(2);
  assert.deepEqual(await t.dictation.finish('de'), { text: 'vom PC' });
  assert.deepEqual(t.uploads, ['audio/wav']);
  const kept = rig({ ready: () => true, hear: async () => 'unused' });
  await kept.dictation.start();
  kept.speak(2);
  const pieces = await kept.dictation.keep();
  assert.equal(pieces.length, 1);
  assert.ok(pieces[0].ref, 'a kept take is stored on the PC (an attachment)');
});

/** 24.11.2026: a cutter that hands on one spoken piece while recording and, at Stop, the pause before it (room noise and the tap on Stop). */
function spokenThenPause(): () => Cutter {
  return () => {
    let spoken = false;
    return {
      push: () => { if (spoken) return null; spoken = true; return { pcm: [pcm16(speech(3000, 0.1))], ms: 3000 }; },
      flush: () => ({ pcm: [pcm16(join(rumble(1500, 0.0056), tap()))], ms: 1600 }),
    };
  };
}

test('24.11.2026: the pause before Stop holds no voice – it goes to neither the phone nor the PC, so no name is written for it', async () => {
  const heard = ['Das hast du bei der neuen Handy-App nicht umgesetzt.', 'Colearning Salzburg.'];
  const pieces: number[] = [];
  const t = rig({ ready: () => true, hear: async (blob) => { pieces.push(blob.size); return heard[pieces.length - 1]; } }, { value: false }, spokenThenPause());
  await t.dictation.start(undefined, { language: 'de-DE' });
  t.speak(1);
  assert.deepEqual(await t.dictation.finish('de-DE'), { text: 'Das hast du bei der neuen Handy-App nicht umgesetzt.' });
  assert.equal(pieces.length, 1, 'only the spoken piece was heard');
  assert.deepEqual(t.uploads, [], 'and nothing went over the PC');
  assert.deepEqual(t.dictation.heardPieces.value.map((piece) => piece.text), ['Das hast du bei der neuen Handy-App nicht umgesetzt.', ''], 'the pause counts as heard with no words');

  const pc = rig(undefined, { value: false }, spokenThenPause()); // desktop or an older app: the PC's way
  await pc.dictation.start();
  pc.speak(1);
  assert.deepEqual(await pc.dictation.finish('de'), { text: 'vom PC' });
  assert.deepEqual(pc.uploads, ['audio/wav'], 'the pause is neither uploaded …');
  assert.deepEqual(pc.transcribed, ['de'], '… nor transcribed');

  const kept = rig(undefined, { value: false }, spokenThenPause()); // an audio attachment keeps all of it
  await kept.dictation.start(undefined, { hear: false });
  kept.speak(1);
  assert.equal((await kept.dictation.keep()).length, 2);
  assert.deepEqual(kept.uploads, ['audio/wav', 'audio/wav']);
});
