// Secure mode after Andrea Griffiths' VM test (25.11.2026, Konrad's decisions): the web asks once per new site and
// remembers it (webDomains), a search stays open; the agents' own browsers hold back a move to a site not open yet
// (browser/nav-guard.ts); web.fetch follows a redirect only to an open site; the question the person gets; the list as
// settings.json keeps it; the engines' TMP/TEMP/TMPDIR at the own temp folder (engines/temp-env.ts).
// Owns: these assertions only. Never: a real network, browser or settings file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { securityDefaults, siteListed, siteOf, siteOfUrl, type SecuritySettings } from '../../../src/shared/model/security-settings.ts';
import { asPerson, guardPage, guardRoute, heldSite, installGuard, takeHeld, withPass, type GuardState, type NavGuard, type RequestLike, type RouteLike } from '../../../src/runtime/browser/nav-guard.ts';
import { webTools, type FetchFn } from '../../../src/runtime/tools/builtin/web.ts';
import { questionOf } from '../../../src/runtime/tasks/approval-todo.ts';
import { validateSecurity } from '../../../src/runtime/settings/security-keys.ts';
import { ownTempEnv, secureShellEnv, withOwnTemp } from '../../../src/runtime/engines/temp-env.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';

test('a site is its host in one form; a listed site covers its subdomains, never a look-alike', () => {
  assert.equal(siteOf(' WWW.Example.COM. '), 'example.com');
  assert.equal(siteOf('[::1]'), '::1');
  assert.equal(siteOfUrl('https://user:pw@Docs.Example.com:8443/a?b#c'), 'docs.example.com');
  assert.equal(siteOfUrl('example.com/path'), 'example.com', 'a bare address counts as https');
  assert.equal(siteOfUrl('http://203.0.113.5/x'), '203.0.113.5');
  for (const none of ['data:text/html,<b>x</b>', 'file:///etc/passwd', 'about:blank', 'javascript:alert(1)', 'blob:https://example.com/1', '']) assert.equal(siteOfUrl(none), '', none);
  assert.equal(siteListed(['example.com'], 'a.b.example.com'), true);
  assert.equal(siteListed(['example.com'], 'badexample.com'), false);
  assert.equal(siteListed(['example.com'], 'example.com.evil.io'), false);
  assert.equal(siteListed(['example.com'], ''), false);
});

test('the person\'s question for a new site is short and names the agent and the site', () => {
  assert.equal(questionOf({ agentName: 'Tom', summary: 'Open https://example.com/x', capability: 'web', place: { kind: 'site', value: 'example.com' } }),
    'Tom wants to open example.com for the first time. Allow this site?');
  assert.equal(questionOf({ agentName: 'Tom', summary: 'Run: npm test', capability: 'commands' }), 'Tom: Run: npm test', 'every other request as before');
});

test('settings.json: webDomains absent or null = none; entries kept as sites, each once; anything else refused', () => {
  const bad = (path: string, expected: string): never => { throw new Error(`${path}: ${expected}`); };
  const section = (patch: Record<string, unknown>) => ({ ...securityDefaults('secure'), ...patch }) as SecuritySettings;
  const none = section({});
  validateSecurity(none, bad);
  assert.equal('webDomains' in none, false, 'absent stays absent – an older section reads the same');
  const nulled = section({ webDomains: null });
  validateSecurity(nulled, bad);
  assert.equal('webDomains' in nulled, false);
  const listed = section({ webDomains: ['WWW.Example.com', 'example.com', 'docs.github.com.'] });
  validateSecurity(listed, bad);
  assert.deepEqual(listed.webDomains, ['example.com', 'docs.github.com']);
  for (const entry of ['https://example.com/x', 'exa mple.com', '*.example.com', '']) {
    assert.throws(() => validateSecurity(section({ webDomains: [entry] }), bad), /security\.webDomains: a list of up to \d+ host names/, entry);
  }
  assert.throws(() => validateSecurity(section({ web: 'sometimes' }), bad), /security\.web: yes \| chosen \| ask/);
});

// ------------------------------------------------------------------ the agents' own browsers

const guardOf = (open: string[], active = true): NavGuard => ({ active: () => active, open: (_agent, site) => siteListed(open, site) });
const request = (url: string, navigation = true, child = false): RequestLike => ({ url: () => url, isNavigationRequest: () => navigation, frame: () => ({ parentFrame: () => (child ? {} : null) }) });
function route() {
  const done: string[] = [];
  const r: RouteLike = { abort: async (code) => { done.push(`abort:${code}`); }, continue: async () => { done.push('continue'); }, fallback: async () => { done.push('fallback'); } };
  return { r, done };
}

test('nav guard: a top-level move to a site not open is held back and named; open, passed and frame loads go through', async () => {
  const guard = guardOf(['example.com']);
  const state: GuardState = { agentId: 'ag_a' };
  assert.equal(heldSite(guard, state, 'https://docs.example.com/a'), undefined, 'a chosen site and its subdomains');
  assert.equal(heldSite(guard, state, 'https://evil.io/?d=secret'), 'evil.io');
  assert.equal(heldSite(guard, state, 'data:text/html,x'), undefined, 'no site reached');
  assert.equal(heldSite(guardOf([], false), state, 'https://evil.io/'), undefined, 'Trust AI mode or web open: no guard');
  assert.equal(heldSite(guard, state, 'https://shop.other.org/x', 'other.org'), undefined, 'within the site the tab shows');
  assert.equal(heldSite(guard, state, 'https://evil.io/x', 'other.org'), 'evil.io');

  const held = route();
  await guardRoute(guard, state)(held.r, request('https://evil.io/upload?d=1'));
  assert.deepEqual(held.done, ['abort:blockedbyclient']);
  assert.match(takeHeld(state), /^Secure mode held back the move to evil\.io: that site is not open to me yet\. I open it with browser\.open, and the app asks the person first\.$/);
  assert.equal(takeHeld(state), '', 'said once');

  const frame = route();
  await guardRoute(guard, state)(frame.r, request('https://ads.example.net/frame', true, true));
  assert.deepEqual(frame.done, ['fallback'], 'a frame inside the page loads as the page wants');
  const resource = route();
  await guardRoute(guard, state)(resource.r, request('https://cdn.example.net/app.js', false));
  assert.deepEqual(resource.done, ['fallback']);
});

test('nav guard (c): "Allow once" opens the site for that one open only, never for the session', async () => {
  const guard = guardOf(['example.com']);
  const state: GuardState = { agentId: 'ag_a' };
  const during = await withPass(state, 'https://www.Other.org/start', async () => heldSite(guard, state, 'https://other.org/next'));
  assert.equal(during, undefined, 'the open running now – its redirect within that site too');
  assert.equal(heldSite(guard, state, 'https://other.org/later'), 'other.org', 'a later move there goes through the gate again');
  assert.equal(state.passes?.size, 0);
  await assert.rejects(withPass(state, 'https://other.org/', async () => { throw new Error('load failed'); }));
  assert.equal(state.passes?.size, 0, 'a failed open leaves no pass behind');
});

test('nav guard: the person\'s own steps (takeover, live view) are never held back', async () => {
  const guard = guardOf([]);
  let person = false;
  const state: GuardState = { agentId: 'ag_a', person: () => person };
  assert.equal(heldSite(guard, state, 'https://evil.io/'), 'evil.io');
  person = true;
  assert.equal(heldSite(guard, state, 'https://evil.io/'), undefined, 'the person has taken the browser over');
  person = false;
  assert.equal(await asPerson(state, async () => heldSite(guard, state, 'https://evil.io/')), undefined, 'a live-view step');
  assert.equal(heldSite(guard, state, 'https://evil.io/'), 'evil.io', 'and only while it runs');
});

/** A DevTools session that records what the guard answers to each paused document request. */
function fakeCdp(mainFrame = 'F1') {
  const sent: Array<[string, Record<string, unknown> | undefined]> = [];
  let paused: ((event: never) => void) | undefined;
  const cdp = {
    send: async (method: string, params?: Record<string, unknown>) => { sent.push([method, params]); return method === 'Page.getFrameTree' ? { frameTree: { frame: { id: mainFrame } } } : {}; },
    on: (event: string, listener: (payload: never) => void) => { if (event === 'Fetch.requestPaused') paused = listener; },
  };
  const pause = async (requestId: string, url: string, frameId = mainFrame) => { paused?.({ requestId, request: { url }, frameId } as never); await new Promise((r) => setTimeout(r, 5)); };
  const answers = () => sent.filter(([m]) => m.startsWith('Fetch.') && m !== 'Fetch.enable').map(([m, p]) => `${m.slice(6)}:${String(p?.requestId)}`);
  return { cdp, sent, pause, answers };
}

test('nav guard (b): every redirect hop of a document is checked, not only the first request', async () => {
  const guard = guardOf(['example.com']);
  const state: GuardState = { agentId: 'ag_a' };
  const page = { url: () => 'https://example.com/start' };
  const f = fakeCdp();
  await guardPage(guard, state, page, f.cdp);
  assert.deepEqual(f.sent.at(-1), ['Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] }]);
  await f.pause('r1', 'https://example.com/redirect?to=evil');
  await f.pause('r1', 'https://evil.io/collect?d=secret'); // the hop the server redirects to
  await f.pause('r2', 'https://ads.evil.io/frame', 'F2'); // a frame inside the page
  assert.deepEqual(f.answers(), ['continueRequest:r1', 'failRequest:r1', 'continueRequest:r2']);
  assert.equal(f.sent.find(([m]) => m === 'Fetch.failRequest')?.[1]?.errorReason, 'BlockedByClient');
  assert.match(takeHeld(state), /evil\.io/);
});

test('nav guard: installed once and only while active, on the context and each page (routing costs the HTTP cache)', async () => {
  const routes: unknown[] = [];
  const watched: string[] = [];
  let newPage: ((page: { url(): string }) => void) | undefined;
  const context = {
    route: async (_url: unknown, handler: unknown) => { routes.push(handler); },
    pages: () => [{ url: () => 'https://a.example/' }],
    on: (_event: 'page', listener: (page: { url(): string }) => void) => { newPage = listener; },
    newCDPSession: async (page: { url(): string }) => { watched.push(page.url()); return fakeCdp().cdp; },
  };
  const state: GuardState = { agentId: 'ag_a' };
  await installGuard(guardOf([], false), state, context);
  assert.equal(routes.length, 0);
  assert.equal(watched.length, 0, 'Trust AI mode: no DevTools session, nothing paused');
  await installGuard(guardOf([]), state, context);
  await installGuard(guardOf([]), state, context);
  assert.equal(routes.length, 1);
  assert.equal(state.guarded, true);
  newPage?.({ url: () => 'about:blank' });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(watched, ['https://a.example/', 'about:blank'], 'a new tab is watched too');
});

// ------------------------------------------------------------------ web.fetch and redirects

function fetchSetup(security?: { settings: SecuritySettings; open: string[] }) {
  const fetched: Array<{ url: string; redirect: string }> = [];
  const answers = new Map<string, () => Response>();
  const fetch: FetchFn = async (url, init) => {
    fetched.push({ url, redirect: init.redirect });
    return (answers.get(url) ?? (() => new Response('page', { status: 200, headers: { 'content-type': 'text/plain' } })))();
  };
  const services = {
    ...(security ? { security: { current: () => security.settings, check: (req: { site?: string }) => (req.site && siteListed(security.open, req.site) ? 'open' : 'ask') } } : {}),
  } as unknown as RuntimeServices;
  const ctx: ToolContext = { agent: { id: 'ag_a', name: 'Tom' } as ToolContext['agent'], runId: 'run_1', mode: 'coding', services, signal: new AbortController().signal, status() {} };
  const [web] = webTools({ fetch });
  const moved = (from: string, to: string) => answers.set(from, () => new Response('', { status: 302, headers: { location: to } }));
  return { fetched, ctx, web, moved };
}
const text = (out: ToolOutput) => out.content.map((part) => ('text' in part ? part.text : '')).join('');

test('web.fetch in Secure mode: a redirect goes on within the site and to open sites, never to another one', async () => {
  const f = fetchSetup({ settings: { ...securityDefaults('secure'), webDomains: ['example.com'] }, open: ['example.com', 'cdn.net'] });
  f.moved('https://example.com/a', 'https://www.example.com/b');
  f.moved('https://www.example.com/b', 'https://cdn.net/c');
  f.moved('https://cdn.net/c', 'https://evil.io/collect?d=secret');
  const out = await f.web.run({ url: 'https://example.com/a' }, f.ctx);
  assert.deepEqual(f.fetched.map((call) => [call.url, call.redirect]), [
    ['https://example.com/a', 'manual'], ['https://www.example.com/b', 'manual'], ['https://cdn.net/c', 'manual'],
  ], 'evil.io was never asked for');
  assert.match(text(out), /redirect to https:\/\/evil\.io\/collect\?d=secret not followed: Secure mode has not opened that site to me yet/);
  const g = fetchSetup({ settings: securityDefaults('secure'), open: [] });
  g.moved('https://example.com/a', 'file:///etc/passwd');
  assert.match(text(await g.web.run({ url: 'https://example.com/a' }, g.ctx)), /redirect to file:\/\/\/etc\/passwd not followed/);
  assert.equal(g.fetched.length, 1);
});

test('web.fetch in Trust AI mode or with the web open everywhere follows redirects as before', async () => {
  for (const settings of [securityDefaults('trust'), { ...securityDefaults('secure'), web: 'yes' as const }]) {
    const f = fetchSetup({ settings, open: [] });
    await f.web.run({ url: 'https://example.com/a' }, f.ctx);
    assert.equal(f.fetched[0].redirect, 'follow', settings.mode);
  }
});

// ------------------------------------------------------------------ the own temp folder

test('engine env: TMP, TEMP and TMPDIR at the own temp folder, every spelling replaced; only in Secure mode for Codex shells', () => {
  assert.deepEqual(ownTempEnv('/data/tmp'), { TMP: '/data/tmp', TEMP: '/data/tmp', TMPDIR: '/data/tmp' });
  const env = withOwnTemp({ Temp: 'C:\\Users\\A\\AppData\\Local\\Temp', tmp: 'x', PATH: '/bin', TMPDIR: '/tmp' }, '/data/tmp');
  assert.deepEqual(env, { PATH: '/bin', TMP: '/data/tmp', TEMP: '/data/tmp', TMPDIR: '/data/tmp' });
  assert.deepEqual(secureShellEnv({ GIT_X: '1' }, '/data/tmp', true), { GIT_X: '1', TMP: '/data/tmp', TEMP: '/data/tmp', TMPDIR: '/data/tmp' });
  assert.deepEqual(secureShellEnv({ GIT_X: '1' }, '/data/tmp', false), { GIT_X: '1' }, 'Trust AI mode: the PC\'s own temp');
  assert.equal(secureShellEnv(undefined, undefined, true), undefined);
});
