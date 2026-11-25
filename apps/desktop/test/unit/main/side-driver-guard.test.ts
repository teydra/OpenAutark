// Secure mode's guard on a side tab an agent drives (Konrad 25.11.2026, gap a): a call with `web` turns DevTools Fetch
// on for the tab; every main-frame document request – each redirect hop – goes on only to a chosen site, within the site
// the tab shows, or to the site of the open running now (for that open alone, gap c); anything else fails and the agent's
// next answer names it; a new tab the page opens inherits the guard; the person's own use and a call without `web`
// (Trust AI mode, the web open) switch it off; the workspace browser's hooks (workspace-guard.ts); `web` as validate takes it.
// Owns: these assertions only. Never: a real page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SideDriver } from '../../../src/main/side-driver/driver.ts';
import { checkCall } from '../../../src/main/side-driver/validate.ts';
import { TabGuards, UNWATCHED } from '../../../src/main/workspace-guard.ts';
import { FakeContents, checkoutTree, fakeBrowser, pageHandlers, type FakeDebugger } from './side-driver-fakes.ts';

const agent = { id: 'ag_ada', name: 'Ada' };
const web = { sites: ['docs.example'] };
const HELD = /^Secure mode held back the move to evil\.io: that site is not open to me yet\./;

function page(clock: { now: number }, url: string) {
  const contents = new FakeContents(clock);
  contents.url = url;
  pageHandlers(contents.debugger, { tree: checkoutTree() });
  contents.debugger.handlers['Page.getFrameTree'] = () => ({ frameTree: { frame: { id: 'main', url: contents.url } } });
  return contents;
}

function setup() {
  const clock = { now: 1_000_000 };
  const contents = page(clock, 'https://shop.example/cart');
  const browser = fakeBrowser({ 'web-1': contents });
  const driver = new SideDriver({
    browser: () => browser, pointer: () => undefined, person: () => ({ kind: 'person', id: 'owner', name: 'Lukas' }),
    now: () => clock.now, sleep: async (ms) => { clock.now += ms; },
  });
  driver.tab('web-1', contents as never);
  return { clock, contents, dbg: contents.debugger, browser, driver };
}

/** A paused document request of `dbg`'s page and what the guard answered to it. */
async function hop(dbg: FakeDebugger, url: string, frameId = 'main'): Promise<'continued' | 'failed'> {
  const id = `r${dbg.calls.length}`;
  dbg.emit('Fetch.requestPaused', { requestId: id, request: { url }, frameId });
  await new Promise((resolve) => setTimeout(resolve, 5));
  if (dbg.named('Fetch.failRequest').some((call) => call.params.requestId === id)) return 'failed';
  assert.ok(dbg.named('Fetch.continueRequest').some((call) => call.params.requestId === id), `${url} was answered`);
  return 'continued';
}

test('side guard: an agent\'s act in Secure mode guards the tab – chosen sites and the shown site go on, any other hop fails', async () => {
  const { driver, dbg } = setup();
  await driver.call({ action: 'snapshot', agent, web });
  assert.equal(dbg.named('Fetch.enable').length, 0, 'a look alone does not drive the tab');
  const out = await driver.call({ action: 'act', agent, web, steps: [{ action: 'press', key: 'Enter' }] });
  assert.equal(out.ok, true);
  assert.deepEqual(dbg.named('Fetch.enable')[0]!.params, { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
  assert.equal(await hop(dbg, 'https://shop.example/redirect?to=x'), 'continued', 'within the site the tab shows');
  assert.equal(await hop(dbg, 'https://pay.shop.example/'), 'continued', 'a subdomain of it');
  assert.equal(await hop(dbg, 'https://docs.example/a'), 'continued', 'a chosen site');
  assert.equal(await hop(dbg, 'https://evil.io/collect?d=secret'), 'failed', 'a redirect hop to a site not open');
  assert.equal(dbg.named('Fetch.failRequest')[0]!.params.errorReason, 'BlockedByClient');
  assert.equal(await hop(dbg, 'https://ads.evil.io/frame', 'frame-2'), 'continued', 'a frame inside the page loads as the page wants');
  const next = await driver.call({ action: 'act', agent, web, steps: [{ action: 'press', key: 'Tab' }] });
  assert.doesNotMatch(next.changes ?? '', HELD, 'a hold from before this act is not repeated');
});

test('side guard: a move held back during an act is named in its answer', async () => {
  const { driver, dbg } = setup();
  await driver.call({ action: 'eval', agent, web, expression: '1' });
  dbg.handlers['Input.dispatchKeyEvent'] = (p) => { if (p.type === 'keyUp') dbg.emit('Fetch.requestPaused', { requestId: 'k1', request: { url: 'https://evil.io/?q=1' }, frameId: 'main' }); return {}; };
  const out = await driver.call({ action: 'act', agent, web, steps: [{ action: 'press', key: 'Enter' }] });
  assert.match(out.changes ?? '', HELD);
});

test('side guard (c): an open into the tab passes its own site for that call only', async () => {
  const { driver, dbg, contents } = setup();
  dbg.handlers['Page.navigate'] = (p) => { dbg.emit('Fetch.requestPaused', { requestId: 'nav', request: { url: p.url }, frameId: 'main' }); return {}; };
  const out = await driver.call({ action: 'open', agent, web, newTab: false, tab: 'web-1', url: 'https://other.org/start' });
  assert.equal(out.ok, true, out.error);
  assert.ok(dbg.named('Fetch.continueRequest').some((call) => call.params.requestId === 'nav'), 'the open\'s own site goes on');
  contents.url = 'https://shop.example/cart'; // the page the tab shows (the fake does not move)
  assert.equal(await hop(dbg, 'https://other.org/later'), 'failed', '"Allow once" was that open, not the session');
});

test('side guard: Trust AI mode never intercepts; a call without web or the person\'s own use switches it off', async () => {
  const trust = setup();
  await trust.driver.call({ action: 'act', agent, steps: [{ action: 'press', key: 'Enter' }] });
  await trust.driver.call({ action: 'eval', agent, expression: '1' });
  assert.equal(trust.dbg.named('Fetch.enable').length + trust.dbg.named('Fetch.disable').length, 0, 'no web: nothing paused, as before');

  const { driver, dbg } = setup();
  await driver.call({ action: 'eval', agent, web, expression: '1' });
  await driver.call({ action: 'snapshot', agent });
  assert.equal(dbg.named('Fetch.disable').length, 1, 'the web opened everywhere since: off');
  await driver.call({ action: 'eval', agent, web, expression: '1' });
  driver.personUsed('web-1');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(dbg.named('Fetch.disable').length, 2, 'the person moved the tab themselves: off');
});

test('side guard: a page an agent drives opens only tabs the guard lets through, and the new tab inherits it', async () => {
  const { driver, clock } = setup();
  const hooks = driver.guardHooks();
  assert.equal(hooks.mayOpen!('web-1', 'https://evil.io/'), true, 'no guard yet: as before');
  await driver.call({ action: 'eval', agent, web, expression: '1' });
  assert.equal(hooks.mayOpen!('web-1', 'https://evil.io/'), false);
  assert.equal(hooks.mayOpen!('web-1', 'https://help.shop.example/'), true);
  const popup = page(clock, 'about:blank');
  const ready = hooks.beforeLoad!('web-2', popup as never, 'web-1');
  assert.ok(ready, 'the guard goes on before the first load');
  assert.equal(await ready, true);
  assert.equal(popup.debugger.named('Fetch.enable').length, 1);
  assert.equal(await hop(popup.debugger, 'https://shop.example/next'), 'continued', 'within its opener\'s site');
  assert.equal(await hop(popup.debugger, 'https://evil.io/x'), 'failed');
  const out = await driver.call({ action: 'act', agent, web, tab: 'web-1', steps: [{ action: 'press', key: 'Tab' }] });
  assert.doesNotMatch(out.changes ?? '', HELD, 'said before this act began');
  assert.equal(hooks.beforeLoad!('web-3', page(clock, 'about:blank') as never, 'web-9'), undefined, 'an unguarded opener: the page loads at once');
});

test('workspace hooks: the person\'s moves switch the guard off; a page loads once its guard is on, not at all when it cannot be', async () => {
  const used: string[] = [];
  const person = new TabGuards({ personUsed: (id: string) => { used.push(id); } });
  for (const action of ['open', 'back', 'forward', 'reload', 'close', 'zoom']) person.person({ action, id: 'web-1' } as never);
  assert.deepEqual(used, ['web-1', 'web-1', 'web-1', 'web-1']);
  new TabGuards().person({ action: 'open', id: 'web-1' } as never);

  const loads: string[] = [];
  const contents = { isDestroyed: () => false, loadURL: async (url: string) => { loads.push(url); } };
  const failed: string[] = [];
  const no = (why: string) => { failed.push(why); };
  new TabGuards().load('web-1', contents as never, 'https://a.example/', no);
  assert.deepEqual(loads, ['https://a.example/'], 'no hooks: at once');
  new TabGuards({ beforeLoad: () => Promise.resolve(true) }).load('web-1', contents as never, 'https://b.example/', no);
  new TabGuards({ beforeLoad: () => Promise.resolve(false) }).load('web-1', contents as never, 'https://c.example/', no);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(loads, ['https://a.example/', 'https://b.example/']);
  assert.deepEqual(failed, [UNWATCHED]);

  const froms: Array<string | undefined> = [];
  const opener = new TabGuards({ mayOpen: (_from, url) => !url.includes('evil'), beforeLoad: (_id, _c, from) => { froms.push(from); return undefined; } });
  const opened: string[] = [];
  const open = (url: string) => opener.opening('web-1', url, () => { opened.push(url); opener.load('web-2', contents as never, url, no); });
  open('https://evil.io/');
  open('https://help.example/');
  opener.opening('web-1', 'https://x.example/', () => { throw new Error('Close a browser tab before opening another.'); });
  opener.load('web-3', contents as never, 'https://later.example/', no);
  assert.deepEqual(opened, ['https://help.example/'], 'a held site never opens a tab');
  assert.deepEqual(froms, ['web-1', undefined], 'the new tab knows its opener; a later load does not');
});

test('validate: web is a list of host names, nothing else', () => {
  const ok = checkCall({ action: 'snapshot', agent, web: { sites: ['docs.example', '203.0.113.5', '::1'] } });
  assert.ok('call' in ok && ok.call.web?.sites.length === 3);
  const none = checkCall({ action: 'snapshot', agent });
  assert.ok('call' in none && none.call.web === undefined);
  for (const bad of [{ sites: 'x' }, { sites: ['https://evil.io/'] }, { sites: [''] }, ['docs.example'], { sites: [1] }]) {
    assert.ok('error' in checkCall({ action: 'snapshot', agent, web: bad }), JSON.stringify(bad));
  }
});
