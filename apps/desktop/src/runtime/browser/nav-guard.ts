// Secure mode's guard on the agents' own browsers (25.11.2026, after Andrea Griffiths' VM test: data could leave through
// any URL). With the web on 'chosen' the security gate checks the site of each browser.open (security/tool-gate.ts
// webNeed); a click on a link or a form sent from a page moves the tab without a call the gate sees. So, while the guard
// is active, every top-level navigation of an agent's own browser – a click, a form, the page's own script, a new tab,
// and each hop of a server redirect – goes through only
// - to a site the policy lets through without asking (webDomains, its subdomains with it),
// - to the site of the browser.open (or the person's own open) running right now – for that call only: "Allow once" is
//   one call, not the session (Konrad 25.11.2026, c); a later browser.open of that site goes through the gate again,
// - within the site the tab already shows (or a subdomain of it) – like a step in an open tab (policy.ts 'tab'),
// - while the person has taken the browser over or steers it from the live view (their own steps, not an agent's).
// Any other is held back (net::ERR_BLOCKED_BY_CLIENT) and the step's answer says which site, so the agent opens it with
// browser.open and the app asks the person.
// Two hooks see the navigations: Playwright's context route sees the first request of each (also of a new tab), and a
// DevTools Fetch session per page sees every request a document makes, the hops of a redirect included – Playwright
// continues those hops itself, unseen by a route (Konrad 25.11.2026, b).
// Frames inside a page (ads, embedded videos, payment fields) load as the page wants: the page chose them, not the agent.
// Owns: the guard's rule and its install on a context and its pages. Never: asks the person (the gate does) or reads
// settings.

import { heldMoveText, siteListed, siteOfUrl } from '../../shared/model/security-settings.ts';

/** What the guard knows of the security settings (compose/network.ts builds it on services.security). */
export interface NavGuard {
  /** True while moves to new sites are checked: Secure mode with the web not open everywhere. */
  active(): boolean;
  /** True when the policy lets the agent reach `site` without asking. */
  open(agentId: string, site: string): boolean;
}

/** The part of Playwright's Route a guard uses. */
export interface RouteLike { abort(code?: string): Promise<void>; continue(): Promise<void>; fallback?(): Promise<void> }
/** A page as the guard sees it: its address, and the page that opened it (a new tab). */
export interface GuardPage { url(): string; opener?(): Promise<GuardPage | null> }
/** The part of Playwright's Request a guard uses. */
export interface RequestLike { url(): string; isNavigationRequest(): boolean; frame(): { parentFrame(): unknown; page?(): GuardPage } }

/** A session's guard state: the sites of the opens running now, the last site held back, whether the hooks are on. */
export interface GuardState {
  agentId: string;
  /** The sites of the browser.open calls running now (count per site) – each only for its own call. */
  passes?: Map<string, number>;
  held?: string;
  guarded?: boolean;
  /** True while the person has taken this browser over (takeover.ts). */
  person?: () => boolean;
  /** The person's own steps from the live view running now (back, forward, reload – view-steer.ts). */
  personSteps?: number;
}

/** Runs `go`, a step of the person's in the live view, with the guard aside while it runs. */
export async function asPerson<T>(state: GuardState, go: () => Promise<T>): Promise<T> {
  state.personSteps = (state.personSteps ?? 0) + 1;
  try { return await go(); } finally { state.personSteps = Math.max(0, (state.personSteps ?? 1) - 1); }
}

/** The site a page shows – a new tab's (about:blank) is its opener's; '' when none. */
async function siteShown(page: GuardPage | undefined): Promise<string> {
  if (!page) return '';
  try {
    const own = siteOfUrl(page.url());
    if (own) return own;
    const opener = await page.opener?.();
    return opener ? siteOfUrl(opener.url()) : '';
  } catch { return ''; }
}

/**
 * Whether a top-level navigation of `state`'s browser to `url` goes through (undefined) or the site it holds back;
 * `from`: the site the tab shows now.
 */
export function heldSite(guard: NavGuard, state: GuardState, url: string, from = ''): string | undefined {
  if (!guard.active()) return undefined;
  if (state.personSteps || state.person?.()) return undefined; // the person drives
  const site = siteOfUrl(url);
  if (!site) return undefined; // about:, data:, blob: – no site reached
  if (siteListed([...(state.passes?.keys() ?? [])], site)) return undefined; // the open running now
  if (from && siteListed([from], site)) return undefined; // within the site the tab shows
  if (guard.open(state.agentId, site)) return undefined;
  return site;
}

/** The route handler of a guarded context (the first request of each navigation). */
export function guardRoute(guard: NavGuard, state: GuardState): (route: RouteLike, request: RequestLike) => Promise<void> {
  return async (route, request) => {
    let held: string | undefined;
    try {
      const frame = request.isNavigationRequest() ? request.frame() : undefined;
      if (frame && !frame.parentFrame()) held = heldSite(guard, state, request.url(), await siteShown(frame.page?.()));
    } catch { /* a request without a frame (a service worker's) is no navigation */ }
    if (held) {
      state.held = held;
      await route.abort('blockedbyclient').catch(() => undefined);
      return;
    }
    await (route.fallback ? route.fallback() : route.continue()).catch(() => undefined);
  };
}

/** A DevTools session on one page (Playwright's CDPSession). */
export interface GuardCdp { send(method: string, params?: Record<string, unknown>): Promise<unknown>; on(event: string, listener: (payload: never) => void): unknown }
/** Fetch.requestPaused as the guard reads it. */
interface Paused { requestId: string; request: { url: string }; frameId?: string; resourceType?: string }

/**
 * Every document request of `page` – each hop of a redirect included – paused and checked: a top-level one to a site
 * held back fails (BlockedByClient), everything else goes on unchanged.
 */
export async function guardPage(guard: NavGuard, state: GuardState, page: GuardPage, cdp: GuardCdp): Promise<void> {
  const tree = await cdp.send('Page.getFrameTree') as { frameTree?: { frame?: { id?: string } } };
  const main = tree?.frameTree?.frame?.id;
  cdp.on('Fetch.requestPaused', ((event: Paused) => {
    void (async () => {
      let held: string | undefined;
      try { if (main && event.frameId === main) held = heldSite(guard, state, event.request.url, await siteShown(page)); } catch { held = undefined; }
      if (held) {
        state.held = held;
        await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => undefined);
        return;
      }
      await cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => undefined);
    })();
  }) as (payload: never) => void);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
}

/** A context that can route its requests and open DevTools sessions (Playwright's BrowserContext). */
export interface RoutableContext {
  route?(url: (url: URL) => boolean, handler: (route: RouteLike, request: RequestLike) => Promise<void>): Promise<void>;
  pages?(): GuardPage[];
  on?(event: 'page', listener: (page: GuardPage) => void): unknown;
  newCDPSession?(page: GuardPage): Promise<GuardCdp>;
}

/** Turns the guard on for a session's context and its pages once it is active (routing everything costs the HTTP cache, so only then). */
export async function installGuard(guard: NavGuard | undefined, state: GuardState, context: RoutableContext): Promise<void> {
  if (!guard || state.guarded || !context.route) return;
  let active = false;
  try { active = guard.active(); } catch { active = false; }
  if (!active) return;
  state.guarded = true;
  try { await context.route(() => true, guardRoute(guard, state)); } catch { state.guarded = false; return; }
  const cdpOf = context.newCDPSession?.bind(context);
  if (!cdpOf) return;
  const watch = (page: GuardPage) => cdpOf(page).then((cdp) => guardPage(guard, state, page, cdp)).catch(() => undefined);
  context.on?.('page', (page) => { void watch(page); });
  await Promise.all((context.pages?.() ?? []).map(watch));
}

/** Runs `go` (a browser.open's navigation) with `url`'s site open for it alone. */
export async function withPass<T>(state: GuardState, url: string, go: () => Promise<T>): Promise<T> {
  const site = siteOfUrl(url);
  if (!site) return go();
  const passes = (state.passes ??= new Map());
  passes.set(site, (passes.get(site) ?? 0) + 1);
  try { return await go(); } finally {
    const left = (passes.get(site) ?? 1) - 1;
    if (left > 0) passes.set(site, left); else passes.delete(site);
  }
}

/** The site held back since the last call, with the line the agent reads ('' when none). */
export function takeHeld(state: GuardState): string {
  const site = state.held;
  state.held = undefined;
  return site ? heldMoveText(site) : '';
}
