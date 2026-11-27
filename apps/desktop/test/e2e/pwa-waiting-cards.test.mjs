// Waiting cards and checklist actions at phone width in a paired PWA and isolated runtime profile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startRuntime, MESSAGE_EVENTS } from './lib/runtime-client.mjs';
import { detectChannel } from '../../src/runtime/browser/channel.ts';

function installedChannel() {
  try { return detectChannel(); } catch { return undefined; }
}
const channel = process.env.WORKFORCE_PWA_CHANNEL || installedChannel();

test('Waiting on you and checklist controls fit and work at 390 px', { timeout: 120_000, skip: !channel }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const rpc = runtime.client;
  await rpc.call('pwa.enable', { enabled: true, bind: 'lan' });
  const link = await rpc.call('pwa.link', { name: 'Waiting card fixture' });
  const browser = await chromium.launch({ channel, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await rpc.call('chats.create', { title: 'Waiting card fixture', agentIds: [manager.id] });
  await rpc.call('events.subscribe', { topics: ['chats', 'org', `chat:${chat.id}`] });
  const questions = ['Is the installer signed?', 'Is the phone connected?', 'Are the release notes ready?', 'Can we publish?'];
  const calls = questions.map((why, i) => `[[tool:tasks.add ${JSON.stringify({ title: `Wait ${i + 1}`, waiting: `person: ${why}` })}]]`).join('\n');
  const sent = await rpc.call('messages.send', { conversationId: chat.id, body: calls });
  await rpc.waitFor(MESSAGE_EVENTS, (msg) => msg.conversationId === chat.id && msg.authorId === manager.id
    && msg.seq > sent.seq && msg.state === 'final', 30_000);
  const pending = await rpc.call('tasks.list', { status: ['waiting'] });
  assert.equal(pending.filter((task) => task.waitingOn?.on === 'who').length, questions.length);

  await page.goto(`http://localhost:${new URL(link.url).port}/${new URL(link.url).hash}`);
  await page.locator('.mobile-shell').waitFor();
  await page.evaluate(() => { location.hash = '#/tasks'; });
  const view = page.locator('.mobile-shell .tasks-page');
  const waiting = view.getByRole('region', { name: 'Waiting on you' });
  await waiting.waitFor();
  assert.equal(await waiting.locator('.wcard').count(), 3);
  await waiting.getByRole('button', { name: 'See all 4' }).click();
  assert.equal(await waiting.locator('.wcard').count(), 4);
  assert.equal(await page.evaluate(() => innerWidth), 390);
  assert.equal(await waiting.evaluate((el) => el.scrollWidth - el.clientWidth), 0);
  assert.ok(await waiting.getByRole('button').evaluateAll((buttons) => buttons.every((button) => {
    const { width, height } = button.getBoundingClientRect();
    return width >= 44 && height >= 44;
  })));
  const signed = waiting.locator('.wcard', { hasText: questions[0] });
  await signed.getByRole('button', { name: 'Later' }).click();
  await signed.getByText(/Follow up on/).waitFor();
  await signed.getByRole('button', { name: 'Yes, ready' }).click();
  await signed.waitFor({ state: 'detached' });

  const holder = await rpc.call('tasks.create', { title: 'Package the release', plan: ['Upload the installers'] });
  await view.locator('.todo-row', { hasText: holder.title }).locator('.todo-open').click();
  const detail = view;
  const hand = detail.getByRole('combobox', { name: 'Hand over: Upload the installers' });
  await hand.waitFor();
  assert.ok((await hand.boundingBox()).height >= 44);
  await hand.selectOption(manager.id);
  await detail.getByRole('button', { name: /Handed to .*open their task/ }).waitFor();
  const state = await rpc.call('tasks.get', { id: holder.id });
  assert.equal(state.ledger.checklist[0].owner, manager.id);
  assert.ok(state.ledger.checklist[0].taskId);
});


