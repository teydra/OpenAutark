// 25.11.2026 (owner 24.11. #228: the input line must always be there while agents work): a send that is still on its
// way (messages.send answers late while an agent works) never holds the next line. sendDraft empties the draft before
// its first await, so the composer is free at once; a failed send stays independently retryable without touching newer text;
// the live bar gives way in a short column so the composer under it stays on screen.
// Owns: these assertions only. Never: a real runtime (rpc.call is a fake) or rendering.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rpc } from '../../../src/ui/lib/rpc.ts';

const sent: string[] = [];
const gates: Array<{ body: string; release: (ok: boolean) => void }> = [];
(rpc as unknown as { call: unknown }).call = (method: string, params: { body?: string }) => {
  if (method !== 'messages.send') return Promise.resolve({ ok: true });
  sent.push(params.body ?? '');
  return new Promise((resolve, reject) => gates.push({ body: params.body ?? '', release: (ok) => (ok ? resolve({ id: 'msg_1' }) : reject(new Error('offline'))) }));
};
const { draftFor, updateDraft } = await import('../../../src/ui/chat/composer/draft.ts');
const { sendDraft } = await import('../../../src/ui/chat/composer/send.ts');
const { pendingSends } = await import('../../../src/ui/chat/pending-sends.ts');
const { session } = await import('../../../src/ui/lib/session.ts');

const send = (id: string) => sendDraft({ conversationId: id, body: draftFor(id).peek().text, level: 'normal', mentions: () => [] });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the draft is empty right after Send, and a second line goes out while the first is still on its way', async () => {
  session.value = { kind: 'owner', capabilities: [], secrets: true, secure: true, allowedMethods: [] } as never;
  sent.length = 0; gates.length = 0;
  updateDraft('ch_busy', { text: 'first line' });
  const first = send('ch_busy');
  assert.equal(draftFor('ch_busy').peek().text, '', 'emptied before the answer');
  updateDraft('ch_busy', { text: 'second line' });
  const second = send('ch_busy');
  await tick();
  assert.deepEqual(sent, ['first line', 'second line'], 'both are on their way');
  const lines = pendingSends.peek().filter(line => line.conversationId === 'ch_busy');
  assert.deepEqual(lines.map(line => [line.body, line.state]), [['first line', 'sending'], ['second line', 'sending']]);
  assert.notEqual(lines[0].clientId, lines[1].clientId);
  gates[1].release(true); gates[0].release(true);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(draftFor('ch_busy').peek().text, '');
});

test('a failed send is retryable and leaves a newer draft alone; an untouched field gets its old draft back', async () => {
  sent.length = 0; gates.length = 0;
  updateDraft('ch_late', { text: 'lost line' });
  const failing = send('ch_late');
  updateDraft('ch_late', { text: 'typed meanwhile' });
  gates[0].release(false);
  assert.equal(await failing, false);
  assert.equal(draftFor('ch_late').peek().text, 'typed meanwhile');
  const failed = pendingSends.peek().find(line => line.conversationId === 'ch_late');
  assert.deepEqual([failed?.body, failed?.state, failed?.error], ['lost line', 'failed', 'offline']);
  updateDraft('ch_alone', { text: 'only line' });
  const alone = send('ch_alone');
  gates[1].release(false);
  await alone;
  assert.equal(draftFor('ch_alone').peek().text, 'only line');
});

test('the live bar shrinks in a short column (the composer under it stays), and the composer never shrinks', () => {
  const styles = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui/styles');
  const bar = readFileSync(path.join(styles, 'live-bar.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const composer = readFileSync(path.join(styles, 'composer.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(bar, /\.live-bar \{[^}]*flex: 0 1 auto;[^}]*min-height: 36px/);
  assert.match(composer, /\.composer-area \{[^}]*flex: none;/);
});
