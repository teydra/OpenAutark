// Electron window check of the Tasks page (Quests round 20.11.2026: one page instead of My day and Work) with the demo
// engine in an isolated profile:
//   * #/tasks (and the default route): the head – ‹ › before the day, Day | Week –, the quest column in the sidebar
//     ("Quests" with + – the day's title size), the input line, "For you", "Done today (0)", "At work" closed, the
//     calendar beside the list;
//   * the input line: a time in the words with a clock time is marked blue at once and used (its chip, its × drops it);
//     a day alone ("am Freitag") is only offered; the owner's sentence with two times uses none until one is picked;
//     Enter adds the to-do at once – the used phrase leaves the title, a timed one stands on the calendar and under
//     Later on another day; its + is the Plus menu (Files…, Only me, Send to…) – a line sent to an agent shows under
//     "At work";
//   * text in the line and a click into a free time of the calendar: the to-do at that time;
//   * one Tasks destination: the rail's entries are Tasks · Chats · Team (the phone's tabs too);
//   * a row's right-click: Later ›, Repeat › Daily · Weekdays · Weekly, Only me, Important, Rename…, Undo last change,
//     Remove; "In 1 hour" moves its time;
//   * a click on a row opens its detail where the calendar was – title 15 px, its tool, its own thread – and nothing in
//     the list moves; its thread's slim line ("Write … about this…", never "Untitled chat"); the title is edited in
//     place and the time chip takes a typed time; × closes it; Week shows seven days, long titles whole words only;
//   * "+" in the quest column: the line names a quest, Enter opens the quest; a line typed while it is open goes in; the
//     quest's row has the task menu (Rename…, Done, Drop, Delete) and "Rename…" puts the caret into its title;
//   * "At work" opens and closes in place;
//   * light and dark at 1280 px, 390 px (one column: List | Calendar, the detail as its own view – its time chip works
//     there too), no horizontal scroll, no renderer errors. SCREENSHOTS=<dir> keeps the screenshots.
// Run: heavy.sh node --test test/ui/tasks-window.test.mjs (needs a fresh build of main, preload, runtime and ui).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { expectStable } from './lib/stable.mjs';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { runtimeInfo } from './lib/runtime-info.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

test('Tasks page: head, quests, input line with time marks, For you, calendar slot, row menu, detail and its edits, quest menu, At work, phone', { timeout: 480_000, skip: new Date().getHours() >= 22 ? 'needs two hours left in the day (a slot at 23:00)' : false }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-tasks-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
  const app = await electron.launch({
    executablePath: electronPath, args: [root], cwd: root, timeout: 60_000,
    env: { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' },
  });
  let rpc;
  t.after(async () => {
    rpc?.close?.();
    await Promise.race([app.close().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 15_000))]);
    try { app.process().kill(); } catch { /* gone already */ }
    if (!process.env.SCREENSHOTS) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  });

  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => {
    const [win] = BrowserWindow.getAllWindows();
    win.setMinimumSize(320, 480);
    win.setSize(w, h);
  }, [width, height]);
  await size(1280, 820);
  /** A frame asked for first: a window with nothing moving may not paint one by itself (a capture then waits for one). */
  const shot = async (name) => { await page.waitForTimeout(400); await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve()))); await page.screenshot({ path: path.join(shots, `${name}.png`), timeout: 15_000 }); };
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const until = async (check, what, ms = 15_000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await check()) return;
      if (Date.now() > end) assert.fail(`timed out: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  };
  const info = await runtimeInfo(profile); // a fresh profile's runtime writes it after the window shows (lib/runtime-info.mjs)
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } });
  const menu = page.locator('.menu[aria-label="Context menu"]');

  await page.evaluate(() => { location.hash = '#/tasks'; });
  const view = page.locator('.main-slot .tasks-page');
  await view.waitFor({ timeout: 15_000 });
  const header = view.locator('.tasks-header');
  assert.match((await header.locator('.day-line h2').textContent())?.trim() ?? '', /^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}$/, 'the day named for a screen reader: "Friday, November 20"');
  assert.match(await header.locator('.day-dot.today.on').getAttribute('aria-label') ?? '', /^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2} \(today\)(, has entries)?$/, 'the day line: today chosen and marked');
  assert.equal(await header.locator('.day-line-days .day-dot').count(), 7, 'a wide head holds a week of days');
  assert.deepEqual((await header.locator('.tasks-seg [role="tab"]').allTextContents()).map((text) => text.trim()), ['Day', 'Week']);
  assert.equal((await page.locator('.sidebar .frame-header-text').first().textContent())?.trim(), 'Quests');
  const fontOf = (locator) => locator.evaluate((el) => getComputedStyle(el).fontSize);
  assert.equal(await fontOf(page.locator('.sidebar .frame-header-text').first()), '15px', '"Quests" in the page\'s heading size');
  await page.locator('.sidebar [data-cell="new-quest"]').waitFor();
  await view.locator('.task-input').waitFor();
  assert.match((await view.locator('.tasks-sec').first().textContent()) ?? '', /^For you\s*0$/);
  assert.equal((await view.locator('.tasks-fold').textContent())?.trim(), 'Done today (0)');
  assert.equal(await view.locator('.ai-bar[aria-expanded="false"]').count(), 1, 'At work starts closed');
  await view.locator('.tasks-side .task-cal .cal-grid').waitFor({ timeout: 15_000 });
  assert.deepEqual(await page.locator('.rail .rail-top .icon-button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))), ['Tasks', 'Chats', 'Team'], 'one Tasks destination');
  assert.equal(await page.locator('.rail .rail-top .icon-button[aria-label="Tasks"]').getAttribute('aria-current'), 'page');
  await shot('tasks-01-empty-light');

  // 1. One time phrase: marked and used at once; × drops it; Enter adds the to-do without the phrase, under Later.
  const field = view.locator('.task-input-field');
  await field.fill('Steuerberater anrufen morgen um 10');
  await view.locator('.task-input-mirror mark.used').waitFor();
  assert.equal((await view.locator('.task-input-mirror mark.used').textContent())?.trim(), 'morgen um 10');
  assert.match((await view.locator('.task-chip.when').textContent()) ?? '', /^Tomorrow 10:00/);
  await shot('tasks-02-time-marked-light');
  await view.locator('.task-chip.when .task-chip-x').click();
  assert.equal(await view.locator('.task-chip.when').count(), 0, '× drops the time');
  await view.locator('.task-chip.open').click();
  await view.locator('.task-chip.when').waitFor();
  await field.press('Enter');
  const tax = view.locator('.todo-row', { hasText: 'Steuerberater anrufen' });
  await tax.waitFor({ timeout: 15_000 });
  assert.equal((await tax.locator('.todo-title').textContent())?.trim(), 'Steuerberater anrufen', 'the phrase left the title');
  assert.match((await tax.locator('.todo-meta').textContent()) ?? '', /Tomorrow 10:00/);
  assert.equal(await view.locator('li.tasks-sec.later').count(), 1, 'another day: under Later');
  const taxTask = (await rpc.call('todos.list', { limit: 200 })).find((task) => task.title === 'Steuerberater anrufen');
  assert.ok(taxTask?.at, 'its time is the to-do\'s `at`');

  // 2. The owner's sentence: two times, none used until one is picked.
  await field.fill('morgen Paul schreiben, dass wir am Freitag einen Call haben');
  await until(async () => (await view.locator('.task-input-mirror mark').count()) === 2, 'two phrases marked');
  assert.equal(await view.locator('.task-input-mirror mark.used').count(), 0);
  assert.equal(await view.locator('.task-chip.open').count(), 2);
  await shot('tasks-03-two-times-light');
  await field.fill('');

  // 2b. A day alone (the owner's line without "morgen"): offered outlined, not taken – a click uses it, else the assistant decides.
  await field.fill('Person XY schreiben, dass wir am Freitag einen Call haben');
  await until(async () => (await view.locator('.task-input-mirror mark').count()) === 1, 'one phrase marked');
  assert.equal(await view.locator('.task-input-mirror mark.used').count(), 0, 'a day alone is not used at once');
  assert.equal(await view.locator('.task-chip.open').count(), 1);
  assert.match((await view.locator('.task-input-hint').textContent()) ?? '', /^Click the day to use it/);
  await shot('fix-05-day-only-offered-light');
  await field.fill('');

  // 3. A to-do without a time; then text in the line and a click into a free time of the calendar.
  await field.fill('Water the plants');
  await field.press('Enter');
  const plants = view.locator('.todo-row', { hasText: 'Water the plants' });
  await plants.waitFor({ timeout: 15_000 });
  await field.fill('Call Anna about the offer');
  const grid = view.locator('.cal-grid');
  await view.locator('.cal-scroll').evaluate((el) => { el.scrollTop = 22 * 40 - 60; });
  await grid.locator('.cal-slot[data-minute="1380"]').click();
  const block = view.locator('.cal-block.todo', { hasText: 'Call Anna about the offer' });
  await block.waitFor({ timeout: 15_000 });
  assert.match((await view.locator('.todo-row', { hasText: 'Call Anna' }).locator('.todo-meta').textContent()) ?? '', /Today 23:00/);
  await shot('tasks-04-slot-light');

  // 4. A row's right-click menu: Later ›, Only me, Undo last change, Remove; "In 1 hour" moves its time.
  await plants.locator('.todo-open').click({ button: 'right' });
  await menu.waitFor({ timeout: 5_000 });
  const items = (await menu.locator('[role^="menuitem"] .menu-label > span:first-child').allTextContents()).map((text) => text.trim());
  for (const entry of ['In 10 minutes', 'In 1 hour', 'Daily', 'Weekdays', 'Weekly', 'Only me', 'Important', 'Rename…', 'Undo last change', 'Remove']) assert.ok(items.includes(entry), `the menu offers ${entry}: ${items.join(' | ')}`);
  await shot('tasks-05-row-menu-light');
  await menu.getByRole('menuitem', { name: 'In 1 hour' }).click();
  await until(async () => /Today \d\d:\d\d/.test((await plants.locator('.todo-meta').textContent()) ?? ''), 'Later moved its time');

  // 5. A click on a row: its detail where the calendar was; the list does not move; × closes it.
  const steady = ['.main-slot .tasks-list', '.main-slot .task-input', '.main-slot .todo-row[data-task-id]', '.main-slot .tasks-side'];
  await expectStable(page, steady, () => plants.locator('.todo-open').click());
  const detail = view.locator('.tasks-side .task-detail');
  await detail.waitFor();
  assert.equal((await detail.locator('.detail-title').textContent())?.trim(), 'Water the plants');
  assert.equal(await detail.locator('.detail-title').evaluate((el) => getComputedStyle(el).fontSize), '15px', 'one title size: 15 px in the detail');
  assert.equal(await plants.locator('.todo-title').evaluate((el) => getComputedStyle(el).fontSize), '14px', '14 px in the list');
  await detail.locator('.task-thread').waitFor({ timeout: 15_000 });
  const write = detail.locator('.task-thread textarea');
  await write.waitFor({ timeout: 15_000 });
  assert.match(await write.getAttribute('placeholder') ?? '', /^Write (to .+ )?about this…$/, 'the thread\'s slim line: who answers there');
  assert.equal(await detail.locator('.task-thread .composer-area.slim').count(), 1, 'one slim line, no framed composer');
  await detail.locator('.todo-tool').waitFor();
  assert.match(await page.evaluate(() => location.hash), /^#\/tasks\/task_/);
  await shot('tasks-06-detail-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('tasks-06-detail-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // 5b. The person edits it (R2.6): the title where it stands (Enter saves), the time chip's field (a typed time, the line's rule).
  const title = detail.locator('.detail-title');
  await expectStable(page, steady, () => title.click());
  await page.keyboard.press('End');
  await page.keyboard.type(' and the balcony');
  await page.keyboard.press('Enter');
  await view.locator('.todo-row', { hasText: 'Water the plants and the balcony' }).waitFor({ timeout: 15_000 });
  await detail.locator('button.task-chip.time').click();
  const timeField = page.locator('.popover.time-pop .input');
  await timeField.fill('morgen 15 Uhr');
  await page.locator('.popover.time-pop .task-chip.when').waitFor();
  await shot('fix-02-title-time-edit-light');
  await timeField.press('Enter');
  await until(async () => /Tomorrow 15:00/.test((await plants.locator('.todo-meta').textContent()) ?? ''), 'the typed time on its row');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('fix-02-title-time-edit-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await detail.getByRole('button', { name: 'Close' }).click();
  await view.locator('.tasks-side .task-cal').waitFor();

  // 6. Week, then Day again; the head never moves; long titles break between words only (R2.14).
  for (const [text, inMinutes] of [['Steuerberater anrufen wegen der Umsatzsteuervoranmeldung', 60], ['Rechnungsprüfungsunterlagen zusammenstellen', 75]]) {
    await rpc.call('tasks.quickCreate', { text, at: Date.now() + inMinutes * 60_000, minutes: 30, private: true });
  }
  await expectStable(page, ['.main-slot .day-line > .day-line-arrow', '.main-slot .tasks-seg'], () => header.getByRole('tab', { name: 'Week' }).click());
  await until(async () => (await view.locator('.cal-week .cal-wd').count()) === 7, 'seven days');
  const long = view.locator('.cal-wb', { hasText: 'Umsatzsteuervoranmeldung' }).locator('.cal-wb-title');
  await long.waitFor({ timeout: 15_000 });
  assert.deepEqual(await long.evaluate((el) => [getComputedStyle(el).overflowWrap, getComputedStyle(el).wordBreak]), ['normal', 'normal'], 'whole words, never letter by letter');
  await shot('tasks-07-week-light');
  await shot('fix-06-week-long-titles-light');
  await header.getByRole('tab', { name: 'Day' }).click();

  // 7. A quest: "+" in the quest column, a name, Enter – its detail; a line typed while it is open goes into it.
  await page.locator('.sidebar [data-cell="new-quest"] button').click();
  await field.fill('Tax return 2026');
  await field.press('Enter');
  const quest = view.locator('.tasks-side .task-detail.quest');
  await quest.waitFor({ timeout: 15_000 });
  assert.equal((await quest.locator('.detail-title').textContent())?.trim(), 'Tax return 2026');
  await page.locator('.sidebar .quest-item', { hasText: 'Tax return 2026' }).waitFor();
  assert.match((await view.locator('.task-chip.quest').textContent()) ?? '', /In Tax return 2026/);
  await field.fill('Collect the receipts');
  await field.press('Enter');
  await quest.locator('.quest-row', { hasText: 'Collect the receipts' }).waitFor({ timeout: 15_000 });
  assert.match((await view.locator('.todo-row', { hasText: 'Collect the receipts' }).locator('.todo-meta').textContent()) ?? '', /Tax return 2026/);
  await shot('tasks-08-quest-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('tasks-08-quest-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await quest.getByRole('button', { name: 'Close' }).click();

  // 7b. The quest's menu (R2.2): its row's right-click – Rename…, Give to…, Done, Drop, Delete; Rename… puts the caret into its title.
  await page.locator('.sidebar .quest-item', { hasText: 'Tax return 2026' }).click({ button: 'right' });
  await menu.waitFor({ timeout: 5_000 });
  const questItems = (await menu.locator('[role^="menuitem"] .menu-label > span:first-child').allTextContents()).map((text) => text.trim());
  for (const entry of ['Rename…', 'Team – Autark picks', 'Done', 'Drop', 'Delete']) assert.ok(questItems.includes(entry), `the quest menu offers ${entry}: ${questItems.join(' | ')}`);
  await shot('fix-01-quest-menu-light');
  await menu.getByRole('menuitem', { name: 'Rename…' }).click();
  await quest.waitFor({ timeout: 15_000 });
  await until(() => quest.locator('.detail-title').evaluate((el) => document.activeElement === el), 'the title takes the caret');
  const longQuestTitle = 'Tax return 2026 – Finanzamt – collect supporting documents and check every receipt before filing';
  await page.keyboard.type(longQuestTitle);
  await page.keyboard.press('Enter');
  await page.locator('.sidebar .quest-item', { hasText: 'Finanzamt' }).waitFor({ timeout: 15_000 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('fix-01-quest-renamed-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await quest.getByRole('button', { name: 'Close' }).click();

  // 8. The line's + is the Plus menu (R2.8): Files…, Only me, Send to… – a line sent to an agent stands under "At work",
  // which opens and closes in place.
  await expectStable(page, ['.main-slot .task-input', '.main-slot .ai-bar'], () => view.locator('.task-input .task-input-plus').click());
  const addMenu = page.locator('.menu[aria-label="Add"]');
  await addMenu.waitFor({ timeout: 5_000 });
  const addItems = (await addMenu.locator('[role^="menuitem"] .menu-label > span:first-child').allTextContents()).map((text) => text.trim());
  for (const entry of ['Files…', 'Only me']) assert.ok(addItems.includes(entry), `the + offers ${entry}: ${addItems.join(' | ')}`);
  const sendTo = (await addMenu.locator('.menu-title').allTextContents()).includes('Send to…');
  await shot('fix-03-plus-menu-light');
  if (sendTo) {
    const agent = (await addMenu.locator('.menu-section', { hasText: 'Send to…' }).locator('[role^="menuitem"] .menu-label > span:first-child').first().textContent())?.trim() ?? '';
    await addMenu.locator('.menu-section', { hasText: 'Send to…' }).locator('[role^="menuitem"]').first().click();
    await view.locator('.task-input-chips .task-chip.to', { hasText: agent }).waitFor();
    await field.fill('Book the venue for the offsite');
    await field.press('Enter');
    await until(async () => (await view.locator('.task-input-chips .task-chip.to').count()) === 0, 'the line is empty again');
  } else {
    await page.keyboard.press('Escape');
  }
  await expectStable(page, ['.main-slot .task-input', '.main-slot .ai-bar'], () => view.locator('.ai-bar').click());
  await view.locator('.ai-list').waitFor();
  assert.match((await view.locator('.ai-bar b').textContent()) ?? '', /^At work/);
  if (sendTo) await view.locator('.ai-line', { hasText: 'Book the venue for the offsite' }).waitFor({ timeout: 15_000 });
  await shot('tasks-09-ai-open-light');
  await shot('fix-04-at-work-open-light');
  await view.locator('.ai-bar').click();
  assert.equal(await view.locator('.ai-list').count(), 0);
  await until(async () => (await overflow()) <= 1, `no horizontal page scroll at 1280 px (${await overflow()}px)`, 5_000);

  // 9. The phone: one column (Tasks | Calendar as two symbols beside the day line), quests as chips, the detail as its own view.
  await size(390, 844);
  const phone = page.locator('.mobile-shell .tasks-page');
  await phone.waitFor({ timeout: 15_000 });
  assert.deepEqual(await phone.locator('.tasks-seg [role="tab"]').evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('aria-label'))), ['Tasks', 'Calendar']);
  assert.ok(await phone.locator('.day-line-days .day-dot').count() >= 5, 'five days or more beside the arrows at 390 px');
  const questChip = phone.getByRole('button', { name: longQuestTitle, exact: true });
  await questChip.waitFor();
  const label = await questChip.locator('.quest-chip-label').evaluate((el) => {
    const style = getComputedStyle(el);
    const chip = el.closest('.quest-chip');
    const row = chip.closest('.quest-chips');
    return {
      ellipsis: style.textOverflow === 'ellipsis' && style.overflowX === 'hidden',
      truncated: el.scrollWidth > el.clientWidth && el.clientWidth > 0,
      fits: el.getBoundingClientRect().right <= chip.getBoundingClientRect().right
        && chip.getBoundingClientRect().right <= row.getBoundingClientRect().right + 1,
    };
  });
  assert.deepEqual(label, { ellipsis: true, truncated: true, fits: true }, 'long quest title ends inside its chip with an ellipsis');
  await until(async () => (await overflow()) <= 1, `no horizontal page scroll at 390 px (${await overflow()}px)`, 5_000);
  assert.deepEqual((await page.locator('.mobile-shell .tab-bar .tab-label').allTextContents()).map((text) => text.trim()), ['Tasks', 'Chats', 'Team'], 'one Tasks tab');
  await shot('tasks-10-phone-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('tasks-10-phone-dark');
  await phone.locator('.todo-row', { hasText: 'Water the plants' }).locator('.todo-open').click();
  await page.locator('.mobile-shell .tasks-page .task-detail').waitFor();
  assert.equal(await page.locator('.mobile-shell .tab-bar').count(), 0, 'the detail is a pushed view');
  await shot('tasks-11-phone-detail-dark');
  await page.locator('.mobile-shell .task-detail button.task-chip.time').click(); // the time works on the phone too (R2.6)
  await page.locator('.popover.time-pop .input').fill('/9:30');
  await page.locator('.popover.time-pop .task-chip.when').waitFor();
  await shot('fix-07-phone-time-edit-dark');
  await page.locator('.popover.time-pop .input').press('Escape');
  await page.locator('.mobile-shell .task-detail').getByRole('button', { name: 'Close' }).click();
  await phone.getByRole('tab', { name: 'Calendar' }).click();
  await phone.locator('.task-cal').waitFor();
  await shot('tasks-12-phone-calendar-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await size(1280, 820);

  assert.deepEqual(errors.filter((text) => !/favicon|ResizeObserver loop/.test(text)), [], 'no renderer errors');
});
