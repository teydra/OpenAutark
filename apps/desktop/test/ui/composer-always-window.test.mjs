// Electron window check (25.11.2026, owner 24.11. #228: "die Eingabezeile ist nicht richtig immer da, wenn die Agenten
// arbeiten") with the demo engine in an isolated profile. Three agents work on hanging tasks ([[hang:bash]]):
//   * in the chat, with the live bar's lines open, at 1280×820, 900×560 and 640×480 the composer's field is on screen
//     (inside the window), enabled and writable; a line sent then is delivered (it stands in the list);
//   * in the task's detail (the slim line of its thread), with the thread's live bar open, the same at 900×560 and 640×480;
//   * no renderer errors.
// Run: npm run test:ui   (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots.

import { testNetworkEnv } from '../../scripts/test-network-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { runtimeInfo } from './lib/runtime-info.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

test('the composer stays on screen, enabled and sending while agents work (chat and task detail)', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-composer-always-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
  const app = await electron.launch({
    executablePath: electronPath, args: [root], cwd: root, timeout: 60_000,
    env: testNetworkEnv(profile, { WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' }),
  });
  let rpc;
  t.after(async () => {
    rpc?.close?.();
    await app.close().catch(() => undefined);
    if (!process.env.SCREENSHOTS) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  });

  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => {
    const [win] = BrowserWindow.getAllWindows();
    win.setMinimumSize(320, 400);
    win.setSize(w, h);
  }, [width, height]);
  await size(1280, 820);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const info = await runtimeInfo(profile);
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } });

  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const quill = await rpc.call('agents.create', { name: 'Quill', role: 'Writer', managerId: manager.id });
  const sage = await rpc.call('agents.create', { name: 'Sage', role: 'Researcher', managerId: manager.id });
  const chat = await rpc.call('chats.create', { title: 'Launch plan', agentIds: [manager.id, quill.id, sage.id] });
  await rpc.call('events.subscribe', { topics: ['chats', 'tasks', `chat:${chat.id}`, 'org', 'system'] });
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  await page.locator('.composer').waitFor({ timeout: 15_000 });

  const working = rpc.waitFor('agent.activity', (event) => [manager, quill, sage].every((a) => event.active.some((run) => run.agentId === a.id && run.taskId)), 60_000);
  const task = await rpc.call('tasks.create', { conversationId: chat.id, title: 'Plan the launch [[hang:bash]]', to: manager.id });
  await rpc.call('tasks.create', { conversationId: chat.id, title: 'Draft the post [[hang:bash]]', to: quill.id });
  await rpc.call('tasks.create', { conversationId: chat.id, title: 'Research the market [[hang:bash]]', to: sage.id });
  await working;
  await page.waitForFunction(() => document.querySelectorAll('.live-bar .live-bar-line').length === 3, undefined, { timeout: 20_000 });

  /** The field of the visible composer: inside the window, enabled, and the Send button can take a line. */
  const onScreen = async (where) => {
    const state = await page.evaluate(() => {
      const fields = [...document.querySelectorAll('.composer-input')].filter((el) => el.getClientRects().length);
      const field = fields.at(-1);
      const rect = field?.getBoundingClientRect();
      return field && rect ? { top: rect.top, bottom: rect.bottom, height: rect.height, disabled: field.disabled || field.readOnly, vh: innerHeight } : null;
    });
    assert.ok(state, `${where}: a composer field exists`);
    assert.ok(state.height > 8 && state.top >= 0 && state.bottom <= state.vh + 1, `${where}: the field is inside the window ${JSON.stringify(state)}`);
    assert.equal(state.disabled, false, `${where}: the field is writable`);
  };

  // --- the chat: live bar closed and open, three window sizes
  for (const [w, h] of [[1280, 820], [900, 560], [640, 480]]) {
    await size(w, h);
    await page.waitForTimeout(300);
    await onScreen(`chat ${w}×${h}`);
    if (!(await page.locator('.live-bar-more').count())) await page.locator('.chat-header .chat-live').click();
    await page.waitForFunction(() => document.querySelectorAll('.live-bar .live-bar-more').length === 3, undefined, { timeout: 10_000 });
    await onScreen(`chat ${w}×${h}, live bar open`);
    await shot(`composer-always-chat-${w}`);
  }
  await size(900, 560);
  const field = page.locator('.composer-input');
  await field.fill('Where do we stand?');
  await field.press('Enter');
  await page.locator('.message.human', { hasText: 'Where do we stand?' }).waitFor({ timeout: 10_000 });
  assert.equal(await field.inputValue(), '', 'the field is empty after the send');
  await onScreen('chat after a send');

  // --- the task's detail: its thread's slim line
  await page.locator('.live-bar .live-bar-task', { hasText: task.title }).first().click();
  await page.locator('.main-slot .tasks-page .task-detail').waitFor({ timeout: 15_000 });
  for (const [w, h] of [[900, 560], [640, 480]]) {
    await size(w, h);
    await page.waitForTimeout(400);
    await onScreen(`task detail ${w}×${h}`);
    await shot(`composer-always-task-${w}`);
  }
  assert.deepEqual(errors, [], 'no renderer errors');
});
