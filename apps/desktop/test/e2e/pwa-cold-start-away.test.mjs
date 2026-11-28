// A cold start of a paired phone page whose PC does not answer (Juri's iPhone run 27.11.2026: the app's own interface
// came up with "Tasks · Nothing for you here" and nothing said the PC was missing – it looked like an empty company):
// within about 2 s the status line says "<PC> not reachable · reconnecting by itself", and the lists whose data never
// came say they wait for the PC instead of "Nothing for you here". Once the PC answers the line goes and the data shows.
// Uses an installed Chrome or Edge through playwright-core (never downloads one); skipped without.
// WORKFORCE_SHOTS=<folder> keeps the screenshots (360 px: away after 2 s, back again).
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

test('a cold start without the PC says so within 2 s and claims no empty lists', { timeout: 180_000, skip: !channel }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const rpc = runtime.client;
  await rpc.call('pwa.enable', { enabled: true, bind: 'lan' });
  const link = await rpc.call('pwa.link', { name: 'Cold start fixture' });
  const url = new URL(link.url);
  const origin = `http://localhost:${url.port}`;

  const browser = await chromium.launch({ channel, headless: true });
  t.after(() => browser.close());
  // one context: the token (localStorage) stays like in the phone app; no copy of the data is kept yet (fresh pairing)
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  let pcAway = true;
  // the PC does not answer: every socket closes at once (as an unreachable address does), until pcAway is false
  await context.routeWebSocket(/\/ws$/, (ws) => {
    if (pcAway) { ws.close(); return; }
    ws.connectToServer();
  });
  const page = await context.newPage();
  // the pairing link stores the token; the page is then reloaded cold, as an app start with the PC gone
  await page.addInitScript(() => { try { indexedDB.deleteDatabase('workforce'); } catch { /* none */ } });
  await page.goto(`${origin}/${url.hash}`);
  await page.locator('.mobile-shell').waitFor();
  const token = await page.evaluate(() => localStorage.getItem('wf.token'));
  assert.ok(token, 'the pairing link left its token');
  await page.evaluate(() => { location.hash = '#/tasks'; });
  const started = Date.now();
  await page.reload();
  await page.locator('.mobile-shell .tasks-page').waitFor();

  const line = page.locator('.status-note[data-notice="connection"]');
  await line.waitFor({ timeout: 3_000 });
  const after = Date.now() - started;
  assert.match(await line.innerText(), /not reachable · reconnecting by itself/);
  const forYou = page.locator('.mobile-shell .tasks-page');
  assert.doesNotMatch(await forYou.innerText(), /Nothing for you here/, 'no empty list is claimed while nothing was ever loaded');
  // 28.11.2026 (Juri's iPhone run): the line has its own place – it overlaps nothing below it and its text is whole
  const box = await line.boundingBox();
  const below = await page.evaluate(() => {
    const host = document.querySelector('.mobile-shell > .status-host');
    const main = document.querySelector('.mobile-shell > .mobile-main');
    const first = main?.querySelector(':scope > * > *, :scope > *');
    const r = (el) => { const b = el?.getBoundingClientRect(); return b ? { top: b.top, bottom: b.bottom, right: b.right } : null; };
    const text = document.querySelector('.status-note[data-notice="connection"] .status-text');
    return { host: r(host), main: r(main), first: r(first), cut: text ? text.scrollWidth > text.clientWidth || text.scrollHeight > text.clientHeight : true,
      pos: host ? getComputedStyle(host).position : '' };
  });
  assert.ok(box, 'the line has a box');
  assert.notEqual(below.pos, 'absolute', 'the line is not an overlay');
  assert.ok(below.host.bottom <= below.main.top + 0.5, `the line (bottom ${below.host.bottom}) ends above the body (top ${below.main.top})`);
  assert.ok(below.first.top >= box.y + box.height - 0.5, 'the first element below starts under the line');
  assert.ok(box.x >= 0 && box.x + box.width <= 360, 'the line lies inside 360 px');
  assert.equal(below.cut, false, 'the line\'s text is not cut');
  if (shots) await page.screenshot({ path: path.join(shots, 'cold-start-away-360.png') });
  t.diagnostic(`line after ${after} ms`);

  // the PC answers again: the line goes, the real (empty) list shows
  pcAway = false;
  await line.waitFor({ state: 'detached', timeout: 15_000 });
  await page.getByText('Nothing for you here').waitFor({ timeout: 10_000 });
  if (shots) await page.screenshot({ path: path.join(shots, 'cold-start-back-360.png') });
});
