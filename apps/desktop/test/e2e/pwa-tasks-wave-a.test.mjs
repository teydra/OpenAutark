// The Tasks page at 360 px in a paired PWA (Mika's S9 finding, 27.11.2026): an agent's work in "At work" and its detail
// say when it was created and since when it is stuck, its checklist "☑ x/y", a wait of an earlier day with its date –
// and a long title, wait and notes (an ID, a path) wrap inside the screen instead of running off its right edge.
// The page's clock runs two days ahead of the runtime's, so the work made now is two days old there.
// Uses an installed Chrome or Edge through playwright-core (never downloads one); skipped without.
// WORKFORCE_SHOTS=<folder> keeps the screenshots of the list and the detail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startRuntime, MESSAGE_EVENTS } from './lib/runtime-client.mjs';
import { detectChannel } from '../../src/runtime/browser/channel.ts';

function installedChannel() {
  try { return detectChannel(); } catch { return undefined; }
}
const channel = process.env.WORKFORCE_PWA_CHANNEL || installedChannel();
const shots = process.env.WORKFORCE_SHOTS;
const DAY = 24 * 3600_000;
const TITLE = 'OVH: 120 € sofort zurückerstatten lassen (Stanislaus 27.11. 13:22: „Ich will natürlich nicht hundertzwanzig Euro zahlen“) CS17246974-Widerrufsticket-ohne-Leerzeichen-dazwischen';
const WHY = 'OVH: Antwort auf Widerruf-Ticket CS17246974 (hello@ / OVH-Manager) unter C:\\Users\\Heess\\AppData\\Roaming\\Autark-Companies\\company-2\\workspace\\ovh-erstattung';
const QUEST = 'Kunden-Bots schneller machen: andere EU-Hosts probieren, Entscheidungsmodell/Absicherung einbauen (Stanislaus 26.11. 17:30)';
const NOTES ='Stanislaus will die OVH-Vorauszahlung nicht: Bestellung 2026-11-27-OVH-EU-WEST-PAR-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 zurück.\n\nhttps://www.ovh.com/manager/#/dedicated/billing/history/orders/details?orderId=123456789012345678901234567890';

/** Every element of `root` stays inside the viewport's width. */
async function overflowOf(page, selector) {
  return page.locator(selector).evaluate((root) => {
    const out = [];
    for (const el of [root, ...root.querySelectorAll('*')]) {
      const box = el.getBoundingClientRect();
      if (box.width && box.right > innerWidth + 0.5 && getComputedStyle(el).visibility !== 'hidden') out.push(`${el.tagName}.${el.className} right ${Math.round(box.right)}`);
    }
    return { scroll: document.scrollingElement.scrollWidth - innerWidth, out: out.slice(0, 8) };
  });
}

test('At work and the detail show age, checklist and an older wait, and wrap at 360 px', { timeout: 180_000, skip: !channel }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const rpc = runtime.client;
  await rpc.call('pwa.enable', { enabled: true, bind: 'lan' });
  const link = await rpc.call('pwa.link', { name: 'Wave A fixture' });
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await rpc.call('chats.create', { title: 'Wave A fixture', agentIds: [manager.id] });
  await rpc.call('events.subscribe', { topics: ['chats', 'org', `chat:${chat.id}`] });
  const plan = [{ text: 'Ticket schreiben', done: true }, { text: 'Antwort abwarten', done: false }, { text: 'Erstattung prüfen', done: false }];
  const quest = await rpc.call('tasks.create', { kind: 'quest', title: QUEST });
  const call = `[[tool:tasks.add ${JSON.stringify({ title: TITLE, notes: NOTES, plan, waiting: WHY, quest: quest.id, priority: 'urgent' })}]]`;
  const sent = await rpc.call('messages.send', { conversationId: chat.id, body: call });
  const reply = await rpc.waitFor(MESSAGE_EVENTS, (msg) => msg.conversationId === chat.id && msg.authorId === manager.id && msg.seq > sent.seq && msg.state === 'final', 30_000);
  const id = /"taskId":"(task_\w+)"/.exec(reply.body ?? '')?.[1];
  assert.ok(id, `the agent made its task (${String(reply.body).slice(0, 400)})`);
  const task = await rpc.call('tasks.get', { id });
  assert.equal(task.status, 'waiting', JSON.stringify(task).slice(0, 400));
  assert.equal(task.title, TITLE);

  const browser = await chromium.launch({ channel, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  await page.clock.setFixedTime(new Date(Date.now() + 2 * DAY + 3600_000));
  await page.goto(`http://localhost:${new URL(link.url).port}/${new URL(link.url).hash}`);
  await page.locator('.mobile-shell').waitFor();
  await page.evaluate(() => { location.hash = '#/tasks'; });
  const view = page.locator('.mobile-shell .tasks-page');
  await view.getByRole('button', { name: /At work/ }).click();
  const line = view.locator('.ai-line', { hasText: 'CS17246974' }).first();
  await line.waitFor();
  const text = await line.innerText();
  assert.match(text, /☑ 1\/3/);
  assert.match(text, /Created on \w{3} \d{1,2} \w{3}/);
  assert.match(text, /Stuck since \w{3} \d{1,2} \w{3}/);
  assert.match(text, /since \w{3} \d{1,2} \w{3} [\d:]+/, 'a wait of an earlier day carries its date');
  assert.deepEqual(await overflowOf(page, '.mobile-shell'), { scroll: 0, out: [] });
  await line.scrollIntoViewIfNeeded();
  if (shots) await page.screenshot({ path: path.join(shots, 'tasks-list-360.png') });

  await line.click();
  const detail = view.locator('.task-detail');
  await detail.waitFor();
  const head = await detail.locator('.detail-body').innerText();
  assert.match(head, /Created on \w{3} \d{1,2} \w{3}/);
  assert.match(head, /Stuck since \w{3} \d{1,2} \w{3}/);
  assert.match(head, /since \w{3} \d{1,2} \w{3} [\d:]+/);
  assert.deepEqual(await overflowOf(page, '.mobile-shell'), { scroll: 0, out: [] });
  if (shots) await page.screenshot({ path: path.join(shots, 'tasks-detail-360.png') });
});
