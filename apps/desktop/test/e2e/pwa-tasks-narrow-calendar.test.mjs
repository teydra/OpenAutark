// The Tasks page's calendar at 360 px in a paired PWA (Mika's S9 review of 0.3.21, 27.11.2026): the day head keeps its date,
// "AI lane on", "Logbook before now" and – on another day – the "Today" button inside the screen (it wraps into a second line);
// two agents' notes at the same time on the AI lane stand one below the other and stay readable; and a quest with a very
// long name is a chip that ends in an ellipsis inside the screen, its whole name in the tooltip and the accessible name.
// Uses an installed Chrome or Edge through playwright-core (never downloads one); skipped without.
// WORKFORCE_SHOTS=<folder> keeps the screenshots (360 px: today, another day, quest chips; 1100 px: the desktop for comparison).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startRuntime } from './lib/runtime-client.mjs';
import { detectChannel } from '../../src/runtime/browser/channel.ts';

function installedChannel() {
  try { return detectChannel(); } catch { return undefined; }
}
const channel = process.env.WORKFORCE_PWA_CHANNEL || installedChannel();
const shots = process.env.WORKFORCE_SHOTS;
const QUEST = 'Kunden-Bots schneller machen: andere EU-Hosts probieren, Entscheidungsmodell und Absicherung einbauen (Stanislaus 26.11. 17:30)';

/** Every box of `selector`'s elements lies inside the viewport's width and the page does not scroll sideways. */
async function inside(page, selector) {
  return page.locator(selector).evaluateAll((els) => ({
    scroll: document.scrollingElement.scrollWidth - innerWidth,
    out: els.map((el) => { const box = el.getBoundingClientRect(); return { text: el.textContent.trim().slice(0, 30), left: Math.round(box.left), right: Math.round(box.right) }; })
      .filter((box) => box.left < -0.5 || box.right > innerWidth + 0.5),
  }));
}

test('the calendar head, the AI lane and a long quest chip hold at 360 px', { timeout: 180_000, skip: !channel }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const rpc = runtime.client;
  await rpc.call('pwa.enable', { enabled: true, bind: 'lan' });
  const link = await rpc.call('pwa.link', { name: 'Narrow calendar fixture' });
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const mika = await rpc.call('agents.create', { name: 'Mika', managerId: manager.id });
  const lena = await rpc.call('agents.create', { name: 'Lena', managerId: manager.id });
  const quest = await rpc.call('tasks.create', { kind: 'quest', title: QUEST });
  await rpc.call('tasks.create', { title: 'Lange Notiz auf dem Handy', notes: Array.from({ length: 30 }, (_, i) => `Zeile ${i + 1}: genug Text, damit der Bereich scrollen muss.`).join('\n\n') });
  await rpc.call('tasks.create', { title: 'Antwort an die Hosts vorbereiten', parentId: quest.id });
  for (const [who, title] of [[mika, 'Samsung-Abnahme der Tasks-Seite'], [lena, 'Habakuk-Seite vorrendern']]) {
    const made = await rpc.call('tasks.create', { title, to: who.id });
    await rpc.call('tasks.finish', { id: made.id });
  }

  const long = await rpc.call('tasks.create', { title: 'Lange Historie auf dem Handy', notes: Array.from({ length: 12 }, (_, i) => `Notiz ${i + 1}: Diese Zeilen dürfen nicht hinter der Historie verschwinden.`).join('\n\n') });
  await rpc.call('chats.thread', { taskId: long.id });
  for (let i = 1; i <= 40; i++) await rpc.call('messages.send', { conversationId: long.id, body: `Verlauf ${i}: ein Satz, der in der Historie dieser Aufgabe steht und etwas Platz braucht.` });
  const browser = await chromium.launch({ channel, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  await page.goto(`http://localhost:${new URL(link.url).port}/${new URL(link.url).hash}`);
  await page.locator('.mobile-shell').waitFor();
  await page.evaluate(() => { location.hash = '#/tasks'; });
  const view = page.locator('.mobile-shell .tasks-page');

  // the quest chip first: the list is the first view
  const chip = view.locator('.quest-chip', { hasText: 'Kunden-Bots' });
  await chip.waitFor();
  assert.equal(await chip.getAttribute('title'), QUEST, 'the chip carries the whole name as its tooltip');
  assert.deepEqual(await inside(page, '.mobile-shell .quest-chips, .mobile-shell .quest-chip'), { scroll: 0, out: [] });
  const cut = await chip.locator('.quest-chip-label').evaluate((el) => el.scrollWidth > el.clientWidth);
  assert.ok(cut, 'a name this long ends in an ellipsis');
  if (shots) await page.screenshot({ path: path.join(shots, 'tasks-quest-chip-360.png') });

  // the calendar of today with the AI lane (the "At work" bar of the list turns it on)
  await view.getByRole('button', { name: /At work/ }).click();
  await view.getByRole('tab', { name: 'Calendar' }).click();
  const head = view.locator('.cal-head');
  await head.waitFor();
  await view.locator('.cal-ai').first().waitFor();
  // the S9 sets its type wider than this headless Chrome: a 15 % larger text size is what Mika's screenshot shows
  await page.evaluate(() => document.documentElement.style.setProperty('--ui-text', '1.15'));
  assert.match(await head.innerText(), /AI lane on/);
  assert.match(await head.innerText(), /Logbook before now/);
  assert.deepEqual(await inside(page, '.mobile-shell .cal-head, .mobile-shell .cal-head > *'), { scroll: 0, out: [] });
  const marks = await view.locator('.cal-ai').evaluateAll((els) => els.map((el) => { const box = el.getBoundingClientRect(); return { text: el.textContent.trim(), top: box.top, bottom: box.bottom, left: box.left, right: box.right, clipped: el.scrollWidth > el.clientWidth + 1 }; }));
  const names = marks.map((mark) => mark.text).sort();
  assert.deepEqual(names, ['Lena', 'Mika'], 'both notes of the same minute are on the lane');
  marks.sort((a, b) => a.top - b.top);
  assert.ok(marks[0].bottom <= marks[1].top + 0.5, `the two marks do not overlap (${JSON.stringify(marks)})`);
  assert.ok(marks.every((mark) => !mark.clipped), 'a name fits its mark');
  const todayNote = await head.locator('.cal-head-note').evaluate((el) => { const box = el.getBoundingClientRect(); return { left: Math.round(box.left), top: Math.round(box.top) }; });
  await view.locator('.cal-ai').first().scrollIntoViewIfNeeded();
  if (shots) await page.screenshot({ path: path.join(shots, 'tasks-calendar-today-360.png') });

  // another day: the "Today" button and the logbook note both stay
  await view.locator('.day-dot.past').last().click();
  const back = head.getByRole('button', { name: 'Today' });
  await back.waitFor();
  assert.match(await head.innerText(), /Logbook before now/);
  assert.deepEqual(await inside(page, '.mobile-shell .cal-head, .mobile-shell .cal-head > *'), { scroll: 0, out: [] });
  if (shots) await page.screenshot({ path: path.join(shots, 'tasks-calendar-other-day-360.png') });
  const otherNote = await head.locator('.cal-head-note').evaluate((el) => { const box = el.getBoundingClientRect(); return { left: Math.round(box.left), top: Math.round(box.top) }; });
  assert.equal(todayNote.left, otherNote.left, `the note stands at the same x today and on another day (${JSON.stringify({ todayNote, otherNote })})`);
  assert.ok(todayNote.left < 30, `and that place is the left edge (${todayNote.left})`);
  await back.click();
  await head.getByRole('button', { name: 'Today' }).waitFor({ state: 'detached' });

  // a to-do's detail: the scroll area reaches down to the thread's slim line instead of stopping at about half the screen
  await view.getByRole('tab', { name: 'Tasks' }).click();
  await view.locator('.todo-row', { hasText: 'Lange Notiz' }).first().click();
  const body = page.locator('.mobile-shell .detail-body');
  await body.waitFor();
  if (shots) await page.screenshot({ path: path.join(shots, 'tasks-detail-360.png') });
  const room = await page.evaluate(() => {
    const body = document.querySelector('.mobile-shell .detail-body').getBoundingClientRect();
    const next = document.querySelector('.mobile-shell .task-detail > .task-thread').getBoundingClientRect();
    const label = document.querySelector('.mobile-shell .task-detail > .detail-label')?.getBoundingClientRect().height ?? 0; // the History label sits between the two
    const composer = document.querySelector('.mobile-shell .composer-area').getBoundingClientRect();
    return { composerBottom: Math.round(composer.bottom), bodyBottom: Math.round(body.bottom + label), threadTop: Math.round(next.top), threadHeight: Math.round(next.height), height: Math.round(body.height), screen: innerHeight };
  });
  assert.ok(room.threadTop - room.bodyBottom <= 1, `the scroll area ends where the thread (under its label) begins (${JSON.stringify(room)})`);
  assert.ok(room.height > room.screen * 0.58, `and is taller than the old 58 % cap (${JSON.stringify(room)})`);
  assert.ok(room.composerBottom <= room.screen + 1, `the composer stays on the screen (${JSON.stringify(room)})`);
  assert.ok(room.threadHeight < room.screen * 0.3, `while the thread stays slim (${JSON.stringify(room)})`);
  // a task with a long history: the thread must not squeeze the notes – the scroll area keeps at least 40 % of the screen, the thread scrolls inside itself, the composer stays on the screen
  await page.evaluate(() => { location.hash = '#/tasks'; });
  await view.locator('.todo-row', { hasText: 'Lange Historie' }).first().click();
  await body.waitFor();
  await page.locator('.mobile-shell .task-detail > .task-thread .message').nth(5).waitFor();
  const longRoom = await page.evaluate(() => {
    const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
    const thread = document.querySelector('.mobile-shell .task-detail > .task-thread');
    const scroller = [thread, ...thread.querySelectorAll('*')].filter((el) => getComputedStyle(el).overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 4).map((el) => ({ cls: el.className, client: el.clientHeight, scroll: el.scrollHeight }));
    return { body: Math.round(rect('.mobile-shell .detail-body').height), thread: Math.round(rect('.mobile-shell .task-detail > .task-thread').height), composerBottom: Math.round(rect('.mobile-shell .composer-area').bottom), scrollers: scroller, screen: innerHeight };
  });
  if (shots) await page.screenshot({ path: path.join(shots, 'tasks-detail-long-history-360.png') });
  assert.ok(longRoom.body >= longRoom.screen * 0.4, `the notes keep their room next to a long history (${JSON.stringify(longRoom)})`);
  assert.ok(longRoom.composerBottom <= longRoom.screen + 1, `the composer stays on the screen with a long history (${JSON.stringify(longRoom)})`);
  assert.ok(longRoom.scrollers.length > 0, `and the history scrolls inside itself (${JSON.stringify(longRoom)})`);
  // the desktop, for comparison: the head stays one line, the lane its place
  if (shots) {
    const wide = await browser.newPage({ viewport: { width: 1100, height: 740 }, deviceScaleFactor: 1, colorScheme: 'dark' });
    const second = await rpc.call('pwa.link', { name: 'Narrow calendar fixture, desktop' }); // a pairing link serves one device
    await wide.goto(`http://localhost:${new URL(second.url).port}/${new URL(second.url).hash}`);
    await wide.locator('.tasks-page').waitFor();
    await wide.evaluate(() => { location.hash = '#/tasks'; });
    await wide.locator('.cal-head').waitFor();
    assert.equal(await wide.locator('.cal-head').evaluate((el) => el.getBoundingClientRect().height < 50), true, 'the desktop head stays one line');
    await wide.screenshot({ path: path.join(shots, 'tasks-desktop-1100.png') });
  }
});
