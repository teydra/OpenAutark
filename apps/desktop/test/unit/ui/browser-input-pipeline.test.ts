// B-081: input without waiting for each answer (src/ui/workspace/browser-input.ts createInputSender with a window; a remote
// tab's BrowserSurface passes 8): keys and presses go out in order up to the window before any answer; a move waits only
// while another move is unanswered (the newest replaces it) and a press or key behind it sends it first; the first
// failure drops what waits and is said once, also when inputs already on their way fail with it; window 1 is the old
// one-at-a-time sender. The remote view's wiring is read from its source: inFlight 8, its box in every pull, kept frames.
// Owns: these assertions only. Never: a DOM, runtime or socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInputSender } from '../../../src/ui/workspace/browser-input.ts';
import type { BrowserInput } from '../../../src/shared/model/browser.ts';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const at = { x: 1, y: 1, width: 10, height: 10 };
const move = (x: number): BrowserInput => ({ kind: 'mouse', type: 'move', ...at, x });
const down = (x: number): BrowserInput => ({ kind: 'mouse', type: 'down', ...at, x, button: 'left', clicks: 1 });
const key = (name: string): BrowserInput => ({ kind: 'key', type: 'down', key: name, code: '' });

/** A send whose answers the test gives, one by one in arrival order (or all failing). */
function link(window?: number) {
  const sent: BrowserInput[] = [];
  const answers: Array<(error?: unknown) => void> = [];
  const errors: unknown[] = [];
  const sender = createInputSender((_tab, input) => {
    sent.push(input);
    return new Promise<void>((resolve, reject) => { answers.push((error) => (error ? reject(error) : resolve())); });
  }, (error) => errors.push(error), window === undefined ? undefined : { window });
  const answer = async (error?: unknown) => { answers.shift()!(error); await settle(); };
  const label = (input: BrowserInput) => (input.kind === 'key' ? input.key : input.kind === 'mouse' ? `${input.type}${input.x}` : input.kind);
  return { sender, sent, errors, answer, labels: () => sent.map(label) };
}

test('window 8: ten keys start eight sends before any answer, in order; each answer lets the next go', async () => {
  const l = link(8);
  for (let i = 0; i < 10; i++) l.sender.push('t1', key(`k${i}`));
  assert.deepEqual(l.labels(), ['k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7']);
  assert.equal(l.sender.pending(), 2);
  await l.answer();
  assert.deepEqual(l.labels().slice(8), ['k8'], 'one answer, one more on its way');
  await l.answer();
  assert.deepEqual(l.labels().slice(8), ['k8', 'k9']);
  assert.equal(l.sender.pending(), 0);
});

test('a move waits while another move is unanswered and the newest wins; a press behind it sends it first, in order', async () => {
  const l = link(8);
  l.sender.push('t1', move(1));
  l.sender.push('t1', move(2));
  l.sender.push('t1', move(3));
  assert.deepEqual(l.labels(), ['move1'], 'the first move goes, the next waits');
  assert.equal(l.sender.pending(), 1, 'merged into the newest');
  await l.answer();
  assert.deepEqual(l.labels(), ['move1', 'move3']);
  l.sender.push('t1', move(4));
  l.sender.push('t1', down(4));
  assert.deepEqual(l.labels(), ['move1', 'move3', 'move4', 'down4'], 'the press sends the waiting move first, without waiting for an answer');
  l.sender.push('t1', key('a'));
  assert.equal(l.labels().at(-1), 'a', 'keys never wait for moves');
});

test('the first failure drops what waits and is said once, also for inputs already on their way', async () => {
  const l = link(2);
  for (const name of ['a', 'b', 'c', 'd']) l.sender.push('t1', key(name));
  assert.deepEqual(l.labels(), ['a', 'b']);
  await l.answer(new Error('The page shows a dialog – answer it first.'));
  assert.equal(l.sender.pending(), 0, 'keys meant for a page that did not take them are dropped');
  await l.answer(new Error('The page shows a dialog – answer it first.'));
  assert.equal(l.errors.length, 1, 'said once');
  assert.deepEqual(l.labels(), ['a', 'b'], 'c and d never went');
  l.sender.push('t1', key('e'));
  await l.answer(new Error('The page did not take that input. Try again.'));
  assert.equal(l.errors.length, 2, 'a new failure after that is said again');
  l.sender.push('t1', move(5));
  await l.answer(new Error('gone'));
  assert.equal(l.errors.length, 2, 'a failed move is not said');
});

test('window 1 (the default) is the one-at-a-time sender: nothing goes before the answer', async () => {
  const l = link();
  l.sender.push('t1', key('a'));
  l.sender.push('t1', key('b'));
  l.sender.push('t1', move(1));
  l.sender.push('t1', move(2));
  assert.deepEqual(l.labels(), ['a']);
  assert.equal(l.sender.pending(), 2);
  await l.answer();
  await l.answer();
  assert.deepEqual(l.labels(), ['a', 'b', 'move2']);
  const sync = createInputSender(() => { throw new Error('offline'); }, (error) => l.errors.push(error), { window: 8 });
  sync.push('t1', key('x'));
  await settle();
  assert.equal((l.errors.at(-1) as Error).message, 'offline', 'a send that throws counts as a failure');
});

test('the remote view: 8 inputs on their way, its picture box in every pull, the last pictures kept', () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui/workspace');
  const tab = readFileSync(path.join(dir, 'RemoteWebTab.tsx'), 'utf8');
  const surface = readFileSync(path.join(dir, 'BrowserSurface.tsx'), 'utf8');
  assert.match(tab, /export const REMOTE_IN_FLIGHT = 8;/);
  assert.match(tab, /<BrowserSurface [^>]*inFlight=\{REMOTE_IN_FLIGHT\}/);
  assert.match(surface, /createInputSender\([^]*?\{ window: props\.inFlight, lost: /, 'the agents\' browsers keep window 1 (no inFlight)');
  assert.match(tab, /rpc\.call\('side\.pull', \{[^}]*\.\.\.\(view \? \{ view \} : \{\}\)/, 'the pull names the box');
  assert.match(tab, /new ResizeObserver\([^]*?feed\.refresh\(key\)/, 'a changed box pulls at once');
  assert.match(tab, /<div ref=\{box\} class="workspace-screen-view remote-web-view">/, 'the box is the picture\'s room');
  assert.match(tab, /keep: KEPT_FRAMES/);
  assert.match(tab, /export const KEPT_FRAMES = 6;/);
});
